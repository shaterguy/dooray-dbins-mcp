import { createHash } from "node:crypto";
import { AppError } from "./errors.mjs";
import { contactSearchText } from "./vcard.mjs";

export const SEARCH_GET_LIMIT = 256;
const CONCURRENCY = 16;
export const SEARCH_BUDGET_MS = 40_000;
export function searchDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function decodeSearchCursor(value) {
  if (value === undefined) return null;
  const fail = () => { throw new AppError("CARDDAV_INVALID_CURSOR", "Use the returned cursor with the same search query and scope."); };
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { fail(); }
  if (!cursor || Array.isArray(cursor) || Object.keys(cursor).sort().join(",") !== "hash,offset,scope,skipped,unresolved,v"
    || cursor.v !== 1 || !/^[a-f0-9]{64}$/.test(cursor.scope) || !/^[a-f0-9]{64}$/.test(cursor.hash)
    || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 20_000
    || !Number.isInteger(cursor.skipped) || cursor.skipped < 0 || cursor.skipped > cursor.offset
    || typeof cursor.unresolved !== "boolean") fail();
  return cursor;
}
export function encodeSearchCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

// Entries and the reader come only from validated discovery, never from the cursor.
export async function scanResourcePage({ entries, query, limit, offset = 0, skipped = 0, deadline, read }) {
  const contacts = [];
  let requests = 0;
  let invalid = 0;
  let reason = null;
  let failureCode = null;
  const startOffset = offset;
  while (offset < entries.length && contacts.length < limit) {
    if (Date.now() >= deadline) { reason = "time_budget"; break; }
    if (requests >= SEARCH_GET_LIMIT) { reason = "request_budget"; break; }
    const batch = entries.slice(offset, offset + Math.min(CONCURRENCY, SEARCH_GET_LIMIT - requests));
    requests += batch.length;
    const loaded = await Promise.all(batch.map(async (entry) => {
      try { return { item: await read(entry) }; }
      catch (error) { return { error }; }
    }));
    for (let i = 0; i < loaded.length; i++) {
      const { item, error } = loaded[i];
      if (error || item?.missing) {
        reason = error?.code === "CARDDAV_SEARCH_BUDGET" ? "time_budget" : "resource_failed";
        failureCode = item?.missing ? "CARDDAV_NOT_FOUND" : error?.code;
        break;
      }
      const entry = batch[i];
      if (entry.etag && item.etag && entry.etag !== item.etag) {
        throw new AppError("CARDDAV_CURSOR_STALE", "The address book changed during this search. Restart without a cursor.");
      }
      offset += 1;
      if (item.invalid) { invalid += item.invalid; skipped += 1; }
      if (item.projected && contactSearchText(item.projected).includes(query.toLocaleLowerCase("ko-KR"))) contacts.push(item.projected);
      if (contacts.length >= limit) break;
    }
    if (reason) break;
  }
  if (!reason && offset < entries.length) reason = "result_limit";
  return { contacts, offset, skipped, invalid, requests, scanned: offset - startOffset, reason, failureCode };
}
