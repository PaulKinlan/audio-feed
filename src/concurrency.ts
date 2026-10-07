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
 * call (like `Promise.all`) and stops the pool from starting any further items, so
 * the surviving workers cannot drain the rest of the batch unnoticed after the
 * caller has already seen the rejection. The callbacks already in flight still run
 * to completion, since there is no cancellation here.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const workers = Math.max(1, Math.min(Math.trunc(limit), items.length));
  let next = 0;
  let aborted = false;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        // Single-threaded between awaits, so two workers can never take the same index.
        const index = next++;
        if (aborted || index >= items.length) return;
        try {
          results[index] = await fn(items[index]!, index);
        } catch (error) {
          // The first throw rejects the caller, so without this flag the surviving
          // workers keep pulling unstarted items in the background and their errors
          // are swallowed by `Promise.all`. In-flight callbacks still finish.
          aborted = true;
          throw error;
        }
      }
    }),
  );
  return results;
}
