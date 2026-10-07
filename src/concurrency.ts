/**
 * Bounded-concurrency `map`.
 *
 * A serial `await` per item pays the SUM of N round-trips, and a bare
 * `Promise.all(items.map(...))` pays for the same N at once — which on a feed poll
 * or a blob sweep means a stampede against one host or the KV store. This runs at
 * most `limit` callbacks at a time and resolves to the results in INPUT order, so
 * callers that assemble output from the results keep the input's ordering.
 *
 * `fn` is expected to handle its own per-item failures: a throw rejects the whole
 * call (like `Promise.all`) and the remaining in-flight callbacks still run to
 * completion, since there is no cancellation here.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const workers = Math.max(1, Math.min(Math.trunc(limit), items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        // Single-threaded between awaits, so two workers can never take the same index.
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}
