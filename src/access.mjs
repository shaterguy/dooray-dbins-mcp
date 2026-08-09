import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

function secureEqual(actual, expected) {
  return timingSafeEqual(digest(actual), digest(expected));
}

export function readMcpAccessKey(req) {
  const authorization = req.headers?.authorization;
  const bearer = Array.isArray(authorization) ? "" : String(authorization || "").trim();
  if (bearer.toLowerCase().startsWith("bearer ")) return bearer.slice(7).trim();

  const headerKey = req.headers?.["x-mcp-access-key"];
  if (Array.isArray(headerKey)) return "";
  if (headerKey) return String(headerKey).trim();

  const requestUrl = new URL(req.url || "/", "http://localhost");
  const queryKey = requestUrl.searchParams.getAll("access_key");
  if (queryKey.length !== 1) return "";
  return queryKey[0].trim();
}

export function authorizeMcpAccessKey(req, expected = process.env.MCP_ACCESS_KEY) {
  const configured = typeof expected === "string" ? expected.trim() : "";
  if (!configured) return { ok: true, status: 200 };
  const presented = readMcpAccessKey(req);
  if (!presented || !secureEqual(presented, configured)) {
    return { ok: false, status: 401, message: "MCP access key is missing or invalid." };
  }
  return { ok: true, status: 200 };
}

