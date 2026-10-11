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
 * none of that protection applies here — the path must be turned into labels before it is ever a
 * field.
 *
 * THE PREVIOUS VERSION MATCHED CANONICAL SHAPES, and that is exactly how it leaked
 * (audio-feed-pwu4): a matched `/feed/<token>/...` branch copied every REMAINING segment through
 * untouched, so `GET /feed/<token>/master.xml/<token>` stored the token. An exact-shape match is a
 * policy for the shapes someone thought of, and the shape that arrives is chosen by the attacker.
 *
 * So this version is fail-closed rather than shape-aware:
 *
 *   1. Percent-escapes are decoded (repeatedly, bounded) BEFORE splitting, because the router
 *      decodes and therefore serves a different path than the raw string suggests — `%2F` is a
 *      segment separator in reality even though it is not one in the text.
 *   2. A capability prefix (`/feed/`, `/listen/`, `/audio/`) has its first following segment
 *      replaced by a marker WHATEVER it looks like: the capability is the position, not the shape,
 *      and a short token must not be able to pass a "looks random" test.
 *   3. Every other segment survives only if it is a plain lowercase route word. Mixed case, over
 *      length, punctuation an escape could have produced, or anything unparseable is redacted. An
 *      unknown route therefore loses its detail rather than risking a credential.
 *
 * A query string is never logged at all: it is where a token ends up when nobody was thinking.
 */

/** The position at which a capability is carried, per prefix. */
const CAPABILITY_MARKER: Record<string, string> = {
  feed: ":token",
  listen: ":token",
  audio: ":key",
};

/** Literals that may follow a capability prefix without being one themselves. Whitelist, so an
 * unlisted segment is redacted rather than kept. */
const PREFIX_LITERALS = new Set(["master.xml", "master"]);

/**
 * A plain route word. Lowercase only, and no escapes: route words in this app are lowercase paths
 * like `account`, `admin/synthesis`, `api/request-access`, and a real capability is either long or
 * mixed case. Anything else is redacted, so a rule that keeps labels readable cannot become the
 * thing that keeps a token.
 */
const PLAIN_SEGMENT = /^[a-z0-9._~-]{1,24}$/;

/** Decode percent-escapes until the value stops changing, so `%252F` is seen as a separator too. */
function decodeFully(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // A malformed escape is not a route word, so it will fail the plain-word test and be
      // redacted. Returning what we have keeps that property instead of throwing into a request.
      return current;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

export function redactRoutePath(path: string): string {
  const withoutQuery = path.split("?")[0]?.split("#")[0] ?? "";
  const segments = decodeFully(withoutQuery).split("/").filter((segment) => segment.length > 0);
  const head = segments[0] ?? "";
  const prefixed = Object.hasOwn(CAPABILITY_MARKER, head);
  const marker = prefixed ? CAPABILITY_MARKER[head]! : undefined;

  const labels = segments.map((segment, index) => {
    // The capability: replaced by position, before any judgement about what it looks like.
    if (marker && index === 1) return marker;
    // After a capability prefix, only an explicit literal is kept.
    if (marker && index > 1) return PREFIX_LITERALS.has(segment) ? segment : ":redacted";
    return PLAIN_SEGMENT.test(segment) ? segment : ":redacted";
  });

  const joined = `/${labels.join("/")}`;
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}

/**
 * Requests whose success is not worth a record: the enclosure and asset routes. Podcast clients
 * hammer `/audio/:key+` and nothing is learned from each 200 — obs-4's traces are about queue
 * wait, synthesis and write, not about a static byte count. Failures on these routes ARE logged.
 */
export function isHighVolumeAssetPath(path: string): boolean {
  const clean = (path.split("?")[0] ?? "").toLowerCase();
  return clean.startsWith("/audio/") || clean.startsWith("/assets/") ||
    clean === "/icon.svg" || clean === "/manifest.json" || clean === "/favicon.ico";
}
