/**
 * audio-feed-fipl / audio-feed-kx2m: did a live synthesis call actually return usable speech?
 *
 * WHY THIS EXISTS, TWICE CORRECTED, AND THE SECOND CORRECTION IS THE LESSON.
 *
 * The two live TTS controls used to assert a POSITIVE provider refusal (`finishReason === "OTHER"`
 * with no audio). The provider stopped refusing (audio-feed-zrx9), so the claim was narrowed - and
 * the first narrowing asserted the refusal's ABSENCE, which is also true when there was no usable
 * response at all (audio-feed-fipl: a 500, `candidates: []` and a malformed body all read as "not
 * refused"). A negative assertion therefore needs positive evidence that the observation completed.
 *
 * The first positive version then invented its own notion of that evidence - `audioBase64Length > 0`
 * - and a payload that cannot be decoded has a length (audio-feed-kx2m: `data: "%%%%"` on a 200 with
 * `finishReason: STOP` passed while the application's own decoder threw). Every term this helper
 * invents for itself is a place where the proof and the product can disagree, so the audio term is
 * now not a proxy at all: it is the APPLICATION'S OWN DECODER's verdict on the response that was
 * actually observed.
 *
 * THE INVARIANT, IN ONE SENTENCE: the provider answered HTTP 200, named a candidate that completed,
 * and production's decodeAudioResponse accepted that very response and handed back audio for it.
 */

import { decodeAudioResponse } from "../src/tts/gemini.ts";

export interface SynthesisObservation {
  status: number;
  candidateCount: number;
  finishReason?: string;
  /**
   * What the application's decoder did with THIS response body:
   * "accepted" (it returned), "rejected" (it threw), "not-attempted" (no candidate to decode).
   */
  decoder: "accepted" | "rejected" | "not-attempted";
  /** Audio the application's decoder returned once it accepted; 0 when it did not accept. */
  decodedBytes: number;
}

/**
 * Extract what the response actually showed, by asking production's decoder what it makes of it.
 * Nothing here decides usability: this is observation only.
 */
export function observeSynthesis(status: number, body: unknown): SynthesisObservation {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const candidates = Array.isArray(record.candidates)
    ? record.candidates as Array<Record<string, unknown>>
    : [];
  const candidate = candidates[0];
  const finishReason = typeof candidate?.finishReason === "string"
    ? candidate.finishReason
    : undefined;

  let decoder: SynthesisObservation["decoder"] = "not-attempted";
  let decodedBytes = 0;
  if (candidates.length > 0) {
    try {
      decodedBytes = decodeAudioResponse(body).rawBytes.length;
      decoder = "accepted";
    } catch {
      decodedBytes = 0;
      decoder = "rejected";
    }
  }

  return { status, candidateCount: candidates.length, finishReason, decoder, decodedBytes };
}

/** True only when the call returned speech the APPLICATION could use - see the invariant above. */
export function usableSynthesis(observation: SynthesisObservation): boolean {
  return observation.status === 200 &&
    observation.candidateCount >= 1 &&
    observation.finishReason === "STOP" &&
    observation.decoder === "accepted" &&
    observation.decodedBytes > 0;
}

/** The observation as one line, so a failing check prints what it actually saw rather than "false". */
export function describeSynthesis(observation: SynthesisObservation): string {
  return `status=${observation.status}, candidates=${observation.candidateCount}, ` +
    `finishReason=${observation.finishReason}, decoder=${observation.decoder}, ` +
    `decodedBytes=${observation.decodedBytes}`;
}

/**
 * The same invariant for a call that already went through the production client: the client must
 * have RETURNED audio and a complete finish reason, not merely "not thrown a refusal error".
 */
export function usableDecoded(
  result: { rawBytes: Uint8Array; finishReason?: string } | null | undefined,
): boolean {
  return Boolean(result) && result!.rawBytes.length > 0 && result!.finishReason === "STOP";
}
