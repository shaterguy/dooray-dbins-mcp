import { createServer } from "node:http";
import { createMcpServer } from "../src/server.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_CONFIG } from "../src/config.mjs";
import { searchContacts } from "../src/carddav.mjs";

const config = { ...FIXED_CONFIG, secrets: { caldavUsername: "synthetic-user", caldavPassword: "synthetic-password" } };
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
test.afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });
function multi(responses) { return '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">' + responses + '</d:multistatus>'; }
function prop(href, value) { return '<d:response><d:href>' + href + '</d:href><d:propstat><d:prop>' + value + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'; }
function fixture({ count = 300, books = ["/books/resume/"], allMatch = false, failAt = 0 } = {}) {
  const state = { gets: [], requests: [], revision: 1, failAt, missingAt: -1, invalidAt: -1, getEtag: "", afterRequest: null };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    state.requests.push({ path, method: options.method });
    state.afterRequest?.(path, options.method);
    if (options.method === "OPTIONS") return new Response("", { status: 200 });
    if (options.method === "REPORT") return new Response("unsupported", { status: 400 });
    if (options.method === "PROPFIND") {
      if (path === "/.well-known/carddav") return new Response(multi(prop(path, "<d:current-user-principal><d:href>/principals/test/</d:href></d:current-user-principal>")), { status: 207 });
      if (path === "/principals/test/") return new Response(multi(prop(path, "<c:addressbook-home-set><d:href>/books/</d:href></c:addressbook-home-set>")), { status: 207 });
      if (path === "/books/") return new Response(multi(books.map(book => prop(book, "<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype>")).join("")), { status: 207 });
      if (books.includes(path)) return new Response(multi(Array.from({ length: count }, (_, i) => prop(path + String(i).padStart(5, "0") + ".vcf", "<d:getetag>" + state.revision + "</d:getetag>")).reverse().join("")), { status: 207 });
    }
    if (options.method === "GET") {
      const index = Number(path.match(/(\d+)\.vcf$/)?.[1]);
      state.gets.push(path);
      if (index === state.failAt) return new Response("", { status: 503 });
      if (index === state.missingAt) return new Response("", { status: 404 });
      if (index === state.invalidAt) return new Response("invalid-vcard", { status: 200 });
      return new Response(["BEGIN:VCARD", "VERSION:3.0", "UID:" + path, "FN:" + (allMatch || index === count - 1 ? "Target" : "Other"), "NOTE:private-synthetic-note", "END:VCARD"].join("\r\n"), { status: 200, headers: state.getEtag ? { etag: state.getEtag } : {} });
    }
    throw new Error("Unexpected synthetic request");
  };
  return state;
}

test("cold organization search returns bounded progress and resumes on a fresh module instance", async () => {
  const state = fixture({ failAt: -1 });
  const first = await searchContacts(config, { source: "organization", query: "Target", limit: 20 });
  assert.ok(state.gets.length <= 256, "one search must not read the entire 300-resource inventory");
  assert.equal(first.incomplete, true);
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(first.contacts.length, 0);
  const fresh = await import("../src/carddav.mjs?cold-resume-test");
  const second = await fresh.searchContacts(config, { source: "organization", query: "Target", limit: 20, cursor: first.nextCursor });
  assert.equal(second.incomplete, false);
  assert.equal(second.nextCursor, null);
  assert.equal(second.contacts.length, 1);
  assert.match(second.contacts[0].href, /00299.vcf$/);
  assert.equal(new Set(state.gets).size, 300);
  assert.equal(JSON.stringify([first, second]).includes("private-synthetic-note"), false);
  const decoded = Buffer.from(first.nextCursor, "base64url").toString();
  for (const marker of ["synthetic-user", "synthetic-password", "/books/", "Target", "https", "Authorization"]) assert.equal(decoded.includes(marker), false);
});

test("result limit resumes after consumed matches without dropping fetched contacts", async () => {
  fixture({ count: 5, books: ["/books/matches/"], allMatch: true, failAt: -1 });
  const seen = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const page = await searchContacts(config, { source: "organization", query: "Target", limit: 1, cursor });
    assert.equal(page.contacts.length, 1);
    seen.push(page.contacts[0].href);
    cursor = page.nextCursor;
    assert.equal(page.incomplete, i < 4);
  }
  assert.equal(cursor, null);
  assert.equal(new Set(seen).size, 5);
});

test("cursor rejects changed inventory and query instead of silently skipping resources", async () => {
  const state = fixture({ count: 300, books: ["/books/change/"], failAt: -1 });
  const page = await searchContacts(config, { source: "organization", query: "Target", limit: 20 });
  assert.equal(typeof page.nextCursor, "string");
  await assert.rejects(() => searchContacts(config, { source: "organization", query: "different", cursor: page.nextCursor }), { code: "CARDDAV_INVALID_CURSOR" });
  state.revision = 2;
  await assert.rejects(() => searchContacts(config, { source: "organization", query: "Target", cursor: page.nextCursor }), { code: "CARDDAV_CURSOR_STALE" });
});

test("invalid cursor is rejected before network and cannot supply an upstream path", async () => {
  const state = fixture();
  await assert.rejects(() => searchContacts(config, { source: "organization", query: "Target", cursor: "https://attacker.invalid/path" }), { code: "CARDDAV_INVALID_CURSOR" });
  assert.equal(state.requests.length, 0);
});

test("a failed resource leaves an explicit incomplete retry position", async () => {
  const state = fixture({ count: 5, books: ["/books/failure/"], allMatch: true, failAt: 2 });
  const first = await searchContacts(config, { source: "organization", query: "Target" });
  assert.equal(first.incomplete, true);
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(first.contacts.length, 2);
  state.failAt = -1;
  const next = await searchContacts(config, { source: "organization", query: "Target", cursor: first.nextCursor });
  assert.equal(next.incomplete, false);
  assert.equal(next.contacts.length, 3);
});

test("multiple books are covered in stable order", async () => {
  fixture({ count: 3, books: ["/books/z/", "/books/a/"], allMatch: true, failAt: -1 });
  const seen = [];
  let cursor;
  do {
    const page = await searchContacts(config, { source: "organization", query: "Target", limit: 2, cursor });
    seen.push(...page.contacts.map(item => item.href));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ["/books/a/00000.vcf", "/books/a/00001.vcf", "/books/a/00002.vcf", "/books/z/00000.vcf", "/books/z/00001.vcf", "/books/z/00002.vcf"]);
});
test("earlier invalid resources remain incomplete after exhaustion", async () => {
  const state = fixture({ count: 300, books: ["/books/invalid/"], failAt: -1 });
  state.invalidAt = 0;
  const first = await searchContacts(config, { source: "organization", query: "Target" });
  assert.equal(first.progress.skippedResources, 1);
  const last = await searchContacts(config, { source: "organization", query: "Target", cursor: first.nextCursor });
  assert.equal(last.nextCursor, null);
  assert.equal(last.incomplete, true);
  assert.equal(last.reason, "invalid_resources");
});
test("disappearing resources are not verified nonmatches", async () => {
  const state = fixture({ count: 4, books: ["/books/disappear/"], failAt: -1 });
  state.missingAt = 1;
  const page = await searchContacts(config, { source: "organization", query: "Target" });
  assert.equal(page.incomplete, true);
  assert.equal(page.reason, "resource_failed");
  assert.equal(page.progress.nextOffset, 1);
});
test("GET ETag drift rejects changed resources", async () => {
  const state = fixture({ count: 4, books: ["/books/etag/"], failAt: -1 });
  state.getEtag = "different";
  await assert.rejects(() => searchContacts(config, { source: "organization", query: "Target" }), { code: "CARDDAV_CURSOR_STALE" });
});
test("time budget stops discovery before later network requests", async () => {
  const state = fixture({ failAt: -1 });
  let now = 1_000;
  Date.now = () => now;
  state.afterRequest = () => { now += 41_000; };
  await assert.rejects(() => searchContacts(config, { source: "organization", query: "Target" }), { code: "CARDDAV_SEARCH_BUDGET" });
  assert.equal(state.requests.length, 1);
});
test("time budget stops GET traversal at a resumable position", async () => {
  const state = fixture({ count: 300, books: ["/books/time/"], failAt: -1 });
  let now = 1_000;
  Date.now = () => now;
  state.afterRequest = (_path, method) => { if (method === "GET") now += 5_000; };
  const page = await searchContacts(config, { source: "organization", query: "Target" });
  assert.equal(page.incomplete, true);
  assert.equal(page.reason, "time_budget");
  assert.equal(typeof page.nextCursor, "string");
  assert.ok(state.gets.length <= 8);
});
test("source all does not replay personal contacts on continuation", async () => {
  fixture({ count: 300, books: ["/books/all/"], failAt: -1 });
  const first = await searchContacts(config, { source: "all", query: "Target" });
  assert.equal(typeof first.nextCursor, "string");
  const next = await searchContacts(config, { source: "all", query: "Target", cursor: first.nextCursor });
  assert.equal(next.contacts.length, 1);
  assert.equal(next.contacts[0].source, "organization");
  assert.equal(next.sources[0].status, "previous_page");
  assert.equal(next.incomplete, true);
});
test("out-of-range and oversized cursors are rejected", async () => {
  fixture({ count: 300, books: ["/books/range/"], failAt: -1 });
  const first = await searchContacts(config, { source: "organization", query: "Target" });
  const decoded = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
  decoded.offset = 301;
  await assert.rejects(() => searchContacts(config, { source: "organization", query: "Target", cursor: Buffer.from(JSON.stringify(decoded)).toString("base64url") }), { code: "CARDDAV_INVALID_CURSOR" });
  await assert.rejects(() => searchContacts(config, { source: "organization", query: "Target", cursor: "a".repeat(1025) }), { code: "CARDDAV_INVALID_CURSOR" });
});
test("source all preserves personal results if organization discovery fails", async () => {
  fixture({ count: 2, books: ["/books/partial/"], allMatch: true, failAt: -1 });
  const mocked = globalThis.fetch;
  globalThis.fetch = (url, options) => new URL(String(url)).hostname === "carddav-members.dooray.co.kr" ? Promise.resolve(new Response("", { status: 401 })) : mocked(url, options);
  const page = await searchContacts(config, { source: "all", query: "Target" });
  assert.equal(page.contacts.length, 2);
  assert.equal(page.incomplete, true);
  assert.equal(page.nextCursor, null);
  assert.equal(page.sources[1].status, "error");
});
test("address book cap stays explicitly incomplete at exhaustion", async () => {
  fixture({ count: 0, books: Array.from({ length: 21 }, (_, i) => "/books/cap" + i + "/"), failAt: -1 });
  const page = await searchContacts(config, { source: "organization", query: "Target" });
  assert.equal(page.incomplete, true);
  assert.equal(page.nextCursor, null);
  assert.equal(page.reason, "resource_cap");
});

test("an exact selected address book is not incomplete because other books hit the discovery cap", async () => {
  fixture({ count: 0, books: Array.from({ length: 20 }, (_, i) => "/books/selected" + i + "/"), failAt: -1 });
  const page = await searchContacts(config, { source: "organization", query: "Target", addressBookHref: "/books/selected0/" });
  assert.equal(page.incomplete, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.reason, null);
});
test("resource cap exhausts without an endless cursor", async () => {
  fixture({ count: 20_001, books: ["/books/resource-cap/"], failAt: -1 });
  const first = await searchContacts(config, { source: "organization", query: "Target" });
  const cursor = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
  cursor.offset = 20_000;
  const last = await searchContacts(config, { source: "organization", query: "Target", cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") });
  assert.equal(last.nextCursor, null);
  assert.equal(last.incomplete, true);
  assert.equal(last.reason, "resource_cap");
});
test("MCP exposes cursor schema and accepts continuation through the real transport", async () => {
  fixture({ count: 300, books: ["/books/mcp/"], failAt: -1 });
  const http = createServer(async (req, res) => {
    const built = createMcpServer(config);
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await built.server.connect(built.transport);
      res.once("close", () => { void built.transport.close().catch(() => {}); void built.server.close().catch(() => {}); });
      await built.transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch { res.statusCode = 500; res.end(); }
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  async function call(method, params) {
    const response = await originalFetch("http://127.0.0.1:" + http.address().port + "/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  try {
    const list = await call("tools/list", {});
    assert.equal(list.tools.find(tool => tool.name === "carddav_search_contacts").inputSchema.properties.cursor.type, "string");
    const first = await call("tools/call", { name: "carddav_search_contacts", arguments: { source: "organization", query: "Target" } });
    assert.equal(first.structuredContent.ok, true);
    assert.equal(first.structuredContent.data.incomplete, true);
    assert.match(first.content[0].text, /Partial search/);
    const last = await call("tools/call", { name: "carddav_search_contacts", arguments: { source: "organization", query: "Target", cursor: first.structuredContent.data.nextCursor } });
    assert.equal(last.structuredContent.data.incomplete, false);
    assert.equal(last.structuredContent.data.contacts.length, 1);
  } finally { await new Promise(resolve => http.close(resolve)); }
});
