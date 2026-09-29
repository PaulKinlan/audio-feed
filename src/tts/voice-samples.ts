/**
 * Voice audition samples (audio-feed-msw).
 *
 * Five short clips, one per Gemini TTS voice, so a person can HEAR a voice from
 * the account page before choosing it as their read-aloud narrator. They are
 * generated on demand and cached in the blob store: this project keeps no binary
 * in the repo (the icon is inline SVG behind its own route), and five committed
 * clips would be ~1 MB of opaque bytes that can never be regenerated from the
 * description of what they say.
 *
 * Three properties matter, and each one is a test rather than a comment:
 *   · the voice name is checked against the allowlist before anything is read,
 *     generated or spent — it never becomes part of a key built from user input;
 *   · a cache hit costs no API call, and two CONCURRENT misses cost one synthesis,
 *     because five audition buttons invite a five-click burst;
 *   · the text is fixed, so the five clips compare voices rather than scripts.
 */
import {
  type DecodedAudioResult,
  GEMINI_TTS_VOICES,
  type GeminiTtsVoice,
  type NarrationInput,
} from "./gemini.ts";

/**
 * Bump when the sample text or the synthesis path changes. The key carries the
 * version, so clips generated from older text are never served as if they were
 * this text, and the cache needs no invalidation sweep.
 */
export const VOICE_SAMPLE_VERSION = "v1";

export const VOICE_SAMPLE_CONTENT_TYPE = "audio/wav";

/**
 * Roughly four seconds. `includeIntro: false` keeps the clip to this line, and the
 * line deliberately does NOT name the voice: a model that stumbles over its own
 * name is a bad first impression of the voice, and the name is already on the card.
 */
export const VOICE_SAMPLE_TEXT =
  "Here is how your read-aloud voice sounds. Save this one and every article will sound like this.";

/** Not narrated (`includeIntro` is off); it only keeps the request shape honest. */
const VOICE_SAMPLE_TITLE = "Voice sample";

export const voiceSampleKey = (voice: GeminiTtsVoice): string =>
  `voice-samples/${VOICE_SAMPLE_VERSION}/${voice}.wav`;

export const isVoiceSampleName = (name: string): name is GeminiTtsVoice =>
  (GEMINI_TTS_VOICES as readonly string[]).includes(name);

/**
 * The seam a test injects. The real `GeminiTtsClient` satisfies it structurally,
 * and `DecodedAudioResult` keeps the conversion in one place: whatever the API
 * returned, `sampleBytes` is what every caller stores and serves.
 */
export interface VoiceSampleClient {
  synthesizeNarration(input: NarrationInput): Promise<DecodedAudioResult>;
}

/** A refusal that carries the status the route should answer with. */
export class VoiceSampleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "VoiceSampleError";
  }
}

/**
 * One voice, one very short narration, WAV. The worker's derivation is reused
 * exactly (`format === "wav" ? rawBytes : toWav()`) so a sample is the same kind of
 * file an episode is — the browser needs no second playback path.
 */
export async function synthesizeVoiceSample(
  client: VoiceSampleClient,
  voice: GeminiTtsVoice,
): Promise<Uint8Array> {
  let result: DecodedAudioResult;
  try {
    result = await client.synthesizeNarration({
      title: VOICE_SAMPLE_TITLE,
      body: VOICE_SAMPLE_TEXT,
      voice,
      includeIntro: false,
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? error ?? "synthesis failed");
    throw new VoiceSampleError(502, `Sample synthesis failed: ${message}`);
  }
  const bytes = result.format === "wav" ? result.rawBytes : result.toWav();
  if (!bytes || bytes.length === 0) {
    throw new VoiceSampleError(502, "Sample synthesis returned no audio.");
  }
  return bytes;
}
