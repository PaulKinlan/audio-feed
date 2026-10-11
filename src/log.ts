/**
 * The one writer every process uses (audio-feed-wzv9): the app, the synthesis worker, the queue,
 * the cron ticks.
 *
 * Its job is to make the record shape impossible to get wrong at a call site. Caps, redaction and
 * the record's fields live in the store, but a caller that hand-rolls an object can still omit the
 * correlation id, forget the stack on an error, or pass a secret. This API takes the fields that
 * vary and nothing else.
 *
 * It depends on one method of one repository (`appendLog`) rather than the whole store, so a
 * caller — or a test — can supply a recorder and nothing else.
 *
 * NOTHING HERE THROWS. A missing log line must never fail a request, an episode or a claim: the
 * store already resolves to null instead of throwing, and every method here preserves that, so a
 * caller can `await` a lifecycle record without a try/catch. Callers that need the record to exist
 * before they proceed (a claim, an abandonment, a terminal outcome) should await it; callers that
 * are merely narrating can ignore the promise.
 */

import type { LogProcess, LogRecord, LogRepository, LogSeverity } from "./storage/mod.ts";

/** The narrow slice of the store the writer needs. */
export type LogSink = Pick<LogRepository, "appendLog">;

/** The fields that vary between records. Everything else is bound to the writer. */
export interface LogFields {
  correlationId?: string;
  route?: string;
  job?: string;
  episodeId?: string;
  userId?: string;
  /** How far the work got (siv1): what the next reader needs when a process died here. */
  phase?: string;
  attempt?: number;
  /** Why something ended. On a failure path this is the error's message. */
  reason?: string;
  /** Errors only: the stack, verbatim. Set by `failure()`, or explicitly by a caller. */
  stack?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
}

export interface Logger {
  readonly process: LogProcess;
  event(type: string, message: string, fields?: LogFields): Promise<LogRecord | null>;
  warn(type: string, message: string, fields?: LogFields): Promise<LogRecord | null>;
  error(type: string, message: string, fields?: LogFields): Promise<LogRecord | null>;
  /**
   * An error record that keeps the stack, which is the difference between a log an operator can
   * act on and one that only says something broke. Prefer this over `error()` on a caught value.
   */
  failure(type: string, error: unknown, fields?: LogFields): Promise<LogRecord | null>;
  /** A writer with the correlation id (and any other binding) carried into every record. */
  withCorrelation(correlationId: string, extra?: LogFields): Logger;
}

export interface LoggerOptions {
  sink: LogSink;
  process: LogProcess;
  /** Injected for tests; the store stamps the record's time when a caller supplies none. */
  now?: () => Date;
  /** Bindings applied to every record this writer produces. */
  fields?: LogFields;
}

/** The message and stack of anything caught, without assuming it is an Error. */
export function describeError(error: unknown): { message: string; stack?: string; name: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 40).join("\n"),
    };
  }
  if (typeof error === "string") return { name: "Error", message: error };
  try {
    return { name: "Error", message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { name: "Error", message: "unprintable error value" };
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const bound = options.fields ?? {};

  function write(
    severity: LogSeverity,
    type: string,
    message: string,
    fields: LogFields | undefined,
  ): Promise<LogRecord | null> {
    const merged: LogFields = { ...bound, ...fields };
    const record: Omit<LogRecord, "seq"> = {
      time: (options.now?.() ?? new Date()).toISOString(),
      severity,
      type,
      message,
      process: options.process,
    };
    if (merged.correlationId) record.correlationId = merged.correlationId;
    if (merged.route) record.route = merged.route;
    if (merged.job) record.job = merged.job;
    if (merged.episodeId) record.episodeId = merged.episodeId;
    if (merged.userId) record.userId = merged.userId;
    if (merged.phase) record.phase = merged.phase;
    if (typeof merged.attempt === "number") record.attempt = merged.attempt;
    if (merged.reason) record.reason = merged.reason;
    if (merged.stack) record.stack = merged.stack;
    if (typeof merged.durationMs === "number") record.durationMs = merged.durationMs;
    if (merged.context) record.context = merged.context;
    // The store resolves to null on a failure it cannot make; it never throws. Guard anyway: a
    // thrown log must not become a thrown request.
    return options.sink.appendLog(record).catch(() => null);
  }

  const logger: Logger = {
    process: options.process,
    event: (type, message, fields) => write("info", type, message, fields),
    warn: (type, message, fields) => write("warn", type, message, fields),
    error: (type, message, fields) => write("error", type, message, fields),
    failure: (type, error, fields) => {
      const described = describeError(error);
      return write("error", type, described.message, {
        ...fields,
        reason: fields?.reason ?? described.message,
        context: { ...fields?.context, errorName: described.name },
        ...(described.stack ? { stack: described.stack } : {}),
      });
    },
    withCorrelation: (correlationId, extra) =>
      createLogger({ ...options, fields: { ...bound, ...extra, correlationId } }),
  };
  return logger;
}

/**
 * A logger that discards everything, for call sites that legitimately have no store — a unit test
 * of an unrelated path, or a CLI that was invoked without one. Explicit and greppable, unlike a
 * global default that quietly writes nowhere.
 */
export function nullLogger(process: LogProcess = "cli"): Logger {
  const sink: LogSink = { appendLog: () => Promise.resolve(null) };
  return createLogger({ sink, process });
}

/**
 * Requests whose success is not worth a record: the enclosure and asset routes, named by their
 * REGISTERED PATTERN rather than by inspecting a path. Podcast clients hammer `/audio/:key+` and
 * nothing is learned from each 200 — obs-4's traces are about queue wait, synthesis and write, not
 * a static byte count. Their failures are recorded like anything else.
 *
 * A pattern not listed here is recorded, so a route added later costs one extra record rather than
 * losing its diagnostics: the failure mode of this list is noise, never silence.
 */
const HIGH_VOLUME_ROUTES = new Set([
  // A success here is not worth a record for one of two reasons. Volume: podcast clients hammer the
  // enclosure and nothing is learned from each 200. Self-reference: the CWV beacon is sent by the
  // page being measured, so recording it would put an event in the store per report — and its
  // content is an attacker-controlled payload that must not go near the request log at all
  // (audio-feed-i7vi). Its failures are recorded like any other, so a flood of rejected beacons is
  // still visible.
  "/api/cwv",
  // The enclosure, which is the original reason this set exists: podcast clients fetch it constantly
  // and a record per 200 is cost with no diagnosis. (A review test caught this line going missing
  // when the beacon was added — which is why the set is asserted by behaviour and not by size.)
  "/audio/:key+",
  "/assets/:name",
  "/assets/voices/:voice",
  "/icon.svg",
  "/manifest.json",
]);

/**
 * Everything the router dispatches, and nothing else (audio-feed-ao4s).
 *
 * Mirrors the router's own `Method` union, which is the point: the allowlist is the set of methods
 * this app can actually serve, so a value outside it is not a method at all, it is a string a
 * client chose.
 */
const KNOWN_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/** The record for a method this app cannot serve. A constant, like every other logged name. */
export const OTHER_METHOD = "<other>";

/**
 * Normalise the HTTP method before it becomes a field or a message (audio-feed-ao4s).
 *
 * THE METHOD IS ATTACKER-CONTROLLED TOO. Logging `req.method` raw is the same mistake as logging
 * the raw path one field later: a client can send any token it likes as the method, so
 * `Request(method: "<canary>")` used to arrive in the message AND in `context.method` and persist
 * there — a capability the caller chose, stored by the app. The method must be normalised through
 * the set of methods this app serves, exactly as the path is normalised to a route pattern, and
 * anything else records a constant.
 *
 * Case-folded before the lookup because HTTP methods are case-sensitive in the spec but this app
 * serves only the canonical spelling, and a lower-case `get` is untrusted input either way.
 */
export function normaliseMethod(raw: string): string {
  const upper = raw.toUpperCase();
  return KNOWN_METHODS.has(upper) && upper === raw ? upper : OTHER_METHOD;
}

export function isHighVolumeRoute(pattern: string): boolean {
  return HIGH_VOLUME_ROUTES.has(pattern);
}

/**
 * The observability API's own endpoints, which must not be recorded as events (audio-feed-s2pi).
 *
 * AN OBSERVER MUST NOT FEED ITSELF. A poller is a client of this API, so recording each successful
 * poll puts an event into the very store the poller is asking about: `summary` could never report
 * "nothing changed", and the feed would fill with evidence of being read. The API would be correct
 * and useless, and the failure is invisible from a unit test that drives `createApp` — which does
 * not log at all — so it is only reachable by running the real server and polling it.
 *
 * Successes only: a failed poll (401, 410) is still recorded, because a rejected caller is exactly
 * the kind of thing an operator wants to see, and it does not create the endless self-reference a
 * 200 would.
 */
const OBSERVABILITY_ROUTES = new Set([
  "/api/observability/errors",
  "/api/observability/summary",
]);

export function isObservabilityRoute(pattern: string): boolean {
  return OBSERVABILITY_ROUTES.has(pattern);
}
