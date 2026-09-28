import http from "node:http";
import { createMcpServer } from "../src/server.mjs";
import { FIXED_CONFIG } from "../src/config.mjs";
import { getOrganizationCardDavIndexStatus, startOrganizationCardDavIndexWarmup } from "../src/carddav.mjs";

const port = Number(process.env.PORT || "17844");
const baseUrl = new URL((process.env.DOORAY_BASE_URL || "https://api.dooray.com").trim());
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";
const allowedHosts = new Set([
  baseUrl.hostname.toLowerCase(),
  ...(process.env.DOORAY_ALLOWED_HOSTS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
]);
const int = (name, fallback, min, max) => {
  const v = Number(process.env[name] || fallback);
  return Number.isInteger(v) && v >= min && v <= max ? v : fallback;
};
const config = Object.freeze({
  ...FIXED_CONFIG,
  secrets: Object.freeze({
    pathToken: "",
    mcpAccessKey: "",
    doorayUsername: process.env.DOORAY_USERNAME || "",
    doorayPassword: process.env.DOORAY_PASSWORD || "",
    caldavUsername: process.env.DOORAY_USERNAME || "",
    caldavPassword: process.env.DOORAY_PASSWORD || "",
    ldapBindDn: process.env.DOORAY_USERNAME || "",
    ldapPassword: process.env.DOORAY_PASSWORD || "",
    doorayApiToken: (process.env.DOORAY_API_TOKEN || "").trim(),
  }),
  dooray: Object.freeze({
    apiToken: (process.env.DOORAY_API_TOKEN || "").trim(),
    tokenInputFormat: process.env.DOORAY_API_TOKEN ? "configured" : "missing",
    baseUrl,
    allowedHosts,
    timeoutMs: int("DOORAY_TIMEOUT_MS", 20000, 1000, 60000),
    maxResponseBytes: int("DOORAY_MAX_RESPONSE_BYTES", 2000000, 10000, 10000000),
    maxToolTextChars: int("DOORAY_MAX_TOOL_TEXT_CHARS", 120000, 5000, 500000),
  }),
});
const credentialStatus = () => ({
  DOORAY_USERNAME: Boolean(process.env.DOORAY_USERNAME),
  DOORAY_PASSWORD: Boolean(process.env.DOORAY_PASSWORD),
  DOORAY_API_TOKEN: Boolean(process.env.DOORAY_API_TOKEN),
});
async function bodyJson(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const server = http.createServer(async (req,res) => {
  res.setHeader("Cache-Control","no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({ok:true,service:"dooray-dbins-mcp",version:"1.0.0",transport:"streamable-http",loopback:true,credentialStatus:credentialStatus(),organizationContactIndex:getOrganizationCardDavIndexStatus()}));
    return;
  }
  if (req.url !== "/mcp" || req.method !== "POST") {
    res.writeHead(404,{"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({error:"not_found"}));
    return;
  }
  try {
    const parsedBody=await bodyJson(req);
    const built=createMcpServer(config);
    res.once("close",()=>{ void built.transport.close().catch(()=>{}); void built.server.close().catch(()=>{}); });
    await built.server.connect(built.transport);
    await built.transport.handleRequest(req,res,parsedBody);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500,{"content-type":"application/json; charset=utf-8"});
      res.end(JSON.stringify({jsonrpc:"2.0",error:{code:-32603,message:"Internal server error"},id:null}));
    } else if (!res.writableEnded) res.end();
  }
});
server.listen(port,"127.0.0.1",()=>{
  console.log("dooray-dbins local MCP listening on 127.0.0.1:"+port);
  startOrganizationCardDavIndexWarmup(config);
});
