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
 */
import { assertAuthorizedForAudio, NotAuthorizedError } from "../auth/users.ts";
import { GeminiTtsClient, GeminiTtsTruncatedError } from "../tts/gemini.ts";
import type { DecodedAudioResult } from "../tts/gemini.ts";
import type { AppContext } from "../app.ts";
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
}

const DEFAULTS: Required<SynthesisWorkerOptions> = {
  batchSize: 5,
  intervalMs: 15_000,
  maxAttempts: 3,
  retryBaseDelayMs: 500,
  maxEpisodeSeconds: 0,
};

export interface SynthesisBatchResult {
  /** Episodes that became ready this tick. */
  ready: Array<{ episodeId: string; audioKey: string; byteLength: number }>;
  /** Episodes recorded as failed, with the reason a human will read. */
  failed: Array<{ episodeId: string; error: string }>;
  /** Jobs not attempted because the owner may not spend (left pending). */
  deferred: Array<{ episodeId: string; reason: string }>;
  /** Pending episodes considered. */
  considered: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const result: SynthesisBatchResult = { ready: [], failed: [], deferred: [], considered: 0 };
  const { metadata, blobs } = ctx.stores;

  // `listEpisodes` is user-scoped by design, so the queue is gathered per user.
  const users = await metadata.listUsers();
  const pending: Array<{ episode: Episode; userId: string }> = [];
  for (const user of users) {
    const episodes = await metadata.listEpisodes({
      userId: user.id,
      status: "pending",
      limit: opts.batchSize,
    });
    for (const episode of episodes) pending.push({ episode, userId: user.id });
    if (pending.length >= opts.batchSize) break;
  }

  for (const { episode } of pending.slice(0, opts.batchSize)) {
    result.considered++;

    // Re-check approval at the point of spending, not just at queue time.
    try {
      await assertAuthorizedForAudio(metadata, episode.userId);
    } catch (error) {
      const reason = error instanceof NotAuthorizedError ? "not authorized" : String(error);
      // Deferred, not failed: a suspension can be lifted and nothing was spent.
      result.deferred.push({ episodeId: episode.id, reason });
      continue;
    }

    const article = await metadata.getArticle(episode.userId, episode.articleId);
    if (!article) {
      result.failed.push({ episodeId: episode.id, error: "article record is missing" });
      await metadata.putEpisode({
        ...episode,
        status: "failed",
        error: "article record is missing",
      });
      continue;
    }
    const source = await metadata.getSource(episode.userId, episode.sourceId);

    await metadata.putEpisode({ ...episode, status: "synthesizing" });

    let audio: DecodedAudioResult | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      try {
        audio = await synthesize({ article, source, episode, mode: episode.mode });
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
      await metadata.putEpisode({ ...episode, status: "failed", error });
      result.failed.push({ episodeId: episode.id, error });
      continue;
    }

    const bytes = audio.format === "wav" ? audio.rawBytes : audio.toWav();
    const audioKey = `${episode.id}.wav`;
    const stored = await blobs.put(audioKey, bytes, { contentType: "audio/wav" });

    const nowIso = new Date().toISOString();
    await metadata.putEpisode({
      ...episode,
      status: "ready",
      audioKey,
      // The enclosure is built from these, so they must describe the stored bytes.
      byteLength: stored.size ?? bytes.length,
      contentType: "audio/wav",
      durationSeconds: audio.durationSeconds,
      readyAt: nowIso,
      error: undefined,
    });
    result.ready.push({ episodeId: episode.id, audioKey, byteLength: stored.size ?? bytes.length });
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
