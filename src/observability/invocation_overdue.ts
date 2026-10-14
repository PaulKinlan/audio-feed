import type { LogRecord, LogRepository } from "../storage/mod.ts";
import { LOG_READ_LIMIT } from "../storage/log_shape.ts";

/** Each request makes at most this many bounded reads and CAS attempts. */
export const INVOCATION_SCAN_LIMIT = LOG_READ_LIMIT;
export const MAX_INVOCATION_ATTEMPTS = 16;
const MAX_WARNINGS_PER_READ = 8;
const MAX_CHANGED_SNAPSHOTS = 3;

export interface InvocationScan {
  scannedFromSeq: number;
  scannedThroughSeq: number;
  oldestRetainedSeq: number;
  /** A true value means the reader cannot rule out an older unpaired start. */
  olderStartsUnknown: boolean;
  retentionGap: boolean;
  incompleteMarkers: number;
  warningsWritten: number;
  inspectedAttempts: number;
  moreDue: boolean;
}

/** A start mark that opened an invocation, before the snapshot's observations are attached. */
interface StartedInvocation {
  id: string;
  started: LogRecord;
  budgetMs: number;
}

interface Candidate extends StartedInvocation {
  /** The newest record this snapshot holds for the invocation: the last thing we SAW it do. */
  seen: LogRecord;
}

/**
 * The newest stored record per invocation, computed from the snapshot the detector already holds.
 *
 * This is the only honest answer available FROM INSIDE THE ISOLATE to "was the budget consumed, or is
 * the turn simply long?" (audio-feed-fsd9). The platform can end an invocation without running any of
 * our code, so the last record we hold is the last moment it was OBSERVED, not the last moment it
 * existed. An invocation that is alive but silent is indistinguishable here from one that is gone -
 * which is exactly why `lastSeenAgoMs` is a silence measurement and never a liveness verdict.
 *
 * The detector's own warning is deliberately not activity, and cannot become one: a candidate is due
 * only while no `synthesis.invocation.overdue` record carries its id, so its own alert is never the
 * newest record at the moment a warning is written.
 */
function lastObservedActivity(records: LogRecord[]): Map<string, LogRecord> {
  const seen = new Map<string, LogRecord>();
  for (const record of records) {
    const id = record.correlationId;
    if (!id) continue;
    const previous = seen.get(id);
    if (!previous || record.seq > previous.seq) seen.set(id, record);
  }
  return seen;
}

/** A terminal anywhere in the scanned suffix closes the start, even if it arrived late. */
export function invocationCandidates(records: LogRecord[], nowMs: number): {
  due: Candidate[];
  incompleteMarkers: number;
} {
  const starts = new Map<string, StartedInvocation>();
  const terminals = new Set<string>();
  const warned = new Set<string>();
  let incompleteMarkers = 0;
  for (const record of records) {
    if (
      record.type !== "synthesis.invocation" &&
      record.type !== "synthesis.invocation.overdue"
    ) continue;
    const id = record.correlationId;
    if (!id) {
      incompleteMarkers++;
      continue;
    }
    if (record.type === "synthesis.invocation.overdue") {
      warned.add(id);
    } else if (record.phase === "terminal") {
      terminals.add(id);
    } else if (record.phase === "started" && !starts.has(id)) {
      const budgetMs = record.context?.budgetMs;
      const startedMs = Date.parse(record.time);
      if (
        typeof budgetMs !== "number" || !Number.isSafeInteger(budgetMs) || budgetMs <= 0 ||
        !Number.isFinite(startedMs) || !Number.isSafeInteger(2 * budgetMs)
      ) {
        incompleteMarkers++;
        continue; // A missing budget is UNKNOWN, not the current deployment's budget.
      }
      starts.set(id, { id, started: record, budgetMs });
    }
  }
  const observed = lastObservedActivity(records);
  const due = [...starts.values()]
    .map((candidate) => {
      const candidateSeen = observed.get(candidate.id);
      // A record can only be activity if it is AT OR AFTER the start that opened the invocation, and
      // only if its clock is readable. Anything else falls back to the start mark itself, which makes
      // "we saw nothing after the start" explicit rather than silently reporting an older record.
      return {
        ...candidate,
        seen: candidateSeen && candidateSeen.seq >= candidate.started.seq &&
            Number.isFinite(Date.parse(candidateSeen.time))
          ? candidateSeen
          : candidate.started,
      };
    })
    .filter((candidate) =>
      !terminals.has(candidate.id) && !warned.has(candidate.id) &&
      nowMs - Date.parse(candidate.started.time) > 2 * candidate.budgetMs
    );
  due.sort((a, b) => a.started.seq - b.started.seq);
  return { due, incompleteMarkers };
}

/**
 * A default errors/summary read drives detection BEFORE its ordinary cursor scan. The
 * store's sequence CAS means a terminal appended after this snapshot invalidates it;
 * its per-invocation guard means simultaneous readers cannot each emit a warning.
 * No failed read is translated to "no overdue": it throws for the API to refuse.
 */
export async function detectOverdueInvocations(
  logs: LogRepository,
  nowMs: number = Date.now(),
): Promise<InvocationScan> {
  if (!Number.isFinite(nowMs)) throw new Error("invalid detector clock");
  let warningsWritten = 0;
  let inspectedAttempts = 0;
  let changedSnapshots = 0;
  const alreadyHandled = new Set<string>();
  for (;;) {
    const bounds = await logs.logBounds();
    const sinceSeq = Math.max(bounds.oldestSeq - 1, bounds.newestSeq - INVOCATION_SCAN_LIMIT);
    const records = await logs.listLogs({
      sinceSeq,
      untilSeq: bounds.newestSeq,
      limit: INVOCATION_SCAN_LIMIT,
    });
    if (
      records.length !== bounds.newestSeq - sinceSeq ||
      records.some((record, index) => record.seq !== sinceSeq + index + 1)
    ) {
      // A concurrent prune or partial read may have removed a terminal. Do not warn
      // from a snapshot whose sequence range was not actually observed end-to-end.
      throw new Error("invocation log snapshot is incomplete");
    }
    const { due, incompleteMarkers } = invocationCandidates(records, nowMs);
    const remaining = due.filter((candidate) => !alreadyHandled.has(candidate.id));
    const result: InvocationScan = {
      scannedFromSeq: sinceSeq + 1,
      scannedThroughSeq: bounds.newestSeq,
      oldestRetainedSeq: bounds.oldestSeq,
      olderStartsUnknown: sinceSeq >= bounds.oldestSeq || bounds.oldestSeq > 1 ||
        incompleteMarkers > 0,
      retentionGap: bounds.oldestSeq > 1,
      incompleteMarkers,
      warningsWritten,
      inspectedAttempts,
      moreDue: remaining.length > 0 &&
        (warningsWritten >= MAX_WARNINGS_PER_READ ||
          inspectedAttempts >= MAX_INVOCATION_ATTEMPTS),
    };
    if (remaining.length === 0 || result.moreDue) return result;
    const { id, started, budgetMs, seen } = remaining[0]!;
    const thresholdMs = budgetMs * 2;
    // Both are clamped at zero, because a skewed clock must not produce a negative age and a record
    // cannot have been observed before the invocation it belongs to started.
    const seenMs = Date.parse(seen.time);
    const lastSeenAgoMs = Math.max(0, nowMs - seenMs);
    const observedActiveMs = Math.max(0, seenMs - Date.parse(started.time));
    const seenClause = seen.seq === started.seq
      ? `Nothing was stored for it after its start mark, which this scan is ${lastSeenAgoMs}ms after`
      : `Its newest stored activity was ${seen.type}${seen.phase ? ` (${seen.phase})` : ""}, ` +
        `${observedActiveMs}ms into the invocation and ${lastSeenAgoMs}ms before this scan`;
    const alert: Omit<LogRecord, "seq"> = {
      time: new Date(nowMs).toISOString(),
      severity: "warn",
      type: "synthesis.invocation.overdue",
      process: "worker",
      job: "synthesis",
      correlationId: id,
      phase: "overdue",
      message: `No terminal mark was observed for synthesis invocation ${id} more than ` +
        `twice its recorded ${budgetMs}ms budget as of this scan. Cause and current state are unknown.` +
        ` ${seenClause}; whether the isolate is still running cannot be observed from inside it.`,
      context: {
        invocationId: id,
        budgetMs,
        thresholdMs,
        startedAt: started.time,
        startSeq: started.seq,
        // audio-feed-fsd9: what was SEEN, recorded next to what was inferred. `observedActiveMs` is a
        // LOWER BOUND on consumption - it is how long the invocation was observed to be alive, which
        // for a killed one is shorter than how long it ran. Compare it with `budgetMs` to tell a
        // consumed budget from a merely long turn; read `lastSeenAgoMs` as silence, not as death.
        lastSeenAt: seen.time,
        lastSeenSeq: seen.seq,
        lastSeenType: seen.type,
        ...(seen.phase ? { lastSeenPhase: seen.phase } : {}),
        lastSeenAgoMs,
        observedActiveMs,
      },
    };
    inspectedAttempts++;
    const state = await logs.appendLogOnce(alert, `overdue:${id}`, bounds.newestSeq);
    if (state === "unavailable") throw new Error("overdue warning could not be stored");
    if (state === "changed") {
      // This could be the terminal itself. Re-read before making any claim.
      if (++changedSnapshots >= MAX_CHANGED_SNAPSHOTS) {
        throw new Error("overdue scan changed before a warning could be committed");
      }
      continue;
    }
    changedSnapshots = 0;
    alreadyHandled.add(id);
    if (state === "written") warningsWritten++;
  }
}
