/**
 * The screen applied to an UNHANDLED error's message BEFORE it is written (audio-feed-sw1r).
 *
 * WHY A SCREEN AND NOT A TRUNCATION OR A CHARACTER FILTER: an unhandled request error can be thrown by any
 * request path, and its message is a client-chosen string in the general case - a malformed query, a bad
 * Host, a payload that echoes itself. A character-class filter or a length bound does not remove a
 * client-chosen value that happens to be spelled with the allowed characters; it only makes the leak shorter.
 * The invariant test (`tests/log_request_surface_invariant_test.ts`) asserts a mixed-case canary appears
 * NOWHERE in the durable record, and that assertion is only meaningful if the stored value CANNOT contain the
 * canary by construction.
 *
 * SO THE STORED VALUE IS DRAWN FROM A CLOSED LIST. `screenErrorMessage` returns a phrase this codebase itself
 * throws (matched as a PREFIX, so the recognisable part survives and the tail - which is where the request is
 * quoted - is discarded), or `SUPPRESSED_MESSAGE`. There is no third possibility, which is what the tests
 * pin: the output is always a member of `KNOWN_ERROR_PHRASES` or exactly `SUPPRESSED_MESSAGE`.
 *
 * THE LIST IS CODE-OWNED, NOT A GUESS: a unit test walks `src/` and fails if a phrase here has no `throw`
 * site, so the list cannot rot into a set of strings nobody throws, and a phrase that is NOT in the list can
 * never be stored - adding one is a deliberate edit with a throw site beside it.
 */

/** Stored when a message cannot be attributed to this codebase's own throws. */
export const SUPPRESSED_MESSAGE = "message suppressed (not authored by this codebase)";

/**
 * Phrases this codebase itself throws. Matched as a prefix of the thrown message; everything after the match
 * is DISCARDED rather than stored, because that tail is where a request gets quoted.
 */
export const KNOWN_ERROR_PHRASES: readonly string[] = [
  "Synthesis segment cannot fit in byte budget",
  "Synthesis segment byte budget is too small",
  "Synthesis turn boundary has an empty transcript segment",
  "Synthesis turn boundary lost or duplicated transcript turns",
  "Invalid WAV: missing RIFF/WAVE container header",
  "Unauthorized: admin token required",
];

/** The screen. Returns a phrase from KNOWN_ERROR_PHRASES, or SUPPRESSED_MESSAGE - never anything else. */
export function screenErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const phrase = KNOWN_ERROR_PHRASES.find((candidate) => raw.startsWith(candidate));
  return phrase ?? SUPPRESSED_MESSAGE;
}

/** True when `value` is a value this screen could itself have produced. Used by the tests' invariant. */
export function isScreenOutput(value: unknown): boolean {
  return typeof value === "string" &&
    (value === SUPPRESSED_MESSAGE || KNOWN_ERROR_PHRASES.includes(value));
}

/**
 * Closed set of known error names either built into JavaScript or authored by this codebase.
 * Any unhandled error whose .name is not in this closed set is screened to "Error".
 */
export const KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "HttpError",
  "IngestError",
  "GroundedScriptError",
  "SynthesisYieldError",
  "VoiceSampleError",
  "GeminiTtsError",
  "PasskeyError",
  "IllegalTransitionError",
  "UnknownUserError",
  "NotAuthorizedError",
  "DuplicateUserEmailError",
  "CorruptArticleError",
  "RangeNotSatisfiableError",
  "UnsignedPutError",
]);

/** Returns a screened error name from KNOWN_ERROR_NAMES, or "Error". */
export function screenErrorName(error: unknown): string {
  if (
    error instanceof Error && typeof error.name === "string" && KNOWN_ERROR_NAMES.has(error.name)
  ) {
    return error.name;
  }
  return "Error";
}

/**
 * Builds a sanitized Error object for operational stderr logging (audio-feed-ahx5).
 * - Replaces error message with screenErrorMessage (closed set of codebase phrases or SUPPRESSED_MESSAGE).
 * - Screens error.name against KNOWN_ERROR_NAMES (closed set, falls back to "Error").
 * - Omits caller-supplied stack trace locations and frames entirely so no attacker-chosen text
 *   in source paths, URLs, or function names can enter server stderr.
 */
export function screenErrorForLogging(error: unknown): Error {
  const screenedMessage = screenErrorMessage(error);
  const errorName = screenErrorName(error);
  const sanitized = new Error(screenedMessage);
  sanitized.name = errorName;
  sanitized.stack = `${errorName}: ${screenedMessage}`;
  return sanitized;
}
