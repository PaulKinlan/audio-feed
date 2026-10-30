import type { CodeHandling } from "../types.ts";
import { attemptDeadline } from "./deadline.ts";
import {
  assertTextSeams,
  runManagedTurns,
  splitTextUnderByteBudget,
  SynthesisYieldError,
} from "../synthesis/limits.ts";
import { mapWithConcurrency } from "../concurrency.ts";

/** Code-block explanations in flight at once (audio-feed-8acp): each one is a model
 * request, so the pool stays small. */
const CODE_EXPLANATION_CONCURRENCY = 4;

/**
 * Gemini 3.8 / 2.5 Flash TTS Client
 *
 * Provides:
 * - Single-voice narration mode (Stratechery / Ben Thompson style with title, date, author intro)
 * - Two-voice dialogue mode (NotebookLM style: expert + curious foil)
 * - Voice configuration (Aoede, Charon, Fenrir, Kore, Puck)
 * - Request builder for Google Generative Language API
 * - Response decoder for audio output (PCM, WAV, MP3) with PCM-to-WAV conversion
 */

export const GEMINI_TTS_VOICES = [
  "Aoede",
  "Charon",
  "Fenrir",
  "Kore",
  "Puck",
] as const;

export type GeminiTtsVoice = (typeof GEMINI_TTS_VOICES)[number];

export interface VoiceProfile {
  name: GeminiTtsVoice;
  gender: "female" | "male";
  style: string;
  recommendedRole: "narrator" | "expert" | "curious_foil" | "co-host";
}

export const VOICE_PROFILES: Record<GeminiTtsVoice, VoiceProfile> = {
  Aoede: {
    name: "Aoede",
    gender: "female",
    style: "Breezy, melodic, and engagingly narrative",
    recommendedRole: "co-host",
  },
  Charon: {
    name: "Charon",
    gender: "male",
    style: "Measured, clear, authoritative journalistic narrator",
    recommendedRole: "narrator",
  },
  Fenrir: {
    name: "Fenrir",
    gender: "male",
    style: "Deep, resonant, analytical domain expert",
    recommendedRole: "expert",
  },
  Kore: {
    name: "Kore",
    gender: "female",
    style: "Warm, perceptive, conversational interviewer",
    recommendedRole: "curious_foil",
  },
  Puck: {
    name: "Puck",
    gender: "male",
    style: "Upbeat, lively, inquisitive foil",
    recommendedRole: "curious_foil",
  },
};

export const DEFAULT_NARRATION_VOICE: GeminiTtsVoice = "Charon";
export const DEFAULT_EXPERT_VOICE: GeminiTtsVoice = "Fenrir";
export const DEFAULT_FOIL_VOICE: GeminiTtsVoice = "Puck";

export const DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts";
/** 3.8 Flash TTS accepts at most 8192 input tokens; UTF-8 bytes are a conservative
 * upper bound for transcript tokens: each text token consumes at least one input byte, even
 * in CJK/multibyte text. 3000 bytes keeps single-turn TTS latency ~20-25s and within invocation budgets (audio-feed-9lrl).
 * Exact counts still require the provider countTokens endpoint. */
export const MAX_TTS_INPUT_BYTES = 3_000;
/** Explicit audio output ceiling for the current TTS model, rather than an implicit default. */
export const MAX_TTS_OUTPUT_TOKENS = 16_384;
/**
 * Bound paid calls per episode (audio-feed-9yu8, audio-feed-9lrl). Further adaptive splits count too; long
 * articles fail before sending any requests. Raised 24 -> 64 (audio-feed-cco6g): resumable segment claims
 * (audio-feed-wr1u) landed, so a document needing between 25 and 64 segments synthesises across invocation
 * slices instead of failing at ingest.
 *
 * THE WALL-CLOCK CHECK THIS RAISE HAD TO SURVIVE (audio-feed-cco6g): 64 segments x the 45s worst-case turn
 * estimate is ~48 minutes, far beyond the 15-minute claim lease (DEFAULT_CLAIM_LEASE_MS) — and that is
 * safe BY DESIGN, not by tuning. Three mechanisms carry an episode longer than any single lease: (1) the
 * invocation budget (maxInvocationDurationMs, 90s default) yields the claim with durable progress well
 * inside the lease, and a progress-yield resets the attempts counter (audio-feed-vqu4), so a long episode
 * crosses many cron ticks without ever being superseded; (2) the worker stops paid work 60s before lease
 * expiry and passes a lease AbortSignal, and resumable segments mean a claim that DOES expire mid-episode
 * (crash, hang, eviction) re-pays only the segment that was in flight; (3) the per-attempt TTS deadline
 * (TTS_TIMEOUT_MS, 120s) bounds one request, independent of how many the episode needs. What a raise here
 * must never do is make the cap the wall-clock bound: superseded-after-lease work is reported (the
 * `superseded` result field), and a rising count means the lease — not this constant — needs
 * attention. With 64 segments the narration input ceiling is 3 KB x 64 = 192,000 bytes
 * (MAX_NARRATION_BYTES, src/ingest/upload.ts).
 */
export const MAX_TTS_SEGMENTS = 64;
/**
 * Per-attempt deadline: a hung request must not hold a synthesis worker forever. 120s answers the
 * 2026-10-09 incident (audio-feed-bp6r): 9vns measured segments at 45-55s wall-clock, and the
 * recorded failure returned HTTP 200 headers at 59.8s before the old 60s killed the body read —
 * the deadline sat INSIDE the real distribution. Settable per environment with TTS_TIMEOUT_MS
 * (src/config.ts); keep it below the claim lease.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Retries AFTER the first attempt. */
export const DEFAULT_MAX_RETRIES = 1;
/**
 * Extra attempts allowed after a per-attempt DEADLINE fires, on top of `maxRetries`
 * (audio-feed-9yu8). Multi-segment episodes force `maxRetries: 0` per segment, so without a
 * budget of its own a single slow segment would end the whole episode. One retry bounds the
 * cost: a deadline can fire after the provider generated (and billed) that one segment, and the
 * alternative is strictly worse — the episode fails, then up to 3 claim leases are burned
 * before abandonment.
 */
export const DEFAULT_TIMEOUT_RETRIES = 1;
/**
 * Statuses where the API definitively did not process the request, so retrying cannot double-charge.
 * Other 5xx and network failures may already have generated (and billed) audio — retrying those is a
 * cost decision, so it is opt-in via retryOn: "all".
 */
const TRANSIENT_STATUSES = new Set([429, 503]);
export const DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The minimum of an environment a reader needs (audio-feed-lnnjd). Tests pass
 * a fake rather than mutating process-global `Deno.env`, which every
 * concurrently running module would see for the whole set/restore window.
 * The default stays `Deno.env`, so production callers are unchanged.
 */
export interface EnvReader {
  get(key: string): string | undefined;
}

/**
 * Resolve the Gemini API base URL, preferring an explicit override or the
 * GEMINI_API_BASE_URL environment variable, falling back to DEFAULT_GEMINI_API_BASE_URL.
 * Normalizes host-only URLs by appending /v1beta so /models/... appends correctly.
 */
export function getGeminiApiBaseUrl(override?: string, env?: EnvReader): string {
  const raw = override?.trim() || (() => {
    try {
      const reader = env ??
        (typeof Deno !== "undefined" && typeof Deno.env?.get === "function" ? Deno.env : undefined);
      return reader?.get("GEMINI_API_BASE_URL")?.trim();
    } catch {
      // Permission denied or environment access restricted
    }
    return undefined;
  })();

  if (raw && raw.length > 0) {
    const trimmed = raw.replace(/\/+$/, "");
    return /\/v1(?:beta|alpha)?$/.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
  }
  return DEFAULT_GEMINI_API_BASE_URL;
}

export const GEMINI_API_BASE_URL = DEFAULT_GEMINI_API_BASE_URL;

/**
 * Narration input for single-voice reading (Stratechery / Ben Thompson style)
 */
export interface NarrationInput {
  title: string;
  body: string;
  author?: string;
  publishedAt?: string | Date;
  sourceName?: string;
  lead?: string;
  voice?: GeminiTtsVoice | string;
  includeIntro?: boolean;
  customIntro?: string;
  /** Style/tone direction for speech_metadata.style (audio-feed-bjt). Defaults to DEFAULT_NARRATION_STYLE. */
  style?: string;
  /** How to handle code blocks in TTS generation (audio-feed-bdo). Defaults to "skip". */
  codeHandling?: CodeHandling;
  /** Optional code summarizer function when codeHandling is "explain" (audio-feed-bdo). */
  codeSummarizer?: (code: string) => string | Promise<string>;
}

/**
 * Dialogue speaker specification
 */
export interface DialogueSpeaker {
  name: string;
  role: "expert" | "curious_foil" | "host" | "co-host";
  voice: GeminiTtsVoice | string;
}

/**
 * A single spoken turn in a dialogue script
 */
export interface DialogueTurn {
  speaker: string;
  text: string;
  /** Optional style/tone direction for speech_metadata.style (audio-feed-bjt). */
  style?: string;
}

/**
 * Dialogue input for two-voice podcast mode (NotebookLM style)
 */
export interface DialogueInput {
  title?: string;
  topic?: string;
  speakers?: [DialogueSpeaker, DialogueSpeaker];
  turns?: DialogueTurn[];
  script?: string;
  article?: {
    title: string;
    author?: string;
    body: string;
    summary?: string;
  };
  /** How to handle code blocks in TTS generation (audio-feed-bdo). Defaults to "skip". */
  codeHandling?: CodeHandling;
  /** Optional code summarizer function when codeHandling is "explain" (audio-feed-bdo). */
  codeSummarizer?: (code: string) => string | Promise<string>;
}

export interface SpeechMetadata {
  speaker?: string;
  style?: string;
}

export interface ContentPart {
  text: string;
  speech_metadata?: SpeechMetadata;
  speechMetadata?: SpeechMetadata;
}

/**
 * Request payload for Gemini GenerateContent API with Audio modality
 */
export interface GeminiGenerateContentRequest {
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  contents: Array<{
    role?: string;
    parts: Array<ContentPart>;
  }>;
  generationConfig: {
    responseModalities: ["AUDIO"];
    speechConfig: {
      voiceConfig?: {
        prebuiltVoiceConfig: {
          voiceName: string;
        };
      };
      multiSpeakerVoiceConfig?: {
        speakerVoiceConfigs: Array<{
          speaker: string;
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: string;
            };
          };
        }>;
      };
    };
    temperature?: number;
    maxOutputTokens?: number;
  };
}

/**
 * Parsed and decoded audio response
 */
export interface DecodedAudioResult {
  rawBytes: Uint8Array;
  mimeType: string;
  format: "pcm" | "wav" | "mp3" | "unknown";
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number;
  /**
   * Why the model stopped ("STOP" when the audio is complete).
   *
   * An episode that was cut off mid-sentence must not be published as if it were finished, so a
   * non-complete reason is surfaced here AND rejected by default (see allowTruncated).
   */
  finishReason?: string;
  /** True when finishReason is anything other than STOP — the audio is incomplete. */
  truncated: boolean;
  toWav(): Uint8Array;
}

/**
 * Options for audio synthesis
 */
export interface SynthesisOptions {
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Per-attempt deadline in ms. Defaults to the client's timeoutMs (120s). A hung request would
   * otherwise hold a synthesis worker forever.
   */
  timeoutMs?: number;
  /** Override the client's maxRetries for this call. */
  maxRetries?: number;
  /** Override the client's timeoutRetries (extra attempts after a deadline fires). */
  timeoutRetries?: number;
  /**
   * Durable resumable chunking (audio-feed-wr1u). The worker persists each paid segment so a
   * run that dies mid-episode resumes instead of re-billing every segment.
   *
   * `prepare` runs BEFORE the paid call for one segment (its exact text, or for dialogue the
   * batch's turn texts joined by U+0000): return stored WAV bytes to skip the call entirely,
   * "synthesize" to pay for it, or "held" to abort because another live claimant owns that
   * segment's spend right now. `commit` runs after the segment decodes and before the next
   * paid call, so a crash loses at most the segment in flight.
   */
  resume?: {
    /**
     * `wav` carries the stored bytes and the voice that spoke them: the client reuses them
     * only if it is about to use that same voice, so a voice change re-speaks rather than
     * serving another voice's audio.
     */
    prepare: (
      segmentText: string,
      voice: string,
    ) => Promise<{ wav: Uint8Array } | "synthesize" | "held">;
    commit: (
      segmentText: string,
      decoded: DecodedAudioResult,
      voice: string,
      /** The caller's abort signal (budget + lease): the segment put must be interruptible
       * (audio-feed-y9kk) — a commit that uploads without it is a background zombie. */
      signal?: AbortSignal,
    ) => Promise<void>;
  };
  /**
   * Which failures may be retried. "transient" (default) covers only statuses that mean the API
   * definitively did not process the request (429, 503). "all" also retries other 5xx and network
   * errors — a cost decision, because the server may already have generated (and billed) audio.
   */
  retryOn?: RetryPolicy;
  /**
   * Return truncated audio instead of throwing. Off by default: a half-episode is not an episode,
   * and silently publishing one is the failure mode this flag exists to prevent.
   */
  allowTruncated?: boolean;
  /**
   * Optional progress callback (audio-feed-siv1), invoked as each turn/segment begins.
   * Reports turn (1-indexed) and total turns, allowing callers to persist execution phase
   * and heartbeats to survive worker isolate evictions.
   */
  onProgress?: (turn: number, total: number) => Promise<void> | void;
  /**
   * Optional check invoked after a segment completes (audio-feed-vqu4).
   * If it returns true, runManagedTurns throws SynthesisYieldError so the worker
   * can yield its claim back to the queue and let the next cron tick continue.
   */
  shouldYield?: (completedCount: number, totalCount: number) => boolean;
}

export type RetryPolicy = "none" | "transient" | "all";

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with jitter, honouring Retry-After when the API sends one.
 * Jitter matters because a rate-limited fleet retrying in lockstep just re-trips the limit.
 */
function backoffMs(attempt: number, baseMs: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const when = Date.parse(retryAfterHeader);
    if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), 30_000);
  }
  const capped = Math.min(baseMs * 2 ** (attempt - 1), 30_000);
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

export class GeminiTtsError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
    /**
     * Retrying cannot help and may double-bill: a provider verdict (HTTP status), our spend-guard
     * 409, or a truncation. The worker's isPermanent() reads this BEFORE its status heuristic
     * (audio-feed-9yu8), so a wrapper can mark a failure terminal without inventing a status —
     * which is how the whole-episode guard kept the re-billing refusal for provider verdicts
     * while letting a status-less deadline abort be retried.
     */
    public readonly permanent: boolean = false,
  ) {
    super(message);
    this.name = "GeminiTtsError";
  }
}

/** Raised when the model stopped early, so callers cannot mistake partial audio for a full read. */
export class GeminiTtsTruncatedError extends GeminiTtsError {
  constructor(
    public readonly finishReason: string,
    partial: DecodedAudioResult,
  ) {
    super(
      `Gemini TTS returned incomplete audio (finishReason: ${finishReason}). ` +
        `The episode is truncated — split the input, or pass allowTruncated: true to accept it ` +
        `with result.truncated === true.`,
      undefined,
      partial,
    );
    this.name = "GeminiTtsTruncatedError";
  }
}

/**
 * Client configuration
 */
export interface GeminiTtsClientConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Environment the base-URL fallback reads (default Deno.env) — audio-feed-lnnjd. */
  env?: EnvReader;
  fetchFn?: typeof fetch;
  /** Per-attempt deadline in ms (default 120000). */
  timeoutMs?: number;
  /** Retry attempts after the first try (default 1). */
  maxRetries?: number;
  /**
   * Extra attempts after a per-attempt DEADLINE fires, on top of `maxRetries` (default 1,
   * audio-feed-9yu8). Bounded separately so multi-segment episodes — which force `maxRetries: 0`
   * per segment — can still retry one slow segment.
   */
  timeoutRetries?: number;
  /** Which failures may be retried (default "transient": 429 and 503 only). */
  retryOn?: RetryPolicy;
  /** Base backoff in ms, doubled per attempt and jittered (default 250). */
  retryBaseDelayMs?: number;
  /**
   * The retry wait itself (default a real `setTimeout`). Injected so a test can assert the
   * DELAY THE PRODUCT COMPUTED - the honour-Retry-After row asserts 0ms against a 60s base -
   * instead of proving it by out-waiting a real clock (docs/speed.md census row 6).
   */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Build the paid TTS client's configuration from app config (audio-feed-9yu8). Both production call
 * sites go through this — the worker's synthesizer and the voice-sample route — so the configured
 * per-attempt deadline cannot drift from the client default, and a test can drive the real deadline
 * through a hanging fetchFn instead of asserting on a helper the call site may not use.
 */
export function ttsClientConfig(
  config: { geminiApiKey?: string; ttsTimeoutMs?: number },
): GeminiTtsClientConfig {
  return { apiKey: config.geminiApiKey, timeoutMs: config.ttsTimeoutMs };
}

/**
 * Wrap a turn failure for the worker (audio-feed-9yu8).
 *
 * The wrapper's own status must never manufacture a verdict the inner error did not have: a
 * per-attempt deadline is OUR abort, not the provider's, so it stays status-less and the worker's
 * maxAttempts may retry the episode (audio-feed-wr1u resume re-pays only the failed segment). A
 * failure that already carries a verdict — a provider HTTP status, our spend-guard 409, or a
 * truncation — is marked `permanent`, so the re-billing guard still refuses the episode retry for
 * exactly the cases where a retry could pay twice. Marking it explicitly rather than reusing a
 * hardcoded 400 is what keeps a truncation terminal: its own class carries no status, so a
 * status-only propagation would have silently made it retryable and thrice-billed that segment.
 */
function wrapTurnFailure(error: unknown): GeminiTtsError {
  const detail = error instanceof Error ? error.message : String(error);
  const status = error instanceof GeminiTtsError ? error.status : undefined;
  const permanent = error instanceof GeminiTtsError &&
    (error.status !== undefined || error instanceof GeminiTtsTruncatedError);
  return new GeminiTtsError(
    permanent
      ? `TTS turn failed; refusing whole-episode retry: ${detail}`
      : `TTS turn failed (transient; the episode may be retried): ${detail}`,
    status,
    error,
    permanent,
  );
}

/**
 * Custom error thrown when the Gemini TTS API returns an error response
 */

// ---------------------------------------------------------------------------
// Base64 & Audio Format Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string to a Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/[\s\r\n]+/g, "");
  if (
    typeof (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64 ===
      "function"
  ) {
    try {
      return (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64(clean);
    } catch {
      // Fall back if fromBase64 fails on any edge case
    }
  }
  const binaryString = atob(clean);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a Uint8Array to a base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    if (b !== undefined) {
      binary += String.fromCharCode(b);
    }
  }
  return btoa(binary);
}

/**
 * Detect the audio container or encoding format from binary magic bytes and optional MIME hint
 */
export function detectAudioFormat(
  bytes: Uint8Array,
  mimeHint?: string,
): "pcm" | "wav" | "mp3" | "unknown" {
  if (bytes.length >= 12) {
    // RIFF .... WAVE
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    ) {
      return "wav";
    }
  }

  if (bytes.length >= 3) {
    // ID3v2 tag: "ID3" — a strong, unambiguous container signature.
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      return "mp3";
    }
  }

  // An explicit hint now outranks the bare MPEG frame sync below. That sync is only 11 bits, so
  // raw L16 PCM whose first sample starts 0xFF 0xE0.. was being classified as mp3, which silently
  // corrupted sampleRate/channels/duration downstream (audio-feed-e6l). Container signatures above
  // stay authoritative, because a RIFF/ID3 header cannot occur by chance in PCM.
  if (mimeHint) {
    const lower = mimeHint.toLowerCase();
    if (lower.includes("wav")) return "wav";
    if (lower.includes("mp3") || lower.includes("mpeg")) return "mp3";
    if (lower.includes("pcm") || lower.includes("l16")) return "pcm";
  }

  if (bytes.length >= 3) {
    // MPEG frame sync: 11 bits set (0xFF followed by byte with high 3 bits set)
    const b0 = bytes[0];
    const b1 = bytes[1];
    if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) {
      return "mp3";
    }
  }

  // Default to PCM if non-empty byte buffer from Gemini TTS
  return bytes.length > 0 ? "pcm" : "unknown";
}

/**
 * Write a standard 44-byte RIFF/WAVE header into a target buffer (audio-feed-sp38)
 */
export function writeWavHeader(
  target: Uint8Array,
  pcmByteLength: number,
  options: {
    sampleRate?: number;
    numChannels?: number;
    bitsPerSample?: number;
  } = {},
): void {
  const sampleRate = options.sampleRate ?? 24000;
  const numChannels = options.numChannels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;

  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmByteLength;

  const view = new DataView(target.buffer, target.byteOffset, 44);

  // 0-3: "RIFF"
  target[0] = 0x52; // R
  target[1] = 0x49; // I
  target[2] = 0x46; // F
  target[3] = 0x46; // F

  // 4-7: ChunkSize = 36 + dataSize
  view.setUint32(4, 36 + dataSize, true);

  // 8-11: "WAVE"
  target[8] = 0x57; // W
  target[9] = 0x41; // A
  target[10] = 0x56; // V
  target[11] = 0x45; // E

  // 12-15: "fmt "
  target[12] = 0x66; // f
  target[13] = 0x6d; // m
  target[14] = 0x74; // t
  target[15] = 0x20; // ' '

  // 16-19: Subchunk1Size = 16 for PCM
  view.setUint32(16, 16, true);

  // 20-21: AudioFormat = 1 (PCM)
  view.setUint16(20, 1, true);

  // 22-23: NumChannels
  view.setUint16(22, numChannels, true);

  // 24-27: SampleRate
  view.setUint32(24, sampleRate, true);

  // 28-31: ByteRate
  view.setUint32(28, byteRate, true);

  // 32-33: BlockAlign
  view.setUint16(32, blockAlign, true);

  // 34-35: BitsPerSample
  view.setUint16(34, bitsPerSample, true);

  // 36-39: "data"
  target[36] = 0x64; // d
  target[37] = 0x61; // a
  target[38] = 0x74; // t
  target[39] = 0x61; // a

  // 40-43: Subchunk2Size = dataSize
  view.setUint32(40, dataSize, true);
}

/**
 * Wrap raw linear PCM audio into a standard 44-byte RIFF/WAVE header
 */
export function pcmToWav(
  pcmBytes: Uint8Array,
  options: {
    sampleRate?: number;
    numChannels?: number;
    bitsPerSample?: number;
  } = {},
): Uint8Array {
  const headerSize = 44;
  const totalSize = headerSize + pcmBytes.length;

  const wavBuffer = new Uint8Array(totalSize);
  writeWavHeader(wavBuffer, pcmBytes.length, options);
  wavBuffer.set(pcmBytes, 44);

  return wavBuffer;
}

/**
 * Parse a standard WAV file header
 */
export function parseWavHeader(bytes: Uint8Array): {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationSeconds: number;
} {
  if (bytes.length < 44) {
    throw new Error(
      "Invalid WAV: byte buffer shorter than standard 44-byte header",
    );
  }

  const isRiff = bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46;
  const isWave = bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45;

  if (!isRiff || !isWave) {
    throw new Error("Invalid WAV: missing RIFF/WAVE container header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 24000;
  let byteRate = 48000;
  let blockAlign = 2;
  let bitsPerSample = 16;
  let dataOffset = 44;
  let dataLength = bytes.length - 44;

  while (offset + 8 <= bytes.length) {
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const b3 = bytes[offset + 3];
    if (
      b0 === undefined ||
      b1 === undefined ||
      b2 === undefined ||
      b3 === undefined
    ) {
      break;
    }
    const chunkId = String.fromCharCode(b0, b1, b2, b3);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      byteRate = view.getUint32(offset + 16, true);
      blockAlign = view.getUint16(offset + 20, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, bytes.length - dataOffset);
      break;
    }

    offset += 8 + chunkSize;
  }

  const bytesPerSecond = byteRate > 0 ? byteRate : (sampleRate * channels * bitsPerSample) / 8;
  const durationSeconds = bytesPerSecond > 0 ? dataLength / bytesPerSecond : 0;

  return {
    audioFormat,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataOffset,
    dataLength,
    durationSeconds,
  };
}

/**
 * Inspect an MP3 byte stream for basic frame metadata and estimated duration
 */
export function inspectMp3(bytes: Uint8Array): {
  channels: number;
  sampleRate: number;
  bitrateKbps: number;
  durationSeconds: number;
} {
  let offset = 0;

  // Skip ID3v2 if present
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    // ID3 synchsafe size at bytes 6..9
    const b6 = bytes[6] ?? 0;
    const b7 = bytes[7] ?? 0;
    const b8 = bytes[8] ?? 0;
    const b9 = bytes[9] ?? 0;
    const id3Size = ((b6 & 0x7f) << 21) |
      ((b7 & 0x7f) << 14) |
      ((b8 & 0x7f) << 7) |
      (b9 & 0x7f);
    offset = 10 + id3Size;
  }

  // Scan for first MPEG frame sync (11 bits set: 0xFF followed by byte with top 3 bits set)
  while (offset + 4 < bytes.length) {
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];
    if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) {
      break;
    }
    offset++;
  }

  let sampleRate = 44100;
  let channels = 2;
  let bitrateKbps = 128;

  if (offset + 4 <= bytes.length) {
    const b1 = bytes[offset + 1] ?? 0;
    const b2 = bytes[offset + 2] ?? 0;
    const b3 = bytes[offset + 3] ?? 0;

    const versionBits = (b1 >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const _layerBits = (b1 >> 1) & 0x03; // 1 = Layer III
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const sampleRateIdx = (b2 >> 2) & 0x03;
    const channelMode = (b3 >> 6) & 0x03;

    channels = channelMode === 3 ? 1 : 2;

    const sampleRateTable = [44100, 48000, 32000];
    const foundSampleRate = sampleRateTable[sampleRateIdx];
    if (foundSampleRate !== undefined) {
      sampleRate = foundSampleRate;
      if (versionBits === 2) sampleRate /= 2; // MPEG-2
      else if (versionBits === 0) sampleRate /= 4; // MPEG-2.5
    }

    // MPEG-1 Layer III bitrates (kbps)
    const bitrateTable = [
      0,
      32,
      40,
      48,
      56,
      64,
      80,
      96,
      112,
      128,
      160,
      192,
      224,
      256,
      320,
      0,
    ];
    const foundBitrate = bitrateTable[bitrateIdx];
    if (foundBitrate !== undefined && foundBitrate > 0) {
      bitrateKbps = foundBitrate;
    }
  }

  const audioBytes = Math.max(0, bytes.length - offset);
  const bytesPerSecond = (bitrateKbps * 1000) / 8;
  const durationSeconds = bytesPerSecond > 0 ? audioBytes / bytesPerSecond : 0;

  return {
    channels,
    sampleRate,
    bitrateKbps,
    durationSeconds,
  };
}

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

/**
 * Format a Date or date string to a clear spoken English format (e.g. "September 24, 2026")
 */
export function formatSpokenDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) {
    return typeof date === "string" ? date : "";
  }
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Build the Stratechery / Ben Thompson style spoken introduction (audio-feed-tov).
 *
 * First words are the title, followed by publish date, author, and real metadata.
 * Awkward boilerplate ("The following is...") is removed.
 *
 * PROMPT-CENSUS:TRANSCRIPT-ONLY — the interpolated literals here carry publisher data
 * to be SPOKEN and no instruction region, so this builder is declared (not fenced):
 * see scripts/prompt-census.ts and tests/prompt_census_test.ts.
 */
export function formatNarrationIntro(input: NarrationInput): string {
  if (input.customIntro) {
    return input.customIntro.trim();
  }

  const parts: string[] = [];
  const title = input.title.trim();
  const author = input.author?.trim();
  const dateStr = input.publishedAt ? formatSpokenDate(input.publishedAt) : "";
  const source = input.sourceName?.trim();

  let intro = title;
  if (dateStr && author) {
    intro += `. Published on ${dateStr}, by ${author}.`;
  } else if (dateStr) {
    intro += `. Published on ${dateStr}.`;
  } else if (author) {
    intro += `. By ${author}.`;
  } else {
    intro += `.`;
  }
  parts.push(intro);

  if (source) {
    parts.push(`From ${source}.`);
  }

  if (input.lead?.trim()) {
    parts.push(input.lead.trim());
  }

  return parts.join(" ");
}

/**
 * Format article body for TTS according to the feed's codeHandling setting (audio-feed-bdo).
 *
 * If `codeHandling === "skip"`, code blocks (```...```) are removed entirely.
 * If `codeHandling === "explain"`, an optional `codeSummarizer` is called for each block;
 * if no summarizer is provided (or if summarization fails/returns empty), it safely
 * falls back to skipping the code block, ensuring raw code is never read aloud.
 */
function decodeHtmlEntities(html: string): string {
  // audio-feed-91r: decode specific entities first, and &amp; LAST to prevent double-decoding
  // (e.g. &amp;lt; should become &lt;, NOT double-decoded to <).
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export interface CodeBlockMatch {
  index: number;
  full: string;
  code: string;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * The next run of three or more backticks, or of three or more tildes, at or after `from`.
 * `index` is the start of the run and `end` one past its last character: the regex this
 * replaces matched the run greedily (`+`), so four backticks were one four-wide fence.
 */
/**
 * Instrumentation for the scan's own complexity assertion (audio-feed-0evr, audio-feed-cf91x).
 *
 * `examined` counts the characters the scan's forward searches had to cover - the work, not the
 * elapsed time. It is deliberately a COUNT: unlike a wall-clock number it cannot be made
 * comfortable by whatever test ran before it, which is why the fence assertion no longer promises
 * a duration. Pass an object in to collect it; behaviour is unchanged when you do not.
 */
export interface ScanWork {
  examined: number;
}

/**
 * How much of `text` a forward search starting at `from` covered to reach `found`.
 * `found < 0` (no match) covers the rest of the text.
 */
function chargedDistance(
  found: number,
  from: number,
  length: number,
): number {
  return Math.max(0, (found < 0 ? length : found) - from);
}

/**
 * Which fence delimiters occur anywhere in the scanned text (audio-feed-1mowv).
 *
 * Computed once per scan and threaded down, because a delimiter absent from the whole text cannot appear at any
 * `from`: searching for it is guaranteed to miss, and the miss walks to the END of the text. Doing that on every
 * call made the fence scan quadratic - the loop calls this once per fence marker, so the scan performed O(n)
 * work O(n) times. Measured before the fix: doubling the markers cost 4.00x the examined characters at every
 * size (16k: 768,088,000; 64k: 12,288,352,000), i.e. 12,001x and 48,001x the input length.
 */
interface ScanLimits {
  ticks: DelimiterProof;
  tildes: DelimiterProof;
  hasPre: boolean;
}

/**
 * A delimiter's exhaustion proof (audio-feed-375x1).
 *
 * `provenFrom === null` means NOTHING has been proven yet, so no search may be skipped. A number means "absent at or
 * after this index". Keeping "no proof yet" as `null` instead of as a position makes the two states unrepresentable as
 * one number: the previous shape wrote `from` on EVERY `-1`, including the `-1` of a SKIPPED search, which silently
 * RAISED a proof point (weakening it) and turned every later block - matchFence re-searches from a small `infoEnd` -
 * back into a scan to EOF.
 */
interface DelimiterProof {
  provenFrom: number | null;
}

/**
 * `text.indexOf(needle, from)`, but skipping the search when a previous miss proved the needle absent at or after a
 * point <= `from`. This is the ONLY place a proof may be recorded: a skipped search returns without touching the
 * state, so a skip can never be mistaken for a new fan-out of knowledge, and a real miss may only move the proof
 * EARLIER (a miss at a smaller `from` is the stronger fact).
 */
function searchDelimiter(
  text: string,
  needle: string,
  from: number,
  proof: DelimiterProof,
): { index: number; searched: boolean } {
  if (proof.provenFrom !== null && from >= proof.provenFrom) {
    return { index: -1, searched: false };
  }
  const index = text.indexOf(needle, from);
  if (index < 0) {
    proof.provenFrom = proof.provenFrom === null ? from : Math.min(proof.provenFrom, from);
  }
  return { index, searched: true };
}

/**
 * INVARIANT (audio-feed-ewedg) - the fast path may only skip a search whose result is provably -1.
 *
 * `nextFenceRun` searches for each fence delimiter from `from`. It may substitute -1 (skip the search) only when an
 * EARLIER SEARCH - never a skipped one - proved that delimiter absent at or after a point <= `from`. `from` is not
 * monotone across callers (matchFence re-searches from an opener's end, which can be EARLIER than a search that
 * already missed), so the proof is a POINT rather than a flag, and TWO RULES keep it honest:
 *   - a proof may only move EARLIER (a miss at a smaller `from` is the stronger fact), and
 *   - a SKIPPED search records NOTHING.
 * audio-feed-375x1: the old shape wrote `from` on every -1, including the -1 of a skip, which RAISED the proof point
 * and sent every block back to scanning to EOF. "No proof yet" is now `null`, so that write cannot happen.
 * A delimiter absent from the whole text starts at point 0 (a real proof), never assumed.
 *
 * Equivalently: skipping changes only the COST of the scan, never which fence the scan classifies. The enforcement is
 * the differential test in tests/tts_test.ts - the reference regex grammar over the hand-picked shapes plus ~90
 * generated ones (nested, unterminated, absent delimiter, tilde lengths 3..7, mixed ~ and `) - so a divergence fails
 * there rather than shipping as a speed-up.
 */
function nextFenceRun(
  text: string,
  from: number,
  limits: ScanLimits,
  work?: ScanWork,
): { index: number; end: number } | null {
  // Substituting -1 for a skipped search is EXACTLY equivalent: `indexOf` returns -1 for every `from` when the
  // needle does not occur at or after that `from`. Only the cost changes.
  //
  // audio-feed-ewedg: the limit must be MONOTONE-MUTABLE, not a static fact about the whole text. When both
  // delimiters occur somewhere but one exhausts early (e.g. a single `~~~` then thousands of ``` fences), a static
  // hasTildes stayed true and every marker re-ran `indexOf("~~~", from)`, missed, and walked to the end of the text:
  // quadratic, measured at ratio 2.00 x n^2 and 8.19B characters for 64k markers. Raising the exhaustion POINT makes
  // every later marker skip, while a smaller `from` (matchFence re-searches from an opener's end) still searches.
  const ticks = searchDelimiter(text, "```", from, limits.ticks);
  const tildes = searchDelimiter(text, "~~~", from, limits.tildes);
  if (work) {
    if (ticks.searched) work.examined += chargedDistance(ticks.index, from, text.length);
    if (tildes.searched) work.examined += chargedDistance(tildes.index, from, text.length);
  }
  const index = ticks.index < 0
    ? tildes.index
    : tildes.index < 0
    ? ticks.index
    : Math.min(ticks.index, tildes.index);
  if (index < 0) return null;
  const char = text[index];
  let end = index;
  while (end < text.length && text[end] === char) end++;
  return { index, end };
}

/**
 * The next `<pre ...>` tag at or after `from`, or null. `<pre` must be followed by a
 * non-word character (`<pre\b`, so `<prefix>` is not a tag) and then by a `>`; `[^>]*`
 * cannot cross a `>`, so the first `>` after the name closes the tag.
 *
 * audio-feed-wqup (c0gj): If no `>` exists after `index + 4`, no subsequent `<pre`
 * opener can have a closing `>` either; returning null immediately prevents quadratic
 * re-scanning across unterminated `<pre` sequences.
 */
function nextPreTag(
  text: string,
  from: number,
  limits: ScanLimits,
  work?: ScanWork,
): { index: number; end: number } | null {
  // Same short-circuit as the fence runs (audio-feed-1mowv): no `<pre` anywhere means every search from every
  // `from` is a guaranteed miss that walks to the end of the text, and this is called once per loop iteration.
  if (!limits.hasPre) return null;
  let index = nextCi(PRE_OPEN, text, from);
  if (work) work.examined += chargedDistance(index, from, text.length);
  while (index >= 0) {
    const after = text[index + 4];
    if (after !== undefined && !WORD_CHAR.test(after)) {
      const close = text.indexOf(">", index + 4);
      if (work) {
        work.examined += chargedDistance(close, index + 4, text.length);
      }
      if (close < 0) return null;
      return { index, end: close + 1 };
    }
    const next = nextCi(PRE_OPEN, text, index + 1);
    if (work) work.examined += chargedDistance(next, index + 1, text.length);
    index = next;
  }
  return null;
}

/** Where the optional info string (`(?:[^\n\r]*\r?\n)?`) ends, or null when it cannot match. */
function fenceInfoEnd(
  text: string,
  openerEnd: number,
  work?: ScanWork,
): number | null {
  let lineEnd = openerEnd;
  while (
    lineEnd < text.length && text[lineEnd] !== "\n" && text[lineEnd] !== "\r"
  ) {
    lineEnd++;
  }
  if (work) work.examined += lineEnd - openerEnd;
  if (text[lineEnd] === "\n") return lineEnd + 1;
  if (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n") return lineEnd + 2;
  return null;
}

/** The next match of `re` at or after `from`, or null. Callers own `re.lastIndex`. */
function nextCi(re: RegExp, text: string, from: number): number {
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? match.index : -1;
}

const PRE_OPEN = /<pre/gi;
const CODE_OPEN = /<code/gi;
const PRE_CLOSE = /<\/pre>/gi;
const CODE_CLOSE = /<\/code>/gi;

/**
 * Match a fenced block whose opening run is `run`, or null when there is no fence to match.
 *
 * The old pattern was a fence open, an optional info line, a lazy content group, and a fence
 * close; a regex gives characters back from the RIGHT, so the order this reproduces is: the lazy
 * content expands first, then the optional info string is dropped (six backticks followed by
 * `abc` and a newline match as an EMPTY block opened by three backticks, because the info line
 * is given up rather than the opener), and only then does the greedy opener shrink. An opener
 * can only shrink to a length that leaves a three-character tail behind it, because that tail
 * is the closer - so at most four opener lengths are worth trying and this stays linear.
 */
function matchFence(
  text: string,
  run: { index: number; end: number },
  limits: ScanLimits,
  work?: ScanWork,
): CodeBlockMatch | null {
  const length = run.end - run.index;
  const shortest = Math.max(3, length - 3);
  for (let openerLength = length; openerLength >= shortest; openerLength--) {
    const openerEnd = run.index + openerLength;
    const infoEnd = fenceInfoEnd(text, openerEnd, work);
    // The info string is tried first, then dropped.
    for (
      const contentStart of infoEnd === null ? [openerEnd] : [infoEnd, openerEnd]
    ) {
      const close = nextFenceRun(text, contentStart, limits, work);
      if (close) {
        return {
          index: run.index,
          full: text.slice(run.index, close.end),
          code: text.slice(contentStart, close.index).trim(),
        };
      }
    }
  }
  return null;
}

/** The end of an immediately-following `<code ...>` tag, or null when there is not one. */
function codeTagEnd(text: string, from: number): number | null {
  if (nextCi(CODE_OPEN, text, from) !== from) return null;
  const after = text[from + 5];
  if (after === undefined || WORD_CHAR.test(after)) return null;
  const close = text.indexOf(">", from + 5);
  return close < 0 ? null : close + 1;
}

/** Match a `<pre>` block whose tag is `tag`, with content starting at `contentStart`. */
function matchPreAt(
  text: string,
  tag: { index: number; end: number },
  contentStart: number,
): CodeBlockMatch | null {
  const pre = nextCi(PRE_CLOSE, text, contentStart);
  if (pre < 0) return null;
  let contentEnd = pre;
  if (
    pre - 7 >= contentStart &&
    nextCi(CODE_CLOSE, text, pre - 7) === pre - 7
  ) {
    contentEnd = pre - 7;
  }
  return {
    index: tag.index,
    full: text.slice(tag.index, pre + 6),
    code: decodeHtmlEntities(text.slice(contentStart, contentEnd)).trim(),
  };
}

/**
 * Match a `<pre>` block whose tag is `tag`, or null when no `</pre>` follows. The optional
 * `<code ...>` is itself optional in the pattern, so a tag that swallows the only `</pre>`
 * (malformed markup, as in `<pre><code no-gt here</pre>`) is retried without it - that backtrack
 * is why Markdown-ish text starting with `<code` can still be a block at all.
 */
function matchPre(
  text: string,
  tag: { index: number; end: number },
): CodeBlockMatch | null {
  const codeEnd = codeTagEnd(text, tag.end);
  if (codeEnd !== null) {
    const withCode = matchPreAt(text, tag, codeEnd);
    if (withCode) return withCode;
  }
  return matchPreAt(text, tag, tag.end);
}

/**
 * Every code block in `text`, in order (audio-feed-c0gj, audio-feed-wqup, audio-feed-t06l).
 *
 * Linear O(N) single-pass extraction matching origin/main REGEX grammar without
 * quadratic backtracking or repetitive scans.
 *
 * Pass `work` to collect the characters this scan's forward searches had to cover (audio-feed-cf91x):
 * a broken scan cannot produce a sensible count for the same input, and - unlike a duration - the
 * count does not depend on what ran before it.
 */
export function extractCodeBlocks(
  text: string,
  work?: ScanWork,
): CodeBlockMatch[] {
  // A delimiter absent from the WHOLE text starts exhausted at point 0, so every search for it is skipped
  // (audio-feed-1mowv). Otherwise the point is raised when a search from some `from` misses (audio-feed-ewedg):
  // "absent at or after X" may only skip searches whose `from` is at or after X.
  const limits: ScanLimits = {
    // A delimiter absent from the whole text is PROVEN exhausted at 0, which is a proof, so it is `0` and not `null`.
    ticks: { provenFrom: text.includes("```") ? null : 0 },
    tildes: { provenFrom: text.includes("~~~") ? null : 0 },
    hasPre: /<pre\b/i.test(text),
  };
  if (limits.ticks.provenFrom === 0 && limits.tildes.provenFrom === 0 && !limits.hasPre) {
    return [];
  }

  const blocks: CodeBlockMatch[] = [];
  let fencesExhausted = false;
  let presExhausted = false;
  let from = 0;
  while (from < text.length) {
    const fence = fencesExhausted ? null : nextFenceRun(text, from, limits, work);
    const pre = presExhausted ? null : nextPreTag(text, from, limits, work);
    // A null is MONOTONE: `from` only ever increases, so "no opener at or after here" stays true for the rest of
    // the scan. Recording that is half the complexity fix (audio-feed-1mowv): without it every remaining
    // iteration repeated a search that was guaranteed to miss, which is what made the scan quadratic.
    if (!fence) fencesExhausted = true;
    if (!pre) presExhausted = true;
    if (!fence && !pre) break;
    // The earlier start wins; the two alternatives can never begin at the same index.
    if (fence && (!pre || fence.index < pre.index)) {
      const block = matchFence(text, fence, limits, work);
      if (block) {
        blocks.push(block);
        from = block.index + block.full.length;
      } else {
        fencesExhausted = true;
      }
    } else {
      const block = matchPre(text, pre!);
      if (block) {
        blocks.push(block);
        from = block.index + block.full.length;
      } else {
        presExhausted = true;
      }
    }
  }
  return blocks;
}

export async function formatCodeForTts(
  text: string,
  codeHandling: CodeHandling = "skip",
  summarizer?: (code: string) => string | Promise<string>,
): Promise<string> {
  const matches = extractCodeBlocks(text);
  if (matches.length === 0) {
    return text;
  }

  if (codeHandling === "explain" && summarizer) {
    // audio-feed-8acp: resolve every explanation concurrently. Awaiting the summarizer
    // inside the assembly loop made N code blocks cost N sequential model round-trips.
    // The pool is bounded because each call is a model request: a long article with a
    // dozen listings must not fire a dozen at once. Each call keeps its own try/catch,
    // so one block that fails to summarise is omitted rather than failing the script.
    const explanations = await mapWithConcurrency(
      matches,
      CODE_EXPLANATION_CONCURRENCY,
      async (m) => {
        try {
          const explanation = await summarizer(m.code);
          return explanation && explanation.trim() ? explanation.trim() : null;
        } catch {
          // Fallback: omit raw code
          return null;
        }
      },
    );

    let result = "";
    let lastIndex = 0;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      result += text.slice(lastIndex, m.index);
      const explanation = explanations[i];
      if (explanation) {
        result += `\nHere is what that code does: ${explanation}\n`;
      }
      lastIndex = m.index + m.full.length;
    }
    result += text.slice(lastIndex);
    return result.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
  }

  // Fallback or "skip" mode: strip code blocks completely so raw code is never read aloud.
  let result = "";
  let lastIndex = 0;
  for (const m of matches) {
    result += text.slice(lastIndex, m.index);
    lastIndex = m.index + m.full.length;
  }
  result += text.slice(lastIndex);
  return result.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
}

/**
 * System instruction prompt for TTS generation (audio-feed-bdo).
 *
 * Directs the voice model on how to handle technical content and code listings.
 */
export function buildNarrationSystemPrompt(codeHandling: CodeHandling = "skip"): string {
  if (codeHandling === "explain") {
    return "You are an audio narrator. Read the text clearly and naturally. When encountering code explanations or technical listings, explain or summarize their purpose in plain words. Never read raw code, syntax tokens, punctuation, brackets, or code symbols aloud.";
  }
  return "You are an audio narrator. Read the text clearly and naturally. Skip code blocks and code listings entirely. Never read raw code, syntax tokens, punctuation, brackets, or code symbols aloud.";
}

/**
 * Build the full prompt for single-voice narration (Stratechery style)
 *
 * PROMPT-CENSUS:TRANSCRIPT-ONLY — transcript text only, no instruction region, so the
 * narration instructions stay in buildNarrationSystemPrompt's separate, uninterpolated
 * system prompt; declared so the prompt census can pin it: see scripts/prompt-census.ts.
 */
export function formatNarrationPrompt(input: NarrationInput): string {
  const includeIntro = input.includeIntro ?? true;
  const introText = includeIntro ? formatNarrationIntro(input).trim() : "";
  const bodyText = input.body.trim();

  if (introText && bodyText) {
    return `${introText}\n\n${bodyText}`;
  }
  return introText || bodyText;
}

/**
 * What `formatDialoguePrompt` produces: the structured dialogue that actually
 * reaches the API.
 *
 * There used to be a third field, `prompt` — a ~15-line meta-instruction string
 * ("You are generating...", "Style guidelines:", "Speak with natural human
 * cadence...") that was built on every call and then discarded, because
 * `synthesizeDialogue` destructures only `turns` and `speakers` (audio-feed-9jh).
 * It is removed rather than renamed or commented, because the dialogue path was
 * only free of the audio-feed-xad defect BY ACCIDENT, and a field that looks like
 * an unused bug invites someone to "fix" it by wiring it in - which would read the
 * instructions aloud. The guard against that is now a test on the outgoing request,
 * not a comment: see "no meta-instruction reaches the dialogue API" in
 * tests/tts_test.ts.
 */
export interface FormattedDialogue {
  turns: DialogueTurn[];
  speakers: [DialogueSpeaker, DialogueSpeaker];
}

/**
 * Parse a text script with "Speaker: Text" lines into structured DialogueTurns
 */
export function parseScriptIntoTurns(
  script: string,
  speakers: [DialogueSpeaker, DialogueSpeaker],
): DialogueTurn[] {
  const lines = script.split("\n").map((l) => l.trim()).filter(Boolean);
  const turns: DialogueTurn[] = [];
  let currentSpeaker = speakers[0].name;

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && colonIdx < 30) {
      const candidateName = line.slice(0, colonIdx).trim();
      const matched = speakers.find(
        (s) => s.name.toLowerCase() === candidateName.toLowerCase(),
      );
      if (matched) {
        currentSpeaker = matched.name;
        const text = line.slice(colonIdx + 1).trim();
        if (text) {
          turns.push({ speaker: currentSpeaker, text });
          continue;
        }
      }
    }

    const lastTurn = turns[turns.length - 1];
    if (lastTurn) {
      lastTurn.text += " " + line;
    } else {
      turns.push({ speaker: currentSpeaker, text: line });
    }
  }

  return turns.length > 0 ? turns : [{ speaker: speakers[0].name, text: script }];
}

/**
 * Format a NotebookLM-style dialogue prompt between an expert and a curious foil
 *
 * PROMPT-CENSUS:TRANSCRIPT-ONLY — the article fields interpolated into the fallback
 * turns are transcript text to be spoken, never instructions; declared so the prompt
 * census can pin it: see scripts/prompt-census.ts and tests/prompt_census_test.ts.
 */
export function formatDialoguePrompt(input: DialogueInput): FormattedDialogue {
  const speakers: [DialogueSpeaker, DialogueSpeaker] = input.speakers ?? [
    { name: "Alex", role: "expert", voice: DEFAULT_EXPERT_VOICE },
    { name: "Sam", role: "curious_foil", voice: DEFAULT_FOIL_VOICE },
  ];

  const expert = speakers.find((s) => s.role === "expert") ?? speakers[0];
  const foil = speakers.find((s) => s.role === "curious_foil" || s.role === "host") ??
    speakers[1];

  let turns: DialogueTurn[] = [];

  if (input.turns && input.turns.length > 0) {
    turns = [...input.turns];
  } else if (input.script?.trim()) {
    turns = parseScriptIntoTurns(input.script, speakers);
  } else if (input.article) {
    // Generate conversational script framing based on the article
    const art = input.article;
    const authorLine = art.author ? ` written by ${art.author}` : "";
    turns = [
      {
        speaker: foil.name,
        text:
          `Welcome back to the deep dive! Today we're digging into "${art.title}"${authorLine}. ${expert.name}, this looks like a fascinating read. What's the core thesis here?`,
      },
      {
        speaker: expert.name,
        text:
          `Thanks ${foil.name}. At its heart, this piece is about the practical realities and strategic shifts taking place. Let's start with the central argument: ${
            art.summary || art.body.slice(0, 400)
          }...`,
      },
      {
        speaker: foil.name,
        text:
          `That's a bold claim. How does the author back that up, and what are the trade-offs people usually miss?`,
      },
      {
        speaker: expert.name,
        text: `Here is where it gets really interesting: ${art.body.slice(400, 1600)}...`,
      },
      {
        speaker: foil.name,
        text:
          `Makes total sense when you frame it that way. What should listeners take away from this?`,
      },
      {
        speaker: expert.name,
        text:
          `The big takeaway is that execution and architectural simplicity beat premature abstraction every single time.`,
      },
    ];
  } else {
    throw new Error(
      "DialogueInput must provide either turns, script, or an article",
    );
  }

  return {
    turns,
    speakers,
  };
}

// ---------------------------------------------------------------------------
// Request Builders
// ---------------------------------------------------------------------------

export const DEFAULT_NARRATION_STYLE = "natural, engaging narration";

/**
 * Build Gemini GenerateContent request for single-voice narration.
 * Gemini TTS treats parts[].text strictly as a verbatim transcript to be read aloud.
 * Sustained acting, tone, and style instructions belong in speech_metadata.style,
 * never in parts.text (audio-feed-bjt).
 */
export function buildSingleVoiceRequest(
  prompt: string,
  voice: GeminiTtsVoice | string = DEFAULT_NARRATION_VOICE,
  temperature = 0.7,
  style: string = DEFAULT_NARRATION_STYLE,
): GeminiGenerateContentRequest {
  const speechMetadata: SpeechMetadata = { style };
  const part: ContentPart = {
    text: prompt,
    speech_metadata: speechMetadata,
    speechMetadata,
  };

  return {
    contents: [
      {
        parts: [part],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
      temperature,
      maxOutputTokens: MAX_TTS_OUTPUT_TOKENS,
    },
  };
}

/**
 * Build Gemini GenerateContent request for two-voice dialogue.
 * Attaches speech_metadata.speaker to each part in contents as required by Gemini 3.8 Flash TTS.
 * In multi-speaker requests, 100% of parts must specify speech_metadata.speaker matching
 * declared speakerVoiceConfigs (audio-feed-9pc).
 */
export function buildDialogueRequest(
  turnsOrScript: DialogueTurn[] | string,
  speakers: [DialogueSpeaker, DialogueSpeaker],
  temperature = 0.8,
): GeminiGenerateContentRequest {
  const turns = Array.isArray(turnsOrScript)
    ? turnsOrScript
    : parseScriptIntoTurns(turnsOrScript, speakers);

  const parts: ContentPart[] = [];
  for (const turn of turns) {
    parts.push({
      text: turn.text,
      speech_metadata: {
        speaker: turn.speaker,
      },
      speechMetadata: {
        speaker: turn.speaker,
      },
    });
  }

  return {
    contents: [
      {
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            {
              speaker: speakers[0].name,
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: speakers[0].voice,
                },
              },
            },
            {
              speaker: speakers[1].name,
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: speakers[1].voice,
                },
              },
            },
          ],
        },
      },
      temperature,
      maxOutputTokens: MAX_TTS_OUTPUT_TOKENS,
    },
  };
}

/** Backward-compatible TTS budget wrapper around the shared synthesis chunker. */
export function splitTtsText(text: string, maxBytes = MAX_TTS_INPUT_BYTES): string[] {
  return splitTextUnderByteBudget(text, maxBytes);
}

/** Each request yields a self-contained audio file; concatenate only compatible PCM payloads. */
/**
 * Rebuild a DecodedAudioResult from stored WAV bytes (audio-feed-wr1u resume path).
 *
 * Only segments that already passed joinTtsAudio's truncation rejection in their original
 * run are ever stored, so a stored segment is complete by construction; saying STOP here is
 * a statement about the record, not a hope about the model.
 */
export function decodedFromWav(bytes: Uint8Array): DecodedAudioResult {
  const info = parseWavHeader(bytes);
  if (info.audioFormat !== 1 || info.dataLength <= 0) {
    throw new GeminiTtsError("Stored synthesis segment WAV is not valid PCM audio", 400);
  }
  return {
    rawBytes: bytes,
    mimeType: "audio/wav",
    format: "wav",
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitsPerSample: info.bitsPerSample,
    durationSeconds: info.durationSeconds,
    finishReason: "STOP",
    truncated: false,
    toWav: () => bytes,
  };
}

export function joinTtsAudio(
  chunks: readonly DecodedAudioResult[],
  allowTruncated = false,
): DecodedAudioResult {
  if (chunks.length === 0) throw new GeminiTtsError("Narration contained no spoken text", 400);
  if (chunks.length === 1) return chunks[0]!;
  const first = chunks[0]!;
  const pcm = chunks.map((chunk) => {
    if (
      chunk.sampleRate !== first.sampleRate || chunk.channels !== first.channels ||
      chunk.bitsPerSample !== first.bitsPerSample ||
      (chunk.format !== "wav" && chunk.format !== "pcm")
    ) {
      throw new GeminiTtsError("TTS segments returned incompatible or incomplete audio");
    }
    if (chunk.truncated && !allowTruncated) {
      throw new GeminiTtsError("TTS segment returned incomplete audio");
    }
    if (chunk.format === "pcm") return chunk.rawBytes;
    const info = parseWavHeader(chunk.rawBytes);
    if (info.audioFormat !== 1 || info.dataLength <= 0) {
      throw new GeminiTtsError("TTS segment WAV is not valid PCM audio");
    }
    return chunk.rawBytes.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  });
  // audio-feed-sp38: allocate a single buffer for the WAV file (44-byte header + PCM)
  // and construct rawBytes as a subarray at offset 44. This eliminates duplicate memory
  // allocations and extra full-buffer copies during multi-segment audio stitching.
  const totalPcmLength = pcm.reduce((total, bytes) => total + bytes.length, 0);
  const wavBuffer = new Uint8Array(44 + totalPcmLength);
  writeWavHeader(wavBuffer, totalPcmLength, {
    sampleRate: first.sampleRate,
    numChannels: first.channels,
    bitsPerSample: first.bitsPerSample,
  });
  let offset = 44;
  for (const bytes of pcm) {
    wavBuffer.set(bytes, offset);
    offset += bytes.length;
  }
  const rawBytes = wavBuffer.subarray(44);
  return {
    rawBytes,
    mimeType: `audio/pcm;rate=${first.sampleRate}`,
    format: "pcm",
    sampleRate: first.sampleRate,
    channels: first.channels,
    bitsPerSample: first.bitsPerSample,
    durationSeconds: totalPcmLength /
      (first.sampleRate * first.channels * first.bitsPerSample / 8),
    finishReason: chunks.some((chunk) => chunk.truncated) ? "MAX_TOKENS" : "STOP",
    truncated: chunks.some((chunk) => chunk.truncated),
    toWav: () => wavBuffer,
  };
}

// ---------------------------------------------------------------------------
// Response Decoder
// ---------------------------------------------------------------------------

/**
 * Decode a raw Gemini API JSON response and return DecodedAudioResult
 */
export function decodeAudioResponse(
  jsonResponse: unknown,
  defaultSampleRate = 24000,
  options: { allowTruncated?: boolean } = {},
): DecodedAudioResult {
  if (!jsonResponse || typeof jsonResponse !== "object") {
    throw new GeminiTtsError(
      "Invalid response: expected JSON object from Gemini API",
    );
  }

  const res = jsonResponse as Record<string, unknown>;

  if (res.error) {
    const err = res.error as Record<string, unknown>;
    throw new GeminiTtsError(
      typeof err.message === "string" ? err.message : "Gemini API returned an error",
      typeof err.code === "number" ? err.code : 500,
      err,
    );
  }

  const candidates = res.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  if (!candidates || candidates.length === 0) {
    throw new GeminiTtsError("Gemini API response contained no candidates");
  }

  const firstCandidate = candidates[0];
  if (!firstCandidate) {
    throw new GeminiTtsError(
      "Gemini API response contained no valid candidates",
    );
  }

  const finishReason = firstCandidate.finishReason as string | undefined;
  const incomplete = Boolean(
    finishReason && finishReason !== "STOP" &&
      finishReason !== "FINISH_REASON_UNSPECIFIED",
  );
  if (incomplete && finishReason === "SAFETY") {
    throw new GeminiTtsError(
      "Gemini audio generation blocked by SAFETY filter",
    );
  }

  const content = firstCandidate.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  if (!parts || parts.length === 0) {
    throw new GeminiTtsError("Gemini API candidate contained no content parts");
  }

  // Find inline audio part
  let base64Data: string | undefined;
  let mimeType = "audio/pcm;rate=24000";

  for (const part of parts) {
    const inline = (part.inlineData ?? part.inline_data) as
      | { mimeType?: string; mime_type?: string; data?: string }
      | undefined;
    if (inline?.data) {
      base64Data = inline.data;
      mimeType = inline.mimeType ?? inline.mime_type ?? mimeType;
      break;
    }
  }

  if (!base64Data) {
    throw new GeminiTtsError(
      "No inline audio data found in Gemini API candidate parts",
    );
  }

  const rawBytes = base64ToUint8Array(base64Data);
  const format = detectAudioFormat(rawBytes, mimeType);

  let sampleRate = defaultSampleRate;
  let channels = 1;
  let bitsPerSample = 16;
  let durationSeconds = 0;

  // Extract sample rate hint from mimeType if present e.g. "audio/pcm;rate=24000"
  const rateMatch = mimeType.match(/rate=(\d+)/i);
  if (rateMatch && rateMatch[1]) {
    sampleRate = parseInt(rateMatch[1], 10);
  }

  if (format === "wav") {
    try {
      const wavInfo = parseWavHeader(rawBytes);
      sampleRate = wavInfo.sampleRate;
      channels = wavInfo.channels;
      bitsPerSample = wavInfo.bitsPerSample;
      durationSeconds = wavInfo.durationSeconds;
    } catch {
      // Fallback calculation if custom wav header
      const bytesPerSec = (sampleRate * channels * bitsPerSample) / 8;
      durationSeconds = bytesPerSec > 0 ? (rawBytes.length - 44) / bytesPerSec : 0;
    }
  } else if (format === "mp3") {
    const mp3Info = inspectMp3(rawBytes);
    sampleRate = mp3Info.sampleRate;
    channels = mp3Info.channels;
    bitsPerSample = 16;
    durationSeconds = mp3Info.durationSeconds;
  } else {
    // Raw PCM (usually 24kHz, 16-bit mono)
    const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
    durationSeconds = bytesPerSecond > 0 ? rawBytes.length / bytesPerSecond : 0;
  }

  const result: DecodedAudioResult = {
    rawBytes,
    mimeType,
    format,
    sampleRate,
    channels,
    bitsPerSample,
    durationSeconds,
    finishReason,
    truncated: incomplete,
    toWav(): Uint8Array {
      if (format === "wav") {
        return rawBytes;
      }
      return pcmToWav(rawBytes, {
        sampleRate,
        numChannels: channels,
        bitsPerSample,
      });
    },
  };

  // Fail closed on incomplete audio: a truncated read is not a finished episode, and returning it
  // as a normal success is how a half-episode gets published (web-ai... audio-feed-e6l).
  if (incomplete && !options.allowTruncated) {
    throw new GeminiTtsTruncatedError(finishReason!, result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main Gemini TTS Client
// ---------------------------------------------------------------------------

export class GeminiTtsClient {
  private apiKey: string;
  private model: string;
  public readonly baseUrl: string;
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private maxRetries: number;
  private timeoutRetries: number;
  private retryOn: RetryPolicy;
  private retryBaseDelayMs: number;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(config: GeminiTtsClientConfig = {}) {
    let envKey: string | undefined;
    if (config.apiKey === undefined) {
      try {
        if (
          typeof Deno !== "undefined" && typeof Deno.env?.get === "function"
        ) {
          envKey = Deno.env.get("GEMINI_API_KEY");
        }
      } catch {
        // Permission denied or environment access restricted
      }
    }

    this.apiKey = config.apiKey || envKey || "";
    this.model = config.model || DEFAULT_TTS_MODEL;
    this.baseUrl = config.baseUrl
      ? getGeminiApiBaseUrl(config.baseUrl)
      : getGeminiApiBaseUrl(undefined, config.env);
    this.fetchFn = config.fetchFn || fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutRetries = config.timeoutRetries ?? DEFAULT_TIMEOUT_RETRIES;
    this.retryOn = config.retryOn ?? "transient";
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 250;
    this.sleepFn = config.sleepFn ?? sleep;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Synthesize a single-voice article narration (Stratechery / Ben Thompson style)
   */
  async synthesizeNarration(
    input: NarrationInput,
    options: SynthesisOptions = {},
  ): Promise<DecodedAudioResult> {
    const voice = input.voice || DEFAULT_NARRATION_VOICE;
    const codeHandling = input.codeHandling ?? "skip";
    const processedBody = await formatCodeForTts(input.body, codeHandling, input.codeSummarizer);
    const prompt = formatNarrationPrompt({ ...input, body: processedBody });
    const style = input.style ?? DEFAULT_NARRATION_STYLE;
    const segments = splitTextUnderByteBudget(prompt, MAX_TTS_INPUT_BYTES);
    if (segments.length === 0) throw new GeminiTtsError("Narration contained no spoken text", 400);
    if (segments.length > MAX_TTS_SEGMENTS) {
      throw new GeminiTtsError(
        `Narration needs ${segments.length} TTS segments (limit ${MAX_TTS_SEGMENTS})`,
        400,
      );
    }
    assertTextSeams(prompt, segments);
    try {
      return await runManagedTurns({
        segments,
        maxTurns: MAX_TTS_SEGMENTS,
        request: async (segment) => {
          const prepared = options.resume
            ? await options.resume.prepare(segment, voice)
            : "synthesize";
          if (prepared === "held") {
            throw new GeminiTtsError(
              "Synthesis segment is reserved by another live claimant; refusing double spend",
              409,
            );
          }
          if (prepared !== "synthesize") return decodedFromWav(prepared.wav);
          const decoded = await this.sendRequest(
            buildSingleVoiceRequest(segment, voice, options.temperature, style),
            segments.length > 1 ? { ...options, maxRetries: options.maxRetries ?? 0 } : options,
          );
          // A truncated segment must never be persisted as resumable: decodedFromWav would
          // serve it later as STOP-complete. Only complete audio becomes resume material.
          // The stage signal rides along so the segment put is abortable (audio-feed-y9kk).
          if (!decoded.truncated) {
            await options.resume?.commit(segment, decoded, voice, options.signal);
          }
          return decoded;
        },
        splitOnOutputLimit: (segment, error) => {
          if (
            !(error instanceof GeminiTtsTruncatedError) || error.finishReason !== "MAX_TOKENS" ||
            new TextEncoder().encode(segment).length < 8
          ) return null;
          const halves = splitTextUnderByteBudget(
            segment,
            Math.floor(new TextEncoder().encode(segment).length / 2),
          );
          assertTextSeams(segment, halves);
          return halves;
        },
        stitch: (audio) => {
          assertTextSeams(prompt, segments);
          return joinTtsAudio(audio, options.allowTruncated);
        },
        onProgress: options.onProgress,
        shouldYield: options.shouldYield,
      });
    } catch (error) {
      if (options.signal?.aborted || error instanceof SynthesisYieldError) throw error;
      throw wrapTurnFailure(error);
    }
  }

  /**
   * Synthesize a two-voice dialogue deep dive (NotebookLM style)
   */
  async synthesizeDialogue(
    input: DialogueInput,
    options: SynthesisOptions = {},
  ): Promise<DecodedAudioResult> {
    const codeHandling = input.codeHandling ?? "skip";
    let formattedInput = input;
    if (input.article) {
      const processedBody = await formatCodeForTts(
        input.article.body,
        codeHandling,
        input.codeSummarizer,
      );
      formattedInput = {
        ...input,
        article: { ...input.article, body: processedBody },
      };
    }
    const { turns, speakers } = formatDialoguePrompt(formattedInput);
    const batches: DialogueTurn[][] = [];
    let batch: DialogueTurn[] = [];
    let bytes = 0;
    const encoder = new TextEncoder();
    for (const turn of turns) {
      for (const text of splitTextUnderByteBudget(turn.text, MAX_TTS_INPUT_BYTES)) {
        const size = encoder.encode(text).length;
        if (batch.length && bytes + size > MAX_TTS_INPUT_BYTES) {
          batches.push(batch);
          batch = [];
          bytes = 0;
        }
        batch.push({ ...turn, text });
        bytes += size;
      }
    }
    if (batch.length) batches.push(batch);
    if (batches.length > MAX_TTS_SEGMENTS) {
      throw new GeminiTtsError(
        `Dialogue needs ${batches.length} TTS segments (limit ${MAX_TTS_SEGMENTS})`,
        400,
      );
    }
    if (batches.length === 0) throw new GeminiTtsError("Dialogue contained no spoken text", 400);
    const sourceText = turns.map((turn) => turn.text).join("");
    const batchText = () => batches.flatMap((part) => part.map((turn) => turn.text));
    assertTextSeams(sourceText, batchText());
    try {
      return await runManagedTurns({
        segments: batches,
        maxTurns: MAX_TTS_SEGMENTS,
        request: async (part) => {
          // Attribution is part of the identity: the same sentences spoken by swapped
          // speakers are different audio, and must not reuse each other's segments.
          const segmentText = part.map((turn) => `${turn.speaker}\u0001${turn.text}`).join(
            "\u0000",
          );
          const dialogueVoice = speakers.map((speaker) => speaker.voice).join(",");
          const prepared = options.resume
            ? await options.resume.prepare(segmentText, dialogueVoice)
            : "synthesize";
          if (prepared === "held") {
            throw new GeminiTtsError(
              "Synthesis segment is reserved by another live claimant; refusing double spend",
              409,
            );
          }
          if (prepared !== "synthesize") return decodedFromWav(prepared.wav);
          const decoded = await this.sendRequest(
            buildDialogueRequest(part, speakers, options.temperature),
            batches.length > 1 ? { ...options, maxRetries: options.maxRetries ?? 0 } : options,
          );
          if (!decoded.truncated) {
            // The stage signal rides along so the segment put is abortable (audio-feed-y9kk).
            await options.resume?.commit(segmentText, decoded, dialogueVoice, options.signal);
          }
          return decoded;
        },
        stitch: (audio) => {
          assertTextSeams(sourceText, batchText());
          return joinTtsAudio(audio, options.allowTruncated);
        },
        onProgress: options.onProgress,
        shouldYield: options.shouldYield,
      });
    } catch (error) {
      if (options.signal?.aborted || error instanceof SynthesisYieldError) throw error;
      throw wrapTurnFailure(error);
    }
  }

  /**
   * Send a prepared GenerateContent request to the Gemini API and decode the audio
   */
  async sendRequest(
    request: GeminiGenerateContentRequest,
    options: SynthesisOptions = {},
  ): Promise<DecodedAudioResult> {
    const model = options.model || this.model;
    const apiKey = this.apiKey;

    if (!apiKey) {
      throw new GeminiTtsError(
        "GEMINI_API_KEY is not configured. Set the environment variable or pass apiKey to GeminiTtsClient.",
      );
    }

    // Do not pass API key in query params; send via x-goog-api-key header only
    const url = `${this.baseUrl}/models/${model}:generateContent`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    };

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const retryOn = options.retryOn ?? this.retryOn;
    // audio-feed-9yu8: each failure class carries its own retry budget. A deadline abort must not
    // consume the status-retry budget, because multi-segment episodes force `maxRetries: 0` per
    // segment and would otherwise make one slow segment terminal.
    const maxStatusRetries = Math.max(0, maxRetries);
    const maxTimeoutRetries = retryOn === "none"
      ? 0
      : Math.max(0, options.timeoutRetries ?? this.timeoutRetries);
    let statusRetries = 0;
    let timeoutRetries = 0;

    let lastError: unknown;
    while (true) {
      // Attempt number is only there to scale backoff, so a refused retry must leave it alone.
      const attempt = 1 + statusRetries + timeoutRetries;
      // audio-feed-0cmu: a CLEARABLE deadline, disposed when this attempt ends. `AbortSignal.any`
      // is deliberately not used here: once that composite aborts it re-refs the caller's lease
      // timer and holds the event loop long after the work is done. `using` disposes on every exit
      // from this block, including both retry paths.
      using deadline = attemptDeadline(timeoutMs, options.signal);
      // The caller's signal (if any) still wins; the timeout is the floor, never a replacement for it.
      const signal = deadline.signal;

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error; // caller cancelled: never retry
        // audio-feed-bp6r: attribute the abort to the per-attempt deadline whenever the
        // CALLER's signal did not fire. The old `!options.signal` guard mislabelled every
        // production timeout — the worker always passes a lease signal, so Paul's UI showed
        // the raw "The operation was aborted due to timeout" with no timeout value attached.
        const timedOut = deadline.timedOut() && !options.signal?.aborted;
        lastError = timedOut
          ? new GeminiTtsError(
            `Gemini TTS request timed out after ${timeoutMs}ms`,
            undefined,
            error,
          )
          : error;
        if (timedOut && timeoutRetries < maxTimeoutRetries) {
          timeoutRetries++;
          await this.sleepFn(backoffMs(attempt, this.retryBaseDelayMs, null));
          continue;
        }
        // Other network failures stay opt-in (`retryOn: "all"`) — a retry may double-charge.
        if (!timedOut && retryOn === "all" && statusRetries < maxStatusRetries) {
          statusRetries++;
          await this.sleepFn(backoffMs(attempt, this.retryBaseDelayMs, null));
          continue;
        }
        throw lastError;
      }

      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch (error) {
          // The deadline can fire while the multi-MB base64 body is still streaming —
          // that was the 2026-10-09 incident path (audio-feed-bp6r): 200 headers at
          // 59.8s, then the abort killed the body read. Name it with the deadline that
          // fired, unless the caller's own signal did.
          if (options.signal?.aborted) throw error;
          if (deadline.timedOut()) {
            lastError = new GeminiTtsError(
              `Gemini TTS request timed out after ${timeoutMs}ms while reading the response body`,
              undefined,
              error,
            );
            // Same budget as the fetch-stage deadline: the incident took THIS path, and a
            // never-retried body read is why one slow segment ended the episode.
            if (timeoutRetries < maxTimeoutRetries) {
              timeoutRetries++;
              await this.sleepFn(backoffMs(attempt, this.retryBaseDelayMs, null));
              continue;
            }
            throw lastError;
          }
          throw error;
        }
        return decodeAudioResponse(json, undefined, {
          allowTruncated: options.allowTruncated,
        });
      }

      let errDetails: unknown;
      let errMsg = `Gemini API HTTP error ${res.status}: ${res.statusText}`;
      try {
        errDetails = await res.json();
        if (
          errDetails &&
          typeof errDetails === "object" &&
          "error" in errDetails
        ) {
          const apiErr = (errDetails as { error: { message?: string } }).error;
          if (apiErr?.message) {
            errMsg = `Gemini API error: ${apiErr.message}`;
          }
        }
      } catch (error) {
        // Mirror the ok branch (audio-feed-icl4): the deadline can fire while the error body is
        // still streaming, and a bare swallow made our own bound look like an ordinary provider
        // rejection with an empty body — the exact class of incompleteness Paul reported. The
        // classification is deliberately untouched: this response still came from the provider, so
        // res.status decides (and `details` stays the non-Error { statusText } stand-in below).
        if (options.signal?.aborted) throw error; // a lease expiry is not a provider error
        if (deadline.timedOut()) {
          errMsg +=
            ` (Gemini TTS request timed out after ${timeoutMs}ms while reading the error response body)`;
        }
        // Otherwise use the default statusText.
      }

      const inputBytes = request.contents.reduce(
        (total, content) =>
          total +
          content.parts.reduce((sum, part) => sum + new TextEncoder().encode(part.text).length, 0),
        0,
      );
      lastError = new GeminiTtsError(
        `${errMsg} [model=${model}, inputBytes=${inputBytes}, estimatedInputTokens<=${inputBytes} (UTF-8-byte bound), ` +
          `maxOutputTokens=${request.generationConfig.maxOutputTokens ?? "unset"}]`,
        res.status,
        // audio-feed-bp6r: details must ALWAYS be a non-Error object here —
        // describeSynthesisFailure reads that shape as "this status came from a real
        // API response". An unparseable body (proxy/gateway 5xx, HTML error page)
        // still came from the provider, so stand in with the status text rather
        // than leaving details undefined and losing the provider-status label.
        errDetails ?? { statusText: res.statusText },
      );
      const retryable = retryOn !== "none" && statusRetries < maxStatusRetries &&
        (TRANSIENT_STATUSES.has(res.status) ||
          (retryOn === "all" && res.status >= 500));
      if (!retryable) throw lastError;
      statusRetries++;
      await this.sleepFn(
        backoffMs(attempt, this.retryBaseDelayMs, res.headers.get("retry-after")),
      );
    }
  }
}
