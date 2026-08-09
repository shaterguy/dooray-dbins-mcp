export type DoorayTokenInputFormat =
  | "raw"
  | "quoted"
  | "dooray-api-prefixed"
  | "authorization-header"
  | "environment-assignment";

export interface NormalizedDoorayToken {
  token: string;
  inputFormat: DoorayTokenInputFormat;
}

function stripMatchingQuotes(value: string): { value: string; stripped: boolean } {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return { value: value.slice(1, -1).trim(), stripped: true };
    }
  }
  return { value, stripped: false };
}

export function normalizeDoorayApiToken(rawValue: string): NormalizedDoorayToken {
  let value = rawValue.trim();
  let inputFormat: DoorayTokenInputFormat = "raw";

  const assignmentMatch = value.match(/^DOORAY_API_TOKEN\s*=\s*(.+)$/is);
  if (assignmentMatch) {
    value = assignmentMatch[1].trim();
    inputFormat = "environment-assignment";
  }

  const quoted = stripMatchingQuotes(value);
  if (quoted.stripped) {
    value = quoted.value;
    if (inputFormat === "raw") inputFormat = "quoted";
  }

  const authorizationMatch = value.match(/^Authorization\s*:\s*dooray-api\s+(.+)$/is);
  if (authorizationMatch) {
    value = authorizationMatch[1].trim();
    inputFormat = "authorization-header";
  } else {
    const prefixMatch = value.match(/^dooray-api\s+(.+)$/is);
    if (prefixMatch) {
      value = prefixMatch[1].trim();
      inputFormat = "dooray-api-prefixed";
    }
  }

  const quotedAfterPrefix = stripMatchingQuotes(value);
  if (quotedAfterPrefix.stripped) value = quotedAfterPrefix.value;

  if (!value) {
    throw new Error("DOORAY_API_TOKEN is empty after normalization.");
  }
  if (/\s/.test(value)) {
    throw new Error("DOORAY_API_TOKEN must contain only the raw token value without whitespace.");
  }
  if (value.length < 16 || value.length > 4096) {
    throw new Error("DOORAY_API_TOKEN length is outside the expected range.");
  }

  return { token: value, inputFormat };
}

