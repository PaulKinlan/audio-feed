/**
 * Real-voice upload acceptance for Paul (audio-feed-9hfz9) — PREPARATION ONLY.
 *
 * The uploads P1 acceptance (audio-feed-d82rv) drove the pipeline with an INJECTED STUB
 * synthesizer, so it proves ingest -> worker -> READY but cannot by construction catch a
 * real Gemini TTS failure. Closing that gap needs one real upload with the real voice —
 * which SPENDS MONEY, so running it is Paul's decision, not a lane's. This command is the
 * prepared, cost-marked instrument; the lane that wrote it never ran it live.
 *
 * ONE COMMAND, DRY BY DEFAULT:
 *
 *   deno run --allow-net --allow-env --allow-read --allow-write scripts/real-voice-upload-acceptance.ts
 *     → DRY: no network, no worker, no spend. Prints what --live would do and what it
 *       would cost (heuristic token count; the exact one needs the provider's free
 *       countTokens, which is itself a network call, so dry mode does not make it).
 *
 *   deno run --allow-net --allow-env --allow-read --allow-write scripts/real-voice-upload-acceptance.ts --live
 *     → the real thing: boots the app in-process with the PRODUCTION synthesizer
 *       (createGeminiSynthesizer — the real GeminiTtsClient path, direct/single-voice
 *       mode), uploads ONE small real document through the app's own POST /api/upload,
 *       and waits for the episode to settle. Requires credentials: GEMINI_API_KEY set,
 *       or GEMINI_API_BASE_URL pointed at a proxy that injects the key (the fleet proxy
 *       https://gemini.int.exe.xyz/v1beta works keylessly — audio-feed-u60a).
 *
 *   --cleanup  (with either mode's run) deletes the created episode, article, audio blob
 *       and the temp WAV after reporting.
 *
 * COST MARKS, because this command's whole point is that the spend is a decision:
 *   - BEFORE any paid call (live mode): the narration prompt is built with the production
 *     formatNarrationPrompt and segmented with the production splitTextUnderByteBudget,
 *     and its tokens are counted EXACTLY with the provider's free :countTokens endpoint
 *     through the same base URL the client will use. The printed estimate separates input
 *     cost (exact) from output cost (bounded — output tokens depend on the voice's pacing
 *     and cannot be known before generation, so the WORST case from the provider's own
 *     caps is printed alongside; that worst case is the honest pre-call number).
 *   - AFTER: episode id, final state, audio byte length, decoded duration, and the
 *     observed cost: exact input tokens + measured duration x 25 tokens/s. The 25
 *     tokens-per-second rate is Google's documented audio tokenization ("Audio tokens
 *     correspond to 25 tokens per second of audio", Google Cloud TTS pricing), and it is
 *     labelled DERIVED in the output because GeminiTtsClient does not surface the
 *     response's usageMetadata — the duration is measured, the token conversion is
 *     documented arithmetic, not a provider-reported figure.
 *   - Prices (Google Cloud Text-to-Speech pricing, Gemini-TTS table, measured 2026-10-21):
 *     gemini-3.8-flash-tts input $0.50 / output-audio $9.00 per 1M tokens through
 *     2026-12-31; $1.00 / $18.00 from 2027-01-01. The script picks the schedule by the
 *     clock and prints which one it used, so a stale rate cannot pass silently.
 *
 * WHAT TOUCHES PRODUCTION: nothing. Stores are memoryStores() — the episode, article,
 * blob and any state die with the process; only the temp WAV file (printed) can outlive
 * it, and --cleanup removes that too. No port is listened on (the app's fetch handler is
 * driven in-process), and the worker is aborted in a finally block.
 *
 * PASS CRITERIA: exit 0 only when the episode reaches READY with decodable audio whose
 * duration is plausible ( > 0 ). A FAILED episode, a timeout (money may have been spent —
 * the output says so), or undecodable audio all exit non-zero with the episode's own
 * error where one exists.
 */
import {
  type DecodedAudioResult,
  decodedFromWav,
  DEFAULT_GEMINI_API_BASE_URL,
  DEFAULT_TTS_MODEL,
  formatNarrationPrompt,
  MAX_TTS_INPUT_BYTES,
  MAX_TTS_SEGMENTS,
} from "../src/tts/gemini.ts";
import { splitTextUnderByteBudget } from "../src/synthesis/limits.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { startSynthesisWorker } from "../src/worker/synthesis.ts";
import { createGeminiSynthesizer } from "../src/worker/synthesis.ts";

/** The one small real document the acceptance narrates: real prose, seconds of audio. */
export const DOCUMENT_TITLE = "A short real-voice acceptance note";
export const DOCUMENT = `This sentence exists to be spoken by a real voice.
Audio Feed turns writing like this into a personal podcast episode: the text is
ingested, an episode is queued, a worker claims it, and a speech model narrates
it back. If you can hear this sentence, the whole path worked — real upload,
real queue, real synthesis, real audio in the feed.
It is deliberately short. Narrating it costs a fraction of a cent, and the
command that ran it prints exactly what it spent, before and after.`;

/** The feed token the seeded approved user authenticates /api/upload with. */
export const ACCEPTANCE_FEED_TOKEN = "real-voice-acceptance-token-01";

/**
 * Gemini-TTS prices per 1M tokens (Google Cloud Text-to-Speech pricing, Gemini-TTS
 * table), measured 2026-10-21. The promotional schedule runs through 2026-12-31.
 */
export interface TtsRates {
  inputPer1M: number;
  outputPer1M: number;
  /** Which schedule the clock selected, printed with the estimate. */
  schedule: "promotional (through 2026-12-31)" | "standard (from 2027-01-01)";
}

export function ratesFor(now: Date): TtsRates {
  // The date boundary is the pricing page's own: standard rates start 2027-01-01.
  const standard = now.getTime() >= Date.parse("2027-01-01T00:00:00Z");
  return standard
    ? { inputPer1M: 1.0, outputPer1M: 18.0, schedule: "standard (from 2027-01-01)" }
    : { inputPer1M: 0.5, outputPer1M: 9.0, schedule: "promotional (through 2026-12-31)" };
}

/**
 * The provider-contract worst case for ONE synthesis invocation, printed before every
 * live run: MAX_TTS_SEGMENTS segments at the model's own per-segment token caps
 * (8,192 in / 16,384 out, measured from model metadata by audio-feed-u60a). Output
 * cannot be known before generation, so this bound — not the optimistic estimate — is
 * what a pre-call decision can rely on.
 */
export const WORST_CASE = {
  inputTokens: MAX_TTS_SEGMENTS * 8192,
  outputTokens: MAX_TTS_SEGMENTS * 16384,
} as const;

/** Google's documented audio tokenization rate (TTS pricing page). */
export const AUDIO_TOKENS_PER_SECOND = 25;

/**
 * Dry-mode token heuristic, from this repo's own committed live measurement
 * (audio-feed-u60a evidence: 47,044 prompt bytes counted as 10,512 provider tokens
 * — 4.476 bytes/token). Only used when no countTokens call is made.
 */
export const HEURISTIC_BYTES_PER_TOKEN = 4.5;

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  rates: TtsRates,
): { inputUsd: number; outputUsd: number; totalUsd: number } {
  const inputUsd = (inputTokens / 1_000_000) * rates.inputPer1M;
  const outputUsd = (outputTokens / 1_000_000) * rates.outputPer1M;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
  };
}

const usd = (v: number) => `$${v.toFixed(v < 0.01 && v > 0 ? 5 : 2)}`;

export function parseArgs(args: string[]): { live: boolean; cleanup: boolean } {
  return {
    live: args.includes("--live"),
    cleanup: args.includes("--cleanup"),
  };
}

/** Bytes of a UTF-8 string, the unit every bound in this pipeline speaks. */
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** The narration prompt exactly as production would build it for this document. */
export function acceptancePrompt(): string {
  return formatNarrationPrompt({ title: DOCUMENT_TITLE, body: DOCUMENT });
}

function printPlan(prompt: string, rates: TtsRates, exactInputTokens: number | null): number {
  const segments = splitTextUnderByteBudget(prompt, MAX_TTS_INPUT_BYTES);
  const inputTokens = exactInputTokens ??
    Math.ceil(utf8Bytes(prompt) / HEURISTIC_BYTES_PER_TOKEN);
  // Output: unknown before generation. Give the pacing-typical guess AND the bound.
  const typicalSeconds = Math.round(inputTokens / 15); // ~150 spoken words/min ≈ 2.5 words/s ≈ 15 tok/s of text
  const typicalOutputTokens = typicalSeconds * AUDIO_TOKENS_PER_SECOND;

  console.log("=== Real-voice upload acceptance (audio-feed-9hfz9) ===");
  console.log(
    `document        : "${DOCUMENT_TITLE}", ${utf8Bytes(DOCUMENT)} bytes, ${DOCUMENT.length} chars`,
  );
  console.log(
    `narration prompt : ${
      utf8Bytes(prompt)
    } bytes -> ${segments.length} segment(s) under the ${MAX_TTS_INPUT_BYTES}-byte budget`,
  );
  console.log(
    exactInputTokens
      ? `input tokens     : ${inputTokens} (EXACT, provider countTokens — a free call)`
      : `input tokens     : ~${inputTokens} (heuristic ${HEURISTIC_BYTES_PER_TOKEN} bytes/token; --live replaces this with the provider's exact free countTokens)`,
  );
  console.log(
    `prices           : input ${usd(rates.inputPer1M)}/1M, output audio ${
      usd(rates.outputPer1M)
    }/1M — ${rates.schedule}`,
  );
  console.log(
    `output tokens    : DERIVED post-hoc from duration x ${AUDIO_TOKENS_PER_SECOND}/s (Google-documented rate); unknowable before generation`,
  );

  const expected = estimateCost(inputTokens, typicalOutputTokens, rates);
  console.log(
    `ESTIMATE (voice at ~${typicalSeconds}s): input ${usd(expected.inputUsd)} + output ${
      usd(expected.outputUsd)
    } = ${usd(expected.totalUsd)}`,
  );
  const worst = estimateCost(WORST_CASE.inputTokens, WORST_CASE.outputTokens, rates);
  console.log(
    `WORST CASE (provider caps: ${MAX_TTS_SEGMENTS} segments x 8,192 in / 16,384 out): input ${
      usd(worst.inputUsd)
    } + output ${usd(worst.outputUsd)} = ${usd(worst.totalUsd)}`,
  );
  console.log(
    `mode             : direct (single voice). deepdive would add a paid script-generation call, which this acceptance does not exercise.`,
  );
  return segments.length;
}

/** Resolve the base URL exactly as the client does: env first, then the production default. */
function geminiBaseUrl(): string {
  return Deno.env.get("GEMINI_API_BASE_URL")?.trim() || DEFAULT_GEMINI_API_BASE_URL;
}

/** The provider's free token count for the prompt, through the same base URL the client uses. */
/**
 * The headers the free countTokens pre-check sends (audio-feed-rc30m).
 *
 * `x-goog-api-key` when a direct key is configured — the same credential GeminiTtsClient's
 * transport uses — so a non-proxy configuration stops 403ing on the very call that is
 * supposed to prove the spend before it happens. Without a key (fleet proxy) the header is
 * absent and the proxy injects authentication server-side, exactly as for synthesis.
 */
export function countPromptHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey?.trim();
  if (key) headers["x-goog-api-key"] = key;
  return headers;
}

async function countPromptTokens(prompt: string): Promise<number> {
  const base = geminiBaseUrl();
  const response = await fetch(`${base}/models/${DEFAULT_TTS_MODEL}:countTokens`, {
    method: "POST",
    headers: countPromptHeaders(Deno.env.get("GEMINI_API_KEY")),
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) {
    throw new Error(
      `countTokens failed: status=${response.status} from ${base} (is GEMINI_API_BASE_URL right, or does the key apply?)`,
    );
  }
  const json = await response.json();
  if (typeof json.totalTokens !== "number") throw new Error("countTokens returned no totalTokens");
  return json.totalTokens;
}

async function readBlobBytes(
  stores: ReturnType<typeof memoryStores>,
  key: string,
): Promise<Uint8Array> {
  const blob = await stores.blobs.get(key);
  if (!blob) throw new Error(`audio blob ${key} not found`);
  const chunks: Uint8Array[] = [];
  const reader = blob.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

export async function main(args: string[]): Promise<number> {
  const { live, cleanup } = parseArgs(args);
  const rates = ratesFor(new Date());

  if (!live) {
    console.log(
      "DRY RUN (default). Nothing has been or will be spent. Add --live to run the real synthesizer.\n",
    );
    printPlan(acceptancePrompt(), rates, null);
    console.log("\nTo run for real:");
    console.log(
      "  deno run --allow-net --allow-env --allow-read --allow-write scripts/real-voice-upload-acceptance.ts --live",
    );
    console.log(
      "Credentials: GEMINI_API_KEY set, or GEMINI_API_BASE_URL=https://gemini.int.exe.xyz/v1beta (fleet proxy, key injected server-side).\n",
    );
    console.log(
      "Add --cleanup to delete the created episode, article, audio blob and temp WAV after the run.",
    );
    return 0;
  }

  // --live guard: refuse BEFORE any network spend if no credential story exists.
  const base = geminiBaseUrl();
  const apiKeyConfigured = Boolean(Deno.env.get("GEMINI_API_KEY")?.trim());
  if (!apiKeyConfigured && base === DEFAULT_GEMINI_API_BASE_URL) {
    console.error(
      "Refusing --live: no GEMINI_API_KEY is set and GEMINI_API_BASE_URL is the production\n" +
        "default, so synthesis would fail after spending nothing — or worse, be misconfigured.\n" +
        "Set GEMINI_API_KEY, or point GEMINI_API_BASE_URL at the fleet proxy\n" +
        "(https://gemini.int.exe.xyz/v1beta injects the key server-side; audio-feed-u60a).",
    );
    return 1;
  }

  const stores = memoryStores();
  const config = { port: 0, adminToken: "real-voice-acceptance" };
  const ctx = { config, stores };

  // The approved user whose feed token authorizes the upload.
  let user = await createUser(stores.metadata, {
    email: "paul@example.com",
    displayName: "Paul Kinlan",
    isAdmin: true,
  });
  user = await approveUser(stores.metadata, user.id, "real-voice-acceptance");
  user.feedToken = ACCEPTANCE_FEED_TOKEN;
  await stores.metadata.putUser(user);

  const app = createApp(ctx, createHandlers(ctx));

  // THE difference from the d82rv acceptance: the production synthesizer, not a stub.
  const workerAbort = new AbortController();
  const worker = startSynthesisWorker(ctx, createGeminiSynthesizer(ctx), {
    signal: workerAbort.signal,
    intervalMs: 1_000,
    batchSize: 2,
    onTick: (result) => {
      if (result.ready.length || result.failed.length || result.deferred.length) {
        console.log(
          `[worker] ready: ${result.ready.length}, failed: ${result.failed.length}, deferred: ${result.deferred.length} (of ${result.considered})`,
        );
      }
    },
  });

  const prompt = acceptancePrompt();
  printPlan(prompt, rates, null);

  let tempWav: string | null = null;
  let episodeArticleId: string | null = null;
  const created = {
    episodeId: null as string | null,
    articleId: null as string | null,
    audioKey: null as string | null,
  };
  try {
    console.log("\n--live: counting prompt tokens exactly (free call) before anything is spent...");
    // INSIDE the try (audio-feed-rc30m): every statement from here on runs with the worker
    // already live, so a countTokens failure must unwind through the same finally that
    // aborts it — previously this call sat before the try and a 403 left a polling worker
    // looping forever after main had returned.
    const exactInputTokens = await countPromptTokens(prompt);
    console.log(`input tokens     : ${exactInputTokens} (EXACT)`);
    const expected = estimateCost(
      exactInputTokens,
      Math.round((exactInputTokens / 15) * AUDIO_TOKENS_PER_SECOND),
      rates,
    );
    console.log(
      `EXPECTED SPEND   : ~${
        usd(expected.totalUsd)
      } (output estimate), worst case below is the bound:\n`,
    );

    // Upload through the app's OWN route — the ingest half of the path under test.
    const form = new FormData();
    form.append(
      "file",
      new File([DOCUMENT], "real-voice-acceptance.txt", { type: "text/plain" }),
    );
    const res = await app.fetch(
      new Request("http://localhost/api/upload", {
        method: "POST",
        headers: { "x-feed-token": ACCEPTANCE_FEED_TOKEN },
        body: form,
      }),
    );
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.status !== 202 || typeof body.episodeId !== "string") {
      console.error(`upload refused (HTTP ${res.status}):`, JSON.stringify(body));
      return 1;
    }
    created.episodeId = body.episodeId;
    created.articleId = typeof body.articleId === "string" ? body.articleId : null;
    console.log(
      `uploaded         : episode ${created.episodeId} queued (HTTP 202). Waiting for the worker...`,
    );

    // Wait for the real worker to claim and synthesize it.
    const deadline = Date.now() + 10 * 60_000;
    let episode = await stores.metadata.getEpisode(user.id, created.episodeId);
    while (episode && !["ready", "failed"].includes(episode.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      episode = await stores.metadata.getEpisode(user.id, created.episodeId);
    }
    if (!episode) {
      console.error("episode vanished from the store — unexpected");
      return 1;
    }
    if (!["ready", "failed"].includes(episode.status)) {
      console.error(
        `TIMED OUT after 10 min with episode still "${episode.status}". Money MAY have been spent\n` +
          `(a claimed segment bills even if the deadline fired); check the admin spend page before re-running.`,
      );
      return 1;
    }

    created.audioKey = episode.audioKey ?? null;
    episodeArticleId = episode.articleId ?? null;
    let audio: { bytes: Uint8Array; decoded: DecodedAudioResult } | null = null;
    if (episode.audioKey) {
      const bytes = await readBlobBytes(stores, episode.audioKey);
      try {
        audio = { bytes, decoded: decodedFromWav(bytes) };
        tempWav = await Deno.makeTempFile({ prefix: "audio-feed-real-voice-", suffix: ".wav" });
        await Deno.writeFile(tempWav, bytes);
      } catch (decodeError) {
        console.error(
          `audio present (${bytes.byteLength} bytes) but the production decoder refused it:`,
          decodeError,
        );
        audio = null;
      }
    }

    // The observed-cost block: exact inputs, measured audio, one labelled DERIVED factor.
    const durationSeconds = audio?.decoded.durationSeconds ?? 0;
    const observed = estimateCost(
      exactInputTokens,
      durationSeconds * AUDIO_TOKENS_PER_SECOND,
      rates,
    );
    console.log("\n=== RESULT ===");
    console.log(`episode id       : ${episode.id}`);
    console.log(
      `final state      : ${episode.status}${episode.error ? ` (${episode.error})` : ""}`,
    );
    console.log(
      `audio bytes      : ${
        audio ? audio.bytes.byteLength : (episode.audioKey ? "present, undecodable" : "none")
      }`,
    );
    console.log(
      `duration         : ${durationSeconds.toFixed(2)}s (decoded by the production decoder)`,
    );
    if (tempWav) {
      console.log(
        `audio file       : ${tempWav} — LISTEN TO THIS; the acceptance is the voice, not the status code`,
      );
    }
    console.log(
      `input tokens     : ${exactInputTokens} (exact, countTokens) -> ${usd(observed.inputUsd)}`,
    );
    console.log(
      `output tokens    : ${
        (durationSeconds * AUDIO_TOKENS_PER_SECOND).toFixed(0)
      } — DERIVED from measured duration x ${AUDIO_TOKENS_PER_SECOND}/s (documented rate; usageMetadata is not surfaced by the client) -> ${
        usd(observed.outputUsd)
      }`,
    );
    console.log(
      `OBSERVED SPEND   : ~${usd(observed.totalUsd)} (vs estimate ${
        usd(expected.totalUsd)
      }, worst case ${
        usd(estimateCost(WORST_CASE.inputTokens, WORST_CASE.outputTokens, rates).totalUsd)
      })`,
    );

    if (episode.status !== "ready" || !audio || durationSeconds <= 0) {
      console.error("\nACCEPTANCE FAILED: the real-voice path did not produce playable audio.");
      return 1;
    }
    console.log(
      "\nACCEPTANCE PASSED: real upload -> real worker -> real Gemini TTS -> playable audio.",
    );
    return 0;
  } finally {
    workerAbort.abort();
    await worker.stop();
    if (cleanup) {
      const removed: string[] = [];
      if (created.episodeId) {
        await stores.metadata.deleteEpisode(user.id, created.episodeId);
        removed.push(`episode ${created.episodeId}`);
      }
      const articleId = created.articleId ?? episodeArticleId;
      if (articleId) {
        await stores.metadata.deleteArticle(user.id, articleId);
        removed.push(`article ${articleId}`);
      }
      if (created.audioKey) {
        await stores.blobs.delete(created.audioKey);
        removed.push(`blob ${created.audioKey}`);
      }
      if (tempWav) {
        await Deno.remove(tempWav).catch(() => {});
        removed.push(tempWav);
      }
      console.log(
        `--cleanup: removed ${
          removed.length ? removed.join(", ") : "nothing (nothing was created)"
        }.`,
      );
      console.log("Stores were in-memory only: every remaining row dies with this process.");
    } else if (tempWav) {
      console.log(
        `Kept ${tempWav} (no --cleanup). Stores are in-memory; nothing else outlives this process.`,
      );
    }
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
