/**
 * Background synthesis worker (audio-feed-b3a).
 *
 * Ingest queues an article and an episode with status `pending`; until this ran,
 * nothing ever turned that into audio — the last gap between "nothing 501s" and
 * "the product makes a podcast".
 *
 * The loop is deliberately boring: every tick it lists pending episodes, asks the
 * approval gate whether the owner may still spend money, synthesises through the
 * Gemini 3.8 Flash TTS client, writes the audio to the blob store and marks the
 * episode `ready`. A failed job is recorded as `failed` with its reason rather
 * than retried forever, because every attempt is money.
 *
 * Ownership and safety:
 * - The gate is re-checked HERE, not only at ingest: an approval can be revoked
 *   between queueing and synthesis, and this is the process that spends.
 * - Unauthorised jobs are DEFERRED, not failed: a suspended user may be
 *   re-admitted, and deferring does not spend. They are simply not picked up.
 * - Retries are bounded (maxAttempts) with backoff. The TTS client already
 *   retries 429/503 internally and honours Retry-After, so this outer loop covers
 *   the rest (blob write failures, transient transport errors); after that the
 *   episode is marked failed so a poison job cannot bill repeatedly.
 *
 * Exclusivity and recovery (audio-feed-vfs / audio-feed-kiq):
 * - Every episode is taken with an ATOMIC CLAIM immediately before its own
 *   synthesis. `server.ts` starts a worker per process and Deno Deploy runs
 *   several isolates, so without a compare-and-swap two workers both saw
 *   `pending`, both wrote `synthesizing`, and both paid for the same episode.
 * - The claim carries a LEASE, which is what makes `synthesizing` recoverable.
 *   A worker that dies mid-synthesis leaves a claim nobody will finish; once the
 *   lease expires another worker takes it over, instead of the episode sitting
 *   in a status the queue never looks at, forever.
 * - The terminal write is claim-conditional. A slow worker whose lease expired
 *   must not overwrite the result of the worker that superseded it.
 * - Claims are bounded per episode. Lease recovery without a bound re-bills a
 *   job that reliably kills its host, which is the one case the in-tick retry
 *   counter cannot see — it dies with the process.
 */
import { assertAuthorizedForAudio, NotAuthorizedError } from "../auth/users.ts";
import {
  DEFAULT_NARRATION_VOICE,
  DEFAULT_TIMEOUT_MS,
  formatCodeForTts,
  GeminiTtsClient,
  GeminiTtsError,
  GeminiTtsTruncatedError,
  MAX_TTS_INPUT_BYTES,
  MAX_TTS_SEGMENTS,
  ttsClientConfig,
} from "../tts/gemini.ts";
import type { DecodedAudioResult, DialogueSpeaker } from "../tts/gemini.ts";
import type { AppContext } from "../app.ts";
import { PROMPT_VERSION } from "../tts/prompt_version.ts";
import {
  createGroundedScriptGenerator,
  type GroundedScriptInput,
  type ScriptGenerator,
} from "./script.ts";
import {
  audioBlobKey,
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_CODE_HANDLING,
  DEFAULT_MAX_CLAIMS,
  DEFAULT_VOICES,
  INBOX_SOURCE_ID,
  segmentBlobKey,
  segmentTextHash,
  unsynthesized,
  utcDayKey,
} from "../types.ts";
import type { Article, AudioMode, Episode, Source, SynthesisSegmentRecord } from "../types.ts";
import { type BlobInfo, type BlobStore, collect, type MetadataStore } from "../storage/mod.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import {
  DEFAULT_DAILY_EPISODE_BUDGET,
  DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET,
  DEFAULT_MAX_INVOCATION_DURATION_MS,
} from "../config.ts";
import { spanSeverity, SYNTHESIS_SPAN_EVENT, synthesisSpan } from "../observability/spans.ts";
import { claimLifecycleEvent } from "../storage/episode_events.ts";
import {
  ASSUMED_UPLOAD_BYTES_PER_MS,
  type BudgetedOutcome,
  ESTIMATED_SCRIPT_STAGE_DURATION_MS,
  ESTIMATED_TTS_TURN_DURATION_MS,
  ESTIMATED_UPLOAD_DURATION_MS,
  estimateUploadDurationMs,
  INVOCATION_FLUSH_MARGIN_MS,
  InvocationBudgetAbortError,
  isInvocationBudgetAbort,
  SynthesisYieldError,
  withInvocationBudget,
} from "../synthesis/limits.ts";

/** Segment blob deletions in flight at once (audio-feed-ikst). Bounded so the sweep
 * that follows a finished run cannot stampede the blob store. */
const SEGMENT_DELETE_CONCURRENCY = 8;

/** Transcription of one job into the client call; injectable so tests need no network. */
export type Synthesizer = (job: {
  article: Article;
  source: Source | null;
  episode: Episode;
  mode: AudioMode;
  /** Claim lifetime for lease-aware network cancellation; injected synthesizers may ignore it. */
  leaseMs?: number;
  /**
   * Durable resumable chunking (audio-feed-wr1u). The worker builds these hooks around the
   * claim; a synthesizer that forwards them to the TTS client resumes persisted segments and
   * persists each new one before the next paid call. Injected synthesizers may ignore them,
   * exactly like leaseMs — the episode then simply re-bills on resume, as before wr1u.
   */
  resume?: SegmentResume;
  /**
   * Invocation budget constraints (audio-feed-vqu4, audio-feed-9wqt).
   * When limits are reached, synthesis yields cleanly with SynthesisYieldError.
   */
  invocationBudget?: {
    maxSegments?: number;
    maxDurationMs?: number;
    startTimeMonotonicMs?: number;
    estimatedTurnDurationMs?: number;
    estimatedScriptDurationMs?: number;
    flushMarginMs?: number;
  };
}) => Promise<DecodedAudioResult>;

/** The prepare/commit pair the TTS client drives; see SynthesisOptions.resume. */
export interface SegmentResume {
  prepare: (
    segmentText: string,
    voice: string,
  ) => Promise<{ wav: Uint8Array } | "synthesize" | "held">;
  commit: (segmentText: string, decoded: DecodedAudioResult, voice: string) => Promise<void>;
}

export interface SynthesisWorkerOptions {
  /** Episodes per tick. Sequential: each result can be a megabyte of audio. */
  batchSize?: number;
  /** Delay between ticks when idle. */
  intervalMs?: number;
  /** Attempts per episode before it is marked failed. */
  maxAttempts?: number;
  /** Base backoff between attempts. */
  retryBaseDelayMs?: number;
  /**
   * Maximum narration input allowed for synthesis before spend, in UTF-8 BYTES
   * (audio-feed-3hb, audio-feed-y98q). The unit matters: the segmenter packs
   * MAX_TTS_INPUT_BYTES bytes per paid call, so a character count admitted multibyte
   * articles that the 12-segment cap then rejected inside the client — after the episode
   * had been claimed. Measured after code handling, matching what the client segments.
   * Defaults to MAX_TTS_INPUT_BYTES * MAX_TTS_SEGMENTS.
   */
  maxInputBytes?: number;
  /**
   * The daily per-user episode ceiling applied to a subscriber with no
   * `dailyEpisodeBudget` of their own (audio-feed-khk3). Defaults to the deployment's
   * `config.defaultDailyEpisodeBudget`, then to DEFAULT_DAILY_EPISODE_BUDGET — and a
   * value that is not a finite number >= 0 falls back the same way, so there is no
   * value of this option, and no state of the user record, that leaves a subscriber
   * without a ceiling.
   *
   * Deliberately NOT a key of DEFAULTS above: the deployment value has to be able to win,
   * and a default spread into the options object would have silently masked it.
   */
  defaultDailyEpisodeBudget?: number;
  /**
   * The ceiling on paid episodes per UTC day across EVERY subscriber (audio-feed-m182).
   *
   * The per-subscriber ceiling above bounds one subscriber, so total spend grows with the number of
   * approved subscribers. This bounds the sum. Resolved explicit -> deployment config -> constant,
   * and resolved inside the worker like the ceiling above, so no entry point that synthesises can
   * forget it. Also deliberately NOT a key of DEFAULTS, for the same reason.
   */
  globalDailyEpisodeBudget?: number;
  /** How long a claim is honoured before another worker may take the episode. */
  leaseMs?: number;
  /** Claims per episode before it is abandoned as unprocessable. */
  maxClaims?: number;
  /** Worker identity recorded on the claim. Defaults to a per-process id. */
  owner?: string;
  /**
   * Maximum newly synthesized segments to produce in a single invocation before
   * checkpointing and yielding the claim back to the queue (audio-feed-vqu4).
   * Default: undefined (unbounded by segment count).
   */
  maxSegmentsPerInvocation?: number;
  /**
   * Maximum duration in ms a single invocation may spend synthesizing before
   * checkpointing and yielding back to the queue (audio-feed-vqu4).
   * Defaults to DEFAULT_MAX_INVOCATION_DURATION_MS (45_000ms), safely inside Deno Deploy's cron isolate lifetime.
   */
  maxInvocationDurationMs?: number;
  /** Margin reserved for flushing checkpoints and yields in ms (audio-feed-9wqt, audio-feed-vvwb). */
  flushMarginMs?: number;
  /** Estimated worst-case duration for one TTS turn in ms (audio-feed-9wqt, audio-feed-vvwb). */
  estimatedTurnDurationMs?: number;
  /** Estimated worst-case duration for terminal audio upload in ms (audio-feed-dv4p). */
  estimatedUploadDurationMs?: number;
  /** Revision for a regenerated audio key. Injectable so a test can force a repeat. */
  revision?: () => string;
  /** Current time in ms since epoch; injectable so tests can advance time deterministically. */
  nowMs?: number;
}

/**
 * One id per process. Two isolates therefore never share an owner, which is
 * what lets `completeEpisode` tell "my claim" from "someone else's".
 */
const WORKER_ID = `worker-${crypto.randomUUID()}`;

const DEFAULTS: Required<
  Omit<
    SynthesisWorkerOptions,
    | "nowMs"
    | "defaultDailyEpisodeBudget"
    | "globalDailyEpisodeBudget"
    | "maxSegmentsPerInvocation"
    | "maxInvocationDurationMs"
    | "flushMarginMs"
    | "estimatedTurnDurationMs"
    | "estimatedUploadDurationMs"
  >
> = {
  batchSize: 5,
  intervalMs: 15_000,
  maxAttempts: 3,
  retryBaseDelayMs: 500,
  // At most 12 sequential TTS calls; preserve the 15-minute claim lease and per-episode spend.
  // In UTF-8 bytes, the same unit as the TTS budget it approximates: see maxInputBytes.
  maxInputBytes: MAX_TTS_INPUT_BYTES * MAX_TTS_SEGMENTS,
  leaseMs: DEFAULT_CLAIM_LEASE_MS,
  maxClaims: DEFAULT_MAX_CLAIMS,
  owner: WORKER_ID,
  // A full UUID: 8 hex digits could repeat a key still on the orphan list (audio-feed-8oz).
  revision: () => crypto.randomUUID(),
};

/**
 * The daily ceiling in force for one subscriber, and where it came from.
 *
 * Called at BOTH gates — the gather-time fairness filter and the spend gate — so the two cannot
 * disagree about who is over budget; before this they each carried their own copy of the condition.
 *
 * An unusable explicit budget (negative, NaN, non-integer, Infinity) is treated as ABSENT rather
 * than as unlimited. The condition this replaces was `typeof budget === "number" && budget >= 0`,
 * which is not a validity check: `Number("abc")` in the admin form produced NaN, NaN failed the
 * comparison, and the budget was silently ignored — the same unbounded outcome as never setting one.
 *
 * A `deploymentDefault` that is not a finite number >= 0 also falls back to the constant, so no
 * caller, test double or future refactor can hand this function a value that means "no ceiling".
 */
export function dailyEpisodeBudgetFor(
  user: { dailyEpisodeBudget?: number } | null | undefined,
  deploymentDefault?: number,
): { limit: number; source: "user" | "default" } {
  const own = user?.dailyEpisodeBudget;
  if (typeof own === "number" && Number.isFinite(own) && own >= 0) {
    return { limit: own, source: "user" };
  }
  const fallback = typeof deploymentDefault === "number" && Number.isFinite(deploymentDefault) &&
      deploymentDefault >= 0
    ? deploymentDefault
    : DEFAULT_DAILY_EPISODE_BUDGET;
  return { limit: fallback, source: "default" };
}

/**
 * The fleet-wide daily ceiling in force, and where it came from (audio-feed-m182).
 *
 * The same shape as dailyEpisodeBudgetFor, and for the same reason: an unusable value (negative,
 * NaN, non-integer, Infinity) means ABSENT, not unlimited, so no caller, test double or future
 * refactor can hand this function something that means "no ceiling". `configured` distinguishes a
 * number an operator set (option or environment) from the built-in constant, because those are
 * different decisions and the defer reason should say which one stopped the work.
 */
export function globalDailyEpisodeBudgetFor(
  option?: number,
  deployment?: number,
): { limit: number; source: "configured" | "default" } {
  const usable = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const configured = usable(option) ?? usable(deployment);
  return configured === undefined
    ? { limit: DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET, source: "default" }
    : { limit: configured, source: "configured" };
}

/**
 * The deferral reason when the fleet-wide ceiling has been reached.
 *
 * Parallel to budgetDeferReason, and it names the ceiling it was, the day's usage, and whether the
 * number was configured or the built-in default — an operator reading a deferred episode has to be
 * able to tell "I set this" from "nobody set this".
 */
function globalCeilingDeferReason(
  budget: { limit: number; source: "configured" | "default" },
  spentToday: number,
): string {
  const base =
    `daily spend ceiling reached across all subscribers (limit: ${budget.limit}, used: ` +
    `${spentToday}`;
  return budget.source === "configured"
    ? `${base})`
    : `${base}, source: built-in default - no global budget configured)`;
}

/**
 * The deferral reason for a subscriber at their ceiling. The configured-budget wording is byte for
 * byte what audio-feed-9mp shipped, because the admin console and its tests read it; a subscriber
 * held by the deployment default gets the extra clause so an operator can tell a configured limit
 * from the ceiling that was applied because nobody configured one (audio-feed-khk3).
 */
function budgetDeferReason(
  budget: { limit: number; source: "user" | "default" },
  spentToday: number,
): string {
  const base = `daily episode budget exceeded (limit: ${budget.limit}, used: ${spentToday}`;
  return budget.source === "user"
    ? `${base})`
    : `${base}, source: deployment default - no per-user budget configured)`;
}

export interface SynthesisBatchResult {
  /** Episodes that became ready this tick. */
  ready: Array<{ episodeId: string; audioKey: string; byteLength: number }>;
  /** Episodes recorded as failed, with the reason a human will read. */
  failed: Array<{ episodeId: string; error: string; title?: string }>;
  /** Jobs not attempted because the owner may not spend (left pending). */
  deferred: Array<{ episodeId: string; reason: string }>;
  /**
   * Jobs another worker holds, or that are out of claims. Nothing was spent —
   * this is the normal outcome of losing a race, not a failure.
   */
  skipped: Array<{ episodeId: string; reason: string }>;
  /**
   * Work that completed but could not be written because the claim was lost.
   *
   * Reported rather than swallowed: it is money spent for nothing, and a rising
   * count means the lease is too short for real synthesis times.
   *
   * `heldMs` is what makes it actionable. "Superseded" says the lease is wrong;
   * "superseded after 1080s, lease was 900s" says what to set it to. Without the
   * number, the next tuning round is another guess.
   */
  superseded: Array<{ episodeId: string; heldMs: number; leaseMs: number }>;
  /**
   * Episodes that made forward progress and yielded back to pending to respect
   * the invocation budget (audio-feed-vqu4).
   */
  yielded: Array<{ episodeId: string; completedTurns: number; totalTurns: number }>;
  /** Pending episodes considered. */
  considered: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long this worker held the claim it just lost, against the lease it was
 * given. The gap between the two is the amount by which the lease was too
 * short — which is the number an operator needs, not the fact of the refusal.
 */
function supersededEntry(
  episode: Episode,
  leaseMs: number,
): { episodeId: string; heldMs: number; leaseMs: number } {
  const claimedAtMs = Date.parse(episode.claimedAt ?? "");
  return {
    episodeId: episode.id,
    heldMs: Number.isFinite(claimedAtMs) ? Date.now() - claimedAtMs : -1,
    leaseMs,
  };
}

/** A failure that retrying cannot fix, so the episode is marked failed immediately. */
function isPermanent(error: unknown): boolean {
  // audio-feed-9yu8: the whole-episode wrapper carries the verdict explicitly, because its own
  // status is not the provider's. A status-less deadline abort is retryable here; a provider
  // verdict, our spend-guard 409 or a truncation is not, whatever number it happens to carry.
  if (error instanceof GeminiTtsError && error.permanent) return true;
  if (error instanceof GeminiTtsTruncatedError) return true;
  const status = (error as { status?: number }).status;
  if (typeof status === "number") {
    // 429/503 are transient; anything else is a request the API rejected.
    return status !== 429 && status !== 503 && status < 500;
  }
  const message = String((error as Error)?.message ?? error);
  if (/SAFETY/i.test(message)) return true;
  return false;
}

/**
 * Record a phase and heartbeat checkpoint for an owned claim (audio-feed-2m5z).
 *
 * Every phase/script checkpoint write must be awaited and checked. If the store throws
 * or returns false (CAS failure: claim lost, lease expired, or taken over), abort the
 * claim visibly with a permanent GeminiTtsError so synthesis does not proceed to paid work.
 */
export async function checkpointEpisodeClaim(
  metadata: MetadataStore,
  userId: string,
  episodeId: string,
  owner: string,
  update: {
    phase: string;
    now?: string;
    scriptTurns?: Array<{ speaker: string; text: string }>;
  },
): Promise<void> {
  let ok: boolean;
  try {
    ok = await metadata.touchEpisodeClaim(userId, episodeId, owner, update);
  } catch (error) {
    throw new GeminiTtsError(
      `claim checkpoint failed at phase "${update.phase}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
      error,
      true, // permanent: abort claim immediately without retry
    );
  }
  if (!ok) {
    throw new GeminiTtsError(
      `claim checkpoint failed at phase "${update.phase}": claim no longer held by worker ${owner}`,
      409,
      undefined,
      true, // permanent: claim lost / superseded, abort immediately
    );
  }
}

/**
 * Timer heartbeat for a long awaited stage (audio-feed-aqms).
 *
 * `checkpointEpisodeClaim` fires only at stage BOUNDARIES, so while a stage is
 * awaited (the terminal upload being the one that motivated this) the claim's
 * `lastHeartbeat` freezes at the stage's entry checkpoint. From the outside - and
 * from the abandonment record written at lease expiry - "still uploading" is then
 * indistinguishable from "died at the checkpoint". This helper touches the claim on
 * a timer while the caller awaits its stage, with NO phase change: the record shows
 * the worker was alive N seconds into the stage, which is what makes the NEXT
 * incident diagnosable.
 *
 * The touch is phase-less on purpose: both metadata adapters log a lifecycle event
 * only when the phase CHANGES, so a heartbeat cannot bury the real transitions in
 * noise. It is best-effort: a failed touch (store hiccup, superseded claim) is
 * swallowed - the stage's own checkpoint/yield writes remain the durable truth.
 *
 * Returns a stop function; callers MUST call it when the stage ends. The timer is
 * unref'd so that even a missed stop cannot keep the isolate alive on its own.
 */
export function startClaimHeartbeat(
  metadata: MetadataStore,
  userId: string,
  episodeId: string,
  owner: string,
  opts: { leaseMs?: number; intervalMs?: number; now?: () => string } = {},
): () => void {
  const intervalMs = opts.intervalMs ??
    Math.min(30_000, Math.max(1_000, Math.floor((opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS) / 4)));
  const timer = setInterval(() => {
    void metadata.touchEpisodeClaim(userId, episodeId, owner, { now: opts.now?.() }).catch(
      () => {},
    );
  }, intervalMs);
  try {
    Deno.unrefTimer(timer);
  } catch {
    // Not a Deno timer handle in this runtime; the stop function still clears it.
  }
  return () => clearInterval(timer);
}

/**
 * The failure reason persisted on an episode and shown in the UI (audio-feed-bp6r).
 *
 * The TTS client wraps a turn failure as "TTS turn failed; ..." (audio-feed-bp6r) — its own status
 * is never the provider's, so persisting it would mislabel a client-side timeout as a provider
 * rejection. The wrapper carries the inner error in `details`; unwrap the chain so the record keeps
 * the true root: which timeout fired and its duration, or the provider's real HTTP status. A status
 * is reported as `provider status` only when the root error came from an actual API response (its
 * details carry the parsed response body, never an Error); our own client-side statuses — the
 * spend-guard 409 — are never dressed up as the provider's. Claim and mode make the record
 * actionable on their own: "claim 2/3" says the episode is about to be abandoned.
 */
export function describeSynthesisFailure(
  lastError: unknown,
  claimed: Pick<Episode, "attempts" | "mode">,
  maxClaims: number,
): string {
  let root = lastError;
  while (root instanceof GeminiTtsError && root.details instanceof Error) {
    root = root.details;
  }
  const message = String((lastError as Error)?.message ?? lastError ?? "synthesis failed");
  const parts = [`mode ${claimed.mode}`, `claim ${claimed.attempts ?? "?"}/${maxClaims}`];
  const status = (root as { status?: unknown })?.status;
  const rootDetails = root instanceof GeminiTtsError ? root.details : undefined;
  if (
    typeof status === "number" && rootDetails !== undefined && !(rootDetails instanceof Error)
  ) {
    parts.push(`provider status ${status}`);
  }
  return `${message} [${parts.join("; ")}]`;
}

/**
 * Default synthesizer: the real client, with voices resolved per audio-feed-4xt.
 *
 * Direct-mode narrator order: source voice, then the user's own preference
 * (`User.voice` — the existing field, not a newly-named `defaultVoice`), then the
 * system `DEFAULT_VOICE`, then DEFAULT_NARRATION_VOICE. Earlier terms are only
 * reachable because VoiceConfig fields are now optional and sources are no longer
 * stamped with a default at creation; with a required field hard-filled at
 * creation, the first term always won and the rest was decoration.
 *
 * Deep dive is deliberately NOT driven by DEFAULT_VOICE. A single default name has
 * no honest mapping onto a two-voice pair — "use it for the expert and keep Puck"
 * is a decision about the product, not an implementation detail — so the pair still
 * falls back to DEFAULT_VOICES.deepdive. Flagged for coord rather than chosen here.
 */
/**
 * Run the grounded script stage, or decide not to (audio-feed-yaz5).
 *
 * Three cases, in order: an injected generator (a test, or an operator pinning a model), an
 * explicit `null` (the stage is off), or the real generator when an API key exists. The stage
 * is best-effort by design: it costs a second API call per episode and can be refused for
 * reasons that say nothing about this article, so a failure logs the reason and returns
 * `undefined` — the caller then falls back to the static dialogue builder, which is exactly
 * how the pipeline behaved before this stage existed. A shallow episode is worse than a
 * researched one; it is not worse than no episode.
 */
/** Six bounded 60s grounded turns may be needed after MAX_TOKENS; each request still
 * has its own 60s deadline in script.ts. The worker claim lease remains the outer bound. */
export const DEFAULT_SCRIPT_STAGE_TIMEOUT_MS = 360_000;

async function runScriptStage(
  generator: ScriptGenerator | null,
  input: GroundedScriptInput,
  budget?: { maxDurationMs?: number; startTimeMonotonicMs?: number },
  flushMarginMs?: number,
  estimateMs = ESTIMATED_SCRIPT_STAGE_DURATION_MS,
  defaultTimeoutMs = DEFAULT_SCRIPT_STAGE_TIMEOUT_MS,
): Promise<Awaited<ReturnType<ScriptGenerator>> | undefined> {
  if (!generator) return undefined;
  const outcome = await withInvocationBudget({
    name: "script_generation",
    budget: budget?.maxDurationMs
      ? budget
      : { maxDurationMs: defaultTimeoutMs, startTimeMonotonicMs: performance.now() },
    flushMarginMs: budget?.maxDurationMs ? flushMarginMs : 0,
    worstCaseEstimateMs: budget?.maxDurationMs ? estimateMs : 0,
    fn: (signal) => generator(input, { signal }),
  });
  if (outcome.kind === "budget-yield") {
    if (budget?.maxDurationMs) {
      throw outcome.error;
    }
    console.warn(
      `[synthesis] grounded script stage failed for "${input.article.title}": ` +
        `grounded script stage exceeded ${defaultTimeoutMs}ms — falling back to the static dialogue builder`,
    );
    return undefined;
  }
  if (outcome.kind === "error") {
    console.warn(
      `[synthesis] grounded script stage failed for "${input.article.title}": ` +
        `${
          String((outcome.error as Error)?.message ?? outcome.error)
        } — falling back to the static dialogue builder`,
    );
    return undefined;
  }
  return outcome.value;
}

export function createGeminiSynthesizer(
  ctx: AppContext,
  /** Injectable so a test can drive the real request path with a capturing fetchFn
   *  instead of asserting on a helper the call site may or may not use. */
  deps: {
    client?: GeminiTtsClient;
    codeSummarizer?: (code: string) => string | Promise<string>;
    /** `undefined` = use the real generator when a key is configured; `null` = stage is off. */
    scriptGenerator?: ScriptGenerator | null;
    /** Whole-stage deadline across continued turns; see DEFAULT_SCRIPT_STAGE_TIMEOUT_MS. */
    scriptTimeoutMs?: number;
    perTurnTimeoutMs?: number;
    estimatedScriptDurationMs?: number;
    estimatedTurnDurationMs?: number;
    flushMarginMs?: number;
  } = {},
): Synthesizer {
  const client = deps.client ?? new GeminiTtsClient(ttsClientConfig(ctx.config));
  const scriptGenerator = deps.scriptGenerator === null ? null : deps.scriptGenerator ??
    (ctx.config.geminiApiKey
      ? createGroundedScriptGenerator({ apiKey: ctx.config.geminiApiKey })
      : null);
  return async ({
    article,
    source,
    episode,
    mode,
    leaseMs,
    resume,
    invocationBudget,
  }) => {
    // Stop paid work before the claim expires; reserve one minute for persisting its outcome.
    // A terminal TTS error prevents the worker retrying already-paid segments from turn one.
    const claimedAt = Date.parse(episode.claimedAt ?? "");
    const remainingMs = leaseMs && Number.isFinite(claimedAt)
      ? claimedAt + leaseMs - Date.now() - 60_000
      : undefined;
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw new GeminiTtsError("synthesis claim has insufficient lease time", 400);
    }
    const leaseSignal = remainingMs === undefined ? undefined : AbortSignal.timeout(remainingMs);
    const claimedBy = episode.claimedBy ?? "";
    const onProgress = async (turn: number, total: number) => {
      if (claimedBy) {
        await checkpointEpisodeClaim(ctx.stores.metadata, episode.userId, episode.id, claimedBy, {
          phase: `synthesizing_segment_${turn}_of_${total}`,
        });
      }
    };

    let initiatedTurnsCount = 0;
    let committedTurnsCount = 0;
    const wrappedResume = resume
      ? {
        prepare: async (segmentText: string, voice: string) => {
          const res = await resume.prepare(segmentText, voice);
          if (res === "synthesize") {
            initiatedTurnsCount++;
          }
          return res;
        },
        commit: async (
          segmentText: string,
          decoded: DecodedAudioResult,
          voice: string,
        ) => {
          await resume.commit(segmentText, decoded, voice);
          committedTurnsCount++;
        },
      }
      : undefined;

    const flushMargin = invocationBudget?.flushMarginMs ??
      deps.flushMarginMs ??
      (invocationBudget?.maxDurationMs ? INVOCATION_FLUSH_MARGIN_MS : 0);

    const shouldYield = (_completed: number, _total: number) => {
      if (
        invocationBudget?.maxSegments &&
        initiatedTurnsCount >= invocationBudget.maxSegments
      ) {
        return true;
      }
      // Preflight check before each turn: does remaining budget fit next turn + flush margin? (audio-feed-9wqt)
      if (invocationBudget?.maxDurationMs && invocationBudget?.startTimeMonotonicMs) {
        const elapsed = performance.now() - invocationBudget.startTimeMonotonicMs;
        const remaining = invocationBudget.maxDurationMs - elapsed;
        const turnEstimate = invocationBudget.estimatedTurnDurationMs ??
          deps.estimatedTurnDurationMs ??
          ESTIMATED_TTS_TURN_DURATION_MS;
        if (remaining < turnEstimate + flushMargin) {
          return true;
        }
      }
      return false;
    };

    const ttsOptions = {
      ...(leaseSignal ? { signal: leaseSignal } : {}),
      ...(wrappedResume ? { resume: wrappedResume } : (resume ? { resume } : {})),
      timeoutMs: deps.perTurnTimeoutMs ?? ctx.config.ttsTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      onProgress,
      shouldYield,
    };
    const codeHandling = source?.codeHandling ?? DEFAULT_CODE_HANDLING;
    if (mode === "deepdive") {
      // One home for the pair. This used to repeat ["Kore", "Puck"] as a literal
      // while the doc comment above claimed it fell back to DEFAULT_VOICES.deepdive
      // - the comment was describing an intention the line did not have, and
      // audio-feed-4xt made this branch reachable in production for the first time,
      // so the two could now disagree while both looked correct.
      // No `!`: DEFAULT_VOICES is typed Required, so the completeness of the fallback
      // is a compile-time guarantee rather than an assertion (audio-feed-9cz).
      const [expert, foil] = source?.voices.deepdive ?? DEFAULT_VOICES.deepdive;
      const speakers: [DialogueSpeaker, DialogueSpeaker] = [
        { name: "Alex", role: "expert", voice: expert },
        { name: "Sam", role: "curious_foil", voice: foil },
      ];
      // Research and write the script first (audio-feed-yaz5).
      // Check if script turns were already saved in a previous attempt (audio-feed-siv1)
      let turns = episode.scriptTurns;
      if (!turns || turns.length === 0) {
        if (claimedBy) {
          await checkpointEpisodeClaim(
            ctx.stores.metadata,
            episode.userId,
            episode.id,
            claimedBy,
            {
              phase: "generating_script",
            },
          );
        }
        const script = await runScriptStage(
          scriptGenerator,
          {
            article: {
              title: article.title,
              author: article.author,
              body: article.content,
              summary: article.excerpt,
            },
            speakers,
          },
          invocationBudget,
          flushMargin,
          deps.scriptTimeoutMs ??
            invocationBudget?.estimatedTurnDurationMs ??
            deps.estimatedTurnDurationMs ??
            ESTIMATED_SCRIPT_STAGE_DURATION_MS,
          remainingMs !== undefined
            ? Math.min(deps.scriptTimeoutMs ?? DEFAULT_SCRIPT_STAGE_TIMEOUT_MS, remainingMs)
            : (deps.scriptTimeoutMs ?? DEFAULT_SCRIPT_STAGE_TIMEOUT_MS),
        );
        turns = script?.turns;
        if (turns && turns.length > 0) {
          if (claimedBy) {
            await checkpointEpisodeClaim(
              ctx.stores.metadata,
              episode.userId,
              episode.id,
              claimedBy,
              {
                phase: "script_generated",
                scriptTurns: turns,
              },
            );
          }
          // Only cache in episode once checkpoint write has durably succeeded (audio-feed-2m5z)
          episode.scriptTurns = turns;

          // audio-feed-9wqt, audio-feed-vvwb: preflight check before first dialogue turn:
          // ensure remaining time fits at least one turn + flush margin
          if (invocationBudget?.maxDurationMs && invocationBudget?.startTimeMonotonicMs) {
            const elapsed = performance.now() - invocationBudget.startTimeMonotonicMs;
            const remaining = invocationBudget.maxDurationMs - elapsed;
            const turnEstimate = invocationBudget.estimatedTurnDurationMs ??
              deps.estimatedTurnDurationMs ??
              ESTIMATED_TTS_TURN_DURATION_MS;
            if (remaining < turnEstimate + flushMargin) {
              throw new SynthesisYieldError(
                0,
                turns.length,
                `Script generated; yielding before first turn: remaining budget ${
                  Math.round(remaining)
                }ms < required ${turnEstimate + flushMargin}ms`,
              );
            }
          }
        }
      }
      if (
        leaseSignal?.aborted ||
        (leaseMs && Number.isFinite(claimedAt) && Date.now() >= claimedAt + leaseMs - 60_000)
      ) {
        throw new GeminiTtsError("synthesis stopped before claim lease expired", 400);
      }
      const dialogueOutcome = await withInvocationBudget({
        name: "dialogue_tts",
        budget: invocationBudget,
        flushMarginMs: flushMargin,
        worstCaseEstimateMs: invocationBudget?.estimatedTurnDurationMs ??
          deps.estimatedTurnDurationMs ??
          ESTIMATED_TTS_TURN_DURATION_MS,
        completedTurns: committedTurnsCount,
        totalTurns: turns?.length ?? MAX_TTS_SEGMENTS,
        fn: (signal) => {
          const combinedSignal = signal && leaseSignal
            ? AbortSignal.any([leaseSignal, signal])
            : (signal ?? leaseSignal);
          return client.synthesizeDialogue({
            title: article.title,
            article: {
              title: article.title,
              author: article.author,
              body: article.content,
              summary: article.excerpt,
            },
            speakers,
            turns,
            codeHandling,
            codeSummarizer: deps.codeSummarizer,
          }, {
            ...ttsOptions,
            ...(combinedSignal ? { signal: combinedSignal } : {}),
          });
        },
      });
      if (dialogueOutcome.kind === "budget-yield") {
        throw dialogueOutcome.error;
      }
      if (dialogueOutcome.kind === "error") {
        const errMsg = String(dialogueOutcome.error);
        if (leaseSignal?.aborted || errMsg.includes("claim cancelled before TTS spend")) {
          throw new GeminiTtsError(
            "synthesis stopped before claim lease expired",
            400,
            dialogueOutcome.error,
          );
        }
        throw dialogueOutcome.error;
      }
      return dialogueOutcome.value;
    }

    // Only read the user record when nothing above it decided, so the common case
    // (a source with an explicit voice) costs no extra store read.
    const sourceVoice = source?.voices.direct;
    const user = sourceVoice ? null : await ctx.stores.metadata.getUser(episode.userId);
    // First NON-EMPTY wins, not first non-nullish: an empty `direct` string is what
    // "cleared but never set" looks like in stored data, and `??` would hand it to
    // the API as a voice name — the client's own `||` fallback would then silently
    // pick Charon and skip both the user preference and DEFAULT_VOICE.
    const voice = [sourceVoice, user?.voice, ctx.config.defaultVoice, DEFAULT_NARRATION_VOICE]
      .find((name): name is string => typeof name === "string" && name.trim() !== "") ??
      DEFAULT_NARRATION_VOICE;

    if (claimedBy) {
      await checkpointEpisodeClaim(ctx.stores.metadata, episode.userId, episode.id, claimedBy, {
        phase: "preparing_input",
      });
    }

    if (
      leaseSignal?.aborted ||
      (leaseMs && Number.isFinite(claimedAt) && Date.now() >= claimedAt + leaseMs - 60_000)
    ) {
      throw new GeminiTtsError("synthesis stopped before claim lease expired", 400);
    }
    const narrationOutcome = await withInvocationBudget({
      name: "narration_tts",
      budget: invocationBudget,
      flushMarginMs: flushMargin,
      worstCaseEstimateMs: invocationBudget?.estimatedTurnDurationMs ??
        deps.estimatedTurnDurationMs ??
        ESTIMATED_TTS_TURN_DURATION_MS,
      completedTurns: committedTurnsCount,
      totalTurns: MAX_TTS_SEGMENTS,
      fn: (signal) => {
        const combinedSignal = signal && leaseSignal
          ? AbortSignal.any([leaseSignal, signal])
          : (signal ?? leaseSignal);
        return client.synthesizeNarration({
          title: article.title,
          author: article.author,
          publishedAt: article.publishedAt,
          sourceName: source?.title ?? episode.sourceTitle,
          body: article.content,
          voice,
          codeHandling,
          codeSummarizer: deps.codeSummarizer,
        }, {
          ...ttsOptions,
          ...(combinedSignal ? { signal: combinedSignal } : {}),
        });
      },
    });
    if (narrationOutcome.kind === "budget-yield") {
      throw narrationOutcome.error;
    }
    if (narrationOutcome.kind === "error") {
      const errMsg = String(narrationOutcome.error);
      if (leaseSignal?.aborted || errMsg.includes("claim cancelled before TTS spend")) {
        throw new GeminiTtsError(
          "synthesis stopped before claim lease expired",
          400,
          narrationOutcome.error,
        );
      }
      throw narrationOutcome.error;
    }
    return narrationOutcome.value;
  };
}

/**
 * The resume hooks for one claimed episode (audio-feed-wr1u).
 *
 * prepare: a finalized record for this exact text at this prompt version and voice is reused
 * from its blob — no paid call. Anything else is RESERVED first (claim-conditional CAS), so a
 * worker that is no longer the live claimant hears "held"/refusal before spending, never
 * after. A reservation whose claim lease expired is stealable by the next claimant, like the
 * episode claim itself.
 *
 * commit: stores the segment's WAV under its own per-attempt key and finalizes the record,
 * claim-conditionally. A superseded worker's finalize fails and its blob is recorded as an
 * orphan rather than left silent.
 *
 * sweep: once the stitched audio is committed, the segment blobs and records have done their
 * job; deleting them here is what keeps the blob store from growing one WAV per segment per
 * episode forever.
 */
export function buildSegmentResume(
  ctx: AppContext,
  episode: Episode,
  options: { owner: string; leaseMs: number; revision: () => string; nowMs?: number },
): { resume: SegmentResume; sweep: () => Promise<void> } {
  const { metadata, blobs } = ctx.stores;
  const now = () => options.nowMs ?? Date.now();
  let listed: Promise<SynthesisSegmentRecord[]> | null = null;
  const records = () => listed ??= metadata.listSynthesisSegments(episode.userId, episode.id);

  const prepare = async (segmentText: string, voice: string) => {
    const textHash = segmentTextHash(segmentText);
    // Reuse is gated on prompt version AND voice: either changing means different words or
    // a different speaker, and neither may serve the old bytes. Slots are keyed by
    // (hash, version, voice), so drift does not fight the old record — it opens a new slot
    // beside it, and the episode's sweep reclaims the old blob once audio is committed.
    const existing = (await records()).find((record) =>
      record.textHash === textHash && record.finalized &&
      record.promptVersion === PROMPT_VERSION && record.voice === voice
    );
    if (existing) {
      const blob = await blobs.get(existing.audioKey).catch(() => null);
      if (
        blob && (blob.size ?? existing.byteLength) === existing.byteLength &&
        existing.text === segmentText
      ) {
        return { wav: await collect(blob.body) };
      }
      // Blob gone or record inconsistent with its own hash: speak again into a fresh
      // revision; the stranded record is sweep fodder, never reuse fodder.
    }
    const outcome = await metadata.reserveSynthesisSegment(
      episode.userId,
      episode.id,
      {
        textHash,
        text: segmentText,
        promptVersion: PROMPT_VERSION,
        voice,
        audioKey: "",
        byteLength: 0,
        owner: options.owner,
        claimAt: new Date(now()).toISOString(),
        createdAt: new Date(now()).toISOString(),
        finalized: false,
      },
      now(),
      options.leaseMs,
    );
    if (outcome === "finalized") {
      // Lost a reserve race to a record that finished between our list and our reserve:
      // reuse it if it matches, else speak again.
      const record = (await metadata.listSynthesisSegments(episode.userId, episode.id)).find(
        (r) =>
          r.textHash === textHash && r.finalized && r.promptVersion === PROMPT_VERSION &&
          r.voice === voice,
      );
      if (record) {
        const blob = await blobs.get(record.audioKey).catch(() => null);
        if (
          blob && (blob.size ?? record.byteLength) === record.byteLength &&
          record.text === segmentText
        ) {
          return { wav: await collect(blob.body) };
        }
      }
      return "synthesize";
    }
    if (outcome === "no-claim") {
      // This worker's claim is gone (superseded or lease-expired). "held" aborts the spend
      // before the paid call; the batch then reports the episode superseded.
      return "held";
    }
    return "synthesize";
  };

  const commit = async (segmentText: string, decoded: DecodedAudioResult, voice: string) => {
    const textHash = segmentTextHash(segmentText);
    const wav = decoded.format === "wav" ? decoded.rawBytes : decoded.toWav();
    const audioKey = segmentBlobKey(episode, textHash, options.revision());
    let byteLength = wav.length;
    try {
      const stored = await blobs.put(audioKey, wav, { contentType: "audio/wav" });
      byteLength = stored.size ?? wav.length;
    } catch (error) {
      // The segment audio exists only in this run's memory; stitching still succeeds, but
      // the next claimant cannot reuse it. Say so loudly rather than pretending.
      console.error(
        `[audio-feed] segment blob write failed for episode ${episode.id} segment ${textHash}:`,
        error,
      );
      return;
    }
    const finalized = await metadata.finalizeSynthesisSegment(
      episode.userId,
      episode.id,
      { textHash, promptVersion: PROMPT_VERSION, voice },
      { audioKey, byteLength },
      options.owner,
      now(),
      options.leaseMs,
    );
    if (!finalized) {
      // Superseded between reserve and finalize: the blob is this attempt's own key, so
      // deleting it can never take another worker's audio with it.
      try {
        await blobs.delete(audioKey);
      } catch {
        await metadata.recordOrphanBlob(audioKey).catch(() => {});
      }
    }
  };

  const sweep = async () => {
    const all = await metadata.listSynthesisSegments(episode.userId, episode.id);
    const keys = all.map((record) => record.audioKey).filter((key): key is string => Boolean(key));
    // audio-feed-ikst: bounded concurrency over the deletions. When an episode has ten
    // segments, serial deletes made the sweep the slowest part of finishing a run.
    // Each delete keeps its own failure handling, so one blob that refuses to go is
    // recorded as an orphan and the rest are still reclaimed.
    await mapWithConcurrency(keys, SEGMENT_DELETE_CONCURRENCY, async (key) => {
      try {
        await blobs.delete(key);
      } catch {
        await metadata.recordOrphanBlob(key).catch(() => {});
      }
    });
    await metadata.clearSynthesisSegments(episode.userId, episode.id);
  };

  return { resume: { prepare, commit }, sweep };
}

/**
 * One tick: claim pending episodes, synthesise them, write what succeeded.
 *
 * Exported separately from the loop so a test (and an operator with a CLI) can
 * drain the queue once without starting a timer.
 */
/**
 * Shared terminal settlement helper (audio-feed-y0da, audio-feed-g5bi, audio-feed-n8wk).
 * Owns the commit/settle/delete decision from durable state across cleanupOnAbort,
 * budget-yield, and error paths.
 */
async function settleTerminalPersistence(
  metadata: MetadataStore,
  blobs: BlobStore,
  userId: string,
  episodeId: string,
  owner: string,
  stagingKey: string,
  nowMs: number,
): Promise<{ committed: boolean; episode?: Episode }> {
  // Direct durable check: did completeEpisode commit ready with this stagingKey?
  const current = await metadata.getEpisode(userId, episodeId);
  if (current?.status === "ready" && current?.audioKey === stagingKey) {
    // Commit won! Refuse to delete blob and refuse to record orphan.
    return { committed: true, episode: current };
  }

  // Not ready with stagingKey: revert claim to pending so completeEpisode cannot commit.
  // audio-feed-aqms: the phase names WHAT WILL HAPPEN NEXT, not what finished: an
  // episode requeued here is RETRYING its upload on a later tick, and "upload_retry"
  // is legible as retrying on the admin page and in the claim history where
  // "audio_synthesized" read as a finished state with no reason attached.
  await metadata.yieldEpisodeClaim(
    userId,
    episodeId,
    owner,
    { phase: "upload_retry", now: new Date(nowMs).toISOString() },
  ).catch(() => {});

  // Re-check durable state: did completeEpisode commit concurrently during the yield?
  const checkAfter = await metadata.getEpisode(userId, episodeId);
  if (checkAfter?.status === "ready" && checkAfter?.audioKey === stagingKey) {
    return { committed: true, episode: checkAfter };
  }

  // Confirmed uncommitted: delete blob and record orphan in KV (audio-feed-fsbk)
  await blobs.delete(stagingKey).catch(() => {});
  await metadata.recordOrphanBlob(stagingKey).catch(() => {});
  return { committed: false };
}

export async function runSynthesisBatch(
  ctx: AppContext,
  synthesize: Synthesizer,
  options: SynthesisWorkerOptions = {},
): Promise<SynthesisBatchResult> {
  const opts = { ...DEFAULTS, ...options };
  /**
   * The deployment ceiling, resolved HERE from the context rather than threaded in by each caller
   * (audio-feed-v2ym). The first version of this fix resolved it at the call sites, so the cron
   * honoured `DEFAULT_DAILY_EPISODE_BUDGET` while the admin "synthesize now" route and
   * `startSynthesisWorker` charged the constant instead — and the dashboard, which reads the config,
   * advertised a limit those two paths were not applying. One resolution point means a new call site
   * cannot forget: an explicit option (a test, an operator) wins, then the deployment's config, then
   * the constant.
   */
  const deploymentDailyEpisodeBudget = options.defaultDailyEpisodeBudget ??
    ctx.config.defaultDailyEpisodeBudget;
  /**
   * The fleet-wide ceiling for this tick (audio-feed-m182). Resolved here rather than at each gate,
   * for the same reason the per-subscriber ceiling is: the gather-time filter and the spend gate
   * must not be able to disagree about whether the deployment has money left.
   */
  const globalBudget = globalDailyEpisodeBudgetFor(
    options.globalDailyEpisodeBudget,
    ctx.config.globalDailyEpisodeBudget,
  );
  let warnedGlobalCeiling = false;
  /** Users already reported as held by the deployment default this run (audio-feed-khk3). */
  const warnedDefaultBudget = new Set<string>();
  /**
   * Spend visibility (audio-feed-khk3, the other half of the audio-feed-9mp ask): say so, once per
   * run, when the ceiling that stopped work was the deployment default rather than a decision.
   *
   * Deliberately called from BOTH gates: the common case never reaches the spend gate at all,
   * because a subscriber already over budget is filtered out while the batch is being gathered, so
   * a warning that lived only in the spend gate would stay silent exactly when it matters. A
   * configured budget stays quiet — it is doing what its owner told it to.
   */
  const warnDefaultCeiling = (userId: string, limit: number): void => {
    if (warnedDefaultBudget.has(userId)) return;
    warnedDefaultBudget.add(userId);
    console.warn(
      `[audio-feed] holding work for user ${userId} at the deployment default daily ceiling of ${limit} (no per-user budget configured; set DEFAULT_DAILY_EPISODE_BUDGET or this subscriber's budget) (audio-feed-khk3)`,
    );
  };
  /**
   * Say it once per tick when the fleet-wide ceiling is what stopped the run (audio-feed-m182).
   *
   * Once per tick rather than per subscriber: the fleet ceiling belongs to the deployment, so a log
   * line per subscriber would be the same fact repeated, and khk3's per-user warning already covers
   * the per-subscriber case.
   */
  const warnGlobalCeiling = (limit: number): void => {
    console.warn(
      `[audio-feed] holding all work at the fleet-wide daily ceiling of ${limit} paid episodes (set GLOBAL_DAILY_EPISODE_BUDGET to raise it) (audio-feed-m182)`,
    );
  };
  const result: SynthesisBatchResult = {
    ready: [],
    failed: [],
    deferred: [],
    skipped: [],
    superseded: [],
    yielded: [],
    considered: 0,
  };
  const { metadata, blobs } = ctx.stores;
  const nowMs = options.nowMs ?? Date.now();
  const invocationStartMonotonicMs = performance.now();
  const maxSegmentsPerInvocation = options.maxSegmentsPerInvocation ??
    ctx.config.maxSegmentsPerInvocation;
  const maxInvocationDurationMs = options.maxInvocationDurationMs ??
    ctx.config.maxInvocationDurationMs ??
    DEFAULT_MAX_INVOCATION_DURATION_MS;
  const flushMargin = opts.flushMarginMs ?? INVOCATION_FLUSH_MARGIN_MS;
  const notifyEnabled = ctx.config.notifyOutboxEnabled ?? false;

  const notifyOnDemand = async (episode: Episode, status: "ready" | "failed", error?: string) => {
    if (!notifyEnabled || episode.sourceId !== INBOX_SOURCE_ID || episode.regenerating) return;
    try {
      const user = await metadata.getUser(episode.userId);
      const base = ctx.config.publicBaseUrl ? ctx.config.publicBaseUrl.replace(/\/+$/, "") : "";
      const playerUrl = user?.feedToken
        ? `${base}/listen/${encodeURIComponent(user.feedToken)}`
        : `${base}/listen`;
      await metadata.queueNotification({
        id: crypto.randomUUID(),
        userId: episode.userId,
        episodeId: episode.id,
        status,
        title: episode.title,
        playerUrl,
        error,
        createdAt: new Date(nowMs).toISOString(),
      });
    } catch (err) {
      console.error(`[audio-feed] failed to queue notification for episode ${episode.id}:`, err);
    }
  };

  // Cross-user FIFO queue (audio-feed-bbb):
  //
  // `listPendingEpisodes` lists the oldest pending or recoverable episodes across
  // all users in one query, ordered by createdAt ascending (FIFO). This eliminates the
  // per-user fan-out (scaling query count with queue depth, not total users) and
  // ensures older jobs are never starved behind a prolific user's backlog.
  //
  // Authorization is checked per-user before spending. Deferred work (e.g. from
  // unapproved/suspended users) is reported but does not block approved work behind it,
  // and result.deferred is capped at batchSize to prevent unbounded memory growth.
  // Cross-user FIFO queue (audio-feed-bbb):
  //
  // `listPendingEpisodes` lists the oldest pending or recoverable episodes across
  // all users in FIFO order. Paged in chunks so that a large backlog from unapproved
  // or suspended users cannot saturate the query window and starve approved jobs
  // (sotw-ds-flash review finding 5z1), while bounding per-tick scans (xxn).
  const pending: Array<{ episode: Episode; userId: string }> = [];
  const authCache = new Map<string, string | null>();
  const isUserAuthorized = async (userId: string): Promise<string | null> => {
    if (authCache.has(userId)) return authCache.get(userId)!;
    let reason: string | null = null;
    try {
      await assertAuthorizedForAudio(metadata, userId);
    } catch (error) {
      reason = error instanceof NotAuthorizedError ? "not authorized" : String(error);
    }
    // Check per-user daily episode budget ceiling (audio-feed-9mp, audio-feed-akm)
    if (reason === null) {
      try {
        const today = utcDayKey(new Date(nowMs));
        // audio-feed-m182: the fleet-wide ceiling first. It is the ceiling on the sum, so it applies
        // to every subscriber at once, and reading it per check means a tick that spends up to it
        // stops there rather than at the snapshot taken when the tick started.
        const globalToday = await metadata.getDailySynthesisCount(today);
        if (globalToday >= globalBudget.limit) {
          reason = globalCeilingDeferReason(globalBudget, globalToday);
          if (globalBudget.source === "default" && !warnedGlobalCeiling) {
            warnedGlobalCeiling = true;
            warnGlobalCeiling(globalBudget.limit);
          }
        }
        if (reason === null) {
          const user = await metadata.getUser(userId);
          const budget = dailyEpisodeBudgetFor(user, deploymentDailyEpisodeBudget);
          const spentToday = await metadata.getUserDailySynthesisCount(userId, today);
          if (spentToday >= budget.limit) {
            reason = budgetDeferReason(budget, spentToday);
            if (budget.source === "default") warnDefaultCeiling(userId, budget.limit);
          }
        }
      } catch (err) {
        // Fail closed for spend ceiling: if daily count cannot be verified, defer rather than spending
        reason = `could not verify daily budget: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
    authCache.set(userId, reason);
    return reason;
  };

  let cursor: string | undefined = undefined;
  const chunkSize = Math.max(opts.batchSize * 5, 25);

  while (pending.length < opts.batchSize) {
    const { episodes: candidates, cursor: nextCursor } = await metadata.listPendingEpisodes({
      cursor,
      limit: chunkSize,
      nowMs,
      leaseMs: opts.leaseMs,
    });
    if (candidates.length === 0) break;

    for (const episode of candidates) {
      if (pending.length >= opts.batchSize) break;
      result.considered++;

      const deferReason = await isUserAuthorized(episode.userId);
      if (deferReason !== null) {
        if (result.deferred.length < opts.batchSize) {
          result.deferred.push({ episodeId: episode.id, reason: deferReason });
        }
        continue;
      }

      pending.push({ episode, userId: episode.userId });
    }

    if (!nextCursor || candidates.length < chunkSize) break;
    cursor = nextCursor;
  }

  let claimedAny = false;
  const inFlightUploadKeys = new Set<string>();
  for (const { episode } of pending) {
    // Two approval checks, each for a different job:
    //  - the gather-time filter above decides fairly who gets the batch budget, so a
    //    suspended user cannot starve anyone;
    //  - this one is the SPEND gate. A tick is not instantaneous (real synthesis
    //    measured 10.2s per episode, so a batchSize of 5 runs ~50s), and a
    //    suspension landing inside that window must stop the money. The gather-time
    //    snapshot is "approved when the tick started"; this is "approved when we
    //    spend", and only the second one is the gate (audio-feed-opus review).
    try {
      await assertAuthorizedForAudio(metadata, episode.userId);
    } catch (error) {
      const reason = error instanceof NotAuthorizedError ? "not authorized" : String(error);
      // Deferred, not failed: nothing was spent and a lifted suspension can be served.
      result.deferred.push({ episodeId: episode.id, reason });
      continue;
    }

    // Check budget at spend gate (audio-feed-9mp, audio-feed-akm, audio-feed-khk3, audio-feed-m182)
    try {
      const today = utcDayKey(new Date(nowMs));
      // The fleet-wide ceiling is re-read here, not reused from the gather pass: a tick is not
      // instantaneous (5 episodes at ~10s each), so episodes completed during it have already added
      // to today's total. This is the check that stops the money; the gather pass only decides who
      // gets the batch.
      const globalToday = await metadata.getDailySynthesisCount(today);
      if (globalToday >= globalBudget.limit) {
        const reason = globalCeilingDeferReason(globalBudget, globalToday);
        if (globalBudget.source === "default" && !warnedGlobalCeiling) {
          warnedGlobalCeiling = true;
          warnGlobalCeiling(globalBudget.limit);
        }
        result.deferred.push({ episodeId: episode.id, reason });
        continue;
      }
      const spendUser = await metadata.getUser(episode.userId);
      const budget = dailyEpisodeBudgetFor(spendUser, deploymentDailyEpisodeBudget);
      const spentToday = await metadata.getUserDailySynthesisCount(episode.userId, today);
      if (spentToday >= budget.limit) {
        const reason = budgetDeferReason(budget, spentToday);
        if (budget.source === "default") warnDefaultCeiling(episode.userId, budget.limit);
        result.deferred.push({ episodeId: episode.id, reason });
        continue;
      }
    } catch (err) {
      // Fail closed: if budget verification fails, defer rather than spending blindly
      const reason = `could not verify daily budget: ${
        err instanceof Error ? err.message : String(err)
      }`;
      result.deferred.push({ episodeId: episode.id, reason });
      continue;
    }

    // Preflight check before claiming: ensure remaining batch time fits at least one turn + flush margin (audio-feed-9wqt)
    if (maxInvocationDurationMs) {
      const elapsed = performance.now() - invocationStartMonotonicMs;
      const remaining = maxInvocationDurationMs - elapsed;
      const requiredBatchMargin =
        (options.estimatedTurnDurationMs ?? ESTIMATED_TTS_TURN_DURATION_MS) +
        (options.flushMarginMs ?? INVOCATION_FLUSH_MARGIN_MS);
      if (remaining < requiredBatchMargin) {
        break;
      }
    }

    // Claim just-in-time, not at gather time. Claiming all five up front would
    // leave the last claim ageing through four synthesis calls, so a legitimate
    // long batch would manufacture its own stale lease.
    const claimed = await metadata.claimEpisode(episode.userId, episode.id, {
      owner: opts.owner,
      now: new Date().toISOString(),
      leaseMs: opts.leaseMs,
      maxClaims: opts.maxClaims,
    });
    if (!claimed) {
      // Another worker holds it, or it is out of claims and the store abandoned
      // it. Either way nothing was spent here.
      result.skipped.push({ episodeId: episode.id, reason: "claimed elsewhere or exhausted" });
      continue;
    }
    claimedAny = true;
    // audio-feed-i7vi: this attempt's span opens at the claim, because that is the moment the
    // episode stopped waiting for a worker and started working.
    const spanStartedAt = performance.now();
    /**
     * How long the episode waited for a worker — a PROXY, and deliberately labelled one.
     *
     * There is no enqueue timestamp on an episode, so this measures from `createdAt`: an episode that
     * sat in the queue after being created reads correctly, and one created long before it could be
     * processed reads too high. Measured anyway because a total cannot separate "the queue was backed
     * up" from "the TTS call hung", and those need different fixes; the direction of the error is
     * written down here rather than hidden behind a number that looks exact.
     */
    const spanQueueWaitMs = Date.parse(claimed.claimedAt ?? claimed.createdAt) -
      Date.parse(claimed.createdAt);
    try {
      await checkpointEpisodeClaim(metadata, claimed.userId, claimed.id, opts.owner, {
        phase: "reading_article",
      });
    } catch (err) {
      const error = String((err as Error)?.message ?? err);
      console.error(
        `[audio-feed] synthesis checkpoint failed for episode "${claimed.id}": ${error}`,
      );
      if (err instanceof GeminiTtsError && err.status === 409) {
        result.superseded.push(supersededEntry(claimed, opts.leaseMs));
      } else {
        const wrote = await metadata.completeEpisode(unsynthesized(claimed, error), opts.owner);
        if (wrote) {
          result.failed.push({ episodeId: claimed.id, error, title: claimed.title });
          await notifyOnDemand(claimed, "failed", error);
        } else {
          result.superseded.push(supersededEntry(claimed, opts.leaseMs));
        }
      }
      continue;
    }

    const article = await metadata.getArticle(claimed.userId, claimed.articleId);
    // A regeneration that produces no new audio goes back to ready on its old audio
    // rather than failing out of the feed (audio-feed-8oz).
    if (!article) {
      const error = "article record is missing";
      console.error(
        `[audio-feed] synthesis failed for episode "${claimed.id}" ("${claimed.title}"): ${error}`,
      );
      const wrote = await metadata.completeEpisode(unsynthesized(claimed, error), opts.owner);
      if (wrote) {
        result.failed.push({ episodeId: claimed.id, error, title: claimed.title });
        await notifyOnDemand(claimed, "failed", error);
      } else {
        result.superseded.push(supersededEntry(claimed, opts.leaseMs));
      }
      continue;
    }

    const source = await metadata.getSource(claimed.userId, claimed.sourceId);

    // The budget is in bytes, so the guard must count bytes (audio-feed-y98q): .length counts
    // UTF-16 code units, which for CJK/emoji under-counts by 2-3x and lets the client reject the
    // article at the 12-segment cap after this claim has already been spent. It must also measure
    // the text the client will SEGMENT rather than the raw article: code handling strips fenced
    // and <pre> blocks before segmentation, so counting raw bytes failed articles whose entire
    // overage was strippable code (audio-feed-n19w).
    // No summarizer is passed, deliberately: none of the production call sites gives the
    // synthesizer one, so `formatCodeForTts` strips code here exactly as the client will, and the
    // guard can never admit more than the client is willing to speak. It stays an approximation
    // in ONE respect — the client segments the prompt (this body plus a title/author preamble) and
    // may cut at a sentence boundary before a segment is full — so the client is still the exact
    // gate.
    const codeHandling = source?.codeHandling ?? DEFAULT_CODE_HANDLING;
    const narrationInput = await formatCodeForTts(article.content, codeHandling);
    const inputBytes = new TextEncoder().encode(narrationInput).length;
    if (opts.maxInputBytes && inputBytes > opts.maxInputBytes) {
      const error =
        `article content exceeds input limit (${inputBytes} > ${opts.maxInputBytes} bytes)`;
      console.error(
        `[audio-feed] synthesis failed for episode "${claimed.id}" ("${claimed.title}"): ${error}`,
      );
      const wrote = await metadata.completeEpisode(unsynthesized(claimed, error), opts.owner);
      if (wrote) {
        result.failed.push({ episodeId: claimed.id, error, title: claimed.title });
        await notifyOnDemand(claimed, "failed", error);
      } else {
        result.superseded.push(supersededEntry(claimed, opts.leaseMs));
      }
      continue;
    }

    // Durable resumable chunking (audio-feed-wr1u): hooks are bound to THIS claim, so every
    // reserve/finalize inside them is claim-conditional.
    const segmentResume = buildSegmentResume(ctx, claimed, {
      owner: opts.owner,
      leaseMs: opts.leaseMs,
      revision: opts.revision,
      nowMs: options.nowMs,
    });

    let audio: DecodedAudioResult | null = null;
    let lastError: unknown = null;
    let currentEpisode = claimed;
    const initialScriptTurns = claimed.scriptTurns?.length ?? 0;
    const initialSegments = (await metadata.listSynthesisSegments(claimed.userId, claimed.id))
      .filter((s) => s.finalized).length;

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      try {
        audio = await synthesize({
          article,
          source,
          episode: currentEpisode,
          mode: currentEpisode.mode,
          leaseMs: opts.leaseMs,
          resume: segmentResume.resume,
          invocationBudget: {
            maxSegments: maxSegmentsPerInvocation,
            maxDurationMs: maxInvocationDurationMs,
            startTimeMonotonicMs: invocationStartMonotonicMs,
          },
        });
        break;
      } catch (error) {
        lastError = error;
        if (isInvocationBudgetAbort(error)) {
          const yieldErr = error instanceof SynthesisYieldError
            ? error
            : new InvocationBudgetAbortError(0, 0, "Invocation budget reached");
          lastError = yieldErr;

          // FOUR-PROPERTY SYNTHESIS INVOCATION INVARIANT (audio-feed-fsr3, audio-feed-o88z):
          // 1. Bound: Per-invocation work is bounded by maxDurationMs and maxSegments.
          // 2. Preflight: Work is verified to fit before initiation, yielding if margin is insufficient.
          // 3. Provenance: Only our explicit InvocationBudgetAbortError sentinel yields; provider/lease aborts take retry/failure.
          // 4. Progress: DURABLE PROGRESS = observable on the next tick after a restart; anything else is not progress.
          //    Every yield must either make durable progress (finalized segments committed or scriptTurns checkpointed)
          //    resetting attempts to 0, or count against opts.maxAttempts. Zero-progress budget yields advance attempts
          //    and fail once maxAttempts is exhausted, preventing infinite livelocks and unbounded paid spend across cron ticks.
          const refreshed = await metadata.getEpisode(currentEpisode.userId, currentEpisode.id);
          const finalScriptTurns = refreshed?.scriptTurns?.length ?? 0;
          const finalSegments =
            (await metadata.listSynthesisSegments(currentEpisode.userId, currentEpisode.id))
              .filter((s) => s.finalized).length;

          const madeProgress = (finalSegments > initialSegments) ||
            (finalScriptTurns > 0 && initialScriptTurns === 0);

          if (!madeProgress && (claimed.attempts ?? 1) >= opts.maxAttempts) {
            // Refuse infinite livelock: zero progress across maxAttempts must fail the episode.
            break;
          }

          // Clean yield to respect invocation budget: resets attempts to 0 on progress, or advances attempts on zero progress.
          const yielded = await metadata.yieldEpisodeClaim(
            currentEpisode.userId,
            currentEpisode.id,
            opts.owner,
            {
              phase: `synthesized_${finalSegments}_of_${yieldErr.totalTurns}`,
              advanceAttempts: !madeProgress,
            },
          );
          if (yielded) {
            result.yielded.push({
              episodeId: currentEpisode.id,
              completedTurns: finalSegments,
              totalTurns: yieldErr.totalTurns,
            });
          } else {
            result.superseded.push(supersededEntry(currentEpisode, opts.leaseMs));
          }
          break;
        }
        if (isPermanent(error) || attempt === opts.maxAttempts) break;
        // Re-read current episode from store so any turns or phase touched during attempt 1
        // are available to subsequent retry attempts within this same claim (audio-feed-siv1)!
        const refreshed = await metadata.getEpisode(currentEpisode.userId, currentEpisode.id);
        if (refreshed && refreshed.claimedBy === opts.owner) {
          currentEpisode = refreshed;
        }
        // Exponential backoff; the client already honours Retry-After for its own
        // 429/503 retries, so this covers what is left.
        await sleep(opts.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    if (!audio) {
      if (
        isInvocationBudgetAbort(lastError) &&
        result.yielded.some((y) => y.episodeId === currentEpisode.id)
      ) {
        // audio-feed-vqu4: clean yield to respect invocation budget.
        // Check if whole batch time budget is spent before picking up another episode.
        if (
          maxInvocationDurationMs &&
          performance.now() - invocationStartMonotonicMs >= maxInvocationDurationMs
        ) {
          break;
        }
        continue;
      }
      const error = describeSynthesisFailure(lastError, currentEpisode, opts.maxClaims);
      console.error(
        `[audio-feed] synthesis failed for episode "${currentEpisode.id}" ("${currentEpisode.title}"): ${error}`,
      );
      if (lastError instanceof GeminiTtsError && lastError.status === 409) {
        result.superseded.push(supersededEntry(currentEpisode, opts.leaseMs));
      } else {
        const wrote = await metadata.completeEpisode(
          unsynthesized(currentEpisode, error),
          opts.owner,
        );
        if (wrote) {
          result.failed.push({
            episodeId: currentEpisode.id,
            error,
            title: currentEpisode.title,
          });
          await notifyOnDemand(currentEpisode, "failed", error);
        } else {
          result.superseded.push(supersededEntry(currentEpisode, opts.leaseMs));
        }
      }
      continue;
    }

    const bytes = audio.format === "wav" ? audio.rawBytes : audio.toWav();

    // audio-feed-aqms: the upload estimate must be honest about PAYLOAD SIZE. The flat
    // 5s floor is fine for a small blob and a lie for an episode WAV: a preflight bound
    // enforced by an estimate that ignores bytes STARTS a put that cannot finish inside
    // the remaining budget, and a put that outlives the invocation dies without a
    // terminal write (the phase is checkpointed BEFORE the put starts). Scale by bytes
    // so the preflight refuses to start what cannot fit, and the claim is yielded
    // resumably instead: the next 2-minute tick retries with a fresh budget and the
    // durable segment cache, converting a lost episode into lost minutes.
    const uploadEstimate = opts.estimatedUploadDurationMs ?? ESTIMATED_UPLOAD_DURATION_MS;
    const sizeScaledUploadEstimate = estimateUploadDurationMs(bytes.length, uploadEstimate);

    // FOUR-PROPERTY INVARIANT COVERS TERMINAL PERSISTENCE (audio-feed-dv4p):
    // 1. Bound: Invocation bound covers terminal audio blob write and metadata completion.
    // 2. Preflight: Verify remaining budget fits upload + flush margin; yield before starting if it cannot.
    // 3. Provenance: Upload timeout uses explicit InvocationBudgetAbortError sentinel; real blob store errors fail.
    // 4. Progress: Preserves all segment checkpoints on yield so subsequent tick can complete the upload.
    const previousKey = currentEpisode.regenerating ? currentEpisode.audioKey : undefined;
    const stagingKey = audioBlobKey(currentEpisode, "wav", opts.revision());
    const inFlightStagingKey = stagingKey;

    // audio-feed-i7vi: the synthesis phase ends where the terminal persistence block begins; the
    // blob upload and the commit that follow are the write phase, measured from here.
    const synthesisEndedAt = performance.now();

    // audio-feed-aqms: NEVER start an upload whose BYTE-SCALED duration alone cannot
    // fit even a FRESH invocation. A payload too large for the whole budget is not
    // deferrable - every tick would refuse it and yield forever with attempts reset
    // to zero (an unbounded livelock that the four-property invariant forbids). Fail
    // TERMINALLY with a legible reason instead: the operator learns the payload cannot
    // be uploaded under the current budget and what to change, instead of the episode
    // stalling for 15-minute leases and being abandoned with a reason that names no
    // cause.
    //
    // The gate deliberately ignores the conservative small-payload FLOOR: a floor that
    // exceeds a small budget (a test fixture, or a deliberately tiny deployment
    // budget) still yields resumably - a later invocation with a workable budget can
    // upload a small payload, exactly as the dv4p(a) test pins. Only the size-driven
    // term is a verdict about THIS payload: no invocation at this budget can ever
    // upload it.
    const byteScaledUploadEstimateMs = Math.ceil(bytes.length / ASSUMED_UPLOAD_BYTES_PER_MS);
    if (
      maxInvocationDurationMs !== undefined && maxInvocationDurationMs > 0 &&
      byteScaledUploadEstimateMs + flushMargin > maxInvocationDurationMs
    ) {
      const error =
        `terminal audio upload cannot fit the invocation budget: ${bytes.length} bytes at the assumed ` +
        `${ASSUMED_UPLOAD_BYTES_PER_MS} bytes/ms (~${
          Math.round(byteScaledUploadEstimateMs / 1000)
        }s plus ` +
        `${flushMargin}ms margin) exceeds MAX_INVOCATION_DURATION_MS (${maxInvocationDurationMs}ms); ` +
        `shorten the article or raise the budget (audio-feed-aqms)`;
      console.error(
        `[audio-feed] terminal upload refused for episode "${currentEpisode.id}" ("${currentEpisode.title}"): ${error}`,
      );
      const wrote = await metadata.completeEpisode(
        unsynthesized(currentEpisode, error),
        opts.owner,
      );
      if (wrote) {
        result.failed.push({ episodeId: currentEpisode.id, error, title: currentEpisode.title });
        await notifyOnDemand(currentEpisode, "failed", error);
      } else {
        result.superseded.push(supersededEntry(currentEpisode, opts.leaseMs));
      }
      continue;
    }

    // Only mark the key in-flight on paths that actually attempt the upload: the
    // never-fits gate above continues without starting a put, and a phantom entry
    // would make the orphan sweep skip a key nothing will ever settle (review P3).
    inFlightUploadKeys.add(inFlightStagingKey);

    const terminalEstimate = sizeScaledUploadEstimate + 10; // Upload + terminal commit + usage accounting (audio-feed-uecw)
    // audio-feed-aqms: timer heartbeat while the terminal stage is awaited. The phase
    // is checkpointed BEFORE the put starts, so without this the claim's heartbeat
    // freezes at "uploading_audio" entry and a lease that expires mid-upload cannot
    // distinguish "still uploading" from "died at the checkpoint".
    const stopTerminalHeartbeat = startClaimHeartbeat(
      metadata,
      currentEpisode.userId,
      currentEpisode.id,
      opts.owner,
      { leaseMs: opts.leaseMs },
    );
    let terminalOutcome: BudgetedOutcome<{ stored: BlobInfo; byteLength: number; wrote: boolean }>;
    try {
      // Universal helper withInvocationBudget governs terminal persistence (audio-feed-dv4p, audio-feed-mv1d, audio-feed-fsbk)
      terminalOutcome = await withInvocationBudget({
        name: "terminal_persistence",
        budget: {
          maxDurationMs: maxInvocationDurationMs,
          startTimeMonotonicMs: invocationStartMonotonicMs,
        },
        flushMarginMs: flushMargin,
        worstCaseEstimateMs: terminalEstimate,
        completedTurns: 1,
        totalTurns: 1,
        cleanupOnAbort: async () => {
          // Shared terminal settlement helper owns commit/settle/delete decision (audio-feed-g5bi)
          await settleTerminalPersistence(
            metadata,
            blobs,
            currentEpisode.userId,
            currentEpisode.id,
            opts.owner,
            stagingKey,
            nowMs,
          );
        },
        fn: async (signal) => {
          await checkpointEpisodeClaim(
            metadata,
            currentEpisode.userId,
            currentEpisode.id,
            opts.owner,
            {
              phase: "uploading_audio",
            },
          );
          if (signal?.aborted) {
            throw signal.reason;
          }

          // Abort-aware put with settlement cleanup token (audio-feed-fsbk), and
          // genuinely abortable since audio-feed-aqms: the wrapper's signal is
          // threaded into blobs.put, so the invocation-budget deadline closes the
          // socket (S3 adapter) / rejects (memory adapter) instead of leaving the
          // isolate awaiting an uninterruptible upload past its own bound.
          const putPromise = blobs.put(stagingKey, bytes, {
            contentType: "audio/wav",
            signal,
          });
          putPromise
            .finally(async () => {
              try {
                if (signal?.aborted) {
                  // Delete materialized blob when delayed put settles
                  await blobs.delete(stagingKey).catch(() => {});
                  // Only forget orphan record once blob is confirmed deleted
                  await metadata.forgetOrphanBlob(stagingKey).catch(() => {});
                }
              } finally {
                inFlightUploadKeys.delete(inFlightStagingKey);
              }
            })
            .catch(() => {});

          const stored = await putPromise;
          if (signal?.aborted) {
            await blobs.delete(stagingKey).catch(() => {});
            throw signal.reason;
          }

          const byteLength = stored.size ?? bytes.length;
          // Atomic terminal billing (audio-feed-thrs, audio-feed-pqo8):
          // Billing mutations are appended to the exact same atomic transaction as episode completion.
          const wrote = await metadata.completeEpisode(
            {
              ...currentEpisode,
              status: "ready",
              audioKey: stagingKey,
              byteLength,
              contentType: "audio/wav",
              durationSeconds: audio.durationSeconds,
              readyAt: previousKey && currentEpisode.readyAt
                ? currentEpisode.readyAt
                : new Date().toISOString(),
              promptVersion: PROMPT_VERSION,
              regenerating: undefined,
              error: undefined,
              phase: "ready",
              lastHeartbeat: new Date().toISOString(),
              scriptTurns: undefined,
            },
            opts.owner,
            { byteLength, at: new Date(nowMs) },
          );

          return { stored, byteLength, wrote };
        },
      });
    } finally {
      stopTerminalHeartbeat();
    }

    if (terminalOutcome.kind === "budget-yield") {
      const settle = await settleTerminalPersistence(
        metadata,
        blobs,
        currentEpisode.userId,
        currentEpisode.id,
        opts.owner,
        stagingKey,
        nowMs,
      );
      if (settle.committed && settle.episode) {
        // Complete won! Atomic billing was committed with completeEpisode (audio-feed-thrs).
        result.ready.push({
          episodeId: currentEpisode.id,
          audioKey: stagingKey,
          byteLength: settle.episode.byteLength ?? bytes.length,
        });
        break;
      }

      result.yielded.push({
        episodeId: currentEpisode.id,
        completedTurns: 1,
        totalTurns: 1,
      });
      // audio-feed-aqms: the retry churn must be OPERATOR-VISIBLE, not a pending
      // episode with no reason. The claim history gets one record per interrupted
      // upload naming the cause, so an episode stuck retrying reads as retrying
      // (coord condition on landing). Best-effort: a logging failure must never
      // disturb the yield that already happened.
      try {
        await metadata.appendLog(
          claimLifecycleEvent(currentEpisode, {
            phase: "upload_retry",
            attempt: currentEpisode.attempts ?? 1,
            reason: `terminal upload interrupted by invocation budget (${
              Math.round(bytes.length / 1024)
            } KB); retrying on a later tick`,
          }),
        );
      } catch {
        // nothing left to record it with; the yield itself is durable
      }
      break;
    }

    if (terminalOutcome.kind === "error") {
      const settle = await settleTerminalPersistence(
        metadata,
        blobs,
        currentEpisode.userId,
        currentEpisode.id,
        opts.owner,
        stagingKey,
        nowMs,
      );
      if (settle.committed && settle.episode) {
        // Complete won before error occurred (audio-feed-g5bi)! Blob was preserved.
        // Atomic billing was committed with completeEpisode (audio-feed-thrs).
        result.ready.push({
          episodeId: currentEpisode.id,
          audioKey: stagingKey,
          byteLength: settle.episode.byteLength ?? bytes.length,
        });
        break;
      }

      const error = String((terminalOutcome.error as Error)?.message ?? terminalOutcome.error);
      console.error(
        `[audio-feed] terminal persistence failed for episode "${currentEpisode.id}": ${error}`,
      );
      if (terminalOutcome.error instanceof GeminiTtsError && terminalOutcome.error.status === 409) {
        result.superseded.push(supersededEntry(currentEpisode, opts.leaseMs));
      } else {
        const wrote = await metadata.completeEpisode(
          unsynthesized(currentEpisode, error),
          opts.owner,
        );
        if (wrote) {
          result.failed.push({
            episodeId: currentEpisode.id,
            error,
            title: currentEpisode.title,
          });
          await notifyOnDemand(currentEpisode, "failed", error);
        } else {
          result.superseded.push(supersededEntry(currentEpisode, opts.leaseMs));
        }
      }
      continue;
    }
    const { byteLength, wrote } = terminalOutcome.value;
    const audioKey = stagingKey;

    if (wrote) {
      // audio-feed-i7vi: emitted only when the completion write was OURS. A superseded attempt's
      // timings describe work whose result was discarded, and recording them as a span would put a
      // phantom episode's cost into the traces.
      const spanPhases = {
        queueWaitMs: spanQueueWaitMs,
        synthesisMs: synthesisEndedAt - spanStartedAt,
        writeMs: performance.now() - synthesisEndedAt,
      };
      // TRACING MUST NEVER FAIL A SYNTHESIS THAT SUCCEEDED (audio-feed-77j9). The ready commit above
      // is already durable, so a rejected append here would report a completed episode as failed —
      // the reverse of what this span is for. appendLog is expected to resolve null rather than
      // reject, and this guard does not assume it: a throw is caught, the episode stays ready, and
      // the failure is recorded as its own event so a broken trace path is visible instead of silent.
      const spanRecord = synthesisSpan(currentEpisode, spanPhases, spanSeverity(spanPhases));
      try {
        await metadata.appendLog(spanRecord);
      } catch (err) {
        console.error(
          `[audio-feed] span append failed for episode ${currentEpisode.id}; synthesis is unaffected:`,
          err,
        );
        try {
          await metadata.appendLog({
            ...spanRecord,
            type: `${SYNTHESIS_SPAN_EVENT}_failed`,
            severity: "warn",
            message: `could not store the span for episode ${currentEpisode.id}`,
            reason: err instanceof Error ? err.name : "unknown",
          });
        } catch {
          // Nothing left to record it in. The synthesis result is what matters and it is intact.
        }
      }
      result.ready.push({ episodeId: currentEpisode.id, audioKey, byteLength });
      // The stitched audio is committed; the per-segment blobs have done their job.
      // Tail sweep, notification, statistics, and deletion path are all budgeted (audio-feed-mv1d):
      await withInvocationBudget({
        name: "segment_sweep",
        budget: {
          maxDurationMs: maxInvocationDurationMs,
          startTimeMonotonicMs: invocationStartMonotonicMs,
        },
        flushMarginMs: flushMargin,
        worstCaseEstimateMs: 200,
        fn: async () => {
          try {
            await segmentResume.sweep();
          } catch (err) {
            console.error(
              `[audio-feed] segment sweep failed for episode ${currentEpisode.id}; orphans recorded where possible:`,
              err,
            );
          }
        },
      });

      await withInvocationBudget({
        name: "notify_ready",
        budget: {
          maxDurationMs: maxInvocationDurationMs,
          startTimeMonotonicMs: invocationStartMonotonicMs,
        },
        flushMarginMs: flushMargin,
        worstCaseEstimateMs: 200,
        fn: () => notifyOnDemand(currentEpisode, "ready"),
      });

      if (previousKey && previousKey !== audioKey) {
        await withInvocationBudget({
          name: "delete_previous_audio",
          budget: {
            maxDurationMs: maxInvocationDurationMs,
            startTimeMonotonicMs: invocationStartMonotonicMs,
          },
          flushMarginMs: flushMargin,
          worstCaseEstimateMs: 100,
          fn: async () => {
            try {
              await blobs.delete(previousKey);
            } catch {
              await metadata.recordOrphanBlob(previousKey).catch(() => {});
            }
          },
        });
      }

      // audio-feed-vqu4: stop batch if invocation time budget has expired
      if (
        maxInvocationDurationMs &&
        performance.now() - invocationStartMonotonicMs >= maxInvocationDurationMs
      ) {
        break;
      }
    } else {
      await withInvocationBudget({
        name: "delete_superseded_audio",
        budget: {
          maxDurationMs: maxInvocationDurationMs,
          startTimeMonotonicMs: invocationStartMonotonicMs,
        },
        flushMarginMs: flushMargin,
        worstCaseEstimateMs: 100,
        fn: async () => {
          try {
            await blobs.delete(audioKey);
          } catch {
            await metadata.recordOrphanBlob(audioKey).catch(() => {});
          }
        },
      });
      result.superseded.push(supersededEntry(claimed, opts.leaseMs));
    }
  }

  // Retry old blobs a delete failed on, only in a batch that did work: an idle
  // tick stays one read (audio-feed-0ob). A delete that throws keeps the record.
  // A key an episode references again (a repeated revision) is forgotten, never
  // deleted: deleting it would leave the feed pointing at a missing file.
  if (claimedAny) {
    for (const key of await metadata.listOrphanBlobs(opts.batchSize)) {
      if (inFlightUploadKeys.has(key)) {
        // Upload is still in-flight in this isolate (audio-feed-fsbk).
        // Retain the durable orphan record in KV until the put has settled, so if this isolate
        // dies before settlement, a subsequent worker can clean up the orphan blob.
        continue;
      }
      const parsed = parseAudioBlobKey(key);
      if (!parsed) continue; // unparseable: left recorded for a human
      try {
        let referenced = false;
        if (parsed.segmentEpisodeId) {
          // A segment blob is live while any record of its episode still names it.
          referenced = (await metadata.listSynthesisSegments(
            parsed.userId,
            parsed.segmentEpisodeId,
          )).some((record) => record.audioKey === key);
        }
        for (const id of parsed.candidateIds) {
          const episode = await metadata.getEpisode(parsed.userId, id);
          if (episode?.audioKey === key) {
            referenced = true;
            break;
          }
        }
        if (!referenced) await blobs.delete(key);
        await metadata.forgetOrphanBlob(key);
      } catch {
        // a lookup or delete that throws leaves the record for the next batch
      }
    }
  }

  return result;
}

/**
 * Split `audio/<userId>/<mode>/<id>[-<rev>].<ext>` (see `audioBlobKey`). Ids are
 * UUIDs and contain hyphens, so every hyphen-boundary prefix of the name is a
 * candidate id; a wrong candidate can only make a key look referenced, which
 * keeps a blob rather than deleting one.
 */
export function parseAudioBlobKey(
  key: string,
): { userId: string; candidateIds: string[]; segmentEpisodeId?: string } | null {
  // audio-feed-wr1u: segment blobs live under their own prefix and are referenced by
  // segment RECORDS, not by episode.audioKey — the orphan sweeper checks them differently.
  const segment = /^audio-segments\/([^/]+)\/([^/]+)\/[^/]+$/.exec(key);
  if (segment?.[1] && segment[2]) {
    return { userId: segment[1], candidateIds: [], segmentEpisodeId: segment[2] };
  }
  const match = /^audio\/([^/]+)\/[^/]+\/([^/]+)\.[^./]+$/.exec(key);
  if (!match?.[1] || !match[2]) return null;
  const userId = match[1];
  const parts = match[2].split("-");
  const candidateIds = parts.map((_, i) => parts.slice(0, parts.length - i).join("-"));
  return { userId, candidateIds };
}

export interface SynthesisWorkerHandle {
  /** Resolves when the current tick finishes; the loop stops after it. */
  stop(): Promise<void>;
  /** Run one tick now (used by tests and by an operator draining the queue). */
  runOnce(): Promise<SynthesisBatchResult>;
}

/**
 * Poll loop. Wired by `src/server.ts` to the process lifetime.
 *
 * A poll rather than a watch: the metadata store exposes no change feed, the
 * batch is tiny, and a tick that finds nothing costs one list per user.
 */
export function startSynthesisWorker(
  ctx: AppContext,
  synthesize: Synthesizer,
  options: SynthesisWorkerOptions & {
    signal?: AbortSignal;
    onTick?: (r: SynthesisBatchResult) => void;
  } = {},
): SynthesisWorkerHandle {
  const opts = { ...DEFAULTS, ...options };
  let stopped = false;
  let running: Promise<SynthesisBatchResult> | null = null;

  const runOnce = async () => {
    const result = await runSynthesisBatch(ctx, synthesize, opts);
    options.onTick?.(result);
    return result;
  };

  const loop = async () => {
    while (!stopped && !options.signal?.aborted) {
      try {
        running = runOnce();
        await running;
      } catch (error) {
        // A tick must never kill the worker: record and keep the queue moving.
        console.error("[audio-feed] synthesis tick failed:", error);
      } finally {
        running = null;
      }
      if (stopped || options.signal?.aborted) break;
      await sleep(opts.intervalMs);
    }
  };
  void loop();

  return {
    async stop() {
      stopped = true;
      await running?.catch(() => {});
    },
    runOnce,
  };
}
