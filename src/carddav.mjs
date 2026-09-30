import { SEARCH_BUDGET_MS, decodeSearchCursor, encodeSearchCursor, scanResourcePage, searchDigest } from "./carddav-search.mjs";
import { AppError, toSafeError } from "./errors.mjs";
import {
  XML_BODY_LIMIT,
  asArray,
  multistatusResponses,
  parseDavXml,
  requestDav,
  responseProperties,
  textValue,
  toSameOriginUrl,
} from "./dav.mjs";
import { VCARD_ALLOWED_PROPERTIES, contactSearchText, parseVCard, projectContact } from "./vcard.mjs";

export const CARDDAV_PERSONAL_ORIGIN = "https://carddav.dooray.co.kr";
export const CARDDAV_ORGANIZATION_ORIGIN = "https://carddav-members.dooray.co.kr";
export const CARDDAV_ORIGINS = Object.freeze({
  personal: CARDDAV_PERSONAL_ORIGIN,
  organization: CARDDAV_ORGANIZATION_ORIGIN,
});

const DISCOVERY_PATHS = Object.freeze([
  { label: "well_known", path: "/.well-known/carddav" },
  { label: "root", path: "/" },
  { label: "legacy_carddav", path: "/carddav/" },
]);
const MULTIGET_BATCH_SIZE = 10;
const GET_FALLBACK_CONCURRENCY = 4;
const ORGANIZATION_INDEX_CONCURRENCY = 48;
const ORGANIZATION_INDEX_TTL_MS = 5 * 60 * 1000;
const ORGANIZATION_INDEX_MAX_RESOURCES = 20_000;
const ORGANIZATION_VCARD_RESPONSE_LIMIT = 5 * 1024 * 1024;
const VCARD_ALLOWED_PROPERTY_SET = new Set(VCARD_ALLOWED_PROPERTIES);
const organizationIndexCache = new Map();
let organizationWarmupPromise = null;
let organizationWarmupError = null;
const ADDRESS_DATA_PROPS = "<d:getetag /><c:address-data content-type=\"text/vcard\" version=\"4.0\"><c:prop name=\"UID\" /><c:prop name=\"FN\" /><c:prop name=\"N\" /><c:prop name=\"EMAIL\" /><c:prop name=\"TEL\" /><c:prop name=\"ORG\" /><c:prop name=\"TITLE\" /></c:address-data>";
const METADATA_ONLY_PROPS = "<d:getetag />";
const FIRST_CONTACT_DATA_PROPS = "<c:address-data content-type=\"text/vcard\" version=\"4.0\"><c:prop name=\"UID\" /><c:prop name=\"FN\" /></c:address-data>";
const FIRST_CONTACT_DATA_PROPS_V3 = "<c:address-data content-type=\"text/vcard\" version=\"3.0\"><c:prop name=\"UID\" /><c:prop name=\"FN\" /></c:address-data>";

function xmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sourceList(source = "all") {
  if (source === "all") return ["personal", "organization"];
  if (source === "personal" || source === "organization") return [source];
  throw new AppError("INVALID_CARDDAV_SOURCE", "Source must be personal, organization, or all.");
}

function sourceCredentials(config, source) {
  const username = String(config.secrets?.caldavUsername || "");
  const password = String(config.secrets?.caldavPassword || "");
  return {
    source,
    baseUrl: CARDDAV_ORIGINS[source],
    username,
    password,
    status: username && password ? "configured" : "unconfigured",
    requestTimeoutMs: config.requestTimeoutMs,
    deadlineMs: config.cardDavDeadlineMs,
    responseLimit: Math.min(Number(config.maxCardDavVCardBytes) || 512 * 1024, 512 * 1024),
  };
}

function ensureConfigured(config, source) {
  const credentials = sourceCredentials(config, source);
  if (!credentials.username || !credentials.password) {
    throw new AppError("CARDDAV_NOT_CONFIGURED", "The shared Dooray credentials are not configured.");
  }
  return credentials;
}

function propfindBody(properties) {
  return `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop>${properties}</d:prop>
</d:propfind>`;
}

async function davRequest(credentials, href, options, requestOptions = {}) {
  const remaining = credentials.deadlineMs === undefined ? Infinity : credentials.deadlineMs - Date.now();
  if (remaining <= 0) throw new AppError("CARDDAV_SEARCH_BUDGET", "The contact search reached its time budget.");
  return requestDav({
    baseUrl: credentials.baseUrl,
    username: credentials.username,
    password: credentials.password,
    requestTimeoutMs: Math.min(credentials.requestTimeoutMs, remaining),
    responseLimit: requestOptions.responseLimit ?? credentials.responseLimit,
    errorPrefix: "CARDDAV",
    serviceName: "CardDAV",
    allowSameOriginRedirects: requestOptions.allowSameOriginRedirects === true,
    allowLargeCardDavResponse: requestOptions.allowLargeCardDavResponse === true,
    contentType: requestOptions.contentType,
  }, href, options);
}

async function propfind(credentials, href, depth, properties, requestOptions = {}) {
  const result = await davRequest(credentials, href, {
    method: "PROPFIND",
    depth,
    body: propfindBody(properties),
  }, requestOptions);
  return parseCardDavXml(result.text);
}

function parseCardDavXml(xml) {
  try {
    return parseDavXml(xml);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("CARDDAV_INVALID_RESPONSE", "The CardDAV service returned invalid XML.");
  }
}

function hrefFromResponse(response, credentials) {
  const rawHref = textValue(response?.href);
  if (!rawHref) return "";
  const url = toSameOriginUrl(rawHref, credentials.baseUrl, "CARDDAV_INVALID_PATH", "The CardDAV href is outside the configured service.");
  return `${url.pathname}${url.search}`;
}

function supportedAddressData(value) {
  const result = [];
  for (const item of asArray(value?.["address-data"] || value)) {
    if (typeof item === "string") {
      result.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const contentType = item["@_content-type"] || item["@_contenttype"] || "text/vcard";
    const version = item["@_version"] || item["@_version"] === "" ? item["@_version"] : "";
    result.push(version ? `${contentType};version=${version}` : String(contentType));
  }
  return [...new Set(result)].slice(0, 8);
}

function isAddressBookResource(resourceType) {
  if (!resourceType || typeof resourceType !== "object") return false;
  return Object.keys(resourceType).some((key) => key.toLowerCase() === "addressbook");
}

function addressBooksFromDocument(document, credentials, limit) {
  return multistatusResponses(document)
    .map((response) => {
      const properties = responseProperties(response);
      if (!isAddressBookResource(properties.resourcetype)) return null;
      const href = hrefFromResponse(response, credentials);
      if (!href) return null;
      return {
        source: credentials.source,
        href,
        displayName: textValue(properties.displayname) || href,
        description: textValue(properties["addressbook-description"]),
        supportedAddressData: supportedAddressData(properties["supported-address-data"]),
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

async function directAddressBookDiscovery(credentials, path, config, requestOptions = {}) {
  const document = await propfind(
    credentials,
    path,
    1,
    "<d:displayname /><d:resourcetype /><c:addressbook-description /><c:supported-address-data />",
    requestOptions,
  );
  const addressBooks = addressBooksFromDocument(document, credentials, config.maxCardDavAddressBooks);
  if (addressBooks.length === 0) throw new AppError("CARDDAV_DISCOVERY_FAILED", "No CardDAV address book was discovered.");
  return { addressBooks, discoveryMode: "direct-addressbook", homeHref: path, principalHref: "" };
}

async function standardDiscovery(credentials, path, config, requestOptions = {}) {
  const principalDoc = await propfind(credentials, path, 0, "<d:current-user-principal />", requestOptions);
  const principalResponse = multistatusResponses(principalDoc)[0];
  const principalHref = textValue(responseProperties(principalResponse)?.["current-user-principal"]?.href);
  if (!principalHref) throw new AppError("CARDDAV_DISCOVERY_FAILED", "The CardDAV principal could not be discovered.");

  const homeDoc = await propfind(credentials, principalHref, 0, "<c:addressbook-home-set />");
  const homeResponse = multistatusResponses(homeDoc)[0];
  const homeHref = textValue(responseProperties(homeResponse)?.["addressbook-home-set"]?.href);
  if (!homeHref) throw new AppError("CARDDAV_DISCOVERY_FAILED", "The CardDAV address book home could not be discovered.");
  const homeUrl = toSameOriginUrl(homeHref, credentials.baseUrl, "CARDDAV_INVALID_PATH", "The CardDAV home is outside the configured service.");
  const homePath = `${homeUrl.pathname}${homeUrl.search}`;
  const collectionDoc = await propfind(
    credentials,
    homePath,
    1,
    "<d:displayname /><d:resourcetype /><c:addressbook-description /><c:supported-address-data />",
  );
  const addressBooks = addressBooksFromDocument(collectionDoc, credentials, config.maxCardDavAddressBooks);
  if (addressBooks.length === 0) throw new AppError("CARDDAV_DISCOVERY_FAILED", "No CardDAV address book was discovered.");
  return { addressBooks, discoveryMode: "principal-home-set", homeHref: homePath, principalHref };
}

function diagnosticCode(error) {
  const code = toSafeError(error).code;
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "UPSTREAM_ERROR";
}

function diagnosticAuthScheme(error) {
  const scheme = String(error?.authScheme || "").toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(scheme) ? scheme : null;
}

function isAuthFailure(error) {
  return error?.code === "CARDDAV_AUTH_FAILED" || error?.code === "CARDDAV_FORBIDDEN";
}

async function discoverSource(config, source, { diagnostics } = {}) {
  const credentials = ensureConfigured(config, source);
  let lastError = null;
  let preferredError = null;
  let authError = null;
  let authOnlyPathCount = 0;
  const rememberError = (error, { candidate = true } = {}) => {
    lastError = error;
    if (!candidate || !error?.code || error.code === "CARDDAV_NOT_FOUND") return;
    if (isAuthFailure(error)) authError = authError || error;
    else preferredError = preferredError || error;
  };
  const recordDiagnostic = (attempt, slot, error, options = {}) => {
    rememberError(error, options);
    if (!attempt) return;
    attempt[slot] = diagnosticCode(error);
    const authScheme = diagnosticAuthScheme(error);
    if (authScheme && !attempt.authScheme) attempt.authScheme = authScheme;
  };

  for (const { label, path } of DISCOVERY_PATHS) {
    const attempt = diagnostics
      ? { label, options: null, standard: null, direct: null }
      : null;
    if (attempt) diagnostics.push(attempt);

    let capability = "";
    try {
      const options = await davRequest(credentials, path, { method: "OPTIONS" }, {
        allowSameOriginRedirects: true,
      });
      if (attempt) attempt.options = options.response.status;
      capability = options.response.headers.get("dav") || "";
    } catch (error) {
      recordDiagnostic(attempt, "options", error, { candidate: false });
    }

    let pathAuthFailure = false;
    let pathNonAuthFailure = false;
    try {
      const discovered = await standardDiscovery(credentials, path, config, {
        allowSameOriginRedirects: true,
      });
      if (attempt) attempt.standard = "DISCOVERY_OK";
      return { ...discovered, capability, credentials };
    } catch (standardError) {
      recordDiagnostic(attempt, "standard", standardError);
      if (isAuthFailure(standardError)) {
        pathAuthFailure = true;
      } else {
        pathNonAuthFailure = true;
        try {
          const discovered = await directAddressBookDiscovery(credentials, path, config, {
            allowSameOriginRedirects: true,
          });
          if (attempt) attempt.direct = "DISCOVERY_OK";
          return { ...discovered, capability, credentials };
        } catch (directError) {
          recordDiagnostic(attempt, "direct", directError);
          if (isAuthFailure(directError)) pathAuthFailure = true;
          else pathNonAuthFailure = true;
        }
      }
    }
    if (pathAuthFailure && !pathNonAuthFailure) authOnlyPathCount += 1;
  }

  if (authOnlyPathCount === DISCOVERY_PATHS.length) {
    if (authError instanceof AppError) throw authError;
    const error = new AppError("CARDDAV_AUTH_FAILED", "The configured DAV credentials were rejected.");
    const authScheme = diagnosticAuthScheme(authError);
    if (authScheme) error.authScheme = authScheme;
    throw error;
  }
  if (preferredError instanceof AppError) throw preferredError;
  if (authError instanceof AppError) {
    throw new AppError("CARDDAV_DISCOVERY_FAILED", "The CardDAV address books could not be discovered.");
  }
  if (lastError instanceof AppError) throw lastError;
  throw new AppError("CARDDAV_DISCOVERY_FAILED", "The CardDAV address books could not be discovered.");
}

async function discoverSources(config, source, diagnostics) {
  const results = [];
  for (const currentSource of sourceList(source)) {
    const sourceDiagnostics = diagnostics
      ? { source: currentSource, paths: [] }
      : null;
    if (sourceDiagnostics) diagnostics.push(sourceDiagnostics);
    try {
      results.push({
        ...(await discoverSource(config, currentSource, {
          diagnostics: sourceDiagnostics?.paths,
        })),
        status: "ok",
        source: currentSource,
      });
    } catch (error) {
      if (source !== "all") throw error;
      results.push({
        source: currentSource,
        status: "error",
        error: toSafeError(error),
        addressBooks: [],
      });
    }
  }
  return results;
}

export function cardDavStatus(config) {
  const username = config.secrets?.caldavUsername || "";
  const password = config.secrets?.caldavPassword || "";
  return username && password ? "configured" : "unconfigured";
}

export async function checkCardDav(config, source) {
  const credentials = ensureConfigured(config, source);
  const result = await davRequest(credentials, "/", { method: "OPTIONS" });
  return { ok: true, source, addressbookCapability: (result.response.headers.get("dav") || "").toLowerCase().includes("addressbook") };
}

export async function listAddressBooks(config, { source = "all", diagnostics } = {}) {
  const results = await discoverSources(config, source, diagnostics);
  return {
    sources: results.map((result) => ({
      source: result.source,
      status: result.status,
      addressBooks: result.addressBooks || [],
      ...(result.error ? { error: result.error } : {}),
      ...(result.discoveryMode ? { discoveryMode: result.discoveryMode } : {}),
    })),
    truncated: results.some((result) => (result.addressBooks || []).length >= config.maxCardDavAddressBooks),
  };
}

function exactAddressBook(result, requestedHref, config) {
  const credentials = result.credentials;
  if (!requestedHref) return result.addressBooks;
  const normalized = `${toSameOriginUrl(requestedHref, credentials.baseUrl, "CARDDAV_INVALID_PATH", "Use an address book href returned by CardDAV discovery.").pathname}`;
  const selected = result.addressBooks.filter((book) => book.href === normalized);
  if (selected.length === 0) throw new AppError("CARDDAV_INVALID_PATH", "Use an address book href returned by CardDAV discovery.");
  return selected;
}

function normalAddressBookQueryBody(
  query,
  propertyNames = ["FN", "N", "EMAIL", "TEL", "ORG", "TITLE"],
  { metadataOnly = false } = {},
) {
  const names = [...new Set(propertyNames
    .map((propertyName) => String(propertyName).toUpperCase())
    .filter((propertyName) => /^[A-Z][A-Z0-9-]{0,31}$/.test(propertyName)))];
  const filters = (names.length > 0 ? names : ["FN"])
    .map((name) => `<c:prop-filter name="${name}"><c:text-match collation="i;unicode-casemap" match-type="contains">${xmlText(query)}</c:text-match></c:prop-filter>`)
    .join("");
  const testAttribute = names.length > 1 ? ' test="anyof"' : "";
  const properties = metadataOnly ? METADATA_ONLY_PROPS : ADDRESS_DATA_PROPS;
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop>${properties}</d:prop>
  <c:filter${testAttribute}>${filters}</c:filter>
</c:addressbook-query>`;
}

async function addressBookQuery(
  credentials,
  addressBookHref,
  query,
  propertyNames,
  { metadataOnly = false, contentType } = {},
) {
  const result = await davRequest(credentials, addressBookHref, {
    method: "REPORT",
    depth: 1,
    body: normalAddressBookQueryBody(query, propertyNames, { metadataOnly }),
  }, { contentType });
  return parseCardDavXml(result.text);
}

async function addressBookMultiget(credentials, addressBookHref, hrefs) {
  if (hrefs.length === 0) return null;
  const requestHrefs = hrefs.map((href) => `<d:href>${xmlText(href)}</d:href>`).join("");
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<c:addressbook-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop>${ADDRESS_DATA_PROPS}</d:prop>
  ${requestHrefs}
</c:addressbook-multiget>`;
  const result = await davRequest(credentials, addressBookHref, { method: "REPORT", depth: 0, body });
  return parseCardDavXml(result.text);
}

function compactVCardForProjection(input) {
  const output = [];
  let inside = false;
  let captureContinuation = false;
  let ended = false;
  for (const line of String(input).split(/\r\n|\n|\r/)) {
    if (/^BEGIN:VCARD$/i.test(line)) {
      output.push("BEGIN:VCARD");
      inside = true;
      captureContinuation = false;
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      if (inside) output.push("END:VCARD");
      ended = true;
      break;
    }
    if (!inside) continue;
    if (/^[ \t]/.test(line)) {
      if (captureContinuation) output.push(line);
      continue;
    }
    const left = line.split(":", 1)[0] || "";
    const rawName = left.split(";", 1)[0] || "";
    const name = (rawName.includes(".") ? rawName.slice(rawName.lastIndexOf(".") + 1) : rawName).toUpperCase();
    captureContinuation = VCARD_ALLOWED_PROPERTY_SET.has(name);
    if (captureContinuation) output.push(line);
  }
  if (!inside || !ended) throw new AppError("CARDDAV_INVALID_VCARD", "The DAV resource was not a complete vCard.");
  return output.join("\r\n");
}

async function contactResourceInventory(
  result,
  addressBookHref,
  maxResources = ORGANIZATION_INDEX_MAX_RESOURCES,
) {
  const document = await propfind(
    result.credentials,
    addressBookHref,
    1,
    "<d:getetag />",
    { responseLimit: XML_BODY_LIMIT, allowLargeCardDavResponse: true },
  );
  const bookUrl = toSameOriginUrl(
    addressBookHref,
    result.credentials.baseUrl,
    "CARDDAV_INVALID_PATH",
    "Use an address book href returned by CardDAV discovery.",
  );
  const bookPath = bookUrl.pathname.endsWith("/") ? bookUrl.pathname : `${bookUrl.pathname}/`;
  const resources = new Map();
  for (const response of multistatusResponses(document)) {
    const href = hrefFromResponse(response, result.credentials);
    if (!href || href === bookUrl.pathname || !href.startsWith(bookPath)) continue;
    if (!href.toLowerCase().endsWith(".vcf")) continue;
    resources.set(href, {
      href,
      etag: textValue(responseProperties(response)?.getetag),
    });
  }
  const entries = [...resources.values()].sort((a, b) => a.href < b.href ? -1 : a.href > b.href ? 1 : 0);
  return {
    entries: entries.slice(0, maxResources),
    totalResources: entries.length,
    truncated: entries.length > maxResources,
  };
}

async function contactResourceHrefs(result, addressBookHref, config) {
  const inventory = await contactResourceInventory(
    result,
    addressBookHref,
    config.maxCardDavResources,
  );
  return {
    hrefs: inventory.entries.map((entry) => entry.href),
    totalResources: inventory.totalResources,
  };
}

async function readContactResource(result, addressBookHref, href, config) {
  try {
    const response = await davRequest(result.credentials, href, {
      method: "GET",
      accept: "text/vcard, text/x-vcard;q=0.9",
    }, {
      responseLimit: ORGANIZATION_VCARD_RESPONSE_LIMIT,
      allowLargeCardDavResponse: true,
    });
    const compact = compactVCardForProjection(response.text);
    const contact = parseVCard(compact, { maxBytes: config.maxCardDavVCardBytes });
    return {
      contact,
      projected: projectContact(contact, { source: result.source, addressBookHref, href }),
      invalid: 0,
      etag: response.response.headers.get("etag") || "",
    };
  } catch (error) {
    if (error instanceof AppError && [
      "CARDDAV_RESPONSE_TOO_LARGE",
      "CARDDAV_NOT_FOUND",
      "CARDDAV_INVALID_VCARD",
    ].includes(error.code)) {
      return { contact: null, projected: null, invalid: error.code === "CARDDAV_NOT_FOUND" ? 0 : 1, missing: error.code === "CARDDAV_NOT_FOUND" };
    }
    throw error;
  }
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) }, () => worker()),
  );
  return results;
}

function organizationIndexKey(result, addressBookHref) {
  return `${result.credentials.baseUrl}|${addressBookHref}`;
}

async function buildOrganizationIndex(result, addressBookHref, config, previousData) {
  const inventory = await contactResourceInventory(result, addressBookHref);
  const previous = previousData?.byHref instanceof Map ? previousData.byHref : new Map();
  const byHref = new Map();
  const pending = [];
  for (const entry of inventory.entries) {
    const cached = previous.get(entry.href);
    if (cached && entry.etag && cached.etag === entry.etag) {
      byHref.set(entry.href, cached);
    } else {
      pending.push(entry);
    }
  }

  let invalidVcards = 0;
  let failedResources = 0;
  const loaded = await mapConcurrent(
    pending,
    ORGANIZATION_INDEX_CONCURRENCY,
    async (entry) => {
      try {
        const item = await readContactResource(result, addressBookHref, entry.href, config);
        return { entry, item, error: null };
      } catch (error) {
        return { entry, item: null, error: toSafeError(error) };
      }
    },
  );

  const transientFailures = [];
  for (const loadedEntry of loaded) {
    if (loadedEntry.error) {
      transientFailures.push(loadedEntry.entry);
      continue;
    }
    invalidVcards += loadedEntry.item.invalid;
    byHref.set(loadedEntry.entry.href, {
      etag: loadedEntry.entry.etag,
      contact: loadedEntry.item.projected,
    });
  }

  if (transientFailures.length > 0) {
    const retried = await mapConcurrent(
      transientFailures,
      Math.min(8, ORGANIZATION_INDEX_CONCURRENCY),
      async (entry) => {
        try {
          const item = await readContactResource(result, addressBookHref, entry.href, config);
          return { entry, item, error: null };
        } catch (error) {
          return { entry, item: null, error: toSafeError(error) };
        }
      },
    );
    for (const loadedEntry of retried) {
      if (loadedEntry.error) {
        failedResources += 1;
        continue;
      }
      invalidVcards += loadedEntry.item.invalid;
      byHref.set(loadedEntry.entry.href, {
        etag: loadedEntry.entry.etag,
        contact: loadedEntry.item.projected,
      });
    }
  }

  const contacts = [...byHref.values()].map((entry) => entry.contact).filter(Boolean);
  const byUid = new Map(contacts.map((contact) => [contact.uid, contact]));
  return {
    byHref,
    byUid,
    contacts,
    totalResources: inventory.totalResources,
    indexedResources: byHref.size,
    contactCount: contacts.length,
    invalidVcards,
    failedResources,
    complete: !inventory.truncated && failedResources === 0 && byHref.size === inventory.entries.length,
    builtAt: Date.now(),
  };
}

function beginOrganizationIndexBuild(result, addressBookHref, config) {
  const key = organizationIndexKey(result, addressBookHref);
  const now = Date.now();
  const current = organizationIndexCache.get(key);
  if (current?.data && current.expiresAt > now) return Promise.resolve(current.data);
  if (current?.promise) return current.promise;

  const promise = buildOrganizationIndex(result, addressBookHref, config, current?.data)
    .then((data) => {
      organizationIndexCache.set(key, {
        data,
        expiresAt: Date.now() + ORGANIZATION_INDEX_TTL_MS,
        promise: null,
      });
      return data;
    })
    .catch((error) => {
      if (current?.data) {
        organizationIndexCache.set(key, {
          data: current.data,
          expiresAt: Date.now() + 30_000,
          promise: null,
        });
      } else {
        organizationIndexCache.delete(key);
      }
      throw error;
    });
  organizationIndexCache.set(key, {
    data: current?.data,
    expiresAt: current?.expiresAt || 0,
    promise,
  });
  return promise;
}

async function organizationContactIndex(result, addressBookHref, config) {
  const key = organizationIndexKey(result, addressBookHref);
  const now = Date.now();
  const current = organizationIndexCache.get(key);
  if (current?.data && current.expiresAt > now) {
    return { ...current.data, cacheHit: true, refreshFailed: false, refreshing: false };
  }
  if (current?.promise) {
    if (current.data) {
      return { ...current.data, cacheHit: true, refreshFailed: false, refreshing: true };
    }
    throw new AppError("CARDDAV_INDEX_BUILDING", "The organization contact index is being prepared.");
  }
  if (current?.data) {
    void beginOrganizationIndexBuild(result, addressBookHref, config).catch(() => {});
    return { ...current.data, cacheHit: true, refreshFailed: false, refreshing: true };
  }

  const data = await beginOrganizationIndexBuild(result, addressBookHref, config);
  return { ...data, cacheHit: false, refreshFailed: false, refreshing: false };
}

export function getOrganizationCardDavIndexStatus() {
  const now = Date.now();
  const states = [...organizationIndexCache.values()];
  const data = states.map((state) => state.data).find(Boolean);
  const building = Boolean(organizationWarmupPromise) || states.some((state) => Boolean(state.promise));
  const error = organizationWarmupError;
  const state = building
    ? "building"
    : data
      ? (data.complete ? "ready" : "partial")
      : error
        ? "error"
        : "idle";
  return {
    state,
    totalResources: data?.totalResources || 0,
    indexedResources: data?.indexedResources || 0,
    contactCount: data?.contactCount || 0,
    failedResources: data?.failedResources || 0,
    complete: data?.complete === true,
    ageMs: data?.builtAt ? Math.max(0, now - data.builtAt) : null,
    ...(error ? { error } : {}),
  };
}

export function startOrganizationCardDavIndexWarmup(config) {
  if (organizationWarmupPromise) return getOrganizationCardDavIndexStatus();
  organizationWarmupError = null;
  organizationWarmupPromise = (async () => {
    const results = await discoverSources(config, "organization");
    const organization = results.find((result) => result.source === "organization" && result.status === "ok");
    if (!organization) {
      const failed = results.find((result) => result.source === "organization");
      throw new AppError(
        failed?.error?.code || "CARDDAV_DISCOVERY_FAILED",
        failed?.error?.message || "The organization CardDAV address book could not be discovered.",
      );
    }
    for (const book of organization.addressBooks) {
      await beginOrganizationIndexBuild(organization, book.href, config);
    }
  })()
    .catch((error) => {
      organizationWarmupError = toSafeError(error);
    })
    .finally(() => {
      organizationWarmupPromise = null;
    });
  return getOrganizationCardDavIndexStatus();
}

async function searchOrganizationIndex(result, addressBookHref, query, config, limit) {
  const index = await organizationContactIndex(result, addressBookHref, config);
  const normalizedQuery = String(query || "").toLocaleLowerCase("ko-KR");
  const matched = [];
  for (const contact of index.contacts) {
    if (!normalizedQuery || contactSearchText(contact).includes(normalizedQuery)) {
      matched.push(contact);
    }
  }
  return {
    contacts: matched.slice(0, limit),
    invalid: index.invalidVcards,
    resourceTruncated: !index.complete || matched.length > limit,
    indexMeta: {
      complete: index.complete,
      totalResources: index.totalResources,
      indexedResources: index.indexedResources,
      contactCount: index.contactCount,
      failedResources: index.failedResources,
      cacheHit: index.cacheHit,
      refreshFailed: index.refreshFailed,
      refreshing: index.refreshing,
      ageMs: Math.max(0, Date.now() - index.builtAt),
    },
  };
}

async function scanContactsByGetFallback(
  result,
  addressBookHref,
  config,
  { query = "", uid = "", limit = config.maxCardDavContacts } = {},
) {
  const resources = await contactResourceHrefs(result, addressBookHref, config);
  const contacts = [];
  let invalid = 0;
  let scannedResources = 0;
  const normalizedQuery = String(query || "").toLocaleLowerCase("ko-KR");
  const normalizedUid = String(uid || "");
  for (
    let offset = 0;
    offset < resources.hrefs.length && contacts.length < limit;
    offset += GET_FALLBACK_CONCURRENCY
  ) {
    const batch = resources.hrefs.slice(offset, offset + GET_FALLBACK_CONCURRENCY);
    const loaded = await Promise.all(
      batch.map((href) => readContactResource(result, addressBookHref, href, config)),
    );
    scannedResources += batch.length;
    for (const item of loaded) {
      invalid += item.invalid;
      if (!item.contact || !item.projected) continue;
      if (normalizedUid && item.contact.uid !== normalizedUid) continue;
      if (normalizedQuery && !contactSearchText(item.contact).includes(normalizedQuery)) continue;
      contacts.push(item.projected);
      if (contacts.length >= limit) break;
    }
  }
  return {
    contacts,
    invalid,
    scannedResources,
    resourceTruncated: resources.totalResources > resources.hrefs.length,
  };
}

function parseContacts(document, result, addressBookHref, config, query = "") {
  const contacts = [];
  const candidates = [];
  let invalid = 0;
  for (const response of multistatusResponses(document)) {
    const href = hrefFromResponse(response, result.credentials);
    if (!href) continue;
    const properties = responseProperties(response);
    const raw = textValue(properties["address-data"]);
    if (!raw) {
      candidates.push(href);
      continue;
    }
    try {
      const contact = parseVCard(raw, { maxBytes: config.maxCardDavVCardBytes });
      if (!query || contactSearchText(contact).includes(query.toLocaleLowerCase("ko-KR"))) {
        contacts.push(projectContact(contact, { source: result.source, addressBookHref, href }));
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "CARDDAV_INVALID_VCARD") invalid += 1;
      else throw error;
    }
    if (contacts.length >= config.maxCardDavContacts) break;
  }
  return { contacts, candidates: [...new Set(candidates)], invalid };
}

function boundedFirstContactQueryBody({ vendorCompatible = false, version = "4.0" } = {}) {
  const filter = vendorCompatible
    ? '<c:filter test="anyof"><c:prop-filter name="FN"><c:text-match collation="i;unicode-casemap" match-type="contains"></c:text-match></c:prop-filter></c:filter>'
    : '<c:filter><c:prop-filter name="FN" /></c:filter>';
  const dataProps = version === "3.0" ? FIRST_CONTACT_DATA_PROPS_V3 : FIRST_CONTACT_DATA_PROPS;
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop>${dataProps}</d:prop>
  ${filter}
  <c:limit><c:nresults>1</c:nresults></c:limit>
</c:addressbook-query>`;
}

async function boundedFirstContactQuery(credentials, addressBookHref, options = {}) {
  const {
    vendorCompatible = false,
    version = "4.0",
    contentType,
  } = options;
  const result = await davRequest(credentials, addressBookHref, {
    method: "REPORT",
    depth: 1,
    body: boundedFirstContactQueryBody({ vendorCompatible, version }),
  }, { contentType });
  return parseCardDavXml(result.text);
}

function isQueryCompatibilityFailure(error) {
  return error?.status === 400 || error?.code === "CARDDAV_UNSUPPORTED";
}

async function firstContactInBook(result, addressBookHref, config) {
  const variants = [
    {},
    { vendorCompatible: true },
    { version: "3.0" },
    { vendorCompatible: true, version: "3.0" },
    { contentType: "text/xml; charset=utf-8" },
    { vendorCompatible: true, contentType: "text/xml; charset=utf-8" },
    { version: "3.0", contentType: "text/xml; charset=utf-8" },
    { vendorCompatible: true, version: "3.0", contentType: "text/xml; charset=utf-8" },
  ];
  let document;
  for (let index = 0; index < variants.length; index += 1) {
    try {
      document = await boundedFirstContactQuery(result.credentials, addressBookHref, variants[index]);
      break;
    } catch (error) {
      if (!isQueryCompatibilityFailure(error) || index === variants.length - 1) throw error;
    }
  }
  const parsed = parseContacts(document, result, addressBookHref, config);
  if (parsed.contacts.length > 0) return parsed.contacts[0];

  const [candidate] = parsed.candidates.slice(0, 1);
  if (!candidate) return null;
  const multiget = await addressBookMultiget(result.credentials, addressBookHref, [candidate]);
  if (!multiget) return null;
  return parseContacts(multiget, result, addressBookHref, config).contacts[0] || null;
}

function markCompatibility(diagnostics, field) {
  if (diagnostics && typeof diagnostics === "object") diagnostics[field] = true;
}

async function compatibilityMetadataQuery(result, addressBookHref, query, propertyNames, diagnostics) {
  markCompatibility(diagnostics, "metadataOnlyFallbackAttempted");
  try {
    const document = await addressBookQuery(
      result.credentials,
      addressBookHref,
      query,
      propertyNames,
      { metadataOnly: true },
    );
    markCompatibility(diagnostics, "metadataOnlyFallbackUsed");
    return document;
  } catch (error) {
    if (!isQueryCompatibilityFailure(error)) throw error;
    markCompatibility(diagnostics, "textXmlRetryAttempted");
    const document = await addressBookQuery(
      result.credentials,
      addressBookHref,
      query,
      propertyNames,
      { metadataOnly: true, contentType: "text/xml; charset=utf-8" },
    );
    markCompatibility(diagnostics, "metadataOnlyFallbackUsed");
    markCompatibility(diagnostics, "textXmlRetryUsed");
    return document;
  }
}

async function contactsForBook(
  result,
  addressBookHref,
  query,
  config,
  propertyNames,
  diagnostics,
  limit = config.maxCardDavContacts,
) {
  let invalid = 0;
  let document;
  try {
    document = await addressBookQuery(result.credentials, addressBookHref, query, propertyNames);
  } catch (error) {
    if (!isQueryCompatibilityFailure(error)) throw error;
    try {
      document = await compatibilityMetadataQuery(
        result,
        addressBookHref,
        query,
        propertyNames,
        diagnostics,
      );
    } catch (compatibilityError) {
      if (!isQueryCompatibilityFailure(compatibilityError)) throw compatibilityError;
      markCompatibility(diagnostics, "propfindGetFallbackAttempted");
      const scanned = result.source === "organization"
        ? await searchOrganizationIndex(result, addressBookHref, query, config, limit)
        : await scanContactsByGetFallback(
            result,
            addressBookHref,
            config,
            { query, limit },
          );
      markCompatibility(diagnostics, "propfindGetFallbackUsed");
      if (diagnostics && typeof diagnostics === "object") {
        diagnostics.fallbackScannedResources = scanned.scannedResources;
        diagnostics.fallbackResourceTruncated = scanned.resourceTruncated;
        if (scanned.indexMeta) diagnostics.organizationIndex = scanned.indexMeta;
      }
      return scanned;
    }
  }

  const parsed = parseContacts(document, result, addressBookHref, config, query);
  invalid += parsed.invalid;
  if (parsed.contacts.length >= limit) {
    return { contacts: parsed.contacts.slice(0, limit), invalid, resourceTruncated: false };
  }

  const boundedCandidates = parsed.candidates.slice(0, config.maxCardDavResources);
  for (let offset = 0; offset < boundedCandidates.length && parsed.contacts.length < limit; offset += MULTIGET_BATCH_SIZE) {
    const multiget = await addressBookMultiget(
      result.credentials,
      addressBookHref,
      boundedCandidates.slice(offset, offset + MULTIGET_BATCH_SIZE),
    );
    if (!multiget) continue;
    const second = parseContacts(multiget, result, addressBookHref, config, query);
    parsed.contacts.push(...second.contacts.slice(0, limit - parsed.contacts.length));
    invalid += second.invalid;
  }
  return { contacts: parsed.contacts.slice(0, limit), invalid, resourceTruncated: false };
}

async function searchContactsUnpaged(
  config,
  { source = "all", query, addressBookHref, limit = config.maxCardDavContacts, diagnostics } = {},
) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery || normalizedQuery.length > 200) throw new AppError("INVALID_CARDDAV_QUERY", "The contact search query is invalid.");
  const resultLimit = Math.min(Math.max(Number(limit) || 1, 1), config.maxCardDavContacts);
  const results = await discoverSources(config, source);
  const contacts = [];
  let invalidVcards = 0;
  let matchedAddressBooks = 0;
  let resourceTruncated = false;
  let organizationIndex = null;
  for (const result of results) {
    if (result.status !== "ok") continue;
    for (const book of exactAddressBook(result, addressBookHref, config)) {
      matchedAddressBooks += 1;
      const found = await contactsForBook(
        result,
        book.href,
        normalizedQuery,
        config,
        undefined,
        diagnostics,
        resultLimit - contacts.length,
      );
      contacts.push(...found.contacts);
      invalidVcards += found.invalid;
      resourceTruncated = resourceTruncated || found.resourceTruncated === true;
      if (found.indexMeta) organizationIndex = found.indexMeta;
      if (contacts.length >= resultLimit) break;
    }
    if (contacts.length >= resultLimit) break;
  }
  if (addressBookHref && matchedAddressBooks === 0) throw new AppError("CARDDAV_INVALID_PATH", "Use an address book href returned by CardDAV discovery.");
  return {
    contacts: contacts.slice(0, resultLimit),
    truncated: resourceTruncated || contacts.length >= resultLimit,
    invalidVcards,
    sources: results.map((result) => ({
      source: result.source,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    })),
    ...(organizationIndex ? { organizationIndex } : {}),
  };
}

// Organization searches never await the long-lived process's full-index warmup.
export async function searchContacts(
  config,
  { source = "all", query, addressBookHref, limit = config.maxCardDavContacts, diagnostics, cursor } = {},
) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery || normalizedQuery.length > 200) throw new AppError("INVALID_CARDDAV_QUERY", "The contact search query is invalid.");
  sourceList(source);
  const resumed = decodeSearchCursor(cursor);
  if (source === "personal") {
    if (resumed) throw new AppError("CARDDAV_INVALID_CURSOR", "Personal searches do not accept organization continuation cursors.");
    return searchContactsUnpaged(config, { source, query, addressBookHref, limit, diagnostics });
  }
  const scope = searchDigest([source, normalizedQuery, addressBookHref || ""]);
  if (resumed && resumed.scope !== scope) throw new AppError("CARDDAV_INVALID_CURSOR", "Use the returned cursor with the same search query and scope.");
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const boundedConfig = { ...config, cardDavDeadlineMs: deadline };
  const resultLimit = Math.min(Math.max(Math.floor(Number(limit) || 1), 1), config.maxCardDavContacts);
  let personal = null;
  let personalError = null;
  // Personal results are emitted once; continuation is organization-only.
  if (source === "all" && !resumed) {
    try {
      personal = await searchContactsUnpaged(boundedConfig, { source: "personal", query: normalizedQuery, addressBookHref, limit: resultLimit, diagnostics });
    } catch (error) {
      personalError = toSafeError(error);
    }
  }
  let result;
  let books;
  const entries = [];
  let totalResources = 0;
  let capped = false;
  try {
    [result] = await discoverSources(boundedConfig, "organization");
    books = exactAddressBook(result, addressBookHref, boundedConfig)
      .slice().sort((a, b) => a.href < b.href ? -1 : a.href > b.href ? 1 : 0);
    capped = result.addressBooks.length >= config.maxCardDavAddressBooks;
    for (const book of books) {
      const inventory = await contactResourceInventory(result, book.href);
      totalResources += inventory.totalResources;
      capped ||= inventory.truncated;
      for (const entry of inventory.entries) {
        if (entries.length < ORGANIZATION_INDEX_MAX_RESOURCES) entries.push({ ...entry, bookHref: book.href });
        else capped = true;
      }
    }
  } catch (error) {
    if (source !== "all") throw error;
    return {
      contacts: personal?.contacts || [], truncated: true, incomplete: true,
      nextCursor: cursor || null, reason: "source_unavailable",
      invalidVcards: personal?.invalidVcards || 0,
      sources: [
        { source: "personal", status: resumed ? "previous_page" : personalError ? "error" : "ok", ...(personalError ? { error: personalError } : {}) },
        { source: "organization", status: "error", error: toSafeError(error) },
      ],
    };
  }
  const hash = searchDigest([books.map(book => book.href), entries.map(entry => [entry.bookHref, entry.href, entry.etag]), totalResources, capped]);
  if (resumed && resumed.hash !== hash) throw new AppError("CARDDAV_CURSOR_STALE", "The address book inventory changed. Restart without a cursor.");
  if (resumed && resumed.offset > entries.length) throw new AppError("CARDDAV_INVALID_CURSOR", "The cursor position is outside this address book.");
  // Existing personal searches cannot prove exhaustive coverage; never claim all-source completeness.
  const priorUnresolved = source === "all" || resumed?.unresolved || false;
  const priorContacts = personal?.contacts || [];
  const page = await scanResourcePage({
    entries, query: normalizedQuery, limit: resultLimit - priorContacts.length,
    offset: resumed?.offset || 0, skipped: resumed?.skipped || 0, deadline,
    read: entry => readContactResource(result, entry.bookHref, entry.href, boundedConfig),
  });
  const exhausted = page.offset === entries.length;
  const incomplete = !exhausted || capped || page.skipped > 0 || priorUnresolved;
  const nextCursor = exhausted ? null : encodeSearchCursor({
    v: 1, scope, hash, offset: page.offset, skipped: page.skipped, unresolved: priorUnresolved,
  });
  return {
    contacts: [...priorContacts, ...page.contacts],
    truncated: incomplete, incomplete, nextCursor,
    retryable: page.reason === "resource_failed" ? ["CARDDAV_TIMEOUT", "CARDDAV_UNAVAILABLE", "CARDDAV_RATE_LIMITED"].includes(page.failureCode) : nextCursor !== null,
    reason: page.reason || (capped ? "resource_cap" : page.skipped ? "invalid_resources" : priorUnresolved ? "source_incomplete" : null),
    invalidVcards: (personal?.invalidVcards || 0) + page.invalid,
    sources: [
      ...(source === "all" ? [{ source: "personal", status: resumed ? "previous_page" : personalError ? "error" : "ok", ...(personalError ? { error: personalError } : {}) }] : []),
      { source: "organization", status: "ok" },
    ],
    progress: { scannedResources: page.scanned, nextOffset: page.offset, totalResources, requests: page.requests, skippedResources: page.skipped },
    organizationIndex: {
      complete: !incomplete, totalResources, indexedResources: page.offset,
      contactCount: page.contacts.length, failedResources: page.reason === "resource_failed" ? 1 : 0,
      cacheHit: false, refreshFailed: false, refreshing: false, ageMs: 0,
    },
  };
}

export async function getContact(config, { source, uid, href, addressBookHref } = {}) {
  const [result] = await discoverSources(config, source);
  if (result.status !== "ok") throw new AppError(result.error?.code || "CARDDAV_DISCOVERY_FAILED", result.error?.message || "The CardDAV address book could not be discovered.");
  const books = exactAddressBook(result, addressBookHref, config);
  if (books.length === 0) throw new AppError("CARDDAV_INVALID_PATH", "Use an address book href returned by CardDAV discovery.");
  const normalizedHref = href
    ? `${toSameOriginUrl(href, result.credentials.baseUrl, "CARDDAV_INVALID_PATH", "Use a contact href returned by CardDAV.").pathname}`
    : "";
  if (href && !result.addressBooks.some((book) => normalizedHref.startsWith(`${book.href.replace(/\/$/, "")}/`))) {
    throw new AppError("CARDDAV_INVALID_PATH", "Use a contact href returned by CardDAV.");
  }
  for (const book of books) {
    const targetHrefs = normalizedHref ? [normalizedHref] : [];
    if (targetHrefs.length === 0 && uid) {
      try {
        const document = await addressBookQuery(result.credentials, book.href, String(uid), ["UID"]);
        const parsed = parseContacts(document, result, book.href, config, "");
        const match = parsed.contacts.find((contact) => contact.uid === uid);
        if (match) return match;
      } catch (error) {
        if (!isQueryCompatibilityFailure(error)) throw error;
        if (result.source === "organization") {
          const index = await organizationContactIndex(result, book.href, config);
          const match = index.byUid.get(String(uid));
          if (match) return match;
        } else {
          const scanned = await scanContactsByGetFallback(
            result,
            book.href,
            config,
            { uid: String(uid), limit: 1 },
          );
          if (scanned.contacts[0]) return scanned.contacts[0];
        }
      }
      continue;
    }
    try {
      const document = await addressBookMultiget(result.credentials, book.href, targetHrefs);
      if (!document) continue;
      const parsed = parseContacts(document, result, book.href, config, "");
      const match = parsed.contacts.find((contact) => !uid || contact.uid === uid || contact.href === normalizedHref);
      if (match) return match;
    } catch (error) {
      if (!isQueryCompatibilityFailure(error) || !normalizedHref) throw error;
      const loaded = await readContactResource(result, book.href, normalizedHref, config);
      if (loaded.projected && (!uid || loaded.projected.uid === uid)) return loaded.projected;
    }
  }
  throw new AppError("CARDDAV_CONTACT_NOT_FOUND", "The requested contact was not found.");
}
