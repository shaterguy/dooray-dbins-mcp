import { createHash, timingSafeEqual } from "node:crypto";

export const PATH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/;

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

export function isValidPathToken(presentedToken, expectedToken) {
  const presented = typeof presentedToken === "string" ? presentedToken : "";
  const expected = typeof expectedToken === "string" ? expectedToken : "";
  const shapeIsValid = PATH_TOKEN_PATTERN.test(presented) && PATH_TOKEN_PATTERN.test(expected);
  const valueMatches = timingSafeEqual(digest(presented), digest(expected));
  return shapeIsValid && valueMatches;
}

export function readPathToken(req) {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const publicPathMatch = requestUrl.pathname.match(/^\/([A-Za-z0-9_-]{64})\/mcp$/);
  const isInternalPath = requestUrl.pathname === "/api/mcp";
  if (!isInternalPath && !publicPathMatch) return "";

  // Vercel can preserve the public request path in `req.url` after a route
  // rewrite while exposing destination parameters through `req.query`.
  // Only trust URL parameters when the URL itself is already the internal
  // function path; otherwise the route-injected `req.query` value is the
  // authentication source.
  const urlValues = isInternalPath
    ? requestUrl.searchParams.getAll("__mcp_path_token")
    : [];
  const queryValue = req.query?.__mcp_path_token;
  if (urlValues.length > 1 || Array.isArray(queryValue)) return "";

  const urlValue = urlValues[0];
  if (urlValue !== undefined && queryValue !== undefined && urlValue !== queryValue) return "";
  const candidate = typeof queryValue === "string" ? queryValue : urlValue || "";
  if (publicPathMatch && candidate !== publicPathMatch[1]) return "";
  return candidate;
}

