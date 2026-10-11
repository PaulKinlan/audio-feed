/**
 * The admin observability report (audio-feed-n6uu).
 *
 * Paul asked for this in words: "I asked you to build in observability. I need you to manage this so
 * I can see it from the admin page in audio-feed." He was looking at a failed episode with a claim
 * history and had to COPY it out of the UI and paste it to the fleet. So the report is built to
 * answer, from durable state alone, the three questions that incident needed:
 *
 *   1. what failed, and in which PHASE did each attempt die (not just "it failed");
 *   2. did the attempt end with a terminal write, or did the lease expire with nobody writing —
 *      the siv1 distinction, which "failed" alone cannot express;
 *   3. what is the queue doing right now (claimable depth, live claims, abandonments, draining).
 *
 * ## Why this reads the store directly
 *
 * Every read here goes to `ctx.stores` in-process. It never calls the worker, the cron machinery, or
 * another HTTP route, because the page has to keep rendering while the thing it reports on is
 * broken — a report that depends on the worker is a report that fails with the worker.
 *
 * ## The record shape is the durable history
 *
 * `claim.lifecycle` records (src/storage/episode_events.ts) are written by the STORAGE transitions,
 * not by the worker, which is why they survive a worker that never came back: `claimEpisode` writes
 * the start (and the abandonment), `touchEpisodeClaim` writes each phase, `completeEpisode` writes
 * the terminal. One episode's attempts are all joined by `correlationId`, which is the episode id.
 *
 * ## Honest limits, stated in the page as well as here
 *
 *  - A page inside the app cannot render while the host gate refuses this host, because the gate
 *    runs before every route (audio-feed-du8w). audio-feed-2tbv is the complementary read path.
 *  - Counts are over the RETAINED log window, not all time: the store forgets on a retention timer
 *    (LOG_RETENTION_DAYS), and this report says which window it read rather than implying totality.
 *  - Unhandled request errors record their CLASS and not their message, deliberately
 *    (audio-feed-ao4s): a message can quote the request, which is how a client-chosen string
 *    reaches a record. So the page shows class/route/correlationId/timing for those and says where
 *    the full detail lives, rather than widening what is stored without a way to prove the
 *    redaction. Synthesis and claim failures — the ones this page exists for — carry their reason
 *    and error text already, because those are written by our own worker and storage code.
 */

import type { Episode } from "../types.ts";
import type { LogRecord, RunRecord } from "../storage/mod.ts";
import type { Stores } from "../config.ts";
import { CLAIM_LIFECYCLE_EVENT } from "../storage/episode_events.ts";

/** How many records back the report reads. The store's own read bound is the ceiling. */
export const REPORT_WINDOW = 400;
/** Failures rendered. The page is a diagnosis aid, not an archive. */
export const REPORT_FAILURE_LIMIT = 25;
/** Claimable episodes counted before the count is reported as "at least this many". */
export const REPORT_QUEUE_CAP = 100;
/** Episode records fetched for the failures shown, so the page cannot fan out unboundedly. */
const EPISODE_LOOKUPS = 20;
/** How often the worker is expected to run, for the draining verdict. Cron is every 2 minutes. */
export const SYNTHESIS_TICK_MS = 10 * 60_000;

/** One attempt at one episode, from the claim-lifecycle records. */
export interface ClaimAttempt {
  attempt: number;
  /** Opaque worker id, from the start record's context. Absent for records written before n6uu. */
  owner?: string;
  /** The claim instant. */
  startedAt: string;
  /** The last heartbeat or phase transition time seen for this attempt. */
  lastHeartbeat?: string;
  /** The last phase this attempt reached. The field the incident needed. */
  phase?: string;
  /** Every phase this attempt passed through, in order — "how far it got" at a glance. */
  phases: string[];
  /** The lease this attempt ran under, when the record carries it. */
  leaseMs?: number;
  /** Start + lease, when both are known. */
  leaseExpiresAt?: string;
  /** Has the lease expired by `nowMs`? Unknown (no start/lease) is `null`, not `false`. */
  leaseExpired: boolean | null;
  /**
   * `"finished"` — a terminal write succeeded.
   * `"failed"`   — a terminal write recorded a failure.
   * `"retrying"` — the claim was DELIBERATELY yielded so a later invocation resumes the episode;
   *                no terminal write happened (audio-feed-2sec). Not "failed": the episode's
   *                durable state is still pending, and calling it terminal would be a lie.
   * `"abandoned"` — the lease expired and the STORE took the episode over; nobody wrote a result.
   * `"in-flight"` — no end record yet and the lease is still live.
   */
  outcome: "finished" | "failed" | "retrying" | "abandoned" | "in-flight";
  /** Did a terminal write happen at all? The question "it failed" cannot answer. */
  endedWithTerminalWrite: boolean;
  /** The recorded reason, verbatim (bounded by the store's own caps). */
  reason?: string;
  /** Lease-to-terminal duration, when the terminal record carries it. */
  durationMs?: number;
}

/** One failure row, newest first. */
export interface FailureRow {
  seq: number;
  time: string;
  severity: string;
  type: string;
  route?: string;
  status?: number;
  message: string;
  /** The join to every other record about this request, and to the platform log. */
  correlationId?: string;
  episodeId?: string;
  userId?: string;
  attempt?: number;
  phase?: string;
  reason?: string;
  durationMs?: number;
}

/** An episode the report looked up, so a failure can name the article it was about. */
export interface EpisodeContext {
  id: string;
  title?: string;
  status: Episode["status"];
  attempts?: number;
  claimedBy?: string;
  claimedAt?: string;
  phase?: string;
  /** The episode's own recorded error — for an abandoned claim this is the accumulated history. */
  error?: string;
}

/**
 * A pending episode the worker DELIBERATELY requeued, so a later invocation resumes it
 * (audio-feed-2sec, coord landing condition 2 on audio-feed-aqms).
 *
 * The row is driven by the DURABLE episode state — `status === "pending"` with a phase is
 * only ever the residue of a yielded claim; a fresh pending episode has no phase, and a
 * completed one is not pending — not by scanning the log for prose. The last recorded
 * reason comes from the claim history and is labelled as such on the page.
 */
export interface RetryingRow {
  episodeId: string;
  userId: string;
  title?: string;
  /** The phase the yield preserved, verbatim (e.g. `upload_retry`, `synthesized_3_of_12`). */
  phase: string;
  attempts?: number;
  /** The episode's own heartbeat at yield time — how long the retry has been waiting. */
  lastHeartbeat?: string;
  /** `nowMs - (lastHeartbeat ?? createdAt)`, precomputed for the page. */
  waitingMs: number;
  /** The most recent recorded yield reason from the claim history, verbatim and bounded. */
  lastRetryReason?: string;
}

export interface QueueSnapshot {
  /**
   * Episodes the worker could claim now (pending, or a synthesizing claim whose lease died).
   *
   * `null` means the durable read FAILED — deliberately not `0`, which is what a swallowed
   * rejection used to render as (audio-feed-ciuw): the page then told the operator "no work" at the
   * exact moment it could not see the work, which is the one lie a diagnostic page must not tell.
   */
  claimable: number | null;
  /** True when the count hit REPORT_QUEUE_CAP and the real number is higher. */
  claimableCapped: boolean;
  /** The queue read's failure, so the page can say what broke instead of looking empty. */
  readError?: string;
  /** The oldest claimable episode's createdAt, so "how long has this been waiting" is answerable. */
  oldestClaimableAt?: string;
  /**
   * Live claims seen in the window: an attempt with no end record and an unexpired lease.
   *
   * `null` when the LOG READ failed (audio-feed-m11b). This count is derived from log records, so
   * an unreadable store is not an absence of live claims — and rendering 0 here was the same lie as
   * rendering an empty queue for a failed queue read (audio-feed-ciuw), just in a cell nobody had
   * checked yet.
   */
  liveClaims: number | null;
  /** Abandonments seen in the window: a lease that expired with no terminal write. `null` when the
   * log read failed, for the same reason as `liveClaims` (audio-feed-m11b). */
  abandoned: number | null;
  /** The most recent synthesis run, which is how "is it draining" is answered. */
  lastSynthesisRun?: RunRecord;
  /** The run-history read's failure; `lastSynthesisRun` being absent is then NOT "it never ran". */
  runsReadError?: string;
  /**
   * `"empty"` nothing queued; `"draining"` work queued and the last run made progress;
   * `"stalled"` work queued and the last run did not; `"unknown"` no run history at all;
   * `"unreadable"` the queue could not be read, so nothing about it can be claimed.
   */
  drain: "empty" | "draining" | "stalled" | "unknown" | "unreadable";
}

export interface ObservabilityReport {
  generatedAt: string;
  /**
   * Durable reads that FAILED. A section whose facts could not be read must say so rather than
   * render an empty value: "the queue is empty" and "I could not read the queue" are different
   * statements, and a diagnostic page that confuses them sends the operator the wrong way
   * (audio-feed-ciuw). Empty means every read succeeded.
   */
  readErrors: { store: "logs" | "queue" | "runs" | "episodes"; message: string }[];
  window: {
    /** The oldest retained sequence in the store — what retention has NOT dropped. */
    oldestRetained: number;
    newestSeq: number;
    /** The first sequence actually read for this report. */
    readFrom: number;
    recordsRead: number;
  };
  queue: QueueSnapshot;
  /** Pending episodes deliberately requeued by a yielded claim — retrying, not failed (audio-feed-2sec). */
  retries: RetryingRow[];
  failures: FailureRow[];
  /** Attempt histories keyed by episode id, for the failures and retries shown. */
  attempts: Record<string, ClaimAttempt[]>;
  episodes: Record<string, EpisodeContext>;
}

/** Does this record describe something that failed? */
export function isFailureRecord(record: LogRecord): boolean {
  return record.severity === "error" || record.severity === "warn";
}

/**
 * Fold one episode's claim-lifecycle records into per-attempt rows.
 *
 * The grouping is by `attempt`, and a record with no attempt number belongs to attempt 1: the
 * storage layer always writes one, and a record that predates the field is attempt 1 by definition.
 *
 * The two endings that matter are told apart by what the RECORD says, not by inference:
 *
 *  - an abandonment carries `context.workerState === "unknown"` — the store observed the expiry and
 *    is honest that it cannot know why nobody wrote a result (audio-feed-kd5r);
 *  - a terminal write is a record with a reason or a duration and no such context.
 */
export function claimAttemptsFrom(records: LogRecord[], nowMs: number): ClaimAttempt[] {
  const byAttempt = new Map<number, ClaimAttempt>();
  for (const record of records) {
    if (record.type !== CLAIM_LIFECYCLE_EVENT) continue;
    const attempt = record.attempt ?? 1;
    const existing = byAttempt.get(attempt);
    const row: ClaimAttempt = existing ?? {
      attempt,
      startedAt: record.time,
      lastHeartbeat: undefined,
      leaseExpired: null,
      outcome: "in-flight",
      endedWithTerminalWrite: false,
      phases: [],
    };
    row.startedAt = existing && record.phase === "claimed" ? record.time : row.startedAt;
    if (existing) row.lastHeartbeat = record.time;
    if (record.phase) {
      row.phase = record.phase;
      if (row.phases[row.phases.length - 1] !== record.phase) row.phases.push(record.phase);
    }
    if (typeof record.durationMs === "number") row.durationMs = record.durationMs;

    const context = (record.context ?? {}) as Record<string, unknown>;
    if (typeof context.owner === "string") row.owner = context.owner;
    if (typeof context.leaseMs === "number") row.leaseMs = context.leaseMs;
    if (typeof context.lastHeartbeat === "string") row.lastHeartbeat = context.lastHeartbeat;

    if (record.reason) row.reason = record.reason;
    if (context.workerState === "unknown") {
      // The store took the episode over. Not a terminal write, whoever wrote it.
      row.outcome = "abandoned";
      row.endedWithTerminalWrite = false;
    } else if (context.claimOutcome === "yielded") {
      // audio-feed-2sec: the worker DELIBERATELY released this claim so a later invocation
      // resumes the episode. The structured verdict is the fact; the reason string on the
      // same record is explanation, and must never imply a terminal write - reporting a
      // yielded claim as "failed with a terminal write" contradicts the episode's own
      // durable state (still pending, phase preserved for resume).
      row.outcome = "retrying";
      row.endedWithTerminalWrite = false;
    } else if (record.reason || typeof record.durationMs === "number") {
      row.endedWithTerminalWrite = true;
      row.outcome = record.reason ? "failed" : "finished";
    }
    byAttempt.set(attempt, row);
  }

  const rows = [...byAttempt.values()];
  for (const row of rows) {
    if (row.leaseMs !== undefined) {
      const start = Date.parse(row.startedAt);
      if (Number.isFinite(start)) {
        row.leaseExpiresAt = new Date(start + row.leaseMs).toISOString();
        row.leaseExpired = nowMs - start >= row.leaseMs;
      }
    }
    // A start with no end and an expired lease that nobody has reclaimed yet is what a stranded
    // claim looks like from outside; call it abandoned rather than in-flight, and say so.
    if (row.outcome === "in-flight" && row.leaseExpired === true) row.outcome = "abandoned";
  }
  return rows.sort((a, b) => a.attempt - b.attempt);
}

/** A failure message from a store, bounded and safe to render (the reader escapes it). */
function readFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

/** The report, read from durable state only. */
export async function buildObservabilityReport(
  stores: Stores,
  nowMs: number = Date.now(),
): Promise<ObservabilityReport> {
  const readErrors: ObservabilityReport["readErrors"] = [];

  // The log store first, and its failure is recorded rather than thrown: a page whose whole job is
  // to report on a broken deployment must still render when one of its own reads fails. What it
  // must NOT do is render that failure as an absence of failures (audio-feed-ciuw).
  let bounds = { oldestSeq: 1, newestSeq: 0 };
  let records: LogRecord[] = [];
  try {
    bounds = await stores.metadata.logBounds();
    const readFrom = Math.max(bounds.oldestSeq - 1, bounds.newestSeq - REPORT_WINDOW);
    records = await stores.metadata.listLogs({ sinceSeq: readFrom, limit: REPORT_WINDOW });
  } catch (error) {
    readErrors.push({ store: "logs", message: readFailure(error) });
  }

  const failures: FailureRow[] = [];
  const claimRecords: Record<string, LogRecord[]> = {};
  for (const record of records) {
    if (record.type === CLAIM_LIFECYCLE_EVENT && record.episodeId) {
      const list = claimRecords[record.episodeId] ?? [];
      list.push(record);
      claimRecords[record.episodeId] = list;
    }
  }
  const attempts: Record<string, ClaimAttempt[]> = {};
  for (const [episodeId, list] of Object.entries(claimRecords)) {
    attempts[episodeId] = claimAttemptsFrom(list, nowMs);
  }

  // Failures newest-first, and never the request records for the page itself: reading this page
  // must not fill the report it renders (the observability API already excludes its own reads).
  const failureRecords = records
    .filter(isFailureRecord)
    .filter((record) => record.route !== "/admin/observability")
    .slice(-REPORT_FAILURE_LIMIT)
    .reverse();
  for (const record of failureRecords) {
    const context = (record.context ?? {}) as Record<string, unknown>;
    failures.push({
      seq: record.seq,
      time: record.time,
      severity: record.severity,
      type: record.type,
      route: record.route,
      status: typeof context.status === "number" ? context.status : undefined,
      message: record.message,
      correlationId: record.correlationId,
      episodeId: record.episodeId,
      userId: record.userId,
      attempt: record.attempt,
      phase: record.phase,
      reason: record.reason,
      durationMs: record.durationMs,
    });
  }

  const episodes: Record<string, EpisodeContext> = {};
  const wanted = failures
    .map((failure) => ({ id: failure.episodeId, userId: failure.userId }))
    .filter((entry): entry is { id: string; userId: string } => Boolean(entry.id && entry.userId))
    .slice(0, EPISODE_LOOKUPS);
  const seen = new Set<string>();
  for (const { id, userId } of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    let episode = null;
    try {
      episode = await stores.metadata.getEpisode(userId, id);
    } catch (error) {
      // The failure row still renders; only the episode context is missing, and the page says so
      // rather than showing a failure with no episode as though there had been none.
      readErrors.push({ store: "episodes", message: readFailure(error) });
    }
    if (!episode) continue;
    episodes[id] = {
      id: episode.id,
      title: episode.title,
      status: episode.status,
      attempts: episode.attempts,
      claimedBy: episode.claimedBy,
      claimedAt: episode.claimedAt,
      phase: episode.phase,
      error: episode.error,
    };
  }

  // A queue read that failed is NOT an empty queue (audio-feed-ciuw). `claimable: null` carries the
  // difference through the type so a caller cannot accidentally render it as zero, and the drain
  // verdict is "unreadable" rather than "empty" or "unknown", both of which would be claims about
  // a queue nobody managed to look at.
  let queueEpisodes: Episode[] | null = null;
  let queueReadError: string | undefined;
  try {
    const pending = await stores.metadata.listPendingEpisodes({
      limit: REPORT_QUEUE_CAP + 1,
      nowMs,
    });
    queueEpisodes = pending.episodes;
  } catch (error) {
    queueReadError = readFailure(error);
    readErrors.push({ store: "queue", message: queueReadError });
  }

  // audio-feed-2sec, coord landing condition 2 on aqms: a pending episode with a PHASE is the
  // durable residue of a yielded claim (a fresh pending episode has no phase; a completed one is
  // not pending), so the retrying state is derived from EPISODE STATE, not from scanning log
  // prose. Titles and the last recorded yield reason decorate the row; the verdict stays durable.
  const retries: RetryingRow[] = [];
  if (queueEpisodes) {
    for (const episode of queueEpisodes) {
      if (episode.status !== "pending" || !episode.phase) continue;
      const yieldedReasons = (claimRecords[episode.id] ?? [])
        .filter((record) =>
          ((record.context ?? {}) as Record<string, unknown>).claimOutcome === "yielded" &&
          record.reason
        )
        .map((record) => record.reason as string);
      const anchor = Date.parse(episode.lastHeartbeat ?? episode.createdAt);
      retries.push({
        episodeId: episode.id,
        userId: episode.userId,
        title: episode.title,
        phase: episode.phase,
        attempts: episode.attempts,
        lastHeartbeat: episode.lastHeartbeat,
        waitingMs: Number.isFinite(anchor) ? Math.max(0, nowMs - anchor) : 0,
        ...(yieldedReasons.length > 0
          ? { lastRetryReason: yieldedReasons[yieldedReasons.length - 1]!.slice(0, 300) }
          : {}),
      });
      if (retries.length >= REPORT_QUEUE_CAP) break;
    }
  }

  // Scoped to THIS job kind. A global newest-first page let twenty feed-poll runs crowd out the
  // synthesis run the drain verdict depends on, so the page read "no run recorded" from a page full
  // of unrelated jobs (audio-feed-506m).
  let lastSynthesisRun: RunRecord | undefined;
  let runsReadError: string | undefined;
  try {
    const runs = await stores.metadata.listRuns(20, "synthesis");
    lastSynthesisRun = runs.find((run) => run.kind === "synthesis");
  } catch (error) {
    runsReadError = readFailure(error);
    readErrors.push({ store: "runs", message: runsReadError });
  }

  // Both counts are derived from the log records read above, so a failed log read makes them
  // UNKNOWN rather than zero (audio-feed-m11b). `attempts` is empty in that case, which is exactly
  // why the flag is explicit: an empty map is an absence of evidence, not evidence of absence.
  const logsReadFailed = readErrors.some((failure) => failure.store === "logs");
  const liveClaims = logsReadFailed ? null : Object.values(attempts)
    .flat()
    .filter((attempt) => attempt.outcome === "in-flight").length;
  const abandoned = logsReadFailed ? null : Object.values(attempts)
    .flat()
    .filter((attempt) => attempt.outcome === "abandoned").length;

  const claimable = queueEpisodes ? queueEpisodes.length : null;
  const claimableCapped = claimable !== null && claimable > REPORT_QUEUE_CAP;
  const oldestClaimableAt = queueEpisodes
    ?.map((episode) => episode.createdAt)
    .sort()[0];

  let drain: QueueSnapshot["drain"];
  if (queueEpisodes === null) drain = "unreadable";
  else if (claimable === 0) drain = "empty";
  else if (runsReadError) drain = "unknown";
  else if (lastSynthesisRun) {
    const startedAgo = nowMs - Date.parse(lastSynthesisRun.startedAt);
    const recent = Number.isFinite(startedAgo) && startedAgo <= SYNTHESIS_TICK_MS * 3;
    drain = recent && !lastSynthesisRun.error && (lastSynthesisRun.ready ?? 0) > 0
      ? "draining"
      : "stalled";
  } else {
    drain = "unknown";
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    readErrors,
    window: {
      /** The oldest sequence the store still holds — what retention has NOT dropped. */
      oldestRetained: bounds.oldestSeq,
      newestSeq: bounds.newestSeq,
      /** The first sequence actually read for this report. */
      readFrom: records.length > 0
        ? records[0]!.seq
        : Math.max(bounds.oldestSeq - 1, bounds.newestSeq - REPORT_WINDOW),
      recordsRead: records.length,
    },
    queue: {
      claimable: claimable === null ? null : Math.min(claimable, REPORT_QUEUE_CAP),
      claimableCapped,
      readError: queueReadError,
      oldestClaimableAt,
      liveClaims,
      abandoned,
      lastSynthesisRun,
      runsReadError,
      drain,
    },
    retries,
    failures,
    attempts,
    episodes,
  };
}
