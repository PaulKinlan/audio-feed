/**
 * The authenticated errors API (audio-feed-s2pi / obs-1).
 *
 * GET /api/observability/errors   the feed of error events
 * GET /api/observability/summary  counts over the same cursor, so a poller can tell
 *                                 "nothing changed" from "something new" without fetching events
 *
 * This reads the obs-2 store (`audio-feed-wzv9`); there is no second store and no second index.
 *
 * ## Cursor semantics, written down
 *
 * A cursor IS the `seq` of the last event the caller has consumed, as a decimal string. `seq` is
 * the durable counter the store assigns on append: monotonic, gap-free within what is retained,
 * and — because it lives in the store rather than in a clock — unchanged by a restart. A timestamp
 * is deliberately NOT the cursor: two events in the same millisecond collide, and a poller that
 * advances past a collision loses the event silently, which is the one failure an errors feed
 * cannot have.
 *
 * 1. `since=<cursor>` returns events with `seq` STRICTLY GREATER than the cursor, in ascending
 *    `seq` order. The order is stable: identical requests return identical bodies until new events
 *    arrive.
 * 2. The response `cursor` is the sequence the caller may resume from. It moves FORWARD over
 *    everything the server SCANNED, not only what it returned — a filter must never produce a
 *    cursor that lets an unfiltered event later be skipped. `hasMore` says whether the scan hit the
 *    page limit with more behind it.
 * 3. Retention expiry is answered explicitly, never silently: events before `oldestRetained` are
 *    gone, so a cursor below it gets `410 cursor_too_old` naming the oldest retained sequence.
 *    `oldestRetained` is 1 for a store that has never held an event, so a poller that is simply
 *    early is never refused — and it is `pruned-through + 1` once retention has moved, so an old
 *    cursor is refused EVEN WHEN NOTHING IS RETAINED, which is the case that matters: a store whose
 *    events have all been pruned looks empty, and answering "nothing new" there would report lost
 *    events as quiet. (Found by running the real server and pruning everything: an `oldest >
 *    newest` empty check accepted the lost cursor.)
 * 4. A cursor that is not a non-negative integer is `400 invalid_cursor`. A `limit` outside
 *    1..`MAX_LIMIT` is `400 invalid_limit`. A `severity` this endpoint does not serve is
 *    `400 invalid_severity`.
 *
 * ## Authentication
 *
 * A shared key in `AUDIOFEED_OBSERVABILITY_KEY`, presented as `Authorization: Bearer <key>`, and
 * compared in constant time. The key is read from the environment per request and is NEVER logged,
 * echoed in a response, or stored — the log record for a request carries no headers at all
 * (audio-feed-ao4s), which is what guarantees that. When the variable is unset the endpoint refuses
 * everyone with `503 observability_not_configured`: fail closed, and say why, rather than either
 * opening up or looking broken.
 */

import type { AppContext } from "../app.ts";
import type { Handler } from "../router.ts";
import type { LogBounds, LogRecord, LogSeverity } from "../storage/mod.ts";
import { LOG_READ_LIMIT, summarizeRecords } from "../storage/log_shape.ts";
import { json, problem } from "../http.ts";
import { timingSafeEqual } from "../ids.ts";
import { readQueueSnapshot } from "../observability/admin_report.ts";
import { detectOverdueInvocations } from "../observability/invocation_overdue.ts";

/** Events returned when the caller does not say. Deliberately the store's own read bound. */
export const DEFAULT_LIMIT = 200;
/** The most this endpoint will return in one response. */
export const MAX_LIMIT = 500;

/** Which severities the errors feed serves. */
const SEVERITY_FILTERS: Record<string, LogSeverity[]> = {
  error: ["error"],
  warn: ["warn", "error"],
  info: ["info", "warn", "error"],
  all: ["debug", "info", "warn", "error"],
};

/** One event, in the shape the bead specifies. */
function toEvent(record: LogRecord) {
  return {
    // The id IS the sequence: it is what the store guarantees unique and ordered. A separate id
    // would be a second identity that could disagree with the cursor.
    id: String(record.seq),
    seq: record.seq,
    time: record.time,
    severity: record.severity,
    type: record.type,
    route: record.route ?? null,
    job: record.job ?? null,
    message: record.message,
    stack: record.stack ?? null,
    correlationId: record.correlationId ?? null,
    // Bounded structured root fields let a poller join a stage to its episode and group failures
    // without per-type context parsing or interpreting prose. A stage correlationId names its
    // invocation, not its episode. Keep optional keys present as null for a stable event shape.
    episodeId: record.episodeId ?? null,
    phase: record.phase ?? null,
    attempt: record.attempt ?? null,
    durationMs: record.durationMs ?? null,
    // Pre-existing exposure: do not add userId (subscriber identity) or reason (free-form text)
    // to this bearer-key projection. Admin-session log views can show those separately.
    context: record.context ?? null,
  };
}

/** The bearer token a request presents, or null. Header only: a query parameter is logged by
 * proxies and lands in browser history, which is no place for a shared key. */
function presentedKey(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || rest.length === 0) return null;
  return rest.join(" ");
}

/**
 * Refuse a request that does not carry the shared key.
 *
 * Returns a Response when the request must not proceed, and null when it may. Authentication is
 * checked BEFORE any parameter parsing so an unauthenticated caller learns nothing about the query
 * language.
 */
function authorise(ctx: AppContext, req: Request): Response | null {
  const expected = ctx.config.observabilityKey;
  if (!expected) {
    return problem({
      status: 503,
      title: "observability_not_configured",
      detail:
        "This deployment has no AUDIOFEED_OBSERVABILITY_KEY set, so the observability API is closed.",
    });
  }
  const presented = presentedKey(req);
  // Constant time, and computed against the configured key either way, so a missing header costs
  // the same as a wrong one.
  const ok = presented !== null && timingSafeEqual(presented, expected);
  if (!ok) {
    const refused = problem({
      status: 401,
      title: "unauthorised",
      detail: "Present the observability key as: Authorization: Bearer <key>.",
    });
    refused.headers.set("www-authenticate", 'Bearer realm="observability"');
    return refused;
  }
  return null;
}

interface ParsedQuery {
  since: number;
  until?: number;
  limit: number;
  severities: LogSeverity[];
}

/** Parse and validate, or explain what is wrong. */
function parseQuery(url: URL): ParsedQuery | { error: Response } {
  const rawSince = url.searchParams.get("since") ?? "0";
  if (!/^\d+$/.test(rawSince)) {
    return {
      error: problem({
        status: 400,
        title: "invalid_cursor",
        detail: "since must be a non-negative integer sequence, as returned in cursor.",
      }),
    };
  }
  const since = Number(rawSince);
  if (!Number.isSafeInteger(since)) {
    return {
      error: problem({ status: 400, title: "invalid_cursor", detail: "since is too large." }),
    };
  }

  const rawUntil = url.searchParams.get("until");
  let until: number | undefined;
  if (rawUntil !== null) {
    if (!/^\d+$/.test(rawUntil)) {
      return {
        error: problem({
          status: 400,
          title: "invalid_cursor",
          detail: "until must be a non-negative integer sequence.",
        }),
      };
    }
    until = Number(rawUntil);
  }
  if (until !== undefined && until < since) {
    return {
      error: problem({
        status: 400,
        title: "invalid_cursor",
        detail: "until must not precede since.",
      }),
    };
  }

  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) {
      return {
        error: problem({
          status: 400,
          title: "invalid_limit",
          detail: "limit must be an integer.",
        }),
      };
    }
    limit = Number(rawLimit);
  }
  if (limit < 1 || limit > MAX_LIMIT) {
    return {
      error: problem({
        status: 400,
        title: "invalid_limit",
        detail: `limit must be between 1 and ${MAX_LIMIT}.`,
      }),
    };
  }

  const rawSeverity = url.searchParams.get("severity") ?? "warn";
  const severities = SEVERITY_FILTERS[rawSeverity];
  if (!severities) {
    return {
      error: problem({
        status: 400,
        title: "invalid_severity",
        detail: `severity must be one of: ${Object.keys(SEVERITY_FILTERS).join(", ")}.`,
      }),
    };
  }

  return { since, until, limit, severities };
}

/**
 * Is this cursor older than what the store can still answer for?
 *
 * One rule, with no empty-store special case: a cursor before the oldest retained sequence minus one
 * has had events removed from underneath it and must be refused.
 *
 * The special case I first wrote — "an empty store is not too old" — was wrong, and wrong in the
 * worst direction. It tried to avoid refusing a poller that is simply early, but `oldestSeq >
 * newestSeq` does not mean "nothing has ever happened": it is ALSO what a store whose retention has
 * removed everything reports. So a cursor from before a full prune was accepted and answered with an
 * empty feed, turning lost events into silence. The discriminator is that a store which has never
 * held an event reports `oldestSeq === 1` (so `since = 0` is not below it), while a store whose
 * retention has moved reports `oldestSeq = prunedThrough + 1 > 1`, which refuses the old cursor even
 * though nothing is retained.
 */
export function cursorExpired(since: number, bounds: LogBounds): boolean {
  return since < bounds.oldestSeq - 1;
}

function tooOld(since: number, bounds: LogBounds): Response {
  return problem({
    status: 410,
    title: "cursor_too_old",
    detail:
      `Events after sequence ${since} are no longer retained, so this cursor cannot be resumed ` +
      `without skipping events. Oldest retained: ${bounds.oldestSeq}. Resume from that sequence ` +
      `minus one, or re-baseline from the current cursor.`,
  });
}

/** The window a response reports, so a caller can see what it can still ask for. */
function window(bounds: LogBounds) {
  return { oldestRetained: bounds.oldestSeq, newest: bounds.newestSeq };
}

/** Refuse a quiet answer when the invocation detector could not read or append its evidence. */
async function invocationScan(ctx: AppContext) {
  try {
    return await detectOverdueInvocations(ctx.stores.metadata);
  } catch (error) {
    console.error("[audio-feed] invocation detection unavailable:", error);
    return problem({
      status: 503,
      title: "invocation_detection_unavailable",
      detail:
        "Invocation records could not be checked. No clean coverage claim or cursor is returned; retry later.",
    });
  }
}

export function createObservabilityErrorsHandler(ctx: AppContext): Handler<AppContext> {
  return async ({ req }) => {
    const refused = authorise(ctx, req);
    if (refused) return refused;
    const parsed = parseQuery(new URL(req.url));
    if ("error" in parsed) return parsed.error;

    const detection = await invocationScan(ctx);
    if (detection instanceof Response) return detection;
    const bounds = await ctx.stores.metadata.logBounds();
    if (cursorExpired(parsed.since, bounds)) return tooOld(parsed.since, bounds);

    // One page, then filter for the response. The cursor advances over the whole scanned span
    // (see the semantics above), so a filtered-out event can never be skipped later.
    const scanned = await ctx.stores.metadata.listLogs({
      sinceSeq: parsed.since,
      ...(parsed.until !== undefined ? { untilSeq: parsed.until } : {}),
      limit: parsed.limit,
    });
    const events = scanned
      .filter((record) => parsed.severities.includes(record.severity))
      .map(toEvent);

    // Resume from the last sequence actually scanned. A response with no events still moves the
    // cursor, which is what makes a poller's next question cheap.
    const lastScanned = scanned.length > 0 ? scanned[scanned.length - 1]!.seq : parsed.since;
    const atUntil = parsed.until !== undefined && lastScanned >= parsed.until;
    const hasMore = !atUntil && scanned.length === parsed.limit &&
      lastScanned < bounds.newestSeq;

    return json({
      cursor: String(lastScanned),
      events,
      hasMore,
      scanned: scanned.length,
      returned: events.length,
      invocationDetection: detection,
      window: window(bounds),
    });
  };
}

export function createObservabilitySummaryHandler(ctx: AppContext): Handler<AppContext> {
  return async ({ req }) => {
    const refused = authorise(ctx, req);
    if (refused) return refused;
    const parsed = parseQuery(new URL(req.url));
    if ("error" in parsed) return parsed.error;

    const detection = await invocationScan(ctx);
    if (detection instanceof Response) return detection;
    const bounds = await ctx.stores.metadata.logBounds();
    if (cursorExpired(parsed.since, bounds)) return tooOld(parsed.since, bounds);

    // The point of this endpoint: `total: 0` is the cheap answer to "anything new since my cursor",
    // one bounded scan instead of a page of events.
    //
    // The scan is done HERE rather than through the store's `summarizeLogs`, because the severity
    // filter has to apply to what is COUNTED (audio-feed-ijuc). The store aggregates everything in
    // the window, so answering a `severity=error` request from it reported the unfiltered counts and
    // was indistinguishable from `severity=all` — the caller asked a question and got a different
    // one's answer. Scanning here also gives both endpoints one rule: the cursor advances over what
    // was SCANNED, so a record the filter excluded can never be skipped later.
    const scanned = await ctx.stores.metadata.listLogs({
      sinceSeq: parsed.since,
      ...(parsed.until !== undefined ? { untilSeq: parsed.until } : {}),
      limit: LOG_READ_LIMIT,
    });
    const summary = summarizeRecords(
      scanned.filter((record) => parsed.severities.includes(record.severity)),
    );
    // byType is bounded to the 25 most frequent kinds. Its counts sum to total only when
    // every counted kind is present: a rare claim expiry can be counted as warn but cut from
    // byType. Keep this separate from `truncated`, which is ONLY about unscanned sequences.
    const byTypeTruncated = summary.byType.reduce((sum, entry) => sum + entry.count, 0) <
      summary.total;
    // The boundary is the last sequence SCANNED, not the last one counted, and not the window's
    // newest: a cursor that steps over what was not examined skips events silently
    // (audio-feed-8d6r).
    const lastScanned = scanned.length > 0 ? scanned[scanned.length - 1]!.seq : parsed.since;

    // What "still to scan" means is relative to the window the CALLER asked for (audio-feed-bx1q):
    // if they capped it with `until`, records beyond that cap are none of their business and reaching
    // the cap is a complete answer. Reporting `truncated: true` there told a caller to come back for
    // something they had explicitly excluded, and it disagreed with the errors feed, which correctly
    // reported `hasMore: false` for the same window.
    const windowEnd = parsed.until !== undefined
      ? Math.min(parsed.until, bounds.newestSeq)
      : bounds.newestSeq;
    const ranOutOfStore = scanned.length < LOG_READ_LIMIT;
    const queue = await readQueueSnapshot(ctx.stores);

    return json({
      cursor: String(lastScanned),
      since: String(parsed.since),
      // audio-feed-nwc1: `totalMatches` is the honest name for the number below - records that
      // MATCHED the filter within the SCANNED page, never a count of events in the store. `total` is
      // kept beside it as its alias carrying the same number, because a consumer can be deployed from
      // its own checkout (scripts/observability-agent-run.sh runs the poller from $REPO_DIR while this
      // API is served by Deno Deploy), and a renamed field would read `undefined` there: the poller's
      // idle gate would stop firing and every quiet hour would spend a model call - the incident
      // observability-agent-poll.ts records for a `newest` field that never existed. Both names carry
      // one number, asserted in tests/observability_api_test.ts.
      totalMatches: summary.total,
      total: summary.total,
      bySeverity: summary.bySeverity,
      byType: summary.byType,
      byTypeTruncated,
      // True only when UNSCANNED records lie INSIDE the requested window: the scan filled its bound
      // and did not reach the window's end. `truncated: true` is an INSTRUCTION — keep polling from
      // `cursor` — never a quiet answer, and never "nothing to see": a bound full of filtered-out
      // records reports total 0 with truncated true, and a caller that stops there never reaches the
      // records behind them (audio-feed-36qa).
      truncated: !ranOutOfStore && lastScanned < windowEnd,
      // How many records the scan examined, regardless of the filter. Reported because it is what
      // makes a `total: 0` answer diagnosable: zero scanned means empty, a full bound means "more".
      scanned: scanned.length,
      invocationDetection: detection,
      // audio-feed-1qac: expose durable queue depth and synthesis drain state on the key-gated
      // summary path so an idle log store ("nothing queued" vs "queued but stalled") is
      // distinguishable without an admin browser session. Preserves audio-feed-ciuw: a failed
      // queue read reports `claimable: null` and `drain: "unreadable"` with `readError`, never 0.
      queue,
      window: window(bounds),
    });
  };
}
