import { AppError, toSafeError } from "./errors.mjs";
import {
  asArray,
  multistatusResponses,
  parseDavXml,
  requestDav,
  responseProperties,
  textValue,
  toSameOriginUrl,
} from "./dav.mjs";
import { contactSearchText, parseVCard, projectContact } from "./vcard.mjs";

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
  return requestDav({
    baseUrl: credentials.baseUrl,
    username: credentials.username,
    password: credentials.password,
    requestTimeoutMs: credentials.requestTimeoutMs,
    responseLimit: credentials.responseLimit,
    errorPrefix: "CARDDAV",
    serviceName: "CardDAV",
    allowSameOriginRedirects: requestOptions.allowSameOriginRedirects === true,
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

async function contactsForBook(result, addressBookHref, query, config, propertyNames, diagnostics) {
  let invalid = 0;
  let document;
  try {
    document = await addressBookQuery(result.credentials, addressBookHref, query, propertyNames);
  } catch (error) {
    if (!isQueryCompatibilityFailure(error)) throw error;
    document = await compatibilityMetadataQuery(
      result,
      addressBookHref,
      query,
      propertyNames,
      diagnostics,
    );
  }

  const parsed = parseContacts(document, result, addressBookHref, config, query);
  invalid += parsed.invalid;
  if (parsed.contacts.length >= config.maxCardDavContacts) {
    return { contacts: parsed.contacts, invalid };
  }

  const boundedCandidates = parsed.candidates.slice(0, config.maxCardDavResources);
  for (let offset = 0; offset < boundedCandidates.length && parsed.contacts.length < config.maxCardDavContacts; offset += MULTIGET_BATCH_SIZE) {
    const multiget = await addressBookMultiget(
      result.credentials,
      addressBookHref,
      boundedCandidates.slice(offset, offset + MULTIGET_BATCH_SIZE),
    );
    if (!multiget) continue;
    const second = parseContacts(multiget, result, addressBookHref, config, query);
    parsed.contacts.push(...second.contacts);
    invalid += second.invalid;
  }
  return { contacts: parsed.contacts, invalid };
}

export async function searchContacts(
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
      );
      contacts.push(...found.contacts);
      invalidVcards += found.invalid;
      if (contacts.length >= resultLimit) break;
    }
    if (contacts.length >= resultLimit) break;
  }
  if (addressBookHref && matchedAddressBooks === 0) throw new AppError("CARDDAV_INVALID_PATH", "Use an address book href returned by CardDAV discovery.");
  return {
    contacts: contacts.slice(0, resultLimit),
    truncated: contacts.length >= resultLimit,
    invalidVcards,
    sources: results.map((result) => ({
      source: result.source,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    })),
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
      const document = await addressBookQuery(result.credentials, book.href, String(uid), ["UID"]);
      const parsed = parseContacts(document, result, book.href, config, "");
      const match = parsed.contacts.find((contact) => contact.uid === uid);
      if (match) return match;
      continue;
    }
    const document = await addressBookMultiget(result.credentials, book.href, targetHrefs);
    if (!document) continue;
    const parsed = parseContacts(document, result, book.href, config, "");
    const match = parsed.contacts.find((contact) => !uid || contact.uid === uid || contact.href === normalizedHref);
    if (match) return match;
  }
  throw new AppError("CARDDAV_CONTACT_NOT_FOUND", "The requested contact was not found.");
}
