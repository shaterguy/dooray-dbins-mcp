import { listAddressBooks } from "./carddav.mjs";
import { toolFailure, toolSuccess } from "./errors.mjs";

const SOURCES = new Set(["personal", "organization"]);
const LABELS = new Set(["well_known", "root", "legacy_carddav"]);
const AUTH_SCHEMES = new Set(["basic", "digest", "bearer", "negotiate", "ntlm"]);
const CODES = new Set([
  "DISCOVERY_OK", "UPSTREAM_ERROR",
  "CARDDAV_NOT_CONFIGURED", "CARDDAV_AUTH_FAILED", "CARDDAV_FORBIDDEN",
  "CARDDAV_NOT_FOUND", "CARDDAV_UNSUPPORTED", "CARDDAV_RATE_LIMITED",
  "CARDDAV_UNAVAILABLE", "CARDDAV_TIMEOUT", "CARDDAV_REQUEST_FAILED",
  "CARDDAV_DISCOVERY_FAILED", "CARDDAV_INVALID_PATH", "CARDDAV_INVALID_RESPONSE",
  "CARDDAV_RESPONSE_TOO_LARGE", "CARDDAV_REDIRECT_FAILED", "CARDDAV_METHOD_NOT_ALLOWED",
]);

function safeStatus(value) {
  if (value === null || value === undefined) return null;
  if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  return CODES.has(value) ? value : "UPSTREAM_ERROR";
}

// Rebuild every field; never serialize upstream objects, headers, URLs or messages.
export function safeDiscoveryDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.slice(0, 2).filter((entry) => SOURCES.has(entry?.source)).map((entry) => ({
    source: entry.source,
    paths: (Array.isArray(entry.paths) ? entry.paths : []).slice(0, 3)
      .filter((path) => LABELS.has(path?.label)).map((path) => ({
        label: path.label,
        options: safeStatus(path.options),
        standard: safeStatus(path.standard),
        direct: safeStatus(path.direct),
        ...(AUTH_SCHEMES.has(path.authScheme) ? { authScheme: path.authScheme } : {}),
      })),
  }));
}

export async function listAddressBooksResult(config, { source = "all" } = {}) {
  const diagnostics = [];
  try {
    const data = await listAddressBooks(config, { source, diagnostics });
    if (data.sources.some((entry) => entry.status === "error")) {
      data.diagnostics = safeDiscoveryDiagnostics(diagnostics);
    }
    return toolSuccess(data, "CardDAV address book discovery completed.");
  } catch (error) {
    const failure = toolFailure(error);
    failure.structuredContent.data = { diagnostics: safeDiscoveryDiagnostics(diagnostics) };
    return failure;
  }
}
