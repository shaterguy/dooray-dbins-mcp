import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createMcpServer } from "../src/server.mjs";
import { FIXED_CONFIG } from "../src/config.mjs";

const originalFetch = globalThis.fetch;
const config = {
  ...FIXED_CONFIG,
  secrets: { caldavUsername: "synthetic-user", caldavPassword: "synthetic-password" },
};
const PRIVATE_MARKER = "SYNTHETIC_PRIVATE_MARKER";

async function callList(source, upstream) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === "127.0.0.1") return originalFetch(url, options);
    calls.push({ host: new URL(url).hostname, path: new URL(url).pathname, method: options.method });
    return upstream(new URL(url), options);
  };
  const http = createServer(async (req, res) => {
    const built = createMcpServer(config);
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await built.server.connect(built.transport);
      res.once("close", () => {
        void built.transport.close().catch(() => {});
        void built.server.close().catch(() => {});
      });
      await built.transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const response = await originalFetch(`http://127.0.0.1:${http.address().port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "carddav_list_address_books", arguments: { source } } }),
    });
    assert.equal(response.status, 200);
    return { result: (await response.json()).result, calls };
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => http.close(resolve));
  }
}

function denied(url, options, scheme = "Basic") {
  const status = url.pathname === "/carddav/" ? 404 : 401;
  return new Response(PRIVATE_MARKER, { status, headers: {
    "www-authenticate": `${scheme} realm="${PRIVATE_MARKER}"`,
    "set-cookie": `session=${PRIVATE_MARKER}`,
    "x-private": PRIVATE_MARKER,
  } });
}

test("MCP personal discovery failure returns only bounded safe route diagnostics", async () => {
  const { result, calls } = await callList("personal", denied);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, "CARDDAV_DISCOVERY_FAILED");
  assert.deepEqual(result.structuredContent.data?.diagnostics, [{
    source: "personal",
    paths: [
      { label: "well_known", options: "CARDDAV_AUTH_FAILED", standard: "CARDDAV_AUTH_FAILED", direct: null, authScheme: "basic" },
      { label: "root", options: "CARDDAV_AUTH_FAILED", standard: "CARDDAV_AUTH_FAILED", direct: null, authScheme: "basic" },
      { label: "legacy_carddav", options: "CARDDAV_NOT_FOUND", standard: "CARDDAV_NOT_FOUND", direct: "CARDDAV_NOT_FOUND" },
    ],
  }]);
  assert.equal(calls.length, 7);
  assert.deepEqual([...new Set(calls.map((call) => call.host))], ["carddav.dooray.co.kr"]);
  assert.deepEqual([...new Set(calls.map((call) => call.method))], ["OPTIONS", "PROPFIND"]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [PRIVATE_MARKER, "synthetic-user", "synthetic-password",
    "Authorization", "set-cookie", "www-authenticate", "https://", "/carddav/", "realm="]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("all-source failures preserve partial-result contract and isolate diagnostics", async () => {
  const { result } = await callList("all", denied);
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.data.sources.map((entry) => entry.status), ["error", "error"]);
  assert.deepEqual(result.structuredContent.data.diagnostics?.map((entry) => entry.source), ["personal", "organization"]);
  assert.equal(JSON.stringify(result).includes(PRIVATE_MARKER), false);
});

test("unrecognized upstream authentication scheme is not copied into diagnostics", async () => {
  const { result } = await callList("personal", (url, options) => denied(url, options, PRIVATE_MARKER));
  const diagnostics = result.structuredContent.data?.diagnostics;
  assert.ok(Array.isArray(diagnostics));
  assert.equal(JSON.stringify(result).includes(PRIVATE_MARKER.toLowerCase()), false);
  assert.equal(diagnostics[0].paths.some((entry) => "authScheme" in entry), false);
});
