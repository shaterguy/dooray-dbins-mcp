import type { DoorayQuery, DoorayQueryValue } from "./types.mjs";

const SERVICE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/i;
const VERSION_PATTERN = /^v\d+$/i;
const QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function normalizeDoorayApiPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("Dooray API path must start with '/'.");
  }
  if (trimmed.length > 2048 || /[\\?#\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new Error("Dooray API path contains an unsupported character or is too long.");
  }

  const rawSegments = trimmed.split("/").slice(1);
  if (rawSegments.length < 2 || rawSegments.some((segment) => segment.length === 0)) {
    throw new Error("Dooray API path must follow /<service>/v<number>/... format.");
  }

  const decodedSegments = rawSegments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Dooray API path contains invalid percent encoding.");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Dooray API path traversal is not allowed.");
    }
    if (decoded.length === 0 || decoded.length > 256 || /[\u0000-\u001F\u007F]/.test(decoded)) {
      throw new Error("Dooray API path segment is invalid.");
    }
    return decoded;
  });

  if (!SERVICE_PATTERN.test(decodedSegments[0]) || !VERSION_PATTERN.test(decodedSegments[1])) {
    throw new Error("Dooray API path must follow /<service>/v<number>/... format.");
  }

  return `/${decodedSegments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: DoorayQueryValue): void {
  if (value === undefined || value === null) return;

  const values = Array.isArray(value) ? value : [value];
  if (values.length > 100) {
    throw new Error(`Query parameter '${key}' has too many values.`);
  }

  const normalized = values.map((item) => String(item));
  if (normalized.some((item) => item.length > 2000 || /[\u0000-\u001F\u007F]/.test(item))) {
    throw new Error(`Query parameter '${key}' is invalid.`);
  }

  searchParams.set(key, normalized.join(","));
}

export function buildDoorayUrl(baseUrl: URL, allowedHosts: ReadonlySet<string>, path: string, query: DoorayQuery = {}): URL {
  const host = baseUrl.hostname.toLowerCase();
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.port) {
    throw new Error("Dooray base URL is not allowed.");
  }
  if (!allowedHosts.has(host)) {
    throw new Error(`Dooray API host '${host}' is not in DOORAY_ALLOWED_HOSTS.`);
  }

  const normalizedPath = normalizeDoorayApiPath(path);
  const url = new URL(normalizedPath, baseUrl.origin);
  if (url.origin !== baseUrl.origin) {
    throw new Error("Dooray API URL changed origin unexpectedly.");
  }

  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_KEY_PATTERN.test(key)) {
      throw new Error(`Query parameter name '${key}' is invalid.`);
    }
    appendQueryValue(url.searchParams, key, value);
  }

  return url;
}

export function clampPage(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error("page must be an integer between 0 and 1000000.");
  }
  return value;
}

export function clampPageSize(value: number | undefined, fallback = 20): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("size must be an integer between 1 and 100.");
  }
  return value;
}

export function requireIdentifier(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 256 || normalized.includes("/")) {
    throw new Error(`${name} is required and must be a single path identifier.`);
  }
  return normalized;
}
