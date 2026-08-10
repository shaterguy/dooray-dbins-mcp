import { XMLParser } from "fast-xml-parser";
import { AppError } from "./errors.mjs";

export const XML_BODY_LIMIT = 5 * 1024 * 1024;
const CARDDAV_BUFFERED_BODY_LIMIT = 512 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  maxNestedTags: 64,
  parseTagValue: false,
  trimValues: true,
});

const XML_ENTITY_VALUES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
});

export function decodeXmlEntities(value = "") {
  return String(value).replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|apos|gt|lt|quot);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized in XML_ENTITY_VALUES) return XML_ENTITY_VALUES[normalized];

    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return match;
    return String.fromCodePoint(codePoint);
  });
}

export function parseDavXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new AppError("UNSAFE_XML", "The DAV service returned unsupported XML declarations.");
  }
  return parser.parse(xml);
}

export async function readResponseTextBounded(response, limit = XML_BODY_LIMIT, errorCode = "DAV_RESPONSE_TOO_LARGE", service = "DAV") {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > limit) {
    throw new AppError(errorCode, `The ${service.toLowerCase()} response exceeded the safe size limit.`);
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) {
      throw new AppError(errorCode, `The ${service.toLowerCase()} response exceeded the safe size limit.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        throw new AppError(errorCode, `The ${service.toLowerCase()} response exceeded the safe size limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received).toString("utf8");
}

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function textValue(value) {
  if (typeof value === "string") return decodeXmlEntities(value);
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") return decodeXmlEntities(String(value["#text"] || ""));
  return "";
}

export function responseProperties(response) {
  const properties = {};
  for (const propstat of asArray(response?.propstat)) {
    if (textValue(propstat?.status).includes(" 200 ")) Object.assign(properties, propstat.prop || {});
  }
  return properties;
}

export function multistatusResponses(document) {
  return asArray(document?.multistatus?.response);
}

export function toSameOriginUrl(href, baseUrl, errorCode = "INVALID_DAV_PATH", message = "The DAV path is outside the configured service.") {
  const base = new URL(`${String(baseUrl).replace(/\/$/, "")}/`);
  let url;
  try {
    url = new URL(href || "/", base);
  } catch {
    throw new AppError(errorCode, "The DAV path is invalid.");
  }
  if (url.origin !== base.origin || url.protocol !== "https:" || url.username || url.password) {
    throw new AppError(errorCode, message);
  }
  return url;
}

export function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export function authSchemeFromChallenge(value) {
  const match = String(value || "").match(/^\s*([A-Za-z][A-Za-z0-9_-]{0,31})\b/);
  return match ? match[1].toLowerCase() : "";
}

function requestError(prefix, status, response) {
  let code = `${prefix}_REQUEST_FAILED`;
  let message = "The DAV service rejected the request.";
  if (status === 401) {
    code = `${prefix}_AUTH_FAILED`;
    message = "The configured DAV credentials were rejected.";
  } else if (status === 403) {
    code = `${prefix}_FORBIDDEN`;
    message = "The DAV service denied access to the requested resource.";
  } else if (status === 404) {
    code = `${prefix}_NOT_FOUND`;
    message = "The DAV resource was not found.";
  } else if (status === 405 || status === 501) {
    code = `${prefix}_UNSUPPORTED`;
    message = "The DAV service does not support this read-only request.";
  } else if (status === 429) {
    code = `${prefix}_RATE_LIMITED`;
    message = "The DAV service rate-limited the request.";
  } else if (status >= 500) {
    code = `${prefix}_UNAVAILABLE`;
    message = "The DAV service is unavailable.";
  }
  const error = new AppError(code, message);
  error.status = status;
  if (status === 401) {
    const authScheme = authSchemeFromChallenge(response?.headers?.get("www-authenticate"));
    if (authScheme) error.authScheme = authScheme;
  }
  return error;
}

export async function requestDav({
  baseUrl,
  username,
  password,
  requestTimeoutMs = 5_000,
  responseLimit = XML_BODY_LIMIT,
  errorPrefix = "DAV",
  serviceName = "DAV",
  allowSameOriginRedirects = false,
  contentType = "application/xml; charset=utf-8",
}, href, { method, body, depth, accept = "application/xml, text/calendar;q=0.9" }) {
  let url = toSameOriginUrl(
    href,
    baseUrl,
    `${errorPrefix}_INVALID_PATH`,
    `The ${serviceName.toLowerCase()} path is outside the configured service.`,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const request = () => fetch(url, {
        method,
        headers: {
          Authorization: basicAuthorization(username, password),
          Accept: accept,
          "Content-Type": contentType,
          ...(depth !== undefined ? { Depth: String(depth) } : {}),
        },
        body,
        redirect: allowSameOriginRedirects ? "manual" : "error",
        signal: controller.signal,
      });
    let response;
    if (!allowSameOriginRedirects) {
      response = await request();
    } else {
      for (let redirectCount = 0; ; redirectCount += 1) {
        response = await request();
        const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
        if (!isRedirect) break;
        const location = response.headers.get("location");
        if (!location || redirectCount >= 2) {
          throw new AppError(
            `${errorPrefix}_REDIRECT_FAILED`,
            "The DAV redirect was invalid or exceeded the safe hop limit.",
          );
        }
        url = toSameOriginUrl(
          location,
          baseUrl,
          `${errorPrefix}_INVALID_PATH`,
          "The DAV redirect is outside the configured service.",
        );
      }
    }
    if (!response.ok && response.status !== 207) throw requestError(errorPrefix, response.status, response);
    const effectiveResponseLimit = errorPrefix === "CARDDAV"
      ? Math.min(Number(responseLimit) || CARDDAV_BUFFERED_BODY_LIMIT, CARDDAV_BUFFERED_BODY_LIMIT)
      : responseLimit;
    const text = await readResponseTextBounded(
      response,
      effectiveResponseLimit,
      `${errorPrefix}_RESPONSE_TOO_LARGE`,
      serviceName,
    );
    return { response, text, url };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === "AbortError") {
      throw new AppError(`${errorPrefix}_TIMEOUT`, `The ${serviceName.toLowerCase()} service timed out.`);
    }
    throw new AppError(`${errorPrefix}_UNAVAILABLE`, `The ${serviceName.toLowerCase()} service is unavailable.`);
  } finally {
    clearTimeout(timeout);
  }
}
