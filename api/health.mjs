import { loadConfig } from "../src/config.mjs";

const baseBody = Object.freeze({
  service: "dooray-dbins-mcp",
  version: "1.0.0",
  transport: "streamable-http",
  endpointPattern: "/<64-character-token>/mcp",
});

export default function healthHandler(_req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    loadConfig();
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, ...baseBody }));
  } catch {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, ...baseBody }));
  }
}
