/**
 * The clearable per-attempt deadline (audio-feed-0cmu).
 *
 * `attemptDeadline` replaces `AbortSignal.timeout` + `AbortSignal.any`, whose composite re-refs an
 * input's timer once it aborts: paired with the worker's claim lease (up to ~14 minutes) and the
 * script stage (up to 6), a fired per-attempt deadline kept a finished one-shot process alive for
 * the rest of that outer bound. These cases pin the semantics the call sites depend on. The
 * process-lifetime property itself cannot be observed from inside the runtime — Deno's test runner
 * exits without draining the loop, so a live timer is invisible to a test — so it is asserted from
 * a child process in tests/tts_hardening_test.ts.
 */
import { assertEquals } from "@std/assert";
import { attemptDeadline } from "../src/tts/deadline.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when the signal aborts (or immediately if it already has). */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

Deno.test("the deadline aborts with the reason shape AbortSignal.timeout produced", async () => {
  using deadline = attemptDeadline(20);
  assertEquals(deadline.signal.aborted, false);
  assertEquals(deadline.timedOut(), false);
  await aborted(deadline.signal);
  assertEquals(deadline.signal.aborted, true);
  assertEquals(deadline.timedOut(), true);
  // Anything reading signal.reason (and the messages that quote it) sees what it always did.
  assertEquals((deadline.signal.reason as DOMException).name, "TimeoutError");
});

Deno.test("clear() cancels the timer, so a cleared attempt can never abort later", async () => {
  const deadline = attemptDeadline(20);
  deadline.clear();
  deadline.clear(); // idempotent: `using` disposes after an explicit clear is possible
  await sleep(60);
  assertEquals(deadline.signal.aborted, false);
  assertEquals(deadline.timedOut(), false);
});

Deno.test("a caller abort wins and is never reported as our timeout", async () => {
  const caller = new AbortController();
  using deadline = attemptDeadline(5_000, caller.signal);
  caller.abort(new Error("lease expired"));
  await aborted(deadline.signal);
  assertEquals(deadline.signal.aborted, true);
  assertEquals(deadline.timedOut(), false);
  assertEquals((deadline.signal.reason as Error).message, "lease expired");
});

Deno.test("an already-aborted caller aborts the attempt immediately", () => {
  const caller = new AbortController();
  caller.abort();
  using deadline = attemptDeadline(5_000, caller.signal);
  assertEquals(deadline.signal.aborted, true);
  assertEquals(deadline.timedOut(), false);
});

Deno.test("the caller's deadline still fires when it is the shorter of the two", async () => {
  // The other direction: our own timer must not shadow a caller signal that fires first.
  const caller = AbortSignal.timeout(20);
  using deadline = attemptDeadline(5_000, caller);
  await aborted(deadline.signal);
  assertEquals(deadline.timedOut(), false);
  assertEquals((deadline.signal.reason as DOMException).name, "TimeoutError");
});
