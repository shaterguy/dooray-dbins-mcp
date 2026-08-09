import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { authorizeMcpAccessKey } from "../src/access.mjs";
import { DoorayApiError, DoorayClient } from "../src/dooray/client.mjs";
import { buildDoorayUrl, normalizeDoorayApiPath } from "../src/dooray/guards.mjs";
import { normalizeDoorayApiToken } from "../src/dooray/token.mjs";

const TOKEN = "A".repeat(64);
const API_TOKEN = "abcdefghijklmnop";

function clientWith(fetchImpl, httpsRequestImpl = async () => new Response("unexpected")) {
  return new DoorayClient({
    token: API_TOKEN,
    baseUrl: new URL("https://api.dooray.com"),
    allowedHosts: new Set(["api.dooray.com"]),
    timeoutMs: 1_000,
    maxResponseBytes: 10_000,
  }, fetchImpl, httpsRequestImpl);
}

function authFailure(message = "invalid token") {
  return new Response(JSON.stringify({
    header: { isSuccessful: false, resultCode: 401, resultMessage: message },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("Dooray token normalization and URL guards preserve the source security boundary", () => {
  assert.deepEqual(normalizeDoorayApiToken("dooray-api abcdefghijklmnop"), {
    token: API_TOKEN,
    inputFormat: "dooray-api-prefixed",
  });
  assert.deepEqual(normalizeDoorayApiToken("Authorization: dooray-api abcdefghijklmnop"), {
    token: API_TOKEN,
    inputFormat: "authorization-header",
  });
  assert.equal(normalizeDoorayApiPath("/project/v1/projects/1"), "/project/v1/projects/1");
  assert.throws(() => normalizeDoorayApiPath("/project/v1/../common/v1/members"));
  assert.throws(() => normalizeDoorayApiPath("/project/v1/projects?token=secret"));
  assert.throws(() => buildDoorayUrl(new URL("https://evil.example"), new Set(["api.dooray.com"]), "/project/v1/projects"));
  const url = buildDoorayUrl(new URL("https://api.dooray.com"), new Set(["api.dooray.com"]), "/project/v1/projects", {
    page: 0,
    tagIds: ["one", "two"],
  });
  assert.equal(url.searchParams.get("tagIds"), "one,two");
});

test("Dooray client sends GET-only requests and keeps the standard transport contract", async () => {
  let captured;
  const client = clientWith(async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ header: { isSuccessful: true }, result: { id: "me" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const data = await client.get("/common/v1/members/me");
  assert.equal(data.result.id, "me");
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.headers.Authorization, `dooray-api ${API_TOKEN}`);
  assert.equal(captured.url.origin, "https://api.dooray.com");
});

test("Dooray client preserves auth transport fallbacks without exposing the token", async () => {
  const calls = [];
  const client = clientWith(async (_url, init) => {
    calls.push(init);
    return calls.length === 1
      ? authFailure()
      : new Response(JSON.stringify({ header: { isSuccessful: true }, result: { id: "fallback" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  });
  const data = await client.get("/common/v1/members/me");
  assert.equal(data.result.id, "fallback");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers["Content-Type"], "application/json");

  const allRejected = clientWith(async () => authFailure("Failed to authorize"), async () => authFailure("Failed to authorize"));
  await assert.rejects(() => allRejected.get("/common/v1/members/me"), (error) => {
    assert.ok(error instanceof DoorayApiError);
    assert.equal(error.authenticationFailure, true);
    assert.equal(error.message.includes(API_TOKEN), false);
    assert.match(error.message, /allRejected=true/);
    return true;
  });
});

test("Dooray client rejects binary responses without trying a different transport", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  });
  await assert.rejects(() => client.get("/drive/v1/files/1"), /Binary Dooray responses/);
  assert.equal(calls, 1);
});

test("MCP access key compatibility uses the configured bearer or custom header only", () => {
  const request = (headers = {}, query = "") => ({
    headers,
    url: `/A/mcp${query}`,
  });
  assert.equal(authorizeMcpAccessKey(request({ authorization: "Bearer access-secret" }), "access-secret").ok, true);
  assert.equal(authorizeMcpAccessKey(request({ "x-mcp-access-key": "access-secret" }), "access-secret").ok, true);
  assert.equal(authorizeMcpAccessKey(request({}, "?access_key=access-secret"), "access-secret").ok, true);
  assert.equal(authorizeMcpAccessKey(request({ authorization: "Bearer wrong" }), "access-secret").ok, false);
  assert.equal(authorizeMcpAccessKey(request(), "access-secret").status, 401);
});

test("canonical credentials are shared by CalDAV and LDAP while the REST token stays separate", () => {
  const config = loadConfig({
    MCP_PATH_TOKEN: TOKEN,
    DOORAY_USERNAME: "same-user",
    DOORAY_PASSWORD: "same-password",
    DOORAY_API_TOKEN: API_TOKEN,
  });
  assert.equal(config.secrets.caldavUsername, "same-user");
  assert.equal(config.secrets.ldapBindDn, "same-user");
  assert.equal(config.secrets.caldavPassword, "same-password");
  assert.equal(config.secrets.ldapPassword, "same-password");
  assert.equal(config.secrets.doorayApiToken, API_TOKEN);
});

