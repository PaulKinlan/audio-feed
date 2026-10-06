/** Shared synthesis limit management for any model path that needs multiple bounded turns.
 * The output continuation path may reuse runManagedTurns with a different segment type,
 * split strategy and stitcher; see audio-feed-ls92 for JSON-safe script continuation.
 */

/** Check the exact non-whitespace text sequence, including repeated words and punctuation.
 * Whitespace may move at a breath boundary; a dropped/duplicated spoken character may not. */
export function assertTextSeams(source: string, turns: readonly string[]): void {
  const compact = (text: string) => text.replace(/\s+/gu, "");
  if (compact(turns.join("")) !== compact(source)) {
    throw new Error("Synthesis turn boundary lost or duplicated transcript text");
  }
}

/** Limit total paid turns, including a refused output and its smaller replacements.
 * Failed turns are never silently added to the stitched result. */
export async function runManagedTurns<T, R>(options: {
  segments: T[];
  maxTurns: number;
  /** Completed turns let a text model request a continuation with overlap context. */
  request: (segment: T, completed: readonly R[]) => Promise<R>;
  splitOnOutputLimit?: (segment: T, error: unknown) => T[] | null;
  stitch: (results: R[]) => R;
}): Promise<R> {
  const { segments, maxTurns, request, splitOnOutputLimit, stitch } = options;
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
      const replacement = splitOnOutputLimit?.(segment, error);
      if (
        !replacement || replacement.length < 2 || calls >= maxTurns ||
        segments.length + replacement.length - 1 > maxTurns
      ) throw error;
      segments.splice(index, 1, ...replacement);
      index--;
    }
  }
  return stitch(results);
}
