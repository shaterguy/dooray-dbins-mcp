import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import mcpHandler from "../api/mcp.mjs";
import healthHandler from "../api/health.mjs";
import { isValidPathToken, PATH_TOKEN_PATTERN, readPathToken } from "../src/auth.mjs";
import {
  ConfigurationError,
  FIXED_CONFIG,
  LEGACY_PATH_TOKEN_ENV_KEY,
  loadConfig,
  loadPathToken,
  SECRET_ENV_KEYS,
} from "../src/config.mjs";
import {
  CALDAV_ENTRY_PATH,
  checkCalDav,
  decodeXmlEntities,
  getEvents,
  listCalendars,
  parseDavXml,
  readResponseTextBounded,
  toCalDavUrl,
} from "../src/caldav.mjs";
import { AppError, MAX_STRUCTURED_DATA_BYTES, toolSuccess } from "../src/errors.mjs";
import {
  classifyLdapError,
  escapeLdapFilterValue,
  isWithinBaseDn,
  LDAP_UPSTREAM_MAX_CONCURRENT_SEARCHES,
  mapWithConcurrency,
  PERSON_ATTRIBUTES,
  safeLdapAuthDiagnostic,
  Semaphore,
} from "../src/ldap.mjs";
import { RequestGate } from "../src/request-gate.mjs";
import { safeConnectionStatus } from "../src/server.mjs";
import { expandCalendarEvents, parseCalendarEvents } from "../src/ical.mjs";

const TOKEN = "A".repeat(64);
const VALID_ENV = Object.freeze({
  MCP_PATH_TOKEN: TOKEN,
  DOORAY_USERNAME: "uid=directory-user,dc=dbins.dooray.co.kr",
  DOORAY_PASSWORD: "shared-directory-password",
  DOORAY_API_TOKEN: "abcdefghijklmnop",
});
const ORIGINAL_ENV = { ...process.env };
const VERCEL_CONFIG = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

function useEnv(values = VALID_ENV) {
  for (const key of SECRET_ENV_KEYS) delete process.env[key];
  delete process.env[LEGACY_PATH_TOKEN_ENV_KEY];
  delete process.env.MCP_ACCESS_KEY;
  delete process.env.MCP_ALLOWED_ORIGINS;
  Object.assign(process.env, values);
}

function start(handler) {
  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function startMcp() {
  return start((req, res) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const directApiGate = VERCEL_CONFIG.routes.find((route) => route.src === "^/api/mcp$");
    if (new RegExp(directApiGate.src).test(requestUrl.pathname)) {
      res.statusCode = directApiGate.status;
      return res.end();
    }

    const mcpRoute = VERCEL_CONFIG.routes.find((route) => route.dest?.startsWith("/api/mcp?"));
    const routeMatch = requestUrl.pathname.match(new RegExp(mcpRoute.src));
    if (!routeMatch) {
      res.statusCode = 404;
      return res.end();
    }

    const rewrittenUrl = new URL(mcpRoute.dest.replace("$path_token", routeMatch.groups.path_token), "http://localhost");
    for (const [key, value] of requestUrl.searchParams) rewrittenUrl.searchParams.append(key, value);
    // Match Vercel's production request shape: the public URL can remain in
    // req.url while route destination parameters are supplied via req.query.
    req.query = {};
    for (const [key, value] of rewrittenUrl.searchParams) {
      if (req.query[key] === undefined) req.query[key] = value;
      else req.query[key] = Array.isArray(req.query[key]) ? [...req.query[key], value] : [req.query[key], value];
    }
    return mcpHandler(req, res);
  });
}

test.after(() => {
  process.env = ORIGINAL_ENV;
});

test("fixed service configuration cannot be overridden by environment", () => {
  const config = loadConfig({
    ...VALID_ENV,
    CALDAV_SERVER_URL: "https://attacker.invalid",
    LDAP_URL: "ldap://attacker.invalid",
    LDAP_BASE_DN: "dc=attacker",
  });
  assert.equal(config.caldavServerUrl, "https://caldav.dooray.co.kr");
  assert.equal(config.ldapUrl, "ldaps://ldap.dooray.co.kr:636");
  assert.equal(config.ldapBaseDn, "dc=dbins.dooray.co.kr");
  assert.equal(config.timezone, "Asia/Seoul");
  assert.equal(config.ldapTlsRejectUnauthorized, true);
  assert.equal(config.secrets.caldavUsername, config.secrets.ldapBindDn);
  assert.equal(config.secrets.caldavPassword, config.secrets.ldapPassword);
  assert.equal(config.secrets.doorayApiToken, "abcdefghijklmnop");
  assert.deepEqual(SECRET_ENV_KEYS, ["MCP_PATH_TOKEN", "DOORAY_USERNAME", "DOORAY_PASSWORD", "DOORAY_API_TOKEN"]);
});

test("upstream timeout budgets remain below the Vercel function limit", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const functionLimitMs = vercel.functions["api/mcp.mjs"].maxDuration * 1_000;
  const usableBudgetMs = functionLimitMs - FIXED_CONFIG.upstreamSafetyMarginMs;
  const calDavWorstCaseMs = 4 * FIXED_CONFIG.requestTimeoutMs;
  const ldapGroupWorstCaseMs = FIXED_CONFIG.ldapConnectTimeoutMs
    + (3 + Math.ceil(20 / FIXED_CONFIG.ldapGroupLookupConcurrency)) * FIXED_CONFIG.ldapTimeoutMs;
  assert.equal(FIXED_CONFIG.functionMaxDurationMs, functionLimitMs);
  assert.ok(calDavWorstCaseMs <= usableBudgetMs);
  assert.ok(ldapGroupWorstCaseMs <= usableBudgetMs);
});

test("missing or malformed secret configuration fails readiness", () => {
  assert.throws(() => loadConfig({}), ConfigurationError);
  assert.throws(() => loadConfig({ ...VALID_ENV, MCP_PATH_TOKEN: "short" }), ConfigurationError);
});

test("legacy MCP_ACCESS_TOKEN is a validated fallback and never overrides MCP_PATH_TOKEN", () => {
  const { MCP_PATH_TOKEN: _omitted, ...credentials } = VALID_ENV;
  const legacyConfig = loadConfig({ ...credentials, MCP_ACCESS_TOKEN: TOKEN });
  assert.equal(legacyConfig.secrets.pathToken, TOKEN);
  assert.throws(() => loadConfig({ ...credentials, MCP_ACCESS_TOKEN: "short" }), ConfigurationError);

  const preferredToken = "B".repeat(64);
  const preferredConfig = loadConfig({
    ...credentials,
    MCP_PATH_TOKEN: preferredToken,
    MCP_ACCESS_TOKEN: TOKEN,
  });
  assert.equal(preferredConfig.secrets.pathToken, preferredToken);
  assert.throws(() => loadConfig({
    ...credentials,
    MCP_PATH_TOKEN: "short",
    MCP_ACCESS_TOKEN: TOKEN,
  }), ConfigurationError);
  assert.equal(loadPathToken({ MCP_ACCESS_TOKEN: TOKEN }), TOKEN);
});

test("path token enforces exact URL-safe shape and constant-time digest comparison", () => {
  assert.match(TOKEN, PATH_TOKEN_PATTERN);
  assert.equal(isValidPathToken(TOKEN, TOKEN), true);
  assert.equal(isValidPathToken(`${TOKEN.slice(0, 63)}!`, TOKEN), false);
  assert.equal(isValidPathToken("A".repeat(63), TOKEN), false);
  assert.equal(isValidPathToken("B".repeat(64), TOKEN), false);
  assert.equal(readPathToken({ url: `/api/mcp?__mcp_path_token=${TOKEN}`, query: { __mcp_path_token: TOKEN } }), TOKEN);
  assert.equal(readPathToken({ url: "/api/mcp", query: { __mcp_path_token: TOKEN } }), TOKEN);
  assert.equal(readPathToken({ url: `/${TOKEN}/mcp`, query: { __mcp_path_token: TOKEN } }), TOKEN);
  assert.equal(readPathToken({ url: `/${TOKEN}/mcp` }), "");
  assert.equal(readPathToken({ url: `/${TOKEN}/mcp`, query: { __mcp_path_token: "B".repeat(64) } }), "");
  assert.equal(readPathToken({ url: `/${TOKEN}/mcp`, query: { __mcp_path_token: [TOKEN, TOKEN] } }), "");
  assert.equal(readPathToken({ url: `/api/mcp?path_token=${TOKEN}` }), "");
  assert.equal(readPathToken({ url: `/api/mcp?__mcp_path_token=${TOKEN}&__mcp_path_token=${TOKEN}` }), "");
  assert.equal(readPathToken({ url: `/api/mcp?__mcp_path_token=${TOKEN}`, query: { __mcp_path_token: "B".repeat(64) } }), "");
});

test("Vercel publishes only a token-prefixed route ending in /mcp", async () => {
  const vercel = VERCEL_CONFIG;
  assert.equal("rewrites" in vercel, false);
  assert.equal("headers" in vercel, false);
  assert.deepEqual(vercel.routes.find((route) => route.src === "^/api/mcp$"), {
    src: "^/api/mcp$",
    status: 404,
  });
  assert.deepEqual(vercel.routes.find((route) => route.dest?.startsWith("/api/mcp?")), {
    src: "^/(?<path_token>[A-Za-z0-9_-]{64})/mcp$",
    dest: "/api/mcp?__mcp_path_token=$path_token",
  });
  assert.equal(vercel.routes.some((route) => route.src === "^/api/health$" && route.dest === "/api/health"), true);
  assert.equal(vercel.routes.some((route) => route.src === "^/$" && route.dest === "/index.html"), true);
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const artifact of ["mcp-" + "handler", "j" + "ose", "openid-" + "client"]) {
    assert.equal(artifact in dependencies, false);
  }
});

test("Vercel rewrite shape passes the named path parameter to the internal MCP function", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    const response = await fetch(`${baseUrl}/${TOKEN}/mcp`, { method: "OPTIONS" });
    assert.equal(response.status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CalDAV URL boundary, bounded streaming, XML entity defense, and LDAP escaping are strict", async () => {
  const config = { ...FIXED_CONFIG };
  assert.equal(toCalDavUrl("/users/me/calendar/", config).origin, "https://caldav.dooray.co.kr");
  assert.throws(() => toCalDavUrl("https://attacker.invalid/calendar", config));
  assert.throws(() => parseDavXml("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>"));
  assert.equal(await readResponseTextBounded(new Response("hello"), 5), "hello");
  let cancelled = false;
  const oversizedResponse = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("abc"));
      controller.enqueue(new TextEncoder().encode("def"));
    },
    cancel() {
      cancelled = true;
    },
  }));
  await assert.rejects(() => readResponseTextBounded(oversizedResponse, 5), { code: "CALDAV_RESPONSE_TOO_LARGE" });
  assert.equal(cancelled, true);
  assert.equal(escapeLdapFilterValue("a*(b)\\\u0000"), "a\\2a\\28b\\29\\5c\\00");
  assert.equal(isWithinBaseDn("uid=user,ou=people,DC=dbins.dooray.co.kr", FIXED_CONFIG.ldapBaseDn), true);
  assert.equal(isWithinBaseDn("dc=dbins.dooray.co.kr", FIXED_CONFIG.ldapBaseDn), true);
  assert.equal(isWithinBaseDn("uid=user,dc=dbins.dooray.co.kr.evil", FIXED_CONFIG.ldapBaseDn), false);
  assert.equal(isWithinBaseDn("cn=escaped\\,dc=dbins.dooray.co.kr", FIXED_CONFIG.ldapBaseDn), false);
  assert.equal(isWithinBaseDn("uid=user,dc=other", FIXED_CONFIG.ldapBaseDn), false);
  assert.deepEqual(PERSON_ATTRIBUTES, ["cn", "displayName", "givenName", "sn", "uid", "mail", "title", "department", "telephoneNumber"]);
});

test("CalDAV discovery and health use the canonical /caldav/ entry point and refuse automatic redirects", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const xmlResponses = [
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/caldav/principals/test/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-home-set><d:href>/caldav/calendars/test/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" />`,
  ];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === "OPTIONS") return new Response("", { status: 200 });
    return new Response(xmlResponses.shift(), { status: 207, headers: { "content-type": "application/xml" } });
  };
  try {
    const config = {
      ...FIXED_CONFIG,
      secrets: { caldavUsername: "calendar-user", caldavPassword: "calendar-password" },
    };
    assert.deepEqual(await listCalendars(config), []);
    await checkCalDav(config);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(CALDAV_ENTRY_PATH, "/caldav/");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, "https://caldav.dooray.co.kr/caldav/");
  assert.equal(calls[0].options.method, "PROPFIND");
  assert.equal(calls[1].url, "https://caldav.dooray.co.kr/caldav/principals/test/");
  assert.equal(calls[2].url, "https://caldav.dooray.co.kr/caldav/calendars/test/");
  assert.equal(calls[3].url, "https://caldav.dooray.co.kr/caldav/");
  assert.equal(calls[3].options.method, "OPTIONS");
  assert.equal(calls.every(({ options }) => options.redirect === "error"), true);
});

test("CalDAV XML entities are decoded before calendar-data is parsed as iCalendar", async () => {
  const originalFetch = globalThis.fetch;
  const calendarData = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:event-1",
    "SUMMARY:Encoded line breaks",
    "DTSTART:20260804T090000Z",
    "DTEND:20260804T100000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("&#13;&#10;");
  const xmlResponses = [
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/caldav/principals/test/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-home-set><d:href>/caldav/calendars/test/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/caldav/calendars/test/</d:href><d:propstat><d:prop><d:displayname>&#xac1c;&#xc778;&#xc5c5;&#xbb34;</d:displayname><d:resourcetype><c:calendar /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/caldav/calendars/test/event-1.ics</d:href><d:propstat><d:prop><d:getetag>\"etag-1\"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:calendar-data>${calendarData}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
  ];
  globalThis.fetch = async () => new Response(xmlResponses.shift(), {
    status: 207,
    headers: { "content-type": "application/xml" },
  });
  try {
    const config = {
      ...FIXED_CONFIG,
      secrets: { caldavUsername: "calendar-user", caldavPassword: "calendar-password" },
    };
    assert.equal(decodeXmlEntities("&#xac1c;&#xc778;&#xc5c5;&#xbb34;"), "개인업무");
    const parsed = await getEvents(config, {
      calendarHref: "/caldav/calendars/test/",
      start: "2026-08-04T00:00:00+09:00",
      end: "2026-08-05T00:00:00+09:00",
      limit: 10,
    });
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].uid, "event-1");
    assert.equal(parsed.events[0].summary, "Encoded line breaks");
    assert.equal(parseCalendarEvents(decodeXmlEntities(calendarData)).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CalDAV falls back to an unbounded query and calendar-multiget when needed", async () => {
  const originalFetch = globalThis.fetch;
  const calendarData = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:event-fallback",
    "SUMMARY:Fallback event",
    "DTSTART:20260804T090000Z",
    "DTEND:20260804T100000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const xmlResponses = [
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/caldav/principals/test/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-home-set><d:href>/caldav/calendars/test/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/caldav/calendars/test/</d:href><d:propstat><d:prop><d:displayname>Test</d:displayname><d:resourcetype><c:calendar /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" />`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" />`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/caldav/calendars/test/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar xmlns:c="urn:ietf:params:xml:ns:caldav" /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/caldav/calendars/test/event-fallback.ics</d:href><d:propstat><d:prop><d:getetag>\"etag-fallback\"</d:getetag><d:resourcetype /></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/caldav/calendars/test/event-fallback.ics</d:href><d:propstat><d:prop><d:getetag>\"etag-fallback\"</d:getetag><c:calendar-data>${calendarData}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
  ];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(xmlResponses.shift(), { status: 207, headers: { "content-type": "application/xml" } });
  };
  try {
    const parsed = await getEvents({
      ...FIXED_CONFIG,
      secrets: { caldavUsername: "calendar-user", caldavPassword: "calendar-password" },
    }, {
      calendarHref: "/caldav/calendars/test/",
      start: "2026-08-04T00:00:00+09:00",
      end: "2026-08-05T00:00:00+09:00",
      limit: 10,
    });
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].uid, "event-fallback");
    assert.equal(calls[3].options.method, "REPORT");
    assert.match(calls[3].options.body, /calendar-data content-type="text\/calendar" version="2\.0"/);
    assert.match(calls[3].options.body, /expand start="20260803T150000Z" end="20260804T150000Z"/);
    assert.equal(calls[4].options.method, "REPORT");
    assert.equal(calls[5].options.method, "PROPFIND");
    assert.equal(calls[6].options.method, "REPORT");
    assert.match(calls[6].options.body, /calendar-multiget/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CalDAV reuses event hrefs returned without calendar-data", async () => {
  const originalFetch = globalThis.fetch;
  const calendarData = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:event-href",
    "SUMMARY:Href event",
    "DTSTART:20260804T090000Z",
    "DTEND:20260804T100000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const xmlResponses = [
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/caldav/principals/test/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-home-set><d:href>/caldav/calendars/test/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/caldav/calendars/test/</d:href><d:propstat><d:prop><d:displayname>Test</d:displayname><d:resourcetype><c:calendar /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/caldav/calendars/test/event-href.ics</d:href><d:propstat><d:prop><d:getetag>\"etag-href\"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/caldav/calendars/test/event-href.ics</d:href><d:propstat><d:prop><d:getetag>\"etag-href\"</d:getetag><c:calendar-data>${calendarData}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
  ];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(xmlResponses.shift(), { status: 207, headers: { "content-type": "application/xml" } });
  };
  try {
    const parsed = await getEvents({
      ...FIXED_CONFIG,
      secrets: { caldavUsername: "calendar-user", caldavPassword: "calendar-password" },
    }, {
      calendarHref: "/caldav/calendars/test/",
      start: "2026-08-04T00:00:00+09:00",
      end: "2026-08-05T00:00:00+09:00",
      limit: 10,
    });
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].uid, "event-href");
    assert.equal(calls[3].options.method, "REPORT");
    assert.equal(calls[4].options.method, "REPORT");
    assert.match(calls[4].options.body, /event-href\.ics/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recurring iCalendar events expand into occurrences inside the requested range", () => {
  const parsed = parseCalendarEvents([
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly",
    "SUMMARY:Weekly meeting",
    "DTSTART;TZID=Asia/Seoul:20260320T090000",
    "DTEND;TZID=Asia/Seoul:20260320T100000",
    "RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261225T145959Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"));
  const expanded = expandCalendarEvents(
    parsed,
    new Date("2026-08-02T15:00:00.000Z"),
    new Date("2026-08-09T15:00:00.000Z"),
  );
  assert.deepEqual(expanded.map((event) => event.start.value), ["2026-08-07T09:00:00+09:00"]);
  assert.equal(expanded[0].recurrenceRule, "");
  assert.deepEqual(
    expandCalendarEvents(
      parsed,
      new Date("2026-12-27T15:00:00.000Z"),
      new Date("2027-01-03T15:00:00.000Z"),
    ),
    [],
  );
});

test("monthly all-day recurrences expand by month day and ordinal weekday", () => {
  const parsed = parseCalendarEvents([
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:month-day",
    "DTSTART;VALUE=DATE:20260109",
    "DTEND;VALUE=DATE:20260110",
    "RRULE:FREQ=MONTHLY;BYMONTHDAY=9;UNTIL=20261231",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:last-friday",
    "DTSTART;VALUE=DATE:20260130",
    "DTEND;VALUE=DATE:20260131",
    "RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"));
  const expanded = expandCalendarEvents(
    parsed,
    new Date("2026-08-01T00:00:00.000Z"),
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.deepEqual(expanded.map((event) => [event.uid, event.start.value]), [
    ["month-day", "2026-08-09"],
    ["last-friday", "2026-08-28"],
  ]);
});

test("LDAP and service status expose only allowlisted safe connection errors", () => {
  assert.equal(classifyLdapError({ name: "InvalidCredentialsError", message: "secret" }).code, "LDAP_AUTH_FAILED");
  assert.equal(
    classifyLdapError({ name: "InvalidCredentialsError", message: "LDAP error: data 532, diagnostic includes secret" }).safeMessage,
    "The directory service rejected the configured credentials. Server diagnostic: the password has expired.",
  );
  assert.equal(safeLdapAuthDiagnostic({ message: "data 775" }), "the account is locked");
  assert.equal(safeLdapAuthDiagnostic({ message: "data 999" }), "");
  assert.equal(classifyLdapError({ name: "InvalidDNSyntaxError", resultCode: 34 }).code, "LDAP_BIND_DN_INVALID");
  assert.equal(classifyLdapError({ code: "ETIMEDOUT", message: "host secret" }).code, "LDAP_TIMEOUT");
  assert.equal(classifyLdapError({ code: "ERR_TLS_CERT_ALTNAME_INVALID", stack: "secret" }).code, "LDAP_TLS_FAILED");
  assert.equal(classifyLdapError({ code: "ENOTFOUND", cause: { hostname: "secret" } }).code, "LDAP_UNAVAILABLE");
  assert.equal(classifyLdapError({ message: "bind DN and password" }).code, "LDAP_REQUEST_FAILED");

  const status = safeConnectionStatus({
    status: "rejected",
    reason: new AppError("LDAP_UNAVAILABLE", "The directory service is unavailable."),
  });
  assert.deepEqual(status, {
    ok: false,
    error: { code: "LDAP_UNAVAILABLE", message: "The directory service is unavailable." },
  });
  assert.equal(JSON.stringify(status).includes("secret"), false);
});

test("bounded LDAP concurrency preserves order and MCP output rejects oversized data", async () => {
  let active = 0;
  let peak = 0;
  const mapped = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return `person-${value}`;
  });
  assert.equal(peak, 2);
  assert.deepEqual(mapped, ["person-0", "person-1", "person-2", "person-3", "person-4"]);

  active = 0;
  peak = 0;
  const semaphore = new Semaphore(2);
  await Promise.all([0, 1, 2, 3, 4].map(() => semaphore.withPermit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  })));
  assert.equal(peak, 2);
  assert.equal(LDAP_UPSTREAM_MAX_CONCURRENT_SEARCHES, 8);

  const response = toolSuccess({ people: [{ cn: "홍길동" }] }, "Found one person.");
  assert.equal(response.content[0].text, "Found one person.");
  assert.equal(response.content[0].text.includes("홍길동"), false);
  assert.throws(() => toolSuccess({ value: "x".repeat(MAX_STRUCTURED_DATA_BYTES) }, "oversized"), {
    code: "RESULT_TOO_LARGE",
  });
});

test("health readiness discloses no secret values", async () => {
  useEnv();
  const { server, baseUrl } = await start(healthHandler);
  try {
    const response = await fetch(baseUrl);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    for (const secret of Object.values(VALID_ENV)) assert.equal(text.includes(secret), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("invalid token including OPTIONS receives generic no-store 404", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    const response = await fetch(`${baseUrl}/${"B".repeat(64)}/mcp`, { method: "OPTIONS" });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "not_found" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("legacy MCP_ACCESS_TOKEN authenticates the canonical public route", async () => {
  const { MCP_PATH_TOKEN: _omitted, ...credentials } = VALID_ENV;
  useEnv({ ...credentials, MCP_ACCESS_TOKEN: TOKEN });
  const { server, baseUrl } = await startMcp();
  try {
    const response = await fetch(`${baseUrl}/${TOKEN}/mcp`, { method: "OPTIONS" });
    assert.equal(response.status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("valid OPTIONS is compatible with ChatGPT MCP preflight", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    const response = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://chatgpt.com" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://chatgpt.com");
    assert.equal(response.headers.get("vary"), "Origin");
    assert.match(response.headers.get("access-control-allow-methods"), /POST/);
    assert.match(response.headers.get("access-control-allow-methods"), /DELETE/);
    assert.match(response.headers.get("access-control-allow-headers"), /mcp-protocol-version/);
    assert.equal(response.headers.get("access-control-expose-headers"), "Mcp-Session-Id");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP preflight allows authentication and MCP identification headers only for trusted origins", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    const allowed = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://chatgpt.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Authorization, X-MCP-Access-Key, Mcp-Protocol-Version, Mcp-Method, Mcp-Name",
      },
    });
    assert.equal(allowed.status, 204);
    const allowedHeaders = allowed.headers.get("access-control-allow-headers").toLowerCase().split(",").map((value) => value.trim());
    for (const header of ["authorization", "x-mcp-access-key", "mcp-protocol-version", "mcp-method", "mcp-name"]) {
      assert.equal(allowedHeaders.includes(header), true, header);
    }

    const rejected = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.invalid",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Authorization, X-MCP-Access-Key, Mcp-Protocol-Version, Mcp-Method, Mcp-Name",
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stateless Streamable HTTP negotiates initialize, notification, and all twenty-one annotated tools", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  const endpoint = `${baseUrl}/${TOKEN}/mcp`;
  const post = (body) => fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  try {
    const initialize = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration-test", version: "1" } },
    });
    assert.equal(initialize.status, 200);
    const initBody = await initialize.json();
    assert.equal(initBody.result.serverInfo.name, "dooray-dbins-mcp");
    assert.equal(initBody.result.serverInfo.version, "1.0.0");

    const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.ok([200, 202, 204].includes(initialized.status));

    const toolsResponse = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(toolsResponse.status, 200);
    const toolsBody = await toolsResponse.json();
    assert.deepEqual(toolsBody.result.tools.map((tool) => tool.name), [
      "service_status",
      "calendar_list_calendars",
      "calendar_get_events",
      "calendar_search_events",
      "carddav_list_address_books",
      "carddav_search_contacts",
      "carddav_get_contact",
      "directory_search_people",
      "directory_get_person",
      "directory_get_group_members",
      "dooray_check_connection",
      "dooray_whoami",
      "dooray_common",
      "dooray_projects",
      "dooray_tasks",
      "dooray_messenger",
      "dooray_calendar",
      "dooray_wiki",
      "dooray_drive",
      "dooray_api_get",
      "dooray_capabilities",
    ]);
    for (const tool of toolsBody.result.tools) {
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      assert.equal(tool.inputSchema.type, "object");
      if (tool.outputSchema) assert.equal(tool.outputSchema.type, "object");
    }
    const groupTool = toolsBody.result.tools.find((tool) => tool.name === "directory_get_group_members");
    assert.equal(groupTool.inputSchema.properties.limit.maximum, 20);

    const statusResponse = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "service_status", arguments: {} },
    });
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.result.structuredContent.ok, true);
    assert.equal(statusBody.result.structuredContent.data.connectionsTested, false);
    assert.equal("connections" in statusBody.result.structuredContent.data, false);

    const malformed = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{",
    });
    assert.ok([400, 500].includes(malformed.status));

    const get = await fetch(endpoint, { headers: { accept: "application/json, text/event-stream" } });
    assert.equal(get.status, 405);
    const deletion = await fetch(endpoint, { method: "DELETE", headers: { accept: "application/json, text/event-stream" } });
    assert.equal(deletion.status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("oversized declared POST body is rejected before MCP parsing", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    const response = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(65_537),
    });
    assert.equal(response.status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("direct API, query-token, old, and trailing-slash routes cannot authenticate", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    for (const path of [
      `/api/mcp?path_token=${TOKEN}`,
      `/api/mcp?__mcp_path_token=${TOKEN}`,
      `/?path_token=${TOKEN}`,
      "/api/mcp",
      "/mcp",
      `/mcp/${TOKEN}`,
      `/${TOKEN}/mcp/`,
      `/connect/${TOKEN}`,
      "/.well-known/oauth-authorization-server",
      "/authorize",
      "/oauth/token",
      "/register",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { method: "OPTIONS" });
      assert.equal(response.status, 404, path);
    }

    const injected = await fetch(`${baseUrl}/${TOKEN}/mcp?__mcp_path_token=${TOKEN}`, { method: "OPTIONS" });
    assert.equal(injected.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("wrong token stays 404 before oversized-body checks", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    const response = await fetch(`${baseUrl}/${"B".repeat(64)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(65_537),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("wrong token stays 404 when upstream credentials are not configured", async () => {
  useEnv({ MCP_PATH_TOKEN: TOKEN });
  const { server, baseUrl } = await startMcp();
  try {
    const wrongToken = await fetch(`${baseUrl}/${"B".repeat(64)}/mcp`, { method: "OPTIONS" });
    assert.equal(wrongToken.status, 404);
    assert.deepEqual(await wrongToken.json(), { error: "not_found" });

    const validToken = await fetch(`${baseUrl}/${TOKEN}/mcp`, { method: "OPTIONS" });
    assert.equal(validToken.status, 503);
    assert.deepEqual(await validToken.json(), { error: "service_unavailable" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("valid token requires application/json for POST", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    const response = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { error: "unsupported_media_type" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CORS omits ACAO without Origin and rejects untrusted origins after authentication", async () => {
  useEnv();
  const { server, baseUrl } = await startMcp();
  try {
    const noOrigin = await fetch(`${baseUrl}/${TOKEN}/mcp`, { method: "OPTIONS" });
    assert.equal(noOrigin.status, 204);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);

    const rejected = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.invalid" },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("request gate enforces rolling client quota and per-instance concurrency", () => {
  let now = 0;
  const gate = new RequestGate({ limit: 2, windowMs: 60_000, maxConcurrent: 1, now: () => now });
  const first = gate.enter("client-a");
  assert.equal(first.ok, true);
  assert.deepEqual(gate.enter("client-b"), { ok: false, retryAfterSeconds: 1 });
  first.release();
  first.release();

  const second = gate.enter("client-a");
  assert.equal(second.ok, true);
  second.release();
  assert.equal(gate.enter("client-a").ok, false);
  now = 60_001;
  const reset = gate.enter("client-a");
  assert.equal(reset.ok, true);
  reset.release();
});

test("request gate prunes expired clients and stays memory bounded", () => {
  let now = 1;
  const gate = new RequestGate({ limit: 1, windowMs: 10, maxConcurrent: 10, maxClients: 2, now: () => now });
  gate.enter("client-a").release();
  gate.enter("client-b").release();
  gate.enter("client-c").release();
  assert.equal(gate.clients.size, 2);
  assert.equal(gate.clients.has("client-a"), false);

  now = 20;
  gate.enter("client-d").release();
  assert.equal(gate.clients.size, 1);
  assert.equal(gate.clients.has("client-d"), true);
});
