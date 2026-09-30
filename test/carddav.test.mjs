import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_CONFIG } from "../src/config.mjs";
import {
  CARDDAV_ORIGINS,
  getContact,
  listAddressBooks,
  searchContacts,
} from "../src/carddav.mjs";
import { parseVCard, projectContact } from "../src/vcard.mjs";
import { requestDav, toSameOriginUrl } from "../src/dav.mjs";

const config = {
  ...FIXED_CONFIG,
  secrets: {
    caldavUsername: "shared-user",
    caldavPassword: "shared-password",
  },
};

const originalFetch = globalThis.fetch;

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function discoveryResponse(path) {
  if (path === "/.well-known/carddav") {
    return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>${path}</d:href><d:propstat><d:prop>
    <d:current-user-principal><d:href>/principals/shared/</d:href></d:current-user-principal>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
  }
  if (path === "/principals/shared/") {
    return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>${path}</d:href><d:propstat><d:prop>
    <c:addressbook-home-set><d:href>/addressbooks/shared/</d:href></c:addressbook-home-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
  }
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/addressbooks/shared/</d:href><d:propstat><d:prop>
    <d:displayname>Shared contacts</d:displayname>
    <d:resourcetype><d:collection/><c:addressbook/></d:resourcetype>
    <c:supported-address-data><c:address-data content-type="text/vcard" version="3.0"/></c:supported-address-data>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
}

const vcard = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "UID:person-1",
  "FN:홍길동",
  "N:홍;길동;;;",
  "EMAIL;TYPE=work;PREF=1:hong@example.com",
  "TEL;TYPE=cell:010-0000-0000",
  "ORG:DB손해보험",
  "TITLE:계리사",
  "NOTE:must-not-be-returned",
  "PHOTO;ENCODING=b:AAAA",
  "END:VCARD",
].join("\r\n");

function contactResponse({ href = "/addressbooks/shared/person-1.vcf", includeData = true } = {}) {
  const data = includeData ? `<d:address-data>${xml(vcard)}</d:address-data>` : "";
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>${href}</d:href><d:propstat><d:prop>
    <d:getetag>"v1"</d:getetag>${data}
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
}

function contactListingResponse() {
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/addressbooks/shared/person-1.vcf</d:href><d:propstat><d:prop>
    <d:getetag>"v1"</d:getetag>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
}

function contactListingResponseMany(count, { book = "/addressbooks/shared/" } = {}) {
  const responses = Array.from({ length: count }, (_, index) => `
  <d:response><d:href>${book}person-${index + 1}.vcf</d:href><d:propstat><d:prop>
    <d:getetag>"v${index + 1}"</d:getetag>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`;
}

function personVcard(index, { target = false, largePhoto = false } = {}) {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:person-${index}`,
    `FN:${target ? "홍길동" : `테스트${index}`}`,
    `N:${target ? "홍;길동;;;" : `테스트${index};;;;`}`,
    ...(largePhoto ? [`PHOTO;ENCODING=b:${"A".repeat(600 * 1024)}`] : []),
    `EMAIL;TYPE=work:${target ? "hong@example.com" : `person${index}@example.com`}`,
    "TEL;TYPE=cell:010-0000-0000",
    "ORG:DB손해보험",
    "END:VCARD",
  ].join("\r\n");
}

function installFetch({ organizationUnauthorized = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({
      origin: parsed.origin,
      path: parsed.pathname,
      method: options.method,
      body: String(options.body || ""),
      authorization: options.headers?.Authorization || "",
    });
    if (organizationUnauthorized && parsed.origin === CARDDAV_ORIGINS.organization) {
      return new Response("", { status: 401, headers: { "www-authenticate": "Basic realm=\"test\"" } });
    }
    if (options.method === "OPTIONS") return new Response("", { status: 200, headers: { DAV: "1, addressbook" } });
    if (options.method === "PROPFIND") return new Response(discoveryResponse(parsed.pathname), { status: 207 });
    if (options.method === "REPORT") return new Response(contactResponse(), { status: 207 });
    throw new Error("unexpected method " + options.method);
  };
  return calls;
}

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("vCard parser handles folding, escaping, repeated contact fields, and excludes sensitive properties", () => {
  const folded = vcard.replace("FN:홍길동", "FN:홍길\r\n 동").replace("ORG:DB손해보험", "ORG:DB손해\\,보험");
  const parsed = parseVCard(folded);
  const projected = projectContact(parsed, {
    source: "personal",
    addressBookHref: "/addressbooks/shared/",
    href: "/addressbooks/shared/person-1.vcf",
  });
  assert.equal(projected.uid, "person-1");
  assert.equal(projected.formattedName, "홍길동");
  assert.equal(projected.organization, "DB손해,보험");
  assert.equal(projected.emails[0].value, "hong@example.com");
  assert.equal(projected.phones[0].types[0], "cell");
  assert.equal("note" in projected, false);
  assert.equal("photo" in projected, false);
  assert.throws(() => parseVCard("BEGIN:VCARD\r\nFN:incomplete"), { code: "CARDDAV_INVALID_VCARD" });
});

test("DAV request enforces HTTPS same-origin and sends only the read method requested", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response("", { status: 200 });
  };
  await requestDav({
    baseUrl: CARDDAV_ORIGINS.personal,
    username: "shared-user",
    password: "shared-password",
  }, "/.well-known/carddav", { method: "PROPFIND", body: "<d:propfind/>" });
  assert.equal(calls[0].options.method, "PROPFIND");
  assert.equal(calls[0].options.redirect, "error");
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
  await assert.rejects(
    () => requestDav({
      baseUrl: CARDDAV_ORIGINS.personal,
      username: "shared-user",
      password: "shared-password",
      errorPrefix: "CARDDAV",
      serviceName: "CardDAV",
    }, "/.well-known/carddav", { method: "PUT" }),
    { code: "CARDDAV_METHOD_NOT_ALLOWED" },
  );
  assert.throws(
    () => toSameOriginUrl("https://attacker.invalid/carddav", CARDDAV_ORIGINS.personal),
    { code: "INVALID_DAV_PATH" },
  );
  assert.throws(
    () => toSameOriginUrl("http://carddav.dooray.co.kr/carddav", CARDDAV_ORIGINS.personal),
    { code: "INVALID_DAV_PATH" },
  );
  globalThis.fetch = originalFetch;
});

test("personal discovery and search use bounded read-only CardDAV requests", async () => {
  const calls = installFetch();
  const listed = await listAddressBooks(config, { source: "personal" });
  assert.equal(listed.sources[0].status, "ok");
  assert.equal(listed.sources[0].addressBooks[0].href, "/addressbooks/shared/");
  assert.equal(listed.sources[0].addressBooks[0].supportedAddressData[0], "text/vcard;version=3.0");
  const searched = await searchContacts(config, { source: "personal", query: "홍", limit: 5 });
  assert.equal(searched.contacts.length, 1);
  assert.equal(searched.contacts[0].formattedName, "홍길동");
  assert.equal(searched.contacts[0].source, "personal");
  assert.equal(searched.contacts[0].emails[0].value, "hong@example.com");
  assert.equal(calls.every((call) => ["OPTIONS", "PROPFIND", "REPORT"].includes(call.method)), true);
  assert.equal(calls.every((call) => call.origin === CARDDAV_ORIGINS.personal), true);
  assert.equal(calls.every((call) => call.authorization.startsWith("Basic ")), true);
  assert.equal(calls.some((call) => call.method === "REPORT" && call.body.includes("addressbook-query")), true);
});

test("all-source discovery isolates one source failure without leaking credentials", async () => {
  const calls = installFetch({ organizationUnauthorized: true });
  const listed = await listAddressBooks(config, { source: "all" });
  const bySource = Object.fromEntries(listed.sources.map((item) => [item.source, item]));
  assert.equal(bySource.personal.status, "ok");
  assert.equal(bySource.organization.status, "error");
  assert.equal(bySource.organization.error.code, "CARDDAV_AUTH_FAILED");
  assert.equal(JSON.stringify(listed).includes("shared-password"), false);
  assert.equal(calls.some((call) => call.origin === CARDDAV_ORIGINS.organization), true);
});

test("contact lookup validates discovered href and returns bounded projection", async () => {
  installFetch();
  const contact = await getContact(config, {
    source: "personal",
    href: "/addressbooks/shared/person-1.vcf",
    addressBookHref: "/addressbooks/shared/",
  });
  assert.equal(contact.uid, "person-1");
  assert.equal(contact.formattedName, "홍길동");
  assert.equal("note" in contact, false);
  assert.throws(
    () => toSameOriginUrl("https://carddav-members.dooray.co.kr/addressbooks/shared/person-1.vcf", CARDDAV_ORIGINS.personal),
    { code: "INVALID_DAV_PATH" },
  );
});

test("organization search scans beyond the first 100 resources without relying on an in-memory index", async () => {
  const calls = [];
  const resourceCount = 150;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = String(options.body || "");
    calls.push({ origin: parsed.origin, path: parsed.pathname, method: options.method, body });
    if (options.method === "OPTIONS") return new Response("", { status: 200, headers: { DAV: "1, addressbook" } });
    if (options.method === "PROPFIND") {
      if (parsed.pathname === "/addressbooks/shared/" && body.includes("<d:getetag />") && !body.includes("resourcetype")) {
        return new Response(contactListingResponseMany(resourceCount), { status: 207 });
      }
      return new Response(discoveryResponse(parsed.pathname), { status: 207 });
    }
    if (options.method === "REPORT") return new Response("UNKNOWN_REQUEST", { status: 400 });
    if (options.method === "GET" && /^\/addressbooks\/shared\/person-\d+\.vcf$/.test(parsed.pathname)) {
      const index = Number(parsed.pathname.match(/person-(\d+)\.vcf$/)[1]);
      return new Response(personVcard(index, { target: index === resourceCount }), {
        status: 200,
        headers: { "content-type": "text/vcard; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request ${options.method} ${parsed.pathname}`);
  };

  const searched = await searchContacts(config, {
    source: "organization",
    query: "홍",
    addressBookHref: "/addressbooks/shared/",
    limit: 5,
  });
  assert.equal(searched.contacts.length, 1);
  assert.equal(searched.contacts[0].formattedName, "홍길동");
  assert.equal(searched.contacts[0].source, "organization");
  assert.equal(searched.contacts[0].emails[0].value, "hong@example.com");
  assert.equal(searched.organizationIndex.complete, true);
  assert.equal(searched.organizationIndex.totalResources, resourceCount);
  assert.equal(searched.organizationIndex.indexedResources, resourceCount);
  assert.equal(calls.filter((call) => call.method === "GET").length, resourceCount);

  const getCount = calls.filter((call) => call.method === "GET").length;
  const searchedAgain = await searchContacts(config, {
    source: "organization",
    query: "홍",
    addressBookHref: "/addressbooks/shared/",
    limit: 5,
  });
  assert.equal(searchedAgain.contacts[0].formattedName, "홍길동");
  assert.equal(searchedAgain.organizationIndex.cacheHit, false);
  assert.equal(calls.filter((call) => call.method === "GET").length, getCount + resourceCount);

  const contact = await getContact(config, {
    source: "organization",
    href: `/addressbooks/shared/person-${resourceCount}.vcf`,
    addressBookHref: "/addressbooks/shared/",
  });
  assert.equal(contact.formattedName, "홍길동");
  assert.equal("note" in contact, false);
  assert.equal("photo" in contact, false);
  globalThis.fetch = originalFetch;
});

test("organization index strips oversized disallowed vCard properties before parsing", async () => {
  const book = "/addressbooks/large/";
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = String(options.body || "");
    if (options.method === "OPTIONS") return new Response("", { status: 200, headers: { DAV: "1, addressbook" } });
    if (options.method === "PROPFIND") {
      if (parsed.pathname === book && body.includes("<d:getetag />") && !body.includes("resourcetype")) {
        return new Response(contactListingResponseMany(1, { book }), { status: 207 });
      }
      if (parsed.pathname === "/.well-known/carddav") {
        return new Response(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/.well-known/carddav</d:href><d:propstat><d:prop>
    <d:current-user-principal><d:href>/principals/shared/</d:href></d:current-user-principal>
  </d:prop><d:status>HTTP/1.1 200 OK</d:propstat></d:response>
</d:multistatus>`, { status: 207 });
      }
      if (parsed.pathname === "/principals/shared/") {
        return new Response(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/principals/shared/</d:href><d:propstat><d:prop>
    <c:addressbook-home-set><d:href>/addressbooks/</d:href></c:addressbook-home-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:propstat></d:response>
</d:multistatus>`, { status: 207 });
      }
      if (parsed.pathname === "/addressbooks/") {
        return new Response(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>${book}</d:href><d:propstat><d:prop>
    <d:displayname>Large contacts</d:displayname>
    <d:resourcetype><d:collection/><c:addressbook/></d:resourcetype>
  </d:prop><d:status>HTTP/1.1 200 OK</d:propstat></d:response>
</d:multistatus>`, { status: 207 });
      }
    }
    if (options.method === "REPORT") return new Response("UNKNOWN_REQUEST", { status: 400 });
    if (options.method === "GET" && parsed.pathname === `${book}person-1.vcf`) {
      return new Response(personVcard(1, { target: true, largePhoto: true }), {
        status: 200,
        headers: { "content-type": "text/vcard; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request ${options.method} ${parsed.pathname}`);
  };

  const searched = await searchContacts(config, {
    source: "organization",
    query: "홍",
    addressBookHref: book,
    limit: 5,
  });
  assert.equal(searched.contacts.length, 1);
  assert.equal(searched.contacts[0].formattedName, "홍길동");
  assert.equal(searched.organizationIndex.complete, true);
  globalThis.fetch = originalFetch;
});

test("large CardDAV responses require an explicit metadata opt-in", async () => {
  const largeBody = "x".repeat(600 * 1024);
  globalThis.fetch = async () => new Response(largeBody, { status: 200 });
  await assert.rejects(
    () => requestDav({
      baseUrl: CARDDAV_ORIGINS.organization,
      username: "shared-user",
      password: "shared-password",
      responseLimit: 5 * 1024 * 1024,
      errorPrefix: "CARDDAV",
      serviceName: "CardDAV",
    }, "/", { method: "GET" }),
    { code: "CARDDAV_RESPONSE_TOO_LARGE" },
  );
  const allowed = await requestDav({
    baseUrl: CARDDAV_ORIGINS.organization,
    username: "shared-user",
    password: "shared-password",
    responseLimit: 5 * 1024 * 1024,
    errorPrefix: "CARDDAV",
    serviceName: "CardDAV",
    allowLargeCardDavResponse: true,
  }, "/", { method: "GET" });
  assert.equal(allowed.text.length, largeBody.length);
  globalThis.fetch = originalFetch;
});
