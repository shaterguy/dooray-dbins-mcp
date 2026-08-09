import { createMcpServer } from "../src/server.mjs";
import { isValidPathToken, readPathToken } from "../src/auth.mjs";
import { ConfigurationError, loadConfig, loadPathToken } from "../src/config.mjs";
import { RequestGate, requestClientKey } from "../src/request-gate.mjs";
import { authorizeMcpAccessKey } from "../src/access.mjs";

const ALLOWED_METHODS = new Set(["POST", "GET", "DELETE", "OPTIONS"]);
const DEFAULT_ALLOWED_ORIGINS = ["https://chatgpt.com", "https://www.chatgpt.com", "https://chat.openai.com"];
const requestGate = new RequestGate();

function applySecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function applyCorsHeaders(req, res) {
  const origin = req.headers?.origin;
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version, last-event-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (!origin) return true;
  const allowedOrigins = new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(process.env.MCP_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
  ]);
  if (!allowedOrigins.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendNotFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

async function readBoundedJsonBody(req) {
  if (req.body !== undefined) {
    const size = Buffer.byteLength(typeof req.body === "string" ? req.body : JSON.stringify(req.body), "utf8");
    if (size > 65_536) throw new Error("PAYLOAD_TOO_LARGE");
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export default async function mcpHandler(req, res) {
  applySecurityHeaders(res);

  let expectedToken;
  try {
    expectedToken = loadPathToken();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return sendJson(res, 503, { error: "service_unavailable" });
    }
    throw error;
  }

  const presentedToken = readPathToken(req);
  if (!isValidPathToken(presentedToken, expectedToken)) return sendNotFound(res);

  const access = authorizeMcpAccessKey(req);
  if (!access.ok) return sendJson(res, access.status, { error: "unauthorized" });

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return sendJson(res, 503, { error: "service_unavailable" });
    }
    throw error;
  }

  if (!applyCorsHeaders(req, res)) return sendJson(res, 403, { error: "origin_not_allowed" });

  const permit = requestGate.enter(requestClientKey(req));
  if (!permit.ok) {
    res.setHeader("Retry-After", String(permit.retryAfterSeconds));
    return sendJson(res, 429, { error: "too_many_requests" });
  }

  try {
    return await handleAuthenticatedRequest(req, res, config);
  } finally {
    permit.release();
  }
}

async function handleAuthenticatedRequest(req, res, config) {

  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 65_536) {
    return sendJson(res, 413, { error: "payload_too_large" });
  }

  if (!ALLOWED_METHODS.has(req.method)) {
    res.setHeader("Allow", "POST, GET, OPTIONS, DELETE");
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === "GET" || req.method === "DELETE") {
    res.setHeader("Allow", "POST, OPTIONS");
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.["content-type"] || "")) {
    return sendJson(res, 415, { error: "unsupported_media_type" });
  }

  let parsedBody;
  if (req.method === "POST") {
    try {
      parsedBody = await readBoundedJsonBody(req);
    } catch (error) {
      if (error.message === "PAYLOAD_TOO_LARGE") return sendJson(res, 413, { error: "payload_too_large" });
      return sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
    }
  }

  const { server, transport } = createMcpServer(config);
  const close = () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  };
  res.once("close", close);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
