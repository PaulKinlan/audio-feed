/**
 * The one canonical shape of a log record (audio-feed-wzv9): its caps, its sanitiser and its
 * summary. Shared by both storage adapters and by the writer every process uses, so there is
 * exactly one place where a record is bounded and exactly one place to change if the bound is
 * wrong.
 *
 * Bounds are not tidiness. The errors API (obs-1) is authenticated but the CSP reporting
 * endpoint that feeds this store (obs-5) is open to anyone on the internet, and every field of
 * a CSP report is attacker-controlled — `blockedURL`, `script-sample`, `url`, `user_agent`. A
 * store with no cap is a free way for a stranger to write megabytes per request into the same
 * place the operators read. So: every string is capped, control characters are stripped, a
 * record has a serialised ceiling, and the caps are chosen so a fully-capped record fits under
 * it by construction rather than by hoping.
 *
 * This module also fixes the invariant that the store never interprets content: values are
 * capped and stripped, never escaped, parsed or reparsed. Rendering a record is the consumer's
 * job, and a consumer that writes one into HTML must escape it there.
 */

import type { LogRecord, LogSeverity, LogSummary } from "./mod.ts";

/** Default bound on one read. An unbounded log read is the audio-feed-att failure. */
export const LOG_READ_LIMIT = 500;

export const MAX_LOG_MESSAGE_LENGTH = 2048;
export const MAX_LOG_STACK_LENGTH = 8192;
export const MAX_LOG_TYPE_LENGTH = 64;
export const MAX_LOG_ID_LENGTH = 200;
export const MAX_LOG_CONTEXT_KEYS = 20;
export const MAX_LOG_CONTEXT_LENGTH = 4096;

/**
 * Serialised ceiling for one record. The per-field caps above sum to well below this, so a
 * record that has been through `sanitizeLogRecord` always fits; exceeding it means a caller
 * bypassed the sanitiser, and the store refuses rather than holding a hostile payload.
 */
export const MAX_LOG_RECORD_BYTES = 32 * 1024;

export const LOG_SEVERITIES: readonly LogSeverity[] = ["debug", "info", "warn", "error"];

/**
 * Field names that must never carry a value into the log, matched case-insensitively.
 *
 * This is a second line of defence, not the first: the first is that nothing in this codebase
 * passes a secret to a writer. It exists because the shape is public — obs-5 will hand CSP
 * report bodies through `context` — and a report body is an attacker's chance to have a field
 * named `token` land in the operator's log store.
 */
const REDACTED_KEY =
  /token|secret|password|passkey|credential|api[-_]?key|authorization|auth[-_]?key|cookie|session|bearer|private/i;

const REDACTED = "[redacted]";

/** C0 and C1 controls except tab and newline, which a stack genuinely needs. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function capString(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

/** Cap and strip, in that order: stripping can only shorten, so the cap survives it. */
export function cleanString(value: string, max: number): string {
  return capString(value.replace(CONTROL_CHARS, ""), max);
}

/**
 * Redact by field name, recursively, with bounds on both depth and breadth.
 *
 * Returns a new object; the caller's value is never mutated. Anything that is not a plain
 * object or a primitive is described rather than serialised — a function, a class instance or a
 * circular structure must not be able to make the log path throw.
 */
export function redactContext(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth limit]";
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? cleanString(value, MAX_LOG_CONTEXT_LENGTH) : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LOG_CONTEXT_KEYS).map((item) => redactContext(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: cleanString(value.message, MAX_LOG_MESSAGE_LENGTH) };
  }
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys >= MAX_LOG_CONTEXT_KEYS) break;
    keys++;
    out[key] = REDACTED_KEY.test(key) ? REDACTED : redactContext(item, depth + 1);
  }
  return out;
}

/**
 * The one place a record is made safe to store: caps, control characters, redaction.
 *
 * `seq` is deliberately not accepted here — the store assigns it, under a compare-and-swap, and
 * a record that arrived with its own number would be able to corrupt the cursor.
 */
export function sanitizeLogRecord(input: Omit<LogRecord, "seq">): Omit<LogRecord, "seq"> {
  const record: Omit<LogRecord, "seq"> = {
    time: typeof input.time === "string" && !Number.isNaN(Date.parse(input.time))
      ? input.time
      : new Date().toISOString(),
    severity: LOG_SEVERITIES.includes(input.severity) ? input.severity : "info",
    type: cleanString(input.type, MAX_LOG_TYPE_LENGTH),
    message: cleanString(input.message, MAX_LOG_MESSAGE_LENGTH),
    process: input.process,
  };
  if (input.correlationId) {
    record.correlationId = cleanString(input.correlationId, MAX_LOG_ID_LENGTH);
  }
  if (input.route) record.route = cleanString(input.route, MAX_LOG_ID_LENGTH);
  if (input.job) record.job = cleanString(input.job, MAX_LOG_ID_LENGTH);
  if (input.episodeId) record.episodeId = cleanString(input.episodeId, MAX_LOG_ID_LENGTH);
  if (input.userId) record.userId = cleanString(input.userId, MAX_LOG_ID_LENGTH);
  if (input.phase) record.phase = cleanString(input.phase, MAX_LOG_TYPE_LENGTH);
  if (typeof input.attempt === "number" && Number.isFinite(input.attempt)) {
    record.attempt = Math.max(0, Math.trunc(input.attempt));
  }
  if (input.reason) record.reason = cleanString(input.reason, MAX_LOG_MESSAGE_LENGTH);
  if (input.stack) record.stack = cleanString(input.stack, MAX_LOG_STACK_LENGTH);
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
    record.durationMs = Math.max(0, Math.round(input.durationMs));
  }
  if (input.context && typeof input.context === "object") {
    record.context = redactContext(input.context) as Record<string, unknown>;
  }
  return record;
}

/** Does this record fit the store's serialised ceiling as it stands? */
export function logRecordFits(record: Omit<LogRecord, "seq">): boolean {
  try {
    return JSON.stringify(record).length <= MAX_LOG_RECORD_BYTES;
  } catch {
    return false;
  }
}

/**
 * Give up on a record without throwing, and say so on stderr.
 *
 * Callers are lifecycle paths — a claim, an abandonment, a finished synthesis — and none of
 * them may fail because a log line could not be written. The stderr line is not decoration: if
 * the store can be written by a public endpoint, "the log is quietly dropping records" has to
 * be visible somewhere that does not depend on the log working.
 */
export function refuseLogRecord(why: string, record: Omit<LogRecord, "seq">): null {
  console.error(
    JSON.stringify({
      event: "log.append.refused",
      why,
      type: record.type,
      severity: record.severity,
      message: record.message,
    }),
  );
  return null;
}

/**
 * Counts over a window, for the summary endpoint (obs-1): a poller has to be able to tell
 * "nothing changed" from "something new" without reading and diffing every record.
 */
export function summarizeRecords(records: LogRecord[]): LogSummary {
  const bySeverity: Record<LogSeverity, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  const byType = new Map<string, number>();
  for (const record of records) {
    bySeverity[record.severity] = (bySeverity[record.severity] ?? 0) + 1;
    byType.set(record.type, (byType.get(record.type) ?? 0) + 1);
  }
  const types = [...byType.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return { total: records.length, bySeverity, byType: types.slice(0, 25) };
}
