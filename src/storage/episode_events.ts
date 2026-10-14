/**
 * The lifecycle records for synthesis claims (audio-feed-wzv9, for the siv1 defect).
 *
 * Both adapters build their records here, so a claim logged by the KV store and one logged by the
 * memory store are the same record field for field — the conformance suite asserts the behaviour,
 * and this module makes divergence impossible rather than merely tested.
 *
 * WHY THE STORAGE LAYER WRITES THESE. A claim that dies mid-synthesis never reaches a caller: the
 * worker is gone and the abandonment decision is made here, inside the next `claimEpisode`, by a
 * completely different process. A record written only at the call site would be missing exactly
 * the cases this exists to explain, which is why the emission sits on the state transition.
 *
 * `process` is therefore "storage" — honestly, not as a placeholder: it says which layer produced
 * the record. The worker's own records carry their phase detail under `process: "worker"`, and the
 * two are joined by `correlationId`, which is the episode id so that every attempt at one episode
 * reads as one story. `attempt` says which chapter it is.
 */

import type { Episode } from "../types.ts";
import type { LogRecord } from "./mod.ts";
import { cleanString, MAX_LOG_MESSAGE_LENGTH } from "./log_shape.ts";

/**
 * How long the claim ran, for the terminal record's `durationMs` (obs-4 reads this as a trace:
 * a synthesis that took four minutes and one that died after two seconds are different findings).
 * Zero when the claim time is unreadable, which is a value rather than a guess.
 */
export function elapsedSince(claimedAt: string | undefined, nowMs = Date.now()): number {
  if (!claimedAt) return 0;
  const started = Date.parse(claimedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, nowMs - started);
}

/**
 * The claim lifecycle is ONE event shape, not one per lifecycle moment.
 *
 * WHY ONE TYPE. A claim has five things worth recording — it started, its phase moved, it finished,
 * it was abandoned, an attempt failed — and giving each its own `type` produced five names for one
 * story, so a reader had to know all five to answer "what happened to this episode". It also meant
 * the store and the worker could each write a differently shaped record for the same fact, which is
 * the state this converged with audio-feed-siv1 to avoid. There is one type, `claim.lifecycle`, and
 * the FIELD that varies (`phase`, `reason`) says which moment it is.
 *
 * THE SHAPE, documented here because this is the shape obs-1's errors API, obs-3's view and siv1's
 * claim bookkeeping all consume:
 *
 *   type          "claim.lifecycle" — the only type the claim lifecycle writes
 *   phase         "claimed" at the start of an attempt, otherwise the worker's execution phase —
 *                 deliberately the SAME vocabulary siv1 persists on the episode (reading_article,
 *                 generating_script, uploading_audio, …), so one fact has one name
 *   attempt       1-based attempt number, from the episode's own counter
 *   reason        present only when an attempt ENDED: the observable cause, never an asserted one.
 *                 An abandonment says the lease expired and that worker state is unknown, because
 *                 that is what the store can see — it never claims the worker died (audio-feed-kd5r)
 *   episodeId     the episode, so every attempt of one episode reads as one story
 *   correlationId the episode id, so obs-1 can group without joining
 *   durationMs    claim to terminal, only on a terminal record
 *   context       the observed facts behind the record: owner/leaseMs/maxClaims on a claim, and
 *                 expiredAt/lastHeartbeat/provenance/workerState on an abandonment
 *
 * THE PRODUCER. The storage state transitions are the lifecycle's writer, in both adapters:
 * `claimEpisode` (start, and abandonment), `touchEpisodeClaim` (phase) and `completeEpisode`
 * (terminal). That is deliberate rather than convenient: siv1 made phase and heartbeat durable
 * writes on the episode, so the transition is the only place that cannot miss a phase change, and
 * the worker needs no log writer of its own — which is what stops two shapes appearing for one
 * fact. `claimEpisode` emits the start record BEFORE the claim is honoured, because a process
 * killed mid-synthesis leaves that record behind and its lack of a terminal partner is what
 * distinguishes a claim that died from one that never started (audio-feed-siv1, audio-feed-wzv9).
 */

/** The one event type the claim lifecycle writes. */
export const CLAIM_LIFECYCLE_EVENT = "claim.lifecycle";

/** The phase recorded when an attempt starts. siv1 persists this same value on the episode. */
export const CLAIM_START_PHASE = "claimed";

/** Episode identity and optional article/source/size metadata carried onto claim lifecycle records (audio-feed-4y9v). */
export type ClaimLifecycleEpisode =
  & Pick<Episode, "id" | "userId" | "attempts">
  & Partial<
    Pick<
      Episode,
      | "articleId"
      | "sourceId"
      | "sourceTitle"
      | "mode"
      | "byteLength"
      | "bytesAttempted"
      | "durationSeconds"
      | "scriptTurns"
    >
  >;

/** Facts every lifecycle record carries, from the episode it is about. */
function identity(episode: ClaimLifecycleEpisode): Omit<LogRecord, "seq"> {
  return {
    time: new Date().toISOString(),
    severity: "info",
    type: CLAIM_LIFECYCLE_EVENT,
    process: "storage",
    message: "",
    correlationId: episode.id,
    job: "synthesis",
    episodeId: episode.id,
    userId: episode.userId,
    ...(typeof episode.attempts === "number" ? { attempt: episode.attempts } : {}),
  } as Omit<LogRecord, "seq">;
}

export interface ClaimLifecycleFields {
  /** "claimed" at the start of an attempt, otherwise the worker's execution phase. */
  phase: string;
  /** Present only when the attempt ended. The observable cause. */
  reason?: string;
  /**
   * Structured verdict for how a claim ENDED, when the writer knows (audio-feed-2sec, audio-feed-aueh).
   *
   * `"yielded"` says the claim was DELIBERATELY released so a later invocation can resume the
   * episode: no terminal write happened, and any `reason` on the same record is explanation,
   * not verdict. Without this field the record's prose is the only signal, and a reader that
   * treats "has a reason" as "ended terminally" reports a yielded claim as a failure with a
   * terminal write - a false statement about the episode's durable state.
   *
   * `"expired"` says the claim lease expired without a terminal write and was reclaimed for a
   * subsequent attempt; the previous attempt's claim lifecycle is closed with severity "warn".
   */
  claimOutcome?: "yielded" | "expired";
  /** Terminal-upload retry count recorded by the worker when yielding (audio-feed-lqd6). */
  uploadRetry?: number;
  /** Optional article/synthesis size facts when known to the caller (audio-feed-4y9v). */
  inputByteLength?: number;
  wordCount?: number;
  segmentCount?: number;
  /** Which attempt this record is about, when the caller knows better than the episode does. */
  attempt?: number;
  severity?: "info" | "warn" | "error";
  /** Overrides the record's instant, for a transition whose time the caller already fixed. */
  time?: string;
  durationMs?: number;
  process?: "storage" | "worker";
  context?: LogRecord["context"];
}

/**
 * One claim-lifecycle record.
 *
 * The message is prose built from the same fields, and contains no request path, no capability and
 * no URL — an episode id and a phase are what a reader needs, and nothing here is user-controlled.
 */
export function claimLifecycleEvent(
  episode: ClaimLifecycleEpisode,
  fields: ClaimLifecycleFields,
): Omit<LogRecord, "seq"> {
  const attempt = fields.attempt ?? episode.attempts ?? 1;
  const subject = `claim ${attempt} of episode ${episode.id} is in phase "${fields.phase}"`;
  // An error can have a reason that is empty, whitespace-only, or erased by the store's cleaner.
  // Only error prose needs this check; preserve genuine completions and readable reasons as written.
  const readableReason = fields.severity === "error" && fields.reason
    ? cleanString(fields.reason, MAX_LOG_MESSAGE_LENGTH).trim()
    : fields.reason;
  const message = readableReason
    ? `${subject}: ${fields.reason}`
    : fields.durationMs !== undefined
    ? `${subject}: synthesis ${
      fields.severity === "error" ? "failed" : "finished"
    } in ${fields.durationMs}ms`
    : subject;
  // Article, source, and size facts from the episode record (audio-feed-4y9v), merged before
  // caller-supplied `fields.context` so explicit overrides win.
  const episodeContext: Record<string, unknown> = {
    ...(episode.articleId ? { articleId: episode.articleId } : {}),
    ...(episode.sourceId ? { sourceId: episode.sourceId } : {}),
    ...(episode.sourceTitle ? { sourceTitle: episode.sourceTitle } : {}),
    ...(episode.mode ? { mode: episode.mode } : {}),
    ...(typeof episode.byteLength === "number" ? { byteLength: episode.byteLength } : {}),
    // audio-feed-amhn: the size the terminal upload was ABOUT to send. Present on an episode that was
    // abandoned by a kill inside the put, where `byteLength` is structurally absent because it is only
    // written on completion - so the failure record names the payload size instead of losing it.
    ...(typeof episode.bytesAttempted === "number"
      ? { bytesAttempted: episode.bytesAttempted }
      : {}),
    ...(typeof episode.durationSeconds === "number"
      ? { durationSeconds: episode.durationSeconds }
      : {}),
    ...(Array.isArray(episode.scriptTurns) ? { scriptTurnCount: episode.scriptTurns.length } : {}),
    ...(fields.inputByteLength !== undefined ? { inputByteLength: fields.inputByteLength } : {}),
    ...(fields.wordCount !== undefined ? { wordCount: fields.wordCount } : {}),
    ...(fields.segmentCount !== undefined ? { segmentCount: fields.segmentCount } : {}),
  };
  // The structured verdict merges into `context`, which survives the log sanitiser's
  // key passthrough (only key NAMES matching the redaction pattern are stripped).
  const context = {
    ...episodeContext,
    ...fields.context,
    ...(fields.claimOutcome ? { claimOutcome: fields.claimOutcome } : {}),
    ...(fields.uploadRetry !== undefined ? { uploadRetry: fields.uploadRetry } : {}),
  };
  return {
    ...identity(episode),
    ...(fields.time ? { time: fields.time } : {}),
    ...(fields.process ? { process: fields.process } : {}),
    severity: fields.severity ?? "info",
    message,
    phase: fields.phase,
    attempt,
    ...(fields.reason ? { reason: fields.reason } : {}),
    ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}

/**
 * An attempt that ended without a terminal write: the lease expired and the store is taking the
 * episode over. This is the record the siv1 incident was missing.
 *
 * Every fact here is observed — the expiry instant, the last heartbeat, the last phase, the attempt
 * number and who claimed it. `workerState` is `"unknown"` and the reason says so in words: the store
 * can see that nobody wrote a result, not why, and a record that asserts "the worker died" would be
 * believed later by someone who cannot tell it was a guess (audio-feed-kd5r).
 */
export function abandonedClaimEvent(
  episode: ClaimLifecycleEpisode,
  observed: {
    phase: string;
    attempt: number;
    reason: string;
    expiredAt?: string;
    lastHeartbeat?: string;
    provenance?: string;
    maxClaims?: number;
  },
): Omit<LogRecord, "seq"> {
  return claimLifecycleEvent(episode, {
    phase: observed.phase,
    attempt: observed.attempt,
    reason: observed.reason,
    // `error`, not `warn`: a claim that reached its attempt ceiling without a terminal write is the
    // incident siv1 was, and obs-1's consumer is looking for exactly this.
    severity: "error",
    context: {
      workerState: "unknown",
      ...(observed.expiredAt ? { expiredAt: observed.expiredAt } : {}),
      ...(observed.lastHeartbeat ? { lastHeartbeat: observed.lastHeartbeat } : {}),
      ...(observed.provenance ? { provenance: observed.provenance } : {}),
      ...(observed.maxClaims !== undefined ? { maxClaims: observed.maxClaims } : {}),
    },
  });
}

/**
 * An attempt whose lease expired without a terminal write before being reclaimed for another attempt
 * (audio-feed-aueh).
 *
 * Emitted when an expired claim is reclaimed while attempts <= maxClaims. Unlike abandonedClaimEvent
 * (which is final and writes severity "error"), this writes severity "warn" and context claimOutcome
 * "expired", giving the expired attempt a terminal record in the log stream while preserving observed facts:
 * phase reached, expiry timestamp, last heartbeat, attempt number, and provenance.
 */
export function expiredClaimEvent(
  episode: ClaimLifecycleEpisode,
  observed: {
    phase: string;
    attempt: number;
    reason: string;
    expiredAt?: string;
    lastHeartbeat?: string;
    provenance?: string;
    maxClaims?: number;
  },
): Omit<LogRecord, "seq"> {
  return claimLifecycleEvent(episode, {
    phase: observed.phase,
    attempt: observed.attempt,
    reason: observed.reason,
    severity: "warn",
    ...(observed.expiredAt ? { time: observed.expiredAt } : {}),
    context: {
      claimOutcome: "expired",
      workerState: "unknown",
      ...(observed.expiredAt ? { expiredAt: observed.expiredAt } : {}),
      ...(observed.lastHeartbeat ? { lastHeartbeat: observed.lastHeartbeat } : {}),
      ...(observed.provenance ? { provenance: observed.provenance } : {}),
      ...(observed.maxClaims !== undefined ? { maxClaims: observed.maxClaims } : {}),
    },
  });
}
