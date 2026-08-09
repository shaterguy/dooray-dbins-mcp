import { normalizeDoorayApiToken } from "./dooray/token.mjs";

export const FIXED_CONFIG = Object.freeze({
  caldavServerUrl: "https://caldav.dooray.co.kr",
  ldapUrl: "ldaps://ldap.dooray.co.kr:636",
  ldapBaseDn: "dc=dbins.dooray.co.kr",
  timezone: "Asia/Seoul",
  ldapTlsRejectUnauthorized: true,
  ldapTlsMinVersion: "TLSv1.2",
  requestTimeoutMs: 5_000,
  ldapConnectTimeoutMs: 4_000,
  ldapTimeoutMs: 5_000,
  ldapGroupLookupConcurrency: 4,
  functionMaxDurationMs: 60_000,
  upstreamSafetyMarginMs: 15_000,
  maxCalendarResults: 100,
  maxDirectoryResults: 50,
  maxCalendarRangeDays: 366,
});

export const SECRET_ENV_KEYS = Object.freeze([
  "MCP_PATH_TOKEN",
  "DOORAY_USERNAME",
  "DOORAY_PASSWORD",
  "DOORAY_API_TOKEN",
]);

export const LEGACY_PATH_TOKEN_ENV_KEY = "MCP_ACCESS_TOKEN";

const requiredCredentialKeys = SECRET_ENV_KEYS.slice(1);

export class ConfigurationError extends Error {
  constructor(missingKeys) {
    super(`Missing required secret configuration: ${missingKeys.join(", ")}`);
    this.name = "ConfigurationError";
    this.code = "CONFIGURATION_ERROR";
    this.missingKeys = missingKeys;
  }
}

export function loadPathToken(env = process.env) {
  const tokenKey = env.MCP_PATH_TOKEN ? "MCP_PATH_TOKEN" : LEGACY_PATH_TOKEN_ENV_KEY;
  const token = env[tokenKey] || "";
  if (!token) throw new ConfigurationError(["MCP_PATH_TOKEN or MCP_ACCESS_TOKEN"]);
  if (!/^[A-Za-z0-9_-]{64}$/.test(token)) {
    throw new ConfigurationError([`${tokenKey} (must be exactly 64 URL-safe characters)`]);
  }
  return token;
}

function parsePositiveInteger(name, rawValue, fallback, min, max) {
  const raw = rawValue?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigurationError([`${name} (must be an integer between ${min} and ${max})`]);
  }
  return value;
}

function parseHttpsBaseUrl(rawValue) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new ConfigurationError(["DOORAY_BASE_URL (must be a valid URL)"]);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new ConfigurationError(["DOORAY_BASE_URL (must use HTTPS without credentials or custom port)"]);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function loadDoorayRuntimeConfig(env = process.env) {
  const rawApiToken = env.DOORAY_API_TOKEN;
  if (!rawApiToken?.trim()) {
    throw new ConfigurationError(["DOORAY_API_TOKEN"]);
  }
  let normalizedToken;
  try {
    normalizedToken = normalizeDoorayApiToken(rawApiToken);
  } catch (error) {
    throw new ConfigurationError([error instanceof Error ? error.message : "DOORAY_API_TOKEN"]);
  }

  const baseUrl = parseHttpsBaseUrl((env.DOORAY_BASE_URL || "https://api.dooray.com").trim());
  const configuredHosts = (env.DOORAY_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = new Set([baseUrl.hostname.toLowerCase(), ...configuredHosts]);

  return Object.freeze({
    apiToken: normalizedToken.token,
    tokenInputFormat: normalizedToken.inputFormat,
    baseUrl,
    allowedHosts,
    timeoutMs: parsePositiveInteger("DOORAY_TIMEOUT_MS", env.DOORAY_TIMEOUT_MS, 20_000, 1_000, 60_000),
    maxResponseBytes: parsePositiveInteger("DOORAY_MAX_RESPONSE_BYTES", env.DOORAY_MAX_RESPONSE_BYTES, 2_000_000, 10_000, 10_000_000),
    maxToolTextChars: parsePositiveInteger("DOORAY_MAX_TOOL_TEXT_CHARS", env.DOORAY_MAX_TOOL_TEXT_CHARS, 120_000, 5_000, 500_000),
  });
}

export function loadConfig(env = process.env) {
  const pathToken = loadPathToken(env);
  const missingKeys = requiredCredentialKeys.filter((key) => !env[key]?.trim());
  if (missingKeys.length > 0) throw new ConfigurationError(missingKeys);

  const dooray = loadDoorayRuntimeConfig(env);
  return Object.freeze({
    ...FIXED_CONFIG,
    secrets: Object.freeze({
      pathToken,
      mcpAccessKey: env.MCP_ACCESS_KEY?.trim() || "",
      doorayUsername: env.DOORAY_USERNAME,
      doorayPassword: env.DOORAY_PASSWORD,
      caldavUsername: env.DOORAY_USERNAME,
      caldavPassword: env.DOORAY_PASSWORD,
      ldapBindDn: env.DOORAY_USERNAME,
      ldapPassword: env.DOORAY_PASSWORD,
      doorayApiToken: dooray.apiToken,
    }),
    dooray,
  });
}
