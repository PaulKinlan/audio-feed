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
import { GeminiTtsClient, GeminiTtsTruncatedError } from "../tts/gemini.ts";
import type { DecodedAudioResult } from "../tts/gemini.ts";
import type { AppContext } from "../app.ts";
import { DEFAULT_CLAIM_LEASE_MS, DEFAULT_MAX_CLAIMS } from "../types.ts";
import type { Article, AudioMode, Episode, Source } from "../types.ts";

/** Transcription of one job into the client call; injectable so tests need no network. */
export type Synthesizer = (job: {
  article: Article;
  source: Source | null;
  episode: Episode;
  mode: AudioMode;
}) => Promise<DecodedAudioResult>;

export interface SynthesisWorkerOptions {
  /** Episodes per tick. Sequential: each result can be a megabyte of audio. */
  batchSize?: number;
  /** Delay between ticks when idle. */
  intervalMs?: number;
  /** Attempts per episode before it is marked failed. */
  maxAttempts?: number;
  /** Base backoff between attempts. */
  retryBaseDelayMs?: number;
  maxEpisodeSeconds?: number;
  /** How long a claim is honoured before another worker may take the episode. */
  leaseMs?: number;
  /** Claims per episode before it is abandoned as unprocessable. */
  maxClaims?: number;
  /** Worker identity recorded on the claim. Defaults to a per-process id. */
  owner?: string;
}

/**
 * One id per process. Two isolates therefore never share an owner, which is
 * what lets `completeEpisode` tell "my claim" from "someone else's".
 */
const WORKER_ID = `worker-${crypto.randomUUID()}`;

const DEFAULTS: Required<SynthesisWorkerOptions> = {
  batchSize: 5,
  intervalMs: 15_000,
  maxAttempts: 3,
  retryBaseDelayMs: 500,
  maxEpisodeSeconds: 0,
  leaseMs: DEFAULT_CLAIM_LEASE_MS,
  maxClaims: DEFAULT_MAX_CLAIMS,
  owner: WORKER_ID,
};

export interface SynthesisBatchResult {
  /** Episodes that became ready this tick. */
  ready: Array<{ episodeId: string; audioKey: string; byteLength: number }>;
  /** Episodes recorded as failed, with the reason a human will read. */
  failed: Array<{ episodeId: string; error: string }>;
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

/** Default synthesizer: the real client, with the source's configured voices. */
export function createGeminiSynthesizer(ctx: AppContext): Synthesizer {
  const client = new GeminiTtsClient({ apiKey: ctx.config.geminiApiKey });
  return async ({ article, source, mode }) => {
    if (mode === "deepdive") {
      const [expert, foil] = source?.voices.deepdive ?? ["Kore", "Puck"];
      return await client.synthesizeDialogue({
        title: article.title,
        article: {
          title: article.title,
          author: article.author,
          body: article.content,
          summary: article.excerpt,
        },
        speakers: [
          { name: "Alex", role: "expert", voice: expert },
          { name: "Sam", role: "curious_foil", voice: foil },
        ],
      });
    }
    return await client.synthesizeNarration({
      title: article.title,
      author: article.author,
      publishedAt: article.publishedAt,
      sourceName: source?.title,
      body: article.content,
      voice: source?.voices.direct,
    });
  };
}

/**
 * One tick: claim pending episodes, synthesise them, write what succeeded.
 *
 * Exported separately from the loop so a test (and an operator with a CLI) can
 * drain the queue once without starting a timer.
 */
export async function runSynthesisBatch(
  ctx: AppContext,
  synthesize: Synthesizer,
  options: SynthesisWorkerOptions = {},
): Promise<SynthesisBatchResult> {
  const opts = { ...DEFAULTS, ...options };
  const result: SynthesisBatchResult = {
    ready: [],
    failed: [],
    deferred: [],
    skipped: [],
    superseded: [],
    considered: 0,
  };
  const { metadata, blobs } = ctx.stores;
  const nowMs = Date.now();

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
  const candidates = await metadata.listPendingEpisodes({
    limit: Math.max(opts.batchSize * 3, 20),
    nowMs,
    leaseMs: opts.leaseMs,
  });

  const authCache = new Map<string, string | null>();
  const isUserAuthorized = async (userId: string): Promise<string | null> => {
    if (authCache.has(userId)) return authCache.get(userId)!;
    let reason: string | null = null;
    try {
      await assertAuthorizedForAudio(metadata, userId);
    } catch (error) {
      reason = error instanceof NotAuthorizedError ? "not authorized" : String(error);
    }
    authCache.set(userId, reason);
    return reason;
  };

  const pending: Array<{ episode: Episode; userId: string }> = [];
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

    const article = await metadata.getArticle(claimed.userId, claimed.articleId);
    if (!article) {
      const error = "article record is missing";
      await metadata.completeEpisode({ ...claimed, status: "failed", error }, opts.owner);
      result.failed.push({ episodeId: claimed.id, error });
      continue;
    }
    const source = await metadata.getSource(claimed.userId, claimed.sourceId);

    let audio: DecodedAudioResult | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      try {
        audio = await synthesize({ article, source, episode: claimed, mode: claimed.mode });
        break;
      } catch (error) {
        lastError = error;
        if (isPermanent(error) || attempt === opts.maxAttempts) break;
        // Exponential backoff; the client already honours Retry-After for its own
        // 429/503 retries, so this covers what is left.
        await sleep(opts.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    if (!audio) {
      const error = String((lastError as Error)?.message ?? lastError ?? "synthesis failed");
      const wrote = await metadata.completeEpisode(
        { ...claimed, status: "failed", error },
        opts.owner,
      );
      if (wrote) result.failed.push({ episodeId: claimed.id, error });
      else result.superseded.push(supersededEntry(claimed, opts.leaseMs));
      continue;
    }

    const bytes = audio.format === "wav" ? audio.rawBytes : audio.toWav();
    const audioKey = `${claimed.id}.wav`;
    const stored = await blobs.put(audioKey, bytes, { contentType: "audio/wav" });

    const byteLength = stored.size ?? bytes.length;
    // Claim-conditional: if this worker's lease expired and another already
    // finished the episode, writing here would overwrite the winner's audio
    // with ours and leave no trace that it happened.
    const wrote = await metadata.completeEpisode({
      ...claimed,
      status: "ready",
      audioKey,
      // The enclosure is built from these, so they must describe the stored bytes.
      byteLength,
      contentType: "audio/wav",
      durationSeconds: audio.durationSeconds,
      readyAt: new Date().toISOString(),
      error: undefined,
    }, opts.owner);

    if (wrote) result.ready.push({ episodeId: claimed.id, audioKey, byteLength });
    else result.superseded.push(supersededEntry(claimed, opts.leaseMs));
  }

  return result;
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
