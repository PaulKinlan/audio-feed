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
 * Turn a request path into something safe to record (audio-feed-wzv9).
 *
 * A URL path is the one place this codebase carries a capability with no field name attached:
 * `/listen/<feedToken>` opens a subscriber's private feed, `/audio/<key>` is the enclosure, and
 * `/feed/<token>/master.xml` is what a podcast client holds. The store redacts by field NAME, so
 * none of that protection applies here — the redaction has to happen before the value is ever a
 * field, which is why this function exists rather than a convention at the call site.
 *
 * Two rules, applied in order: known routes have their capability segment replaced by a label, and
 * any remaining segment long enough to be a token is replaced too. A query string is never logged
 * at all, because it is where a token ends up when someone is not thinking about it.
 */
export function redactRoutePath(path: string): string {
  const withoutQuery = path.split("?")[0]?.split("#")[0] ?? "";
  const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
  const head = segments[0] ?? "";

  // Shapes the app actually serves. Named explicitly so the redaction does not depend on a
  // heuristic noticing that a feed token happens to look random.
  if (head === "listen" && segments.length > 1) return "/listen/:token";
  if (head === "feed" && segments.length > 1) {
    const rest = segments.slice(2).join("/");
    return rest ? `/feed/:token/${rest}` : "/feed/:token";
  }
  if (head === "audio" && segments.length > 1) return "/audio/:key";

  const redacted = segments.map((
    segment,
  ) => (LOOKS_LIKE_TOKEN.test(segment) ? ":redacted" : segment));
  const joined = `/${redacted.join("/")}`;
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}

/** A segment long and uniform enough to be a capability rather than a word. */
const LOOKS_LIKE_TOKEN = /^[A-Za-z0-9_-]{24,}$/;

/**
 * Requests whose success is not worth a record: the enclosure and asset routes. Podcast clients
 * hammer `/audio/:key+` and nothing is learned from each 200 — obs-4's traces are about queue
 * wait, synthesis and write, not about a static byte count. Failures on these routes ARE logged.
 */
export function isHighVolumeAssetPath(path: string): boolean {
  const clean = path.split("?")[0] ?? "";
  return clean.startsWith("/audio/") || clean.startsWith("/assets/") ||
    clean === "/icon.svg" || clean === "/manifest.json" || clean === "/favicon.ico";
}
