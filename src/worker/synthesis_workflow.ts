/**
 * Cloudflare Workflows durable per-episode synthesis pipeline (P2).
 *
 * Replaces fragile cron-lease/yield/retry loops with independent, durably
 * checkpointed Cloudflare Workflow steps:
 *   1. authorize-and-load (with `step.sleepUntil(nextUtcMidnight)` on daily budget exhaustion)
 *   2. prepare-plan (persists deepdive scriptTurns or computes deterministic narration segments)
 *   3. tts-segment-i (per-segment durable step with exponential backoff; skips finalized segments;
 *      persists each WAV segment to R2 + D1 immediately and returns only ~200B metadata)
 *   4. assemble-wav (streaming R2 Multipart Upload at ~16 MB constant RAM)
 *   5. finalize (atomic D1 ready commit + billing + R2 segment blob sweep + notification)
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { assertAuthorizedForAudio, NotAuthorizedError } from "../auth/users.ts";
import { loadConfig, openD1Stores } from "../config.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { MAX_ARTICLE_CONTENT_CHARS } from "../ingest/url.ts";
import {
  assembleWavToBlobStore,
  computeStreamingWavRevisionHash,
  inspectStoredWavSegment,
  type StoredWavSegment,
} from "../storage/wav_assembly.ts";
import type { D1DatabaseLike } from "../storage/d1/types.ts";
import type { R2BucketLike } from "../storage/r2.ts";
import type { BlobStore, MetadataStore } from "../storage/mod.ts";
import {
  assertTextSeams,
  splitTextUnderByteBudget,
} from "../synthesis/limits.ts";
import {
  buildChaptersFromSegments,
  extractArticleHeadings,
  splitNarrationIntoChapteredSegments,
} from "../synthesis/chapters.ts";
import { ensureEpisodeArtwork } from "../artwork/generate.ts";
import {
  buildDialogueRequest,
  buildSingleVoiceRequest,
  DEFAULT_NARRATION_STYLE,
  DEFAULT_NARRATION_VOICE,
  type DecodedAudioResult,
  type DialogueSpeaker,
  type DialogueTurn,
  type EnvReader,
  formatCodeForTts,
  formatDialoguePrompt,
  formatNarrationPrompt,
  GeminiTtsClient,
  GeminiTtsEmptyCandidateError,
  GeminiTtsError,
  GeminiTtsTruncatedError,
  isPermanentTtsStatus,
  joinTtsAudio,
  MAX_TTS_INPUT_BYTES,
  MAX_TTS_SEGMENTS,
  parseWavHeader,
  ttsClientConfig,
  ttsPcmBytes,
} from "../tts/gemini.ts";
import { PROMPT_VERSION } from "../tts/prompt_version.ts";
import {
  audioBlobKey,
  DEFAULT_CODE_HANDLING,
  DEFAULT_VOICES,
  type Episode,
  INBOX_SOURCE_ID,
  segmentBlobKey,
  segmentTextHash,
  unsynthesized,
  utcDayKey,
} from "../types.ts";
import { createGroundedScriptGenerator, type ScriptGenerator } from "./script.ts";
import { dailyEpisodeBudgetFor, globalDailyEpisodeBudgetFor } from "./synthesis.ts";

export interface EpisodeSynthesisParams {
  episodeId: string;
  userId: string;
}

export interface WorkflowInstanceLike {
  id: string;
  status?(): Promise<{ status: string }>;
}

export interface WorkflowBindingLike<P = EpisodeSynthesisParams> {
  create(options?: { id?: string; params?: P }): Promise<WorkflowInstanceLike>;
  get?(id: string): Promise<WorkflowInstanceLike>;
}

export interface WorkflowStepConfigLike {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

export interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: WorkflowStepConfigLike, callback: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
}

export interface WorkflowEventLike<P = EpisodeSynthesisParams> {
  readonly payload: P;
  readonly instanceId: string;
  readonly timestamp?: Date;
}

export interface SynthesisWorkflowEnv {
  DB: D1DatabaseLike;
  AUDIO_BUCKET?: R2BucketLike;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  [key: string]: unknown;
}

export interface WorkflowDeps {
  metadata?: MetadataStore;
  blobs?: BlobStore;
  ttsClient?: GeminiTtsClient;
  scriptGenerator?: ScriptGenerator | null;
  now?: () => number;
}

type SegmentPlanItem =
  | {
    kind: "narration";
    textKey: string;
    voice: string;
    text: string;
    heading?: string;
  }
  | {
    kind: "dialogue";
    textKey: string;
    voice: string;
    turns: DialogueTurn[];
    speakers: [DialogueSpeaker, DialogueSpeaker];
    heading?: string;
  };

export const WORKFLOW_CLAIM_LEASE_MS = 30 * 60 * 1000;

/** Compute the next UTC midnight (00:00:00.000Z strictly after `nowMs`). */
export function nextUtcMidnight(nowMs = Date.now()): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
}

function sanitizeWorkflowIdPart(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72);
}

/**
 * Trigger `EpisodeSynthesisWorkflow` for an episode.
 *
 * - Default (`fresh: false`): deduplicates by deterministic id `ep-<episodeId>`.
 *   If a prior run with that ID already errored/terminated/completed, creates a
 *   unique recovery ID so pending retries still execute.
 * - Explicit retry/regenerate (`fresh: true`): always allocates a unique ID
 *   `ep-<episodeId>-r<timestamp>` because Cloudflare Workflows requires unique IDs
 *   when re-running an episode whose earlier workflow instance already terminated.
 */
export async function triggerEpisodeWorkflow(
  binding: WorkflowBindingLike<EpisodeSynthesisParams>,
  episodeId: string,
  userId: string,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  const safeId = sanitizeWorkflowIdPart(episodeId);
  if (opts.fresh) {
    const freshId = `ep-${safeId}-r${Date.now()}`.slice(0, 100);
    await binding.create({ id: freshId, params: { episodeId, userId } });
    return;
  }

  const baseId = `ep-${safeId}`.slice(0, 100);
  try {
    await binding.create({ id: baseId, params: { episodeId, userId } });
  } catch (err) {
    // Instance already exists — inspect status if possible so an active run stays
    // deduplicated while a previously terminated run gets a fresh instance ID.
    if (typeof binding.get === "function") {
      try {
        const existing = await binding.get(baseId);
        const st = existing.status ? (await existing.status()).status : "running";
        if (st === "running" || st === "queued" || st === "waiting" || st === "paused") {
          return;
        }
        const retryId = `ep-${safeId}-${Date.now()}`.slice(0, 100);
        await binding.create({ id: retryId, params: { episodeId, userId } });
        return;
      } catch {
        // Best-effort: cron safety net will retry if needed.
        return;
      }
    }
    // Without `get()`, assume duplicate ID means already scheduled/running.
    const msg = String((err as Error)?.message ?? err);
    if (!/exist|duplicate|already/i.test(msg)) {
      throw err;
    }
  }
}

function makeEnvReader(env: SynthesisWorkflowEnv): EnvReader {
  return {
    get(key: string): string | undefined {
      if (key === "CF_VERSION_ID") return env.CF_VERSION_METADATA?.id;
      const value = env[key];
      return typeof value === "string" ? value : undefined;
    },
  };
}

function isPermanentWorkflowTtsError(error: unknown): boolean {
  if (error instanceof GeminiTtsError && error.permanent) return true;
  if (error instanceof GeminiTtsTruncatedError && error.finishReason !== "MAX_TOKENS") return true;
  const status = (error as { status?: number })?.status;
  if (typeof status === "number") return isPermanentTtsStatus(status);
  const message = String((error as Error)?.message ?? error);
  if (/SAFETY/i.test(message)) return true;
  return false;
}

async function synthesizeOnePlanSegment(
  client: GeminiTtsClient,
  item: SegmentPlanItem,
): Promise<DecodedAudioResult> {
  const synthesizeNarrationText = async (text: string, depth = 0): Promise<DecodedAudioResult> => {
    try {
      const decoded = await client.sendRequest(
        buildSingleVoiceRequest(text, item.voice, undefined, DEFAULT_NARRATION_STYLE),
        { maxRetries: 0 },
      );
      ttsPcmBytes(decoded, "fresh");
      return decoded;
    } catch (error) {
      const byteLen = new TextEncoder().encode(text).length;
      const canSplit = depth < 2 && (
        (error instanceof GeminiTtsTruncatedError && error.finishReason === "MAX_TOKENS" &&
          byteLen >= 8) ||
        (error instanceof GeminiTtsEmptyCandidateError && byteLen >= 200)
      );
      if (canSplit) {
        const halves = splitTextUnderByteBudget(text, Math.floor(byteLen / 2));
        if (halves.length >= 2) {
          assertTextSeams(text, halves);
          const subAudio: DecodedAudioResult[] = [];
          for (const half of halves) {
            subAudio.push(await synthesizeNarrationText(half, depth + 1));
          }
          return joinTtsAudio(subAudio);
        }
      }
      throw error;
    }
  };

  const synthesizeDialogueBatch = async (
    turns: DialogueTurn[],
    speakers: [DialogueSpeaker, DialogueSpeaker],
    depth = 0,
  ): Promise<DecodedAudioResult> => {
    try {
      const decoded = await client.sendRequest(
        buildDialogueRequest(turns, speakers),
        { maxRetries: 0 },
      );
      ttsPcmBytes(decoded, "fresh");
      return decoded;
    } catch (error) {
      const isSplittable = (error instanceof GeminiTtsTruncatedError &&
        error.finishReason === "MAX_TOKENS") ||
        error instanceof GeminiTtsEmptyCandidateError;
      if (depth < 2 && isSplittable) {
        if (turns.length >= 2) {
          const mid = Math.ceil(turns.length / 2);
          const left = await synthesizeDialogueBatch(turns.slice(0, mid), speakers, depth + 1);
          const right = await synthesizeDialogueBatch(turns.slice(mid), speakers, depth + 1);
          return joinTtsAudio([left, right]);
        }
        const only = turns[0];
        if (only) {
          const byteLen = new TextEncoder().encode(only.text).length;
          if (byteLen >= 200) {
            const halves = splitTextUnderByteBudget(only.text, Math.floor(byteLen / 2));
            if (halves.length >= 2) {
              assertTextSeams(only.text, halves);
              const subAudio: DecodedAudioResult[] = [];
              for (const half of halves) {
                subAudio.push(
                  await synthesizeDialogueBatch([{ ...only, text: half }], speakers, depth + 1),
                );
              }
              return joinTtsAudio(subAudio);
            }
          }
        }
      }
      throw error;
    }
  };

  if (item.kind === "narration") {
    return await synthesizeNarrationText(item.text);
  }
  return await synthesizeDialogueBatch(item.turns, item.speakers);
}

/**
 * Testable core workflow execution for `EpisodeSynthesisWorkflow`.
 */
export async function runEpisodeSynthesisWorkflow(
  env: SynthesisWorkflowEnv,
  event: WorkflowEventLike<EpisodeSynthesisParams>,
  step: WorkflowStepLike,
  deps: WorkflowDeps = {},
): Promise<{ status: string; episodeId: string; audioKey?: string; byteLength?: number; reason?: string }> {
  const { episodeId, userId } = event.payload;
  const owner = `workflow-${event.instanceId}`;
  const now = deps.now ?? (() => Date.now());
  const reader = makeEnvReader(env);
  const config = loadConfig(reader);
  const stores = deps.metadata && deps.blobs
    ? { metadata: deps.metadata, blobs: deps.blobs }
    : openD1Stores(env.DB, reader, env.AUDIO_BUCKET);
  const { metadata, blobs } = stores;
  const ttsClient = deps.ttsClient ?? new GeminiTtsClient(ttsClientConfig(config));
  const scriptGenerator = deps.scriptGenerator === null
    ? null
    : deps.scriptGenerator ??
      (config.geminiApiKey
        ? createGroundedScriptGenerator({ apiKey: config.geminiApiKey })
        : null);

  const notifyOnDemand = async (episode: Episode, status: "ready" | "failed", error?: string) => {
    if (!config.notifyOutboxEnabled || episode.sourceId !== INBOX_SOURCE_ID || episode.regenerating) {
      return;
    }
    try {
      const user = await metadata.getUser(episode.userId);
      const base = config.publicBaseUrl ? config.publicBaseUrl.replace(/\/+$/, "") : "";
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
        createdAt: new Date(now()).toISOString(),
      });
    } catch (err) {
      console.error(`[audio-feed] workflow notification failed for ${episode.id}:`, err);
    }
  };

  // Stage 1: Authorize, check daily budget (sleeping until UTC midnight if needed), and claim.
  type AuthOutcome =
    | { kind: "ready-to-run"; episode: Episode }
    | { kind: "sleep-until"; wakeAtIso: string; reason: string }
    | { kind: "stop"; status: string; reason: string };

  let claimedEpisode: Episode | null = null;
  for (let budgetCheck = 0; budgetCheck < 4; budgetCheck++) {
    const stepName = budgetCheck === 0
      ? "authorize-and-claim"
      : `authorize-and-claim-${budgetCheck}`;
    const outcome = await step.do<AuthOutcome>(stepName, async () => {
      const ep = await metadata.getEpisode(userId, episodeId);
      if (!ep) return { kind: "stop", status: "skipped", reason: "episode_not_found" };
      if (ep.status === "ready" && !ep.regenerating) {
        return { kind: "stop", status: "skipped", reason: "already_ready" };
      }
      if (ep.status === "failed") {
        return { kind: "stop", status: "skipped", reason: "already_failed" };
      }

      try {
        await assertAuthorizedForAudio(metadata, userId);
      } catch (err) {
        const reason = err instanceof NotAuthorizedError ? "not_authorized" : String(err);
        return { kind: "stop", status: "deferred", reason };
      }

      const nowMs = now();
      const today = utcDayKey(new Date(nowMs));
      const globalBudget = globalDailyEpisodeBudgetFor(undefined, config.globalDailyEpisodeBudget);
      const globalToday = await metadata.getDailySynthesisCount(today);
      if (globalToday >= globalBudget.limit) {
        return {
          kind: "sleep-until",
          wakeAtIso: nextUtcMidnight(nowMs).toISOString(),
          reason: `global daily episode budget exceeded (${globalToday}/${globalBudget.limit})`,
        };
      }
      const user = await metadata.getUser(userId);
      const userBudget = dailyEpisodeBudgetFor(user, config.defaultDailyEpisodeBudget);
      const userToday = await metadata.getUserDailySynthesisCount(userId, today);
      if (userToday >= userBudget.limit) {
        return {
          kind: "sleep-until",
          wakeAtIso: nextUtcMidnight(nowMs).toISOString(),
          reason: `user daily episode budget exceeded (${userToday}/${userBudget.limit})`,
        };
      }

      // Claim episode (or retain existing ownership by this workflow instance).
      if (ep.status === "synthesizing" && ep.claimedBy === owner) {
        await metadata.touchEpisodeClaim(userId, episodeId, owner, {
          phase: "workflow_claimed",
          now: new Date(nowMs).toISOString(),
        });
        return { kind: "ready-to-run", episode: ep };
      }
      const claimed = await metadata.claimEpisode(userId, episodeId, {
        owner,
        now: new Date(nowMs).toISOString(),
        leaseMs: WORKFLOW_CLAIM_LEASE_MS,
        maxClaims: 10,
      });
      if (!claimed) {
        return { kind: "stop", status: "skipped", reason: "claimed_elsewhere" };
      }
      return { kind: "ready-to-run", episode: claimed };
    });

    if (outcome.kind === "stop") {
      return { status: outcome.status, episodeId, reason: outcome.reason };
    }
    if (outcome.kind === "sleep-until") {
      const sleepName = budgetCheck === 0
        ? "wait-daily-budget"
        : `wait-daily-budget-${budgetCheck}`;
      await step.sleepUntil(sleepName, new Date(outcome.wakeAtIso));
      continue;
    }
    claimedEpisode = outcome.episode;
    break;
  }

  if (!claimedEpisode) {
    return { status: "deferred", episodeId, reason: "daily_budget_exhausted" };
  }

  try {
    // Stage 2: Load article/source, generate deepdive script if needed, build segment plan.
    const plan = await step.do<SegmentPlanItem[]>(
      "prepare-plan",
      {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "3 minutes",
      },
      async () => {
        const ep = (await metadata.getEpisode(userId, episodeId)) ?? claimedEpisode!;
        const article = await metadata.getArticle(userId, ep.articleId);
        if (!article) {
          throw new NonRetryableError("article record is missing");
        }
        if (article.content.length > MAX_ARTICLE_CONTENT_CHARS) {
          throw new NonRetryableError(
            `article content exceeds character limit (${article.content.length} > ${MAX_ARTICLE_CONTENT_CHARS} chars)`,
          );
        }
        const source = await metadata.getSource(userId, ep.sourceId);
        const codeHandling = source?.codeHandling ?? DEFAULT_CODE_HANDLING;
        const maxInputBytes = MAX_TTS_INPUT_BYTES * MAX_TTS_SEGMENTS;
        const processedBody = await formatCodeForTts(article.content, codeHandling);
        const inputBytes = new TextEncoder().encode(processedBody).length;
        if (inputBytes > maxInputBytes) {
          throw new NonRetryableError(
            `article content exceeds input limit (${inputBytes} > ${maxInputBytes} bytes)`,
          );
        }

        if (ep.mode === "deepdive") {
          const [expert, foil] = source?.voices.deepdive ?? DEFAULT_VOICES.deepdive;
          const speakers: [DialogueSpeaker, DialogueSpeaker] = [
            { name: "Alex", role: "expert", voice: expert },
            { name: "Sam", role: "curious_foil", voice: foil },
          ];
          let turns = ep.scriptTurns;
          if (!turns || turns.length === 0) {
            await metadata.touchEpisodeClaim(userId, episodeId, owner, {
              phase: "generating_script",
              now: new Date(now()).toISOString(),
            });
            if (scriptGenerator) {
              try {
                const generated = await scriptGenerator({
                  article: {
                    title: article.title,
                    author: article.author,
                    body: article.content,
                    summary: article.excerpt,
                  },
                  speakers,
                });
                if (generated?.turns?.length) {
                  turns = generated.turns;
                }
              } catch (err) {
                console.warn(
                  `[audio-feed] workflow grounded script fell back to static dialogue for "${article.title}": ${
                    String((err as Error)?.message ?? err)
                  }`,
                );
              }
            }
            if (!turns || turns.length === 0) {
              turns = formatDialoguePrompt({
                title: article.title,
                article: {
                  title: article.title,
                  author: article.author,
                  body: processedBody,
                  summary: article.excerpt,
                },
                speakers,
              }).turns;
            }
            await metadata.touchEpisodeClaim(userId, episodeId, owner, {
              phase: "script_generated",
              scriptTurns: turns,
              now: new Date(now()).toISOString(),
            });
          }

          const formatted = formatDialoguePrompt({
            title: article.title,
            speakers,
            turns,
          });
          const encoder = new TextEncoder();
          const batches: DialogueTurn[][] = [];
          let batch: DialogueTurn[] = [];
          let batchBytes = 0;
          for (const turn of formatted.turns) {
            for (const piece of splitTextUnderByteBudget(turn.text, MAX_TTS_INPUT_BYTES)) {
              const sz = encoder.encode(piece).length;
              if (batch.length > 0 && batchBytes + sz > MAX_TTS_INPUT_BYTES) {
                batches.push(batch);
                batch = [];
                batchBytes = 0;
              }
              batch.push({ ...turn, text: piece });
              batchBytes += sz;
            }
          }
          if (batch.length > 0) batches.push(batch);
          if (batches.length === 0) {
            throw new NonRetryableError("Dialogue contained no spoken text");
          }
          if (batches.length > MAX_TTS_SEGMENTS) {
            throw new NonRetryableError(
              `Dialogue needs ${batches.length} TTS segments (limit ${MAX_TTS_SEGMENTS})`,
            );
          }
          const voiceKey = formatted.speakers.map((s) => s.voice).join(",");
          return batches.map((part): SegmentPlanItem => ({
            kind: "dialogue",
            textKey: part.map((t) => `${t.speaker}\u0001${t.text}`).join("\u0000"),
            voice: voiceKey,
            turns: part,
            speakers: formatted.speakers,
          }));
        }

        // Direct narration mode
        const sourceVoice = source?.voices.direct;
        const user = sourceVoice ? null : await metadata.getUser(userId);
        const voice = [sourceVoice, user?.voice, config.defaultVoice, DEFAULT_NARRATION_VOICE]
          .find((name): name is string => typeof name === "string" && name.trim() !== "") ??
          DEFAULT_NARRATION_VOICE;
        const prompt = formatNarrationPrompt({
          title: article.title,
          author: article.author,
          publishedAt: article.publishedAt,
          sourceName: source?.title ?? ep.sourceTitle,
          body: processedBody,
          voice,
        });
        const headings = extractArticleHeadings(article.content, article.headings);
        const chaptered = splitNarrationIntoChapteredSegments(prompt, headings, MAX_TTS_INPUT_BYTES);
        if (chaptered.length === 0) {
          throw new NonRetryableError("Narration contained no spoken text");
        }
        if (chaptered.length > MAX_TTS_SEGMENTS) {
          throw new NonRetryableError(
            `Narration needs ${chaptered.length} TTS segments (limit ${MAX_TTS_SEGMENTS})`,
          );
        }
        return chaptered.map((seg): SegmentPlanItem => ({
          kind: "narration",
          textKey: seg.text,
          voice,
          text: seg.text,
          ...(seg.heading ? { heading: seg.heading } : {}),
        }));
      },
    );

    // Stage 3: Synthesize each segment in its own durable step (zero PCM retained in memory!).
    const storedSegments: StoredWavSegment[] = [];
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i]!;
      const segMeta = await step.do<StoredWavSegment>(
        `tts-segment-${i}`,
        {
          retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
          timeout: "3 minutes",
        },
        async () => {
          const nowMs = now();
          await metadata.touchEpisodeClaim(userId, episodeId, owner, {
            phase: `synthesizing_segment_${i + 1}_of_${plan.length}`,
            now: new Date(nowMs).toISOString(),
          });

          const textHash = segmentTextHash(item.textKey);
          const existing = (await metadata.listSynthesisSegments(userId, episodeId)).find((r) =>
            r.textHash === textHash &&
            r.finalized &&
            r.promptVersion === PROMPT_VERSION &&
            r.voice === item.voice &&
            r.text === item.textKey
          );
          if (existing) {
            const inspected = await inspectStoredWavSegment(
              blobs,
              existing.audioKey,
              existing.byteLength,
            );
            if (inspected) return inspected;
          }

          const reserveOutcome = await metadata.reserveSynthesisSegment(
            userId,
            episodeId,
            {
              textHash,
              text: item.textKey,
              promptVersion: PROMPT_VERSION,
              voice: item.voice,
              audioKey: "",
              byteLength: 0,
              owner,
              claimAt: new Date(nowMs).toISOString(),
              createdAt: new Date(nowMs).toISOString(),
              finalized: false,
            },
            nowMs,
            WORKFLOW_CLAIM_LEASE_MS,
          );
          if (reserveOutcome === "finalized") {
            const raced = (await metadata.listSynthesisSegments(userId, episodeId)).find((r) =>
              r.textHash === textHash &&
              r.finalized &&
              r.promptVersion === PROMPT_VERSION &&
              r.voice === item.voice &&
              r.text === item.textKey
            );
            if (raced) {
              const inspected = await inspectStoredWavSegment(blobs, raced.audioKey, raced.byteLength);
              if (inspected) return inspected;
            }
          }

          let decoded: DecodedAudioResult;
          try {
            decoded = await synthesizeOnePlanSegment(ttsClient, item);
          } catch (err) {
            if (isPermanentWorkflowTtsError(err)) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new NonRetryableError(msg);
            }
            throw err;
          }

          const wav = decoded.format === "wav" ? decoded.rawBytes : decoded.toWav();
          const info = parseWavHeader(wav);
          const segKey = segmentBlobKey(claimedEpisode!, textHash, crypto.randomUUID());
          const putInfo = await blobs.put(segKey, wav, { contentType: "audio/wav" });
          const byteLength = putInfo.size ?? wav.byteLength;

          await metadata.finalizeSynthesisSegment(
            userId,
            episodeId,
            { textHash, promptVersion: PROMPT_VERSION, voice: item.voice },
            { audioKey: segKey, byteLength },
            owner,
            now(),
            WORKFLOW_CLAIM_LEASE_MS,
          );

          return {
            audioKey: segKey,
            pcmOffset: info.dataOffset,
            pcmByteLength: info.declaredDataLength,
            sampleRate: info.sampleRate,
            channels: info.channels,
            bitsPerSample: info.bitsPerSample,
            durationSeconds: info.durationSeconds,
            byteLength,
          };
        },
      );
      storedSegments.push(segMeta);
    }

    // Stage 4: Stream-assemble final WAV via R2 Multipart Upload (~16 MB constant RAM).
    const assembled = await step.do<{
      audioKey: string;
      byteLength: number;
      durationSeconds: number;
    }>(
      "assemble-wav",
      {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "3 minutes",
      },
      async () => {
        const ep = (await metadata.getEpisode(userId, episodeId)) ?? claimedEpisode!;
        const totalWavBytes = 44 + storedSegments.reduce((sum, s) => sum + s.pcmByteLength, 0);
        await metadata.touchEpisodeClaim(userId, episodeId, owner, {
          phase: "uploading_audio",
          bytesAttempted: totalWavBytes,
          now: new Date(now()).toISOString(),
        });

        const revisionHash = await computeStreamingWavRevisionHash(storedSegments, ep.audioKey);
        const destinationKey = audioBlobKey(ep, "wav", `sha256-${revisionHash}`);

        const existing = await blobs.head(destinationKey);
        if (existing && existing.size === totalWavBytes) {
          const totalDuration = storedSegments.reduce((sum, s) => sum + s.durationSeconds, 0);
          return {
            audioKey: destinationKey,
            byteLength: existing.size,
            durationSeconds: totalDuration,
          };
        }

        const result = await assembleWavToBlobStore({
          blobs,
          destinationKey,
          segments: storedSegments,
        });
        return {
          audioKey: destinationKey,
          byteLength: result.byteLength,
          durationSeconds: result.durationSeconds,
        };
      },
    );

    // Stage 4b: Best-effort episode cover artwork (scraped og:image -> Gemini art -> studio PNG).
    const artworkKey = await step.do<string | null>(
      "ensure-artwork",
      {
        retries: { limit: 1, delay: "5 seconds" },
        timeout: "45 seconds",
      },
      async () => {
        const ep = (await metadata.getEpisode(userId, episodeId)) ?? claimedEpisode!;
        const [article, source] = await Promise.all([
          metadata.getArticle(userId, ep.articleId),
          metadata.getSource(userId, ep.sourceId),
        ]);
        const key = await ensureEpisodeArtwork({
          blobs,
          episode: ep,
          article,
          source,
          geminiApiKey: config.geminiApiKey,
          geminiBaseUrl: reader.get("GEMINI_API_BASE_URL"),
          allowGeminiImageGen: !deps.ttsClient && Boolean(config.geminiApiKey),
        });
        return key ?? null;
      },
    );

    // Stage 5: Finalize episode (`ready`), atomic billing, and sweep segment blobs.
    return await step.do("finalize", {
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
    }, async () => {
      const ep = (await metadata.getEpisode(userId, episodeId)) ?? claimedEpisode!;
      const previousKey = ep.regenerating ? ep.audioKey : undefined;
      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();

      const chapters = buildChaptersFromSegments(
        storedSegments.map((seg, idx) => ({
          heading: plan[idx]?.heading,
          durationSeconds: seg.durationSeconds,
        })),
        { mode: ep.mode },
      );

      // Preserve deepdive script turns as readable transcript for in-app Read Along.
      const dialogueTranscript = ep.mode === "deepdive" && ep.scriptTurns?.length
        ? ep.scriptTurns.map((t) => `${t.speaker}: ${t.text}`).join("\n\n")
        : ep.transcript;

      const wrote = await metadata.completeEpisode(
        {
          ...ep,
          status: "ready",
          audioKey: assembled.audioKey,
          byteLength: assembled.byteLength,
          contentType: "audio/wav",
          durationSeconds: assembled.durationSeconds,
          readyAt: previousKey && ep.readyAt ? ep.readyAt : nowIso,
          promptVersion: PROMPT_VERSION,
          ...(artworkKey ? { artworkKey } : {}),
          ...(chapters.length > 0 ? { chapters } : {}),
          ...(dialogueTranscript ? { transcript: dialogueTranscript } : {}),
          regenerating: undefined,
          error: undefined,
          phase: "ready",
          lastHeartbeat: nowIso,
          scriptTurns: undefined,
          uploadRetry: undefined,
        },
        owner,
        { byteLength: assembled.byteLength, at: new Date(nowMs) },
      );

      if (wrote) {
        const allSegs = await metadata.listSynthesisSegments(userId, episodeId);
        const keysToDelete = allSegs
          .map((r) => r.audioKey)
          .filter((k): k is string => Boolean(k) && k !== assembled.audioKey);
        await mapWithConcurrency(keysToDelete, 4, async (key) => {
          try {
            await blobs.delete(key);
          } catch {
            await metadata.recordOrphanBlob(key).catch(() => {});
          }
        });
        await metadata.clearSynthesisSegments(userId, episodeId);

        if (previousKey && previousKey !== assembled.audioKey) {
          try {
            await blobs.delete(previousKey);
          } catch {
            await metadata.recordOrphanBlob(previousKey).catch(() => {});
          }
        }
        await notifyOnDemand(ep, "ready");
      }

      return {
        status: wrote ? "ready" : "superseded",
        episodeId,
        audioKey: assembled.audioKey,
        byteLength: assembled.byteLength,
      };
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await step.do("mark-failed", async () => {
      const ep = (await metadata.getEpisode(userId, episodeId)) ?? claimedEpisode!;
      if (ep.status === "ready" && !ep.regenerating) return;
      const formatted = `${errorMsg} [mode ${ep.mode}; workflow ${event.instanceId}]`;
      const wrote = await metadata.completeEpisode(unsynthesized(ep, formatted), owner);
      if (wrote) {
        await notifyOnDemand(ep, "failed", formatted);
      }
    });
    throw err;
  }
}

export class EpisodeSynthesisWorkflow extends WorkflowEntrypoint<
  SynthesisWorkflowEnv,
  EpisodeSynthesisParams
> {
  override async run(
    event: Readonly<WorkflowEvent<EpisodeSynthesisParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    return await runEpisodeSynthesisWorkflow(
      this.env,
      event as WorkflowEventLike<EpisodeSynthesisParams>,
      step as unknown as WorkflowStepLike,
    );
  }
}
