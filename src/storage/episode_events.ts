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
import type { EpisodeClaim, LogRecord } from "./mod.ts";

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

/** Columns every synthesis lifecycle record carries, so they can always be found together. */
function base(episode: Pick<Episode, "id" | "userId" | "attempts">) {
  return {
    process: "storage" as const,
    correlationId: episode.id,
    job: "synthesis",
    episodeId: episode.id,
    userId: episode.userId,
    ...(typeof episode.attempts === "number" ? { attempt: episode.attempts } : {}),
  };
}

/**
 * A claim started. Emitted BEFORE the worker does any work, which is the whole point: a process
 * killed during synthesis leaves this record behind, and its absence of a terminal partner is what
 * tells the next reader that the work died rather than never started.
 */
export function claimEvent(episode: Episode, claim: EpisodeClaim): Omit<LogRecord, "seq"> {
  return {
    ...base(episode),
    time: claim.now,
    severity: "info",
    type: "synthesis.claim",
    message: `claimed episode for synthesis (attempt ${episode.attempts ?? 1})`,
    phase: "claimed",
    context: { owner: claim.owner, leaseMs: claim.leaseMs, maxClaims: claim.maxClaims },
  };
}

/**
 * A claim was abandoned rather than re-billed, with the reason the previous code could not state.
 *
 * `reason` is the same sentence the episode carries, deliberately: an operator reading the log and
 * one reading the episode must not be able to reach different conclusions. `attempts` is the count
 * that triggered it, so a reader can tell "gave up after N" from "died on the first try".
 */
export function abandonEvent(
  episode: Episode,
  reason: string,
  maxClaims: number,
): Omit<LogRecord, "seq"> {
  return {
    ...base(episode),
    time: new Date().toISOString(),
    severity: "error",
    type: "synthesis.abandoned",
    message: reason,
    phase: "abandoned",
    reason,
    context: { maxClaims },
  };
}

/**
 * A terminal outcome, successful or not.
 *
 * Emitted from `completeEpisode` rather than from the worker so that EVERY caller is covered —
 * the cron, the poll loop, and the manual admin route that once bypassed the spend ceiling
 * (audio-feed-v2ym). A terminal record is what turns "the claim exists and nothing followed it"
 * into a fact about how long the work ran before it died.
 */
export function terminalEvent(episode: Episode, durationMs: number): Omit<LogRecord, "seq"> {
  const failed = episode.status === "failed";
  return {
    ...base(episode),
    time: new Date().toISOString(),
    severity: failed ? "error" : "info",
    type: failed ? "synthesis.failed" : "synthesis.ready",
    message: failed
      ? `synthesis failed: ${episode.error ?? "no reason recorded"}`
      : "synthesis finished and the audio was written",
    phase: "terminal",
    reason: failed ? (episode.error ?? "no reason recorded") : undefined,
    durationMs,
    context: { status: episode.status },
  };
}
