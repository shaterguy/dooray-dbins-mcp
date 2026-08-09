const MAX_TEXT_LENGTH = 4_000;

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function decodeText(value = "") {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .slice(0, MAX_TEXT_LENGTH);
}

function parseProperty(line) {
  const delimiter = line.indexOf(":");
  if (delimiter < 1) return null;
  const descriptor = line.slice(0, delimiter);
  const value = line.slice(delimiter + 1);
  const [rawName, ...rawParams] = descriptor.split(";");
  const params = Object.fromEntries(
    rawParams.map((part) => {
      const [key, ...rest] = part.split("=");
      return [key.toUpperCase(), rest.join("=").replace(/^"|"$/g, "")];
    }),
  );
  return { name: rawName.toUpperCase(), params, value };
}

function dateValue(property) {
  if (!property) return null;
  const { value, params } = property;
  if (/^\d{8}$/.test(value)) {
    return { value: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, allDay: true };
  }
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
    return { value: iso, allDay: false, timezone: "UTC" };
  }
  if (/^\d{8}T\d{6}$/.test(value)) {
    const offset = params.TZID === "Asia/Seoul" || !params.TZID ? "+09:00" : "";
    const local = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}${offset}`;
    return { value: local, allDay: false, timezone: params.TZID || "Asia/Seoul" };
  }
  return { value: value.slice(0, 64), allDay: params.VALUE === "DATE", timezone: params.TZID };
}

export function parseCalendarEvents(icalText, limit = 100) {
  const events = [];
  let current = null;

  for (const line of unfold(icalText)) {
    if (line === "BEGIN:VEVENT") {
      current = new Map();
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        const first = (name) => current.get(name)?.[0];
        events.push({
          uid: decodeText(first("UID")?.value || ""),
          summary: decodeText(first("SUMMARY")?.value || "(제목 없음)"),
          description: decodeText(first("DESCRIPTION")?.value || ""),
          location: decodeText(first("LOCATION")?.value || ""),
          status: decodeText(first("STATUS")?.value || ""),
          start: dateValue(first("DTSTART")),
          end: dateValue(first("DTEND")),
          organizer: decodeText(first("ORGANIZER")?.value || ""),
          recurrenceRule: decodeText(first("RRULE")?.value || ""),
        });
      }
      current = null;
      if (events.length >= limit) break;
      continue;
    }
    if (!current) continue;
    const property = parseProperty(line);
    if (!property) continue;
    const values = current.get(property.name) || [];
    values.push(property);
    current.set(property.name, values);
  }

  return events;
}

const WEEKDAYS = Object.freeze({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 });
const DAY_MS = 86_400_000;

function parseRule(rule = "") {
  const result = {};
  for (const part of rule.split(";")) {
    const [key, value] = part.split("=");
    if (key && value) result[key.toUpperCase()] = value.toUpperCase();
  }
  return result;
}

function parseByDay(value = "") {
  return value.split(",").map((item) => {
    const match = item.match(/^(-?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    return match ? { ordinal: match[1] ? Number(match[1]) : null, weekday: WEEKDAYS[match[2]] } : null;
  }).filter(Boolean);
}

function offsetMinutes(value = "") {
  if (value.endsWith("Z")) return 0;
  const match = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function wallDate(value, allDay = false) {
  if (allDay) return new Date(`${value}T00:00:00Z`);
  const date = new Date(value);
  return new Date(date.getTime() + offsetMinutes(value) * 60_000);
}

function dateString(date) {
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1).toString().padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
}

function formatWallDate(wall, originalValue) {
  if (originalValue.length === 10) return dateString(wall);
  const offset = offsetMinutes(originalValue);
  const actual = new Date(wall.getTime() - offset * 60_000);
  if (originalValue.endsWith("Z")) return actual.toISOString().replace(/\.\d{3}Z$/, "Z");
  const time = `${wall.getUTCHours().toString().padStart(2, "0")}:${wall.getUTCMinutes().toString().padStart(2, "0")}:${wall.getUTCSeconds().toString().padStart(2, "0")}`;
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  return `${dateString(wall)}T${time}${sign}${Math.floor(absolute / 60).toString().padStart(2, "0")}:${(absolute % 60).toString().padStart(2, "0")}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function addMonths(date, months) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    1,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function dayWithTime(year, month, day, source) {
  return new Date(Date.UTC(
    year,
    month,
    day,
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  ));
}

function startOfWeek(date, weekStart) {
  return addDays(date, -((date.getUTCDay() - weekStart + 7) % 7));
}

function nthWeekdayOfMonth(year, month, weekday, ordinal, source) {
  const lastDay = daysInMonth(year, month);
  if (ordinal > 0) {
    const first = dayWithTime(year, month, 1, source);
    const day = 1 + ((weekday - first.getUTCDay() + 7) % 7) + (ordinal - 1) * 7;
    return day <= lastDay ? dayWithTime(year, month, day, source) : null;
  }
  const last = dayWithTime(year, month, lastDay, source);
  const day = lastDay - ((last.getUTCDay() - weekday + 7) % 7) + (ordinal + 1) * 7;
  return day >= 1 ? dayWithTime(year, month, day, source) : null;
}

function parseUntil(value, allDay) {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T23:59:59.999Z`);
  const utcMatch = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utcMatch) return new Date(`${utcMatch[1]}-${utcMatch[2]}-${utcMatch[3]}T${utcMatch[4]}:${utcMatch[5]}:${utcMatch[6]}Z`);
  return new Date(value);
}

function occursInRange(start, end, rangeStart, rangeEnd) {
  return start < rangeEnd && end > rangeStart;
}

function occurrenceEvent(event, wallStart, durationMs, offset) {
  const actualStart = new Date(wallStart.getTime() - offset * 60_000);
  const actualEnd = new Date(actualStart.getTime() + durationMs);
  const start = { ...event.start, value: event.start.allDay ? dateString(wallStart) : formatWallDate(wallStart, event.start.value) };
  const end = event.end
    ? { ...event.end, value: event.end.allDay ? dateString(new Date(wallStart.getTime() + durationMs)) : formatWallDate(new Date(actualEnd.getTime() + offset * 60_000), event.end.value) }
    : event.end;
  return { ...event, start, end, recurrenceRule: "" };
}

function expandRecurringEvent(event, rangeStart, rangeEnd, limit) {
  const sourceStart = event.start;
  const sourceEnd = event.end;
  if (!sourceStart?.value) return [event];
  const offset = sourceStart.allDay ? 0 : offsetMinutes(sourceStart.value);
  const baseWall = wallDate(sourceStart.value, sourceStart.allDay);
  const baseActual = new Date(baseWall.getTime() - offset * 60_000);
  const endActual = sourceEnd?.value ? new Date(sourceEnd.value) : baseActual;
  const durationMs = Math.max(0, endActual.getTime() - new Date(sourceStart.value).getTime());
  const rule = parseRule(event.recurrenceRule);
  const frequency = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const countLimit = rule.COUNT ? Math.max(0, Number(rule.COUNT)) : null;
  const until = parseUntil(rule.UNTIL, sourceStart.allDay);
  const byDay = parseByDay(rule.BYDAY);
  const byMonthDay = (rule.BYMONTHDAY || "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter((day) => Number.isInteger(day) && day !== 0);
  const candidates = [];
  let occurrenceCount = 0;
  const addCandidate = (candidateWall) => {
    if (!candidateWall || candidateWall < baseWall) return false;
    const candidateActual = new Date(candidateWall.getTime() - offset * 60_000);
    if (until && candidateActual > until) return true;
    if (countLimit !== null && occurrenceCount >= countLimit) return true;
    occurrenceCount += 1;
    const candidateEnd = new Date(candidateActual.getTime() + durationMs);
    if (occursInRange(candidateActual, candidateEnd, rangeStart, rangeEnd)) {
      candidates.push(occurrenceEvent(event, candidateWall, durationMs, offset));
    }
    return false;
  };

  if (frequency === "DAILY") {
    for (let index = 0; index < 5000; index += 1) {
      if (addCandidate(addDays(baseWall, index * interval))) break;
      if (new Date(addDays(baseWall, index * interval).getTime() - offset * 60_000) >= rangeEnd && candidates.length >= limit) break;
    }
  } else if (frequency === "WEEKLY") {
    const weekStart = (rule.WKST && WEEKDAYS[rule.WKST]) ?? 1;
    const weekdays = (byDay.length ? byDay : [{ weekday: baseWall.getUTCDay(), ordinal: null }]).sort((a, b) => a.weekday - b.weekday);
    const firstWeek = startOfWeek(baseWall, weekStart);
    for (let week = 0; week < 520; week += 1) {
      for (const item of weekdays) {
        const dayOffset = (item.weekday - weekStart + 7) % 7;
        if (addCandidate(addDays(firstWeek, week * interval * 7 + dayOffset))) break;
      }
      if (new Date(addDays(firstWeek, week * interval * 7).getTime() - offset * 60_000) >= rangeEnd && candidates.length >= limit) break;
    }
  } else if (frequency === "MONTHLY") {
    for (let month = 0; month < 240; month += 1) {
      const monthDate = addMonths(baseWall, month * interval);
      const year = monthDate.getUTCFullYear();
      const monthIndex = monthDate.getUTCMonth();
      const monthCandidates = [];
      if (byMonthDay.length) {
        const lastDay = daysInMonth(year, monthIndex);
        for (const day of byMonthDay) {
          const resolved = day > 0 ? day : lastDay + day + 1;
          if (resolved >= 1 && resolved <= lastDay) monthCandidates.push(dayWithTime(year, monthIndex, resolved, baseWall));
        }
      } else if (byDay.length) {
        for (const item of byDay) {
          if (item.ordinal) {
            const candidate = nthWeekdayOfMonth(year, monthIndex, item.weekday, item.ordinal, baseWall);
            if (candidate) monthCandidates.push(candidate);
          } else {
            for (let day = 1; day <= daysInMonth(year, monthIndex); day += 1) {
              const candidate = dayWithTime(year, monthIndex, day, baseWall);
              if (candidate.getUTCDay() === item.weekday) monthCandidates.push(candidate);
            }
          }
        }
      } else if (baseWall.getUTCDate() <= daysInMonth(year, monthIndex)) {
        monthCandidates.push(dayWithTime(year, monthIndex, baseWall.getUTCDate(), baseWall));
      }
      monthCandidates.sort((a, b) => a - b);
      for (const candidate of monthCandidates) addCandidate(candidate);
      if (new Date(monthDate.getTime() - offset * 60_000) >= rangeEnd && candidates.length >= limit) break;
    }
  } else {
    const candidateActual = new Date(baseActual);
    if (occursInRange(candidateActual, new Date(candidateActual.getTime() + durationMs), rangeStart, rangeEnd)) return [event];
  }

  return candidates.slice(0, limit);
}

export function expandCalendarEvents(events, rangeStart, rangeEnd, limit = 100) {
  if (!(rangeStart instanceof Date) || !(rangeEnd instanceof Date)) return events.slice(0, limit);
  const expanded = [];
  for (const event of events) {
    if (event.recurrenceRule) expanded.push(...expandRecurringEvent(event, rangeStart, rangeEnd, limit - expanded.length));
    else if (event.start?.value) {
      const start = new Date(event.start.value);
      const end = new Date(event.end?.value || event.start.value);
      if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && occursInRange(start, end, rangeStart, rangeEnd)) expanded.push(event);
    } else expanded.push(event);
    if (expanded.length >= limit) break;
  }
  return expanded.slice(0, limit);
}

