import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const compile = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.dooray.json"],
  { cwd: fileURLToPath(root), encoding: "utf8", stdio: "inherit" },
);
if (compile.status !== 0) throw new Error("Dooray TypeScript sources failed to compile.");

const vercel = JSON.parse(await readFile(new URL("vercel.json", root), "utf8"));
if (vercel.rewrites || vercel.headers) throw new Error("Low-level routes cannot be mixed with rewrites or headers");
const directApiGate = vercel.routes?.find((route) => route.src === "^/api/mcp$");
if (directApiGate?.status !== 404) throw new Error("Direct MCP API route must be blocked");
const mcpRoute = vercel.routes?.find((route) => route.dest?.startsWith("/api/mcp?"));
if (mcpRoute?.src !== "^/(?<path_token>[A-Za-z0-9_-]{64})/mcp$") throw new Error("Unexpected public MCP route");
if (mcpRoute?.dest !== "/api/mcp?__mcp_path_token=$path_token") throw new Error("Unexpected MCP rewrite target");
if (!vercel.routes?.some((route) => route.src === "^/api/health$" && route.dest === "/api/health")) throw new Error("Health routing must be preserved");
if (!vercel.routes?.some((route) => route.src === "^/$" && route.dest === "/index.html")) throw new Error("Public status page routing must be preserved");

const publicIndex = await readFile(new URL("public/index.html", root), "utf8");
if (!publicIndex.includes('content="noindex, nofollow, noarchive"')) throw new Error("Public status page must be noindex");
for (const forbidden of ["MCP_PATH_TOKEN", "MCP_ACCESS_TOKEN", "/mcp", "caldav.dooray.co.kr", "ldap.dooray.co.kr", "carddav.dooray.co.kr", "carddav-members.dooray.co.kr"]) {
  if (publicIndex.includes(forbidden)) throw new Error(`Public status page contains forbidden service detail: ${forbidden}`);
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.name.endsWith(".mjs")) files.push(path);
  }
  return files;
}

for (const file of await collect(fileURLToPath(root))) {
  if (file.includes("node_modules")) continue;
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${file}\n${result.stderr}`);
}

await import(new URL("src/server.mjs", root));
console.log("Build checks passed.");
