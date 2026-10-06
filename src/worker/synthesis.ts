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
  GeminiTtsClient,
  GeminiTtsTruncatedError,
  MAX_TTS_INPUT_BYTES,
  MAX_TTS_SEGMENTS,
} from "../tts/gemini.ts";
import type { DecodedAudioResult, DialogueSpeaker } from "../tts/gemini.ts";
import type { AppContext } from "../app.ts";
import { PROMPT_VERSION } from "../tts/prompt_version.ts";
import {
  createGroundedScriptGenerator,
  DEFAULT_SCRIPT_TIMEOUT_MS,
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
  unsynthesized,
  utcDayKey,
} from "../types.ts";
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
  /** Maximum article content length in characters allowed for synthesis before spend (audio-feed-3hb, audio-feed-cei). Default 2,000,000. */
  maxInputCharacters?: number;
  /** How long a claim is honoured before another worker may take the episode. */
  leaseMs?: number;
  /** Claims per episode before it is abandoned as unprocessable. */
  maxClaims?: number;
  /** Worker identity recorded on the claim. Defaults to a per-process id. */
  owner?: string;
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

const DEFAULTS: Required<Omit<SynthesisWorkerOptions, "nowMs">> = {
  batchSize: 5,
  intervalMs: 15_000,
  maxAttempts: 3,
  retryBaseDelayMs: 500,
  // At most 12 sequential TTS calls; preserve the 15-minute claim lease and per-episode spend.
  maxInputCharacters: MAX_TTS_INPUT_BYTES * MAX_TTS_SEGMENTS,
  leaseMs: DEFAULT_CLAIM_LEASE_MS,
  maxClaims: DEFAULT_MAX_CLAIMS,
  owner: WORKER_ID,
  // A full UUID: 8 hex digits could repeat a key still on the orphan list (audio-feed-8oz).
  revision: () => crypto.randomUUID(),
};

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
async function runScriptStage(
  generator: ScriptGenerator | null,
  input: GroundedScriptInput,
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
): Promise<Awaited<ReturnType<ScriptGenerator>> | undefined> {
  if (!generator) return undefined;
  // Two bounds, because one is not enough (audio-feed-yaz5 review). The signal bounds a generator
  // that passes it to fetch, which the real one does; the race bounds a generator that ignores it,
  // which an injected one can. Either way synthesis reaches the fallback instead of waiting on a
  // stalled search call forever.
  const deadline = AbortSignal.timeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`grounded script stage exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const work = generator(input, { signal: deadline });
  try {
    return await Promise.race([work, expired]);
  } catch (error) {
    console.warn(
      `[synthesis] grounded script stage failed for "${input.article.title}": ` +
        `${
          String((error as Error)?.message ?? error)
        } — falling back to the static dialogue builder`,
    );
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A generator that ignores its signal is still running; its eventual rejection must not
    // surface as an unhandled rejection once synthesis has already fallen back.
    work.catch(() => {});
  }
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
    /** How long the grounded stage may hold up this episode; see DEFAULT_SCRIPT_TIMEOUT_MS. */
    scriptTimeoutMs?: number;
  } = {},
): Synthesizer {
  const client = deps.client ?? new GeminiTtsClient({ apiKey: ctx.config.geminiApiKey });
  const scriptGenerator = deps.scriptGenerator === null ? null : deps.scriptGenerator ??
    (ctx.config.geminiApiKey
      ? createGroundedScriptGenerator({ apiKey: ctx.config.geminiApiKey })
      : null);
  return async ({ article, source, episode, mode }) => {
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
      // Research and write the script first (audio-feed-yaz5). `turns` is the same field a
      // hand-written script uses, so the TTS layer renders either identically.
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
        deps.scriptTimeoutMs,
      );
      return await client.synthesizeDialogue({
        title: article.title,
        article: {
          title: article.title,
          author: article.author,
          body: article.content,
          summary: article.excerpt,
        },
        speakers,
        turns: script?.turns,
        codeHandling,
        codeSummarizer: deps.codeSummarizer,
      });
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

    return await client.synthesizeNarration({
      title: article.title,
      author: article.author,
      publishedAt: article.publishedAt,
      sourceName: source?.title ?? episode.sourceTitle,
      body: article.content,
      voice,
      codeHandling,
      codeSummarizer: deps.codeSummarizer,
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
  const nowMs = options.nowMs ?? Date.now();
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
        const user = await metadata.getUser(userId);
        if (user && typeof user.dailyEpisodeBudget === "number" && user.dailyEpisodeBudget >= 0) {
          const today = utcDayKey(new Date(nowMs));
          const spentToday = await metadata.getUserDailySynthesisCount(userId, today);
          if (spentToday >= user.dailyEpisodeBudget) {
            reason =
              `daily episode budget exceeded (limit: ${user.dailyEpisodeBudget}, used: ${spentToday})`;
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

    // Check budget at spend gate (audio-feed-9mp, audio-feed-akm)
    try {
      const spendUser = await metadata.getUser(episode.userId);
      if (
        spendUser && typeof spendUser.dailyEpisodeBudget === "number" &&
        spendUser.dailyEpisodeBudget >= 0
      ) {
        const today = utcDayKey(new Date(nowMs));
        const spentToday = await metadata.getUserDailySynthesisCount(episode.userId, today);
        if (spentToday >= spendUser.dailyEpisodeBudget) {
          const reason =
            `daily episode budget exceeded (limit: ${spendUser.dailyEpisodeBudget}, used: ${spentToday})`;
          result.deferred.push({ episodeId: episode.id, reason });
          continue;
        }
      }
    } catch (err) {
      // Fail closed: if budget verification fails, defer rather than spending blindly
      const reason = `could not verify daily budget: ${
        err instanceof Error ? err.message : String(err)
      }`;
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
    claimedAny = true;

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

    if (opts.maxInputCharacters && article.content.length > opts.maxInputCharacters) {
      const error =
        `article content exceeds input limit (${article.content.length} > ${opts.maxInputCharacters} chars)`;
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

    const bytes = audio.format === "wav" ? audio.rawBytes : audio.toWav();
    // Every attempt writes under its OWN revision, first synthesis included (audio-feed-xsu):
    // /audio is served immutable, and a first attempt used to write the deterministic canonical
    // key — so a superseded worker and the winner shared one key and the loser's cleanup below
    // deleted the winner's live audio. With a per-attempt revision the cleanup can only ever
    // delete this attempt's own blob. A regeneration additionally deletes the old key.
    const previousKey = claimed.regenerating ? claimed.audioKey : undefined;
    const audioKey = audioBlobKey(claimed, "wav", opts.revision());
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
      // A regenerated episode keeps its pubDate, so clients do not re-surface it as new.
      readyAt: previousKey && claimed.readyAt ? claimed.readyAt : new Date().toISOString(),
      promptVersion: PROMPT_VERSION,
      regenerating: undefined,
      error: undefined,
    }, opts.owner);

    if (wrote) {
      result.ready.push({ episodeId: claimed.id, audioKey, byteLength });
      await notifyOnDemand(claimed, "ready");
      // Record synthesis stats for spend visibility and daily budget (audio-feed-9mp, audio-feed-akm).
      // A failure here is logged as an operational alert so counter anomalies are visible.
      try {
        await metadata.recordSynthesis(claimed.userId, byteLength, new Date(nowMs));
      } catch (err) {
        console.error(
          `[audio-feed] failed to record synthesis for episode ${claimed.id} (user ${claimed.userId}):`,
          err,
        );
      }
      // The swap is committed; the old blob is now unreferenced (audio-feed-8oz).
      if (previousKey && previousKey !== audioKey) {
        try {
          await blobs.delete(previousKey);
        } catch {
          // Recorded, so a later batch retries it instead of orphaning it for good.
          await metadata.recordOrphanBlob(previousKey).catch(() => {});
        }
      }
    } else {
      // Superseded / deleted: clean up the orphaned audio blob written above (audio-feed-8kk).
      // It is this worker's OWN key — a first synthesis is revisioned too (audio-feed-xsu) — so
      // removing it can never take the winner's audio with it.
      try {
        await blobs.delete(audioKey);
      } catch {
        // A failed cleanup must not vanish with the worker (audio-feed-owq): the key is
        // recorded where later batches retry it, exactly like the previousKey swap above.
        await metadata.recordOrphanBlob(audioKey).catch(() => {});
      }
      result.superseded.push(supersededEntry(claimed, opts.leaseMs));
    }
  }

  // Retry old blobs a delete failed on, only in a batch that did work: an idle
  // tick stays one read (audio-feed-0ob). A delete that throws keeps the record.
  // A key an episode references again (a repeated revision) is forgotten, never
  // deleted: deleting it would leave the feed pointing at a missing file.
  if (claimedAny) {
    for (const key of await metadata.listOrphanBlobs(opts.batchSize)) {
      const parsed = parseAudioBlobKey(key);
      if (!parsed) continue; // unparseable: left recorded for a human
      try {
        let referenced = false;
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
): { userId: string; candidateIds: string[] } | null {
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
