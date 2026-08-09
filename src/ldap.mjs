import { Client } from "ldapts";
import { AppError } from "./errors.mjs";

export const PERSON_ATTRIBUTES = Object.freeze([
  "cn",
  "displayName",
  "givenName",
  "sn",
  "uid",
  "mail",
  "title",
  "department",
  "telephoneNumber",
]);

const GROUP_ATTRIBUTES = Object.freeze(["cn", "displayName", "mail", "member", "uniqueMember"]);
export const LDAP_UPSTREAM_MAX_CONCURRENT_SEARCHES = 8;
const LDAP_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);
const LDAP_TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const LDAP_AUTH_DIAGNOSTICS = Object.freeze({
  "52e": "the username or password was rejected",
  "525": "the directory user was not found",
  "530": "the account is not permitted to log on at this time",
  "531": "the account is not permitted to log on from this workstation",
  "532": "the password has expired",
  "533": "the account is disabled",
  "701": "the account has expired",
  "773": "the user must reset the password",
  "775": "the account is locked",
});

export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  async withPermit(operation) {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    try {
      return await operation();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active = Math.max(0, this.active - 1);
    }
  }
}

const upstreamLdapSemaphore = new Semaphore(LDAP_UPSTREAM_MAX_CONCURRENT_SEARCHES);

function limitedSearch(client, ...args) {
  return upstreamLdapSemaphore.withPermit(() => client.search(...args));
}

export function escapeLdapFilterValue(value) {
  return String(value).replace(/[\\*()\u0000]/g, (character) => {
    const escaped = {
      "\\": "\\5c",
      "*": "\\2a",
      "(": "\\28",
      ")": "\\29",
      "\u0000": "\\00",
    };
    return escaped[character];
  });
}

function createClient(config) {
  const servername = new URL(config.ldapUrl).hostname;
  return new Client({
    url: config.ldapUrl,
    connectTimeout: config.ldapConnectTimeoutMs,
    timeout: config.ldapTimeoutMs,
    tlsOptions: {
      rejectUnauthorized: config.ldapTlsRejectUnauthorized,
      minVersion: config.ldapTlsMinVersion,
      // Keep TLS SNI coupled to the configured LDAP endpoint. A previous
      // preview could carry a .com SNI with a .co.kr URL after a hostname
      // rollback, which made the endpoint configuration internally unsafe.
      servername,
    },
  });
}

async function withBoundClient(config, operation) {
  const client = createClient(config);
  try {
    await client.bind(config.secrets.ldapBindDn, config.secrets.ldapPassword);
    return await operation(client);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw classifyLdapError(error);
  } finally {
    try {
      await client.unbind();
    } catch {
      // The connection may already be closed after an upstream failure.
    }
  }
}

export function safeLdapAuthDiagnostic(error) {
  const raw = [error?.message, error?.diagnosticMessage, error?.description]
    .filter((value) => typeof value === "string")
    .join(" ");
  const match = raw.match(/\b(?:data|code|subcode)\s*[:=]?\s*([0-9a-f]{3,4})\b/i);
  if (!match) return "";
  return LDAP_AUTH_DIAGNOSTICS[match[1].toLowerCase()] || "";
}

export function classifyLdapError(error) {
  const name = typeof error?.name === "string" ? error.name : "";
  const code = typeof error?.code === "string" ? error.code : "";
  const resultCode = Number.isInteger(error?.resultCode) ? error.resultCode : Number(error?.code);

  if (resultCode === 49 || name === "InvalidCredentialsError") {
    const diagnostic = safeLdapAuthDiagnostic(error);
    const suffix = diagnostic ? ` Server diagnostic: ${diagnostic}.` : "";
    return new AppError("LDAP_AUTH_FAILED", `The directory service rejected the configured credentials.${suffix}`);
  }
  if (resultCode === 34 || name === "InvalidDNSyntaxError") {
    return new AppError("LDAP_BIND_DN_INVALID", "The directory service rejected the bind name syntax.");
  }
  if (code === "ETIMEDOUT" || name === "TimeoutError") {
    return new AppError("LDAP_TIMEOUT", "The directory service timed out.");
  }
  if (LDAP_TLS_CODES.has(code)) {
    return new AppError("LDAP_TLS_FAILED", "The directory service TLS connection failed.");
  }
  if (LDAP_NETWORK_CODES.has(code) || resultCode === 51 || resultCode === 52) {
    return new AppError("LDAP_UNAVAILABLE", "The directory service is unavailable.");
  }
  return new AppError("LDAP_REQUEST_FAILED", "The directory service request failed.");
}

function first(value) {
  let normalized;
  if (Array.isArray(value)) normalized = value[0] || "";
  else if (Buffer.isBuffer(value)) normalized = value.toString("utf8");
  else normalized = value === undefined || value === null ? "" : String(value);
  return String(normalized).slice(0, 2_000);
}

function normalizePerson(entry) {
  return Object.fromEntries(PERSON_ATTRIBUTES.map((attribute) => [attribute, first(entry[attribute])]).filter(([, value]) => value));
}

function splitUnescaped(value, delimiter) {
  const parts = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      if (index + 1 >= value.length) throw new Error("Invalid trailing DN escape");
      current += character + value[index + 1];
      index += 1;
    } else if (character === delimiter) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts;
}

function normalizeDn(dn) {
  return splitUnescaped(String(dn).trim(), ",").map((rawRdn) => {
    const components = splitUnescaped(rawRdn.trim(), "+").map((rawComponent) => {
      const equalsAt = rawComponent.indexOf("=");
      if (equalsAt <= 0) throw new Error("Invalid DN component");
      const attribute = rawComponent.slice(0, equalsAt).trim().toLowerCase();
      const value = rawComponent.slice(equalsAt + 1).trim().toLowerCase();
      if (!/^(?:[a-z][a-z0-9-]*|\d+(?:\.\d+)*)$/.test(attribute) || !value) {
        throw new Error("Invalid DN component");
      }
      return `${attribute}=${value}`;
    });
    components.sort();
    return components.join("+");
  });
}

export function isWithinBaseDn(dn, baseDn) {
  try {
    const candidateRdns = normalizeDn(dn);
    const baseRdns = normalizeDn(baseDn);
    if (candidateRdns.length < baseRdns.length) return false;
    return baseRdns.every((rdn, index) => rdn === candidateRdns[candidateRdns.length - baseRdns.length + index]);
  } catch {
    return false;
  }
}

export async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  let cursor = 0;
  let firstError;

  async function worker() {
    while (!firstError) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        firstError ||= error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

export async function searchPeople(config, { query, limit = 20 }) {
  const escaped = escapeLdapFilterValue(query.trim());
  const safeLimit = Math.min(Math.max(limit, 1), config.maxDirectoryResults);
  const filter = `(&(|(objectClass=person)(objectClass=inetOrgPerson))(|(cn=*${escaped}*)(displayName=*${escaped}*)(mail=*${escaped}*)(uid=*${escaped}*)))`;
  return withBoundClient(config, async (client) => {
    const { searchEntries } = await limitedSearch(client, config.ldapBaseDn, {
      scope: "sub",
      filter,
      attributes: [...PERSON_ATTRIBUTES],
      sizeLimit: safeLimit,
      timeLimit: Math.ceil(config.ldapTimeoutMs / 1000),
    });
    return searchEntries.slice(0, safeLimit).map(normalizePerson);
  });
}

export async function getPerson(config, { identifier }) {
  const escaped = escapeLdapFilterValue(identifier.trim());
  const filter = `(&(|(objectClass=person)(objectClass=inetOrgPerson))(|(uid=${escaped})(mail=${escaped})(cn=${escaped})))`;
  return withBoundClient(config, async (client) => {
    const { searchEntries } = await limitedSearch(client, config.ldapBaseDn, {
      scope: "sub",
      filter,
      attributes: [...PERSON_ATTRIBUTES],
      sizeLimit: 2,
      timeLimit: Math.ceil(config.ldapTimeoutMs / 1000),
    });
    if (searchEntries.length === 0) throw new AppError("PERSON_NOT_FOUND", "No directory person matched the identifier.");
    if (searchEntries.length > 1) throw new AppError("PERSON_AMBIGUOUS", "More than one directory person matched the identifier.");
    return normalizePerson(searchEntries[0]);
  });
}

export async function getGroupMembers(config, { group, limit = 25 }) {
  const escaped = escapeLdapFilterValue(group.trim());
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  const filter = `(&(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=group))(|(cn=${escaped})(mail=${escaped})))`;
  return withBoundClient(config, async (client) => {
    const { searchEntries } = await limitedSearch(client, config.ldapBaseDn, {
      scope: "sub",
      filter,
      attributes: [...GROUP_ATTRIBUTES],
      sizeLimit: 2,
      timeLimit: Math.ceil(config.ldapTimeoutMs / 1000),
    });
    if (searchEntries.length === 0) throw new AppError("GROUP_NOT_FOUND", "No directory group matched the identifier.");
    if (searchEntries.length > 1) throw new AppError("GROUP_AMBIGUOUS", "More than one directory group matched the identifier.");

    const entry = searchEntries[0];
    const rawMembers = [...asStringArray(entry.member), ...asStringArray(entry.uniqueMember)]
      .filter((dn) => isWithinBaseDn(dn, config.ldapBaseDn))
      .slice(0, safeLimit);
    const peopleByDn = await mapWithConcurrency(rawMembers, config.ldapGroupLookupConcurrency, async (memberDn) => {
      const { searchEntries: people } = await limitedSearch(client, memberDn, {
        scope: "base",
        filter: "(|(objectClass=person)(objectClass=inetOrgPerson))",
        attributes: [...PERSON_ATTRIBUTES],
        sizeLimit: 1,
        timeLimit: Math.ceil(config.ldapTimeoutMs / 1000),
      });
      return people[0] ? normalizePerson(people[0]) : null;
    });
    const members = peopleByDn.filter(Boolean);
    return {
      group: {
        cn: first(entry.cn),
        displayName: first(entry.displayName),
        mail: first(entry.mail),
      },
      members,
      truncated: rawMembers.length >= safeLimit,
    };
  });
}

function asStringArray(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(first).filter(Boolean);
}

export async function checkLdap(config) {
  return withBoundClient(config, async () => ({ ok: true }));
}

