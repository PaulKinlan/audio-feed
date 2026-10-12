/**
 * audio-feed-fipl: did a live synthesis call actually return usable speech?
 *
 * WHY THIS EXISTS. The two live TTS controls used to assert a POSITIVE provider refusal
 * (`candidate.finishReason === "OTHER"` with no audio). When the provider stopped refusing
 * (audio-feed-zrx9) they were narrowed to assert the refusal's ABSENCE - and a negative assertion is
 * exactly where "we saw nothing" and "there was nothing to see" become the same observation:
 * `finishReason !== "OTHER"` is true for an HTTP 500, for an empty candidate list and for a malformed
 * body, none of which is a completed synthesis. A control may therefore conclude something about a
 * refusal only AFTER observing that the call produced usable speech: HTTP 200, at least one
 * candidate, a concrete accepted finish reason (STOP) and non-empty audio.
 *
 * The mutant matrix that made the unguarded checks pass lives in
 * tests/synthesis_observation_test.ts and must keep failing here: 200 + `candidates: []`, a 500 with
 * no candidates, and a malformed/empty body are all "no observation", not "no refusal".
 */

export interface SynthesisObservation {
  status: number;
  candidateCount: number;
  finishReason?: string;
  /** Base64 payload length of the first inline audio part; 0 when the response carries no audio. */
  audioBase64Length: number;
}

/** Extract what the response actually showed, without deciding whether it is usable. */
export function observeSynthesis(status: number, body: unknown): SynthesisObservation {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const candidates = Array.isArray(record.candidates)
    ? record.candidates as Array<Record<string, unknown>>
    : [];
  const candidate = candidates[0];
  const content = candidate?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts)
    ? content.parts as Array<Record<string, unknown>>
    : [];

  let audioBase64Length = 0;
  for (const part of parts) {
    const inline = (part.inlineData ?? part.inline_data) as { data?: unknown } | undefined;
    if (typeof inline?.data === "string" && inline.data.length > 0) {
      audioBase64Length = inline.data.length;
      break;
    }
  }

  return {
    status,
    candidateCount: candidates.length,
    finishReason: typeof candidate?.finishReason === "string" ? candidate.finishReason : undefined,
    audioBase64Length,
  };
}

/** True only when the call returned usable speech - the precondition for any claim about a refusal. */
export function usableSynthesis(observation: SynthesisObservation): boolean {
  return observation.status === 200 &&
    observation.candidateCount >= 1 &&
    observation.finishReason === "STOP" &&
    observation.audioBase64Length > 0;
}

/** The observation as one line, so a failing check prints what it actually saw rather than "false". */
export function describeSynthesis(observation: SynthesisObservation): string {
  return `status=${observation.status}, candidates=${observation.candidateCount}, ` +
    `finishReason=${observation.finishReason}, audioBase64Length=${observation.audioBase64Length}`;
}

/**
 * The same precondition for a call that went through the production client: the client must have
 * RETURNED decoded audio with a complete finish reason, not merely "not thrown a refusal error".
 */
export function usableDecoded(
  result: { rawBytes: Uint8Array; finishReason?: string } | null | undefined,
): boolean {
  return Boolean(result) && result!.rawBytes.length > 0 && result!.finishReason === "STOP";
}
