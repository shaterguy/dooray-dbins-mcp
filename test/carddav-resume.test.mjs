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
  const state = { gets: [], requests: [], revision: 1, failAt };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    state.requests.push({ path, method: options.method });
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
      return new Response(["BEGIN:VCARD", "VERSION:3.0", "UID:" + path, "FN:" + (allMatch || index === count - 1 ? "Target" : "Other"), "NOTE:private-synthetic-note", "END:VCARD"].join("\r\n"), { status: 200 });
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
