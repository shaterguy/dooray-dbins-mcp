import { AppError } from "./errors.mjs";

export const VCARD_ALLOWED_PROPERTIES = Object.freeze([
  "VERSION",
  "UID",
  "FN",
  "N",
  "EMAIL",
  "TEL",
  "ORG",
  "TITLE",
]);

const MAX_LINE_BYTES = 16 * 1024;
const MAX_PROPERTY_COUNT = 256;
const MAX_VALUE_LENGTH = 2_000;
const MAX_MULTI_VALUE_COUNT = 20;

function splitEscaped(value, delimiter) {
  const parts = [];
  let current = "";
  let escaped = false;
  let quoted = false;
  for (const char of String(value)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === delimiter && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function splitFirstUnescaped(value, delimiter) {
  let escaped = false;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) return [value.slice(0, index), value.slice(index + 1)];
  }
  return [value, ""];
}

function decodeQuotedPrintable(value) {
  const input = Buffer.from(String(value), "utf8");
  const bytes = [];
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === 0x3d && index + 2 < input.length) {
      const hex = String.fromCharCode(input[index + 1], input[index + 2]);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(input[index]);
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeText(value, encoding = "") {
  const decoded = encoding.toLowerCase() === "quoted-printable"
    ? decodeQuotedPrintable(value)
    : String(value);
  return decoded.replace(/\\([nN,;\\:])/g, (_match, escaped) => ({
    n: "\n",
    N: "\n",
    ",": ",",
    ";": ";",
    "\\": "\\",
    ":": ":",
  }[escaped]));
}

function unfoldedLines(input) {
  return String(input)
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r\n|\n|\r/)
    .filter((line) => line.length > 0);
}

function parseProperty(line) {
  const [left, rawValue] = splitFirstUnescaped(line, ":");
  const segments = splitEscaped(left, ";");
  const rawName = segments.shift() || "";
  const name = rawName.includes(".") ? rawName.slice(rawName.lastIndexOf(".") + 1) : rawName;
  const parameters = {};
  for (const segment of segments) {
    const [key, rawParameterValue] = splitFirstUnescaped(segment, "=");
    if (!rawParameterValue) continue;
    const normalizedKey = key.toUpperCase();
    parameters[normalizedKey] = splitEscaped(rawParameterValue.replace(/^"|"$/g, ""), ",")
      .map((item) => item.replace(/^"|"$/g, ""));
  }
  return { name: name.toUpperCase(), parameters, rawValue };
}

function safeValue(value, propertyName) {
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_LENGTH) {
    throw new AppError("CARDDAV_INVALID_VCARD", `The vCard ${propertyName.toLowerCase()} value is too large.`);
  }
  return value;
}

function propertyEncoding(parameters) {
  return parameters.ENCODING?.[0] || "";
}

function safeTypes(parameters) {
  return (parameters.TYPE || [])
    .map((type) => type.trim().toLowerCase())
    .filter((type) => /^[a-z0-9_-]{1,32}$/.test(type))
    .slice(0, 8);
}

function safePref(parameters) {
  const value = Number(parameters.PREF?.[0]);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : undefined;
}

export function parseVCard(input, { maxBytes = 512 * 1024 } = {}) {
  if (Buffer.byteLength(String(input), "utf8") > maxBytes) {
    throw new AppError("CARDDAV_INVALID_VCARD", "The vCard exceeded the safe size limit.");
  }
  const lines = unfoldedLines(input);
  if (!lines.some((line) => /^BEGIN:VCARD$/i.test(line)) || !lines.some((line) => /^END:VCARD$/i.test(line))) {
    throw new AppError("CARDDAV_INVALID_VCARD", "The DAV resource was not a complete vCard.");
  }

  const contact = {
    uid: "",
    version: "",
    formattedName: "",
    name: { family: "", given: "", additional: "", prefix: "", suffix: "" },
    emails: [],
    phones: [],
    organization: "",
    title: "",
  };
  let propertyCount = 0;
  let inCard = false;
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      throw new AppError("CARDDAV_INVALID_VCARD", "The vCard line exceeded the safe size limit.");
    }
    if (/^BEGIN:VCARD$/i.test(line)) {
      if (inCard) throw new AppError("CARDDAV_INVALID_VCARD", "The DAV resource contained nested vCards.");
      inCard = true;
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      inCard = false;
      continue;
    }
    if (!inCard) continue;
    propertyCount += 1;
    if (propertyCount > MAX_PROPERTY_COUNT) {
      throw new AppError("CARDDAV_INVALID_VCARD", "The vCard contained too many properties.");
    }
    const property = parseProperty(line);
    if (!VCARD_ALLOWED_PROPERTIES.includes(property.name)) continue;
    const value = safeValue(decodeText(property.rawValue, propertyEncoding(property.parameters)), property.name);
    if (property.name === "VERSION") {
      if (value === "3.0" || value === "4.0") contact.version = value;
    } else if (property.name === "UID") {
      contact.uid = value;
    } else if (property.name === "FN") {
      contact.formattedName = value;
    } else if (property.name === "N") {
      const [family = "", given = "", additional = "", prefix = "", suffix = ""] = splitEscaped(value, ";")
        .map((part) => decodeText(part));
      contact.name = { family, given, additional, prefix, suffix };
    } else if (property.name === "ORG") {
      contact.organization = value;
    } else if (property.name === "TITLE") {
      contact.title = value;
    } else if (property.name === "EMAIL" || property.name === "TEL") {
      const list = property.name === "EMAIL" ? contact.emails : contact.phones;
      if (list.length < MAX_MULTI_VALUE_COUNT) {
        const item = { value };
        const types = safeTypes(property.parameters);
        const pref = safePref(property.parameters);
        if (types.length > 0) item.types = types;
        if (pref !== undefined) item.pref = pref;
        list.push(item);
      }
    }
  }
  if (inCard) throw new AppError("CARDDAV_INVALID_VCARD", "The DAV resource was not a complete vCard.");
  return contact;
}

export function contactSearchText(contact) {
  return [
    contact.formattedName,
    contact.name?.family,
    contact.name?.given,
    contact.name?.additional,
    contact.name?.prefix,
    contact.name?.suffix,
    contact.organization,
    contact.title,
    ...(contact.emails || []).map((item) => item.value),
    ...(contact.phones || []).map((item) => item.value),
  ].join("\n").toLocaleLowerCase("ko-KR");
}

export function projectContact(contact, { source, addressBookHref, href }) {
  return {
    source,
    addressBookHref,
    href,
    uid: contact.uid || href,
    version: contact.version || "unknown",
    formattedName: contact.formattedName,
    name: contact.name,
    emails: contact.emails,
    phones: contact.phones,
    organization: contact.organization,
    title: contact.title,
  };
}
