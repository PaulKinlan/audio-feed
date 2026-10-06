/** Shared synthesis limit management for any model path that needs multiple bounded turns.
 * The output continuation path may reuse runManagedTurns with a different segment type,
 * split strategy and stitcher; see audio-feed-ls92 for JSON-safe script continuation.
 */

/** Split text under a caller-supplied UTF-8 budget. Prefer natural paragraph/sentence
 * boundaries, then words, then Unicode code points for an unbroken oversized token. */
export function splitTextUnderByteBudget(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new Error("Synthesis segment byte budget is too small");
  const result: string[] = [];
  const encoder = new TextEncoder();
  let rest = text.trim();
  while (encoder.encode(rest).length > maxBytes) {
    let end = 0;
    let bytes = 0;
    for (const point of rest) {
      const size = encoder.encode(point).length;
      if (bytes + size > maxBytes) break;
      bytes += size;
      end += point.length;
    }
    const available = rest.slice(0, end);
    const preferred = /\n\s*\n|[.!?。！？][”"')\]]?\s+/gu;
    let boundary = 0;
    for (const match of available.matchAll(preferred)) {
      const candidate = match.index + match[0].length;
      if (candidate > end / 2) boundary = candidate;
    }
    if (!boundary) {
      const word = /\s+\S*$/u.exec(available);
      if (word && word.index > end / 2) boundary = word.index;
    }
    if (boundary) end = boundary;
    const segment = rest.slice(0, end).trim();
    if (!segment) throw new Error("Synthesis segment cannot fit in byte budget");
    result.push(segment);
    rest = rest.slice(end).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}

/** Check the exact non-whitespace text sequence, including repeated words and punctuation.
 * Whitespace may move at a breath boundary; a dropped/duplicated spoken character may not.
 * A segment carrying no spoken characters is rejected outright. */
export function assertTextSeams(source: string, turns: readonly string[]): void {
  const compact = (text: string) => text.replace(/\s+/gu, "");
  if (turns.some((turn) => !turn.trim())) {
    throw new Error("Synthesis turn boundary has an empty transcript segment");
  }
  if (compact(turns.join("")) !== compact(source)) {
    throw new Error("Synthesis turn boundary lost or duplicated transcript text");
  }
}

/** Limit total paid turns, including a refused output and its smaller replacements.
 * Failed turns are never silently added to the stitched result. */
export async function runManagedTurns<T, R, S = R>(options: {
  segments: T[];
  maxTurns: number;
  /** Completed turns let a text model request a continuation with overlap context. */
  request: (segment: T, completed: readonly R[]) => Promise<R>;
  splitOnOutputLimit?: (segment: T, error: unknown) => T[] | null;
  /** A model may return a safe partial completion along with a continuation cursor.
   * The caller alone decides whether its partial output is valid for stitching; incomplete
   * structured JSON must not be accepted until its continuation strategy validates it. */
  continueOnOutputLimit?: (
    segment: T,
    error: unknown,
    completed: readonly R[],
  ) => { partial?: R; next: T[] } | null;
  stitch: (results: R[]) => S;
}): Promise<S> {
  const { segments, maxTurns, request, splitOnOutputLimit, continueOnOutputLimit, stitch } =
    options;
  if (segments.length === 0 || segments.length > maxTurns) {
    throw new Error(`Synthesis needs ${segments.length} turns (limit ${maxTurns})`);
  }
  const results: R[] = [];
  let calls = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    try {
      calls++;
      results.push(await request(segment, results));
    } catch (error) {
      const continuation = continueOnOutputLimit?.(segment, error, results);
      const replacement = continuation?.next ?? splitOnOutputLimit?.(segment, error);
      if (
        !replacement || replacement.length < (continuation?.partial === undefined ? 2 : 1) ||
        calls >= maxTurns || segments.length + replacement.length - 1 > maxTurns
      ) throw error;
      if (continuation?.partial !== undefined) results.push(continuation.partial);
      segments.splice(index, 1, ...replacement);
      index--;
    }
  }
  return stitch(results);
}
