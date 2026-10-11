/**
 * Server spans (audio-feed-i7vi / obs-4).
 *
 * One span per job attempt, carrying the phases a slow synthesis is made of: how long the episode
 * waited for a worker, how long the synthesis itself took, how long the write took, and the total.
 * Splitting the total is the whole point — "the episode took 90s" cannot distinguish a queue that
 * was backed up from a TTS call that hung, and those two lead to different fixes.
 *
 * Emitted as records in the obs-2 store (`audio-feed-wzv9`), with `correlationId` set to the episode
 * id, which is the join the store already establishes for the claim lifecycle. A trace and a failure
 * are then the same kind of record about the same episode, which is what lets obs-1's errors API and
 * obs-3's poller show them together rather than making an operator correlate two systems.
 *
 * `durationMs` is the END-TO-END total and the three phases sum to it, so a reader can check the
 * arithmetic rather than take it on trust.
 */

import type { LogRecord } from "../storage/mod.ts";

/** The one event type a job span uses. */
export const SYNTHESIS_SPAN_EVENT = "synthesis.span";

export interface SpanPhases {
  /** Enqueue to claim: how long the episode waited for a worker. */
  queueWaitMs: number;
  /** Claim to audio in hand: article, script and TTS. */
  synthesisMs: number;
  /** Audio in hand to the completion write: the blob store and the episode write. */
  writeMs: number;
}

/**
 * Round, and never negative or unusable.
 *
 * `Math.max(0, Math.round(NaN))` is NaN, so an unmeasurable phase would have reached the record as
 * NaN — which JSON turns into null and a reader has to interpret. A timing nobody measured is
 * recorded as 0, which is honest about being unmeasured and cannot be mistaken for a value.
 */
const ms = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

export function synthesisSpan(
  episode: { id: string; userId: string; attempts?: number },
  phases: SpanPhases,
  outcome: { severity?: "info" | "warn" | "error"; reason?: string } = {},
): Omit<LogRecord, "seq"> {
  const queueWaitMs = ms(phases.queueWaitMs);
  const synthesisMs = ms(phases.synthesisMs);
  const writeMs = ms(phases.writeMs);
  const total = queueWaitMs + synthesisMs + writeMs;
  return {
    time: new Date().toISOString(),
    // A span that finishes normally is not a finding; one that finishes with a reason is, and the
    // caller says how bad. This is what makes a slow synthesis visible to obs-1's errors feed.
    severity: outcome.severity ?? "info",
    type: SYNTHESIS_SPAN_EVENT,
    process: "worker",
    message: `synthesis of episode ${episode.id} took ${total}ms (queue ${queueWaitMs}ms, ` +
      `synthesis ${synthesisMs}ms, write ${writeMs}ms)`,
    correlationId: episode.id,
    job: "synthesis",
    episodeId: episode.id,
    userId: episode.userId,
    ...(typeof episode.attempts === "number" ? { attempt: episode.attempts } : {}),
    durationMs: total,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    context: { queueWaitMs, synthesisMs, writeMs },
  };
}

/**
 * How long a phase may take before it is worth flagging.
 *
 * Deliberately blunt and few: these are "a human should look" thresholds, not a performance
 * dashboard, and a threshold nobody can explain is worse than none. A synthesis is a paid TTS call
 * plus two model calls, so a minute is not alarming and five is; a write is blob storage and one
 * episode write, so a second is generous.
 */
export const SPAN_THRESHOLDS = {
  queueWaitMs: 300_000,
  synthesisMs: 300_000,
  writeMs: 5_000,
} as const;

/**
 * A queue wait that has stopped being a queue.
 *
 * Separate from the warn band because an episode that waited an HOUR was not slow, it was stuck, and
 * the difference matters: this is the diagnosis the span exists to make, and a pathological wait
 * reported as `info` is invisible to a poller whose default filter is warn+error (audio-feed-cbzg).
 */
export const PATHOLOGICAL_QUEUE_WAIT_MS = 3_600_000;

/** The severity a completed span deserves, and why — or nothing when it is unremarkable. */
export function spanSeverity(
  phases: SpanPhases,
): { severity: "info" | "warn" | "error"; reason?: string } {
  // Checked FIRST and at its own severity: a long queue wait explains a long everything-else, and
  // reporting it as a slow synthesis would point the reader at the wrong component.
  if (phases.queueWaitMs >= PATHOLOGICAL_QUEUE_WAIT_MS) {
    return {
      severity: "error",
      reason: `waited ${
        ms(phases.queueWaitMs)
      }ms for a worker, over the ${PATHOLOGICAL_QUEUE_WAIT_MS}ms pathological threshold`,
    };
  }
  if (phases.queueWaitMs >= SPAN_THRESHOLDS.queueWaitMs) {
    return {
      severity: "warn",
      reason: `waited ${
        ms(phases.queueWaitMs)
      }ms for a worker, over the ${SPAN_THRESHOLDS.queueWaitMs}ms threshold`,
    };
  }
  if (phases.synthesisMs >= SPAN_THRESHOLDS.synthesisMs) {
    return {
      severity: "warn",
      reason: `synthesis took ${
        ms(phases.synthesisMs)
      }ms, over the ${SPAN_THRESHOLDS.synthesisMs}ms threshold`,
    };
  }
  if (phases.writeMs >= SPAN_THRESHOLDS.writeMs) {
    return {
      severity: "warn",
      reason: `write took ${ms(phases.writeMs)}ms, over the ${SPAN_THRESHOLDS.writeMs}ms threshold`,
    };
  }
  return { severity: "info" };
}
