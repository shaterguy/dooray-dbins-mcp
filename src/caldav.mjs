import { XMLParser } from "fast-xml-parser";
import { AppError } from "./errors.mjs";
import { expandCalendarEvents, parseCalendarEvents } from "./ical.mjs";

const XML_BODY_LIMIT = 5 * 1024 * 1024;
export const CALDAV_ENTRY_PATH = "/caldav/";
const CALENDAR_MULTIGET_BATCH_SIZE = 10;
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
    throw new AppError("UNSAFE_XML", "The calendar service returned unsupported XML declarations.");
  }
  return parser.parse(xml);
}

export async function readResponseTextBounded(response, limit = XML_BODY_LIMIT) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > limit) {
    throw new AppError("CALDAV_RESPONSE_TOO_LARGE", "The calendar response exceeded the safe size limit.");
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) {
      throw new AppError("CALDAV_RESPONSE_TOO_LARGE", "The calendar response exceeded the safe size limit.");
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
        throw new AppError("CALDAV_RESPONSE_TOO_LARGE", "The calendar response exceeded the safe size limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received).toString("utf8");
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (typeof value === "string") return decodeXmlEntities(value);
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") return decodeXmlEntities(String(value["#text"] || ""));
  return "";
}

function responseProperties(response) {
  const properties = {};
  for (const propstat of asArray(response?.propstat)) {
    if (textValue(propstat?.status).includes(" 200 ")) Object.assign(properties, propstat.prop || {});
  }
  return properties;
}

function multistatusResponses(document) {
  return asArray(document?.multistatus?.response);
}

export function toCalDavUrl(href, config) {
  const base = new URL(`${config.caldavServerUrl}/`);
  let url;
  try {
    url = new URL(href || "/", base);
  } catch {
    throw new AppError("INVALID_CALENDAR_PATH", "The calendar path is invalid.");
  }
  if (url.origin !== base.origin || url.protocol !== "https:" || url.username || url.password) {
    throw new AppError("INVALID_CALENDAR_PATH", "The calendar path is outside the configured service.");
  }
  return url;
}

async function caldavRequest(config, href, { method, body, depth }) {
  const url = toCalDavUrl(href, config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const authorization = Buffer.from(
    `${config.secrets.caldavUsername}:${config.secrets.caldavPassword}`,
    "utf8",
  ).toString("base64");

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${authorization}`,
        Accept: "application/xml, text/calendar;q=0.9",
        "Content-Type": "application/xml; charset=utf-8",
        ...(depth !== undefined ? { Depth: String(depth) } : {}),
      },
      body,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 207) {
      throw new AppError("CALDAV_REQUEST_FAILED", "The calendar service rejected the request.");
    }
    return await readResponseTextBounded(response);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === "AbortError") {
      throw new AppError("CALDAV_TIMEOUT", "The calendar service timed out.");
    }
    throw new AppError("CALDAV_UNAVAILABLE", "The calendar service is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}

async function propfind(config, href, depth, properties) {
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>${properties}</d:prop>
</d:propfind>`;
  const xml = await caldavRequest(config, href, { method: "PROPFIND", body, depth });
  return parseDavXml(xml);
}

async function calendarHomeHref(config) {
  const principalDoc = await propfind(config, CALDAV_ENTRY_PATH, 0, "<d:current-user-principal />");
  const principalResponse = multistatusResponses(principalDoc)[0];
  const principalHref = textValue(responseProperties(principalResponse)?.["current-user-principal"]?.href);
  if (!principalHref) throw new AppError("CALDAV_DISCOVERY_FAILED", "The calendar principal could not be discovered.");

  const homeDoc = await propfind(config, principalHref, 0, "<c:calendar-home-set />");
  const homeResponse = multistatusResponses(homeDoc)[0];
  const homeHref = textValue(responseProperties(homeResponse)?.["calendar-home-set"]?.href);
  if (!homeHref) throw new AppError("CALDAV_DISCOVERY_FAILED", "The calendar home could not be discovered.");
  return toCalDavUrl(homeHref, config).pathname;
}

export async function listCalendars(config) {
  const homeHref = await calendarHomeHref(config);
  const document = await propfind(
    config,
    homeHref,
    1,
    "<d:displayname /><d:resourcetype /><cs:getctag /><c:supported-calendar-component-set />",
  );

  return multistatusResponses(document)
    .map((response) => {
      const properties = responseProperties(response);
      const resourceType = properties.resourcetype || {};
      if (!("calendar" in resourceType)) return null;
      const href = toCalDavUrl(textValue(response.href), config).pathname;
      return {
        href,
        displayName: textValue(properties.displayname) || href,
        changeTag: textValue(properties.getctag),
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

function validateRange(start, end, config) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate >= endDate) {
    throw new AppError("INVALID_DATE_RANGE", "Start and end must be valid ISO dates, with start before end.");
  }
  const rangeDays = (endDate - startDate) / 86_400_000;
  if (rangeDays > config.maxCalendarRangeDays) {
    throw new AppError("DATE_RANGE_TOO_LARGE", `The calendar range may not exceed ${config.maxCalendarRangeDays} days.`);
  }
  const caldavTime = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { startDate, endDate, startValue: caldavTime(startDate), endValue: caldavTime(endDate) };
}

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function eventOverlapsRange(event, startDate, endDate) {
  if (event.recurrenceRule) return true;
  const eventStart = new Date(event.start?.value || "");
  if (!Number.isFinite(eventStart.getTime())) return true;
  const eventEnd = new Date(event.end?.value || event.start?.value || "");
  if (!Number.isFinite(eventEnd.getTime())) return eventStart < endDate && eventStart >= startDate;
  return eventStart < endDate && eventEnd > startDate;
}

function parsedEventsFromResponses(document, config, limit, range) {
  const events = [];
  for (const response of multistatusResponses(document)) {
    const properties = responseProperties(response);
    const calendarData = textValue(properties["calendar-data"]);
    if (!calendarData) continue;
    const rawHref = textValue(response.href);
    if (!rawHref) continue;
    const resourceHref = toCalDavUrl(rawHref, config).pathname;
    const parsed = expandCalendarEvents(
      parseCalendarEvents(calendarData, limit - events.length),
      range?.startDate,
      range?.endDate,
      limit - events.length,
    );
    for (const event of parsed) {
      if (range && !eventOverlapsRange(event, range.startDate, range.endDate)) continue;
      events.push({ ...event, resourceHref, etag: textValue(properties.getetag) });
      if (events.length >= limit) break;
    }
    if (events.length >= limit) break;
  }
  return events;
}

function responseStats(document) {
  const responses = multistatusResponses(document);
  const statusCodes = new Set();
  const successfulPropertyKeys = new Set();
  let propstats = 0;
  for (const response of responses) {
    for (const propstat of asArray(response?.propstat)) {
      propstats += 1;
      const status = textValue(propstat?.status);
      const statusCode = status.match(/\b\d{3}\b/)?.[0] || "unknown";
      statusCodes.add(statusCode);
      if (statusCode === "200") {
        for (const key of Object.keys(propstat.prop || {})) successfulPropertyKeys.add(key);
      }
    }
  }
  return {
    resources: responses.length,
    propstats,
    statusCodes: [...statusCodes].sort(),
    successfulPropertyKeys: [...successfulPropertyKeys].sort(),
    calendarData: responses.filter((response) => Boolean(textValue(responseProperties(response)["calendar-data"]))).length,
  };
}

function responseResourceHrefs(document, config, limit) {
  return multistatusResponses(document)
    .map((response) => {
      const rawHref = textValue(response.href);
      return rawHref ? toCalDavUrl(rawHref, config).pathname : null;
    })
    .filter(Boolean)
    .slice(0, limit);
}

async function calendarEventHrefs(config, calendarHref, limit) {
  const document = await propfind(config, calendarHref, 1, "<d:getetag /><d:resourcetype />");
  return multistatusResponses(document)
    .map((response) => {
      const rawHref = textValue(response.href);
      if (!rawHref) return null;
      const href = toCalDavUrl(rawHref, config).pathname;
      if (href === calendarHref) return null;
      const resourceType = responseProperties(response).resourcetype || {};
      if ("calendar" in resourceType) return null;
      return href;
    })
    .filter(Boolean)
    .slice(0, limit);
}

function calendarDataProperty(range) {
  const expansion = range
    ? `<c:expand start="${range.startValue}" end="${range.endValue}" />`
    : "";
  return `<c:calendar-data content-type="text/calendar" version="2.0">${expansion}</c:calendar-data>`;
}

async function calendarMultiget(config, calendarHref, eventHrefs, range) {
  if (eventHrefs.length === 0) return null;
  const hrefs = eventHrefs.map((href) => `<d:href>${escapeXmlText(href)}</d:href>`).join("");
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag />${calendarDataProperty(range)}</d:prop>
  ${hrefs}
</c:calendar-multiget>`;
  const xml = await caldavRequest(config, calendarHref, { method: "REPORT", body });
  return parseDavXml(xml);
}

async function calendarMultigetEvents(config, calendarHref, eventHrefs, limit, range) {
  const events = [];
  const stats = [];
  for (let offset = 0; offset < eventHrefs.length && events.length < limit; offset += CALENDAR_MULTIGET_BATCH_SIZE) {
    const batch = eventHrefs.slice(offset, offset + CALENDAR_MULTIGET_BATCH_SIZE);
    const document = await calendarMultiget(config, calendarHref, batch, range);
    stats.push(responseStats(document));
    events.push(...parsedEventsFromResponses(document, config, limit - events.length, range));
  }
  return { events, stats };
}

function calendarQueryBody(range) {
  const timeRange = range
    ? `<c:time-range start="${range.startValue}" end="${range.endValue}" />`
    : "";
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag />${calendarDataProperty(range)}</d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${timeRange}
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
}

async function calendarQuery(config, calendarHref, range) {
  const xml = await caldavRequest(config, calendarHref, {
    method: "REPORT",
    body: calendarQueryBody(range),
    depth: 1,
  });
  return parseDavXml(xml);
}

export async function getEvents(config, { calendarHref, start, end, limit = 50 }) {
  const normalizedHref = toCalDavUrl(calendarHref, config).pathname;
  if (calendarHref !== normalizedHref) {
    throw new AppError("INVALID_CALENDAR_PATH", "Use an exact calendar href returned by calendar_list_calendars.");
  }
  const readableCalendars = await listCalendars(config);
  if (!readableCalendars.some((calendar) => calendar.href === normalizedHref)) {
    throw new AppError("INVALID_CALENDAR_PATH", "Use an exact calendar href returned by calendar_list_calendars.");
  }
  const range = validateRange(start, end, config);
  const safeLimit = Math.min(Math.max(limit, 1), config.maxCalendarResults);
  const document = await calendarQuery(config, normalizedHref, range);
  let events = parsedEventsFromResponses(document, config, safeLimit, range);
  let candidateHrefs = responseResourceHrefs(document, config, safeLimit);
  const diagnostics = {
    timeRangeQuery: responseStats(document),
    parsedAfterTimeRangeQuery: events.length,
    queryEventResources: candidateHrefs.length,
  };

  if (events.length === 0 && candidateHrefs.length === 0) {
    const broadDocument = await calendarQuery(config, normalizedHref);
    events = parsedEventsFromResponses(broadDocument, config, safeLimit, range);
    candidateHrefs = [...new Set([
      ...candidateHrefs,
      ...responseResourceHrefs(broadDocument, config, safeLimit),
    ])].slice(0, safeLimit);
    diagnostics.unboundedQuery = responseStats(broadDocument);
    diagnostics.parsedAfterUnboundedQuery = events.length;
    diagnostics.queryEventResources = candidateHrefs.length;
  }

  if (events.length === 0) {
    const discoveredHrefs = candidateHrefs.length > 0
      ? []
      : await calendarEventHrefs(config, normalizedHref, safeLimit);
    const eventHrefs = [...new Set([...candidateHrefs, ...discoveredHrefs])].slice(0, safeLimit);
    const multigetResult = await calendarMultigetEvents(
      config,
      normalizedHref,
      eventHrefs,
      safeLimit,
      range,
    );
    diagnostics.discoveredEventResources = discoveredHrefs.length;
    diagnostics.multigetRequestedResources = eventHrefs.length;
    events = multigetResult.events;
    diagnostics.multiget = multigetResult.stats;
    diagnostics.parsedAfterMultiget = events.length;
  }
  if (events.length === 0) console.log("[caldav] empty event lookup", diagnostics);
  return { start: range.startDate.toISOString(), end: range.endDate.toISOString(), events };
}

export async function searchEvents(config, { calendarHref, query, start, end, limit = 25 }) {
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const result = await getEvents(config, {
    calendarHref,
    start,
    end,
    limit: config.maxCalendarResults,
  });
  const events = result.events.filter((event) =>
    [event.summary, event.description, event.location, event.organizer]
      .join("\n")
      .toLocaleLowerCase("ko-KR")
      .includes(normalizedQuery),
  );
  return { ...result, query, events: events.slice(0, Math.min(limit, 50)) };
}

export async function checkCalDav(config) {
  await caldavRequest(config, CALDAV_ENTRY_PATH, { method: "OPTIONS" });
  return { ok: true };
}

