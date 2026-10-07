/**
 * Tests for the bounded-concurrency pool (src/concurrency.ts).
 *
 * The module's contract is what feed polling, TTS code-block explanations and the
 * synthesis blob sweeps depend on: at most `limit` callbacks in flight, results in
 * INPUT order, and a throw that rejects the whole call without the surviving
 * workers draining the rest of the batch behind the caller's back.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { mapWithConcurrency } from "../src/concurrency.ts";

Deno.test("results keep input order and the pool runs at most `limit` callbacks", async () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency(items, 2, async (item) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Vary the latency so completion order differs from input order.
    await new Promise((resolve) => setTimeout(resolve, item === "a" ? 5 : 1));
    inFlight--;
    return item.toUpperCase();
  });

  assertEquals(results, ["A", "B", "C", "D", "E", "F"]);
  // The limit is both a floor (> 1 is the point of the pool) and a ceiling.
  assertEquals(peak, 2, "exactly two callbacks may be in flight for a limit of 2");
});

Deno.test("a throwing item rejects the caller and stops the pool starting later items", async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const started: number[] = [];
  const failure = new Error("item 2 failed");
  // Held open so the healthy in-flight items cannot finish (and free their worker
  // to pull more work) until after the caller has observed the rejection.
  const inFlight = Promise.withResolvers<void>();

  const pending = mapWithConcurrency(items, 3, async (index) => {
    started.push(index);
    if (index === 2) throw failure;
    await inFlight.promise;
    return index;
  });

  const error = await assertRejects(() => pending, Error, "item 2 failed");
  assertEquals(error, failure, "the caller receives the error the item threw");
  // Only the three workers that were already running may have started an item.
  assertEquals([...started].sort((a, b) => a - b), [0, 1, 2]);

  // Release the survivors: without the abort flag they would now run indices 3 and
  // 4 (and then every remaining item), which `Promise.all` would never surface.
  inFlight.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(
    [...started].sort((a, b) => a - b),
    [0, 1, 2],
    "no item may start after the batch has been rejected",
  );
});
