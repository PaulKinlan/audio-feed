/**
 * The repo's ONE fake invocation-budget clock (audio-feed-krrws, audio-feed-on12e; shared by
 * decision of audio-feed-n52j3's batching rule: a shared mechanism may be built once and
 * reused, so rows that inject a deadline do not each carry a divergent copy).
 *
 * `now()` never moves and timers never fire until `advance()` moves them, so a deadline armed
 * on this clock lands exactly where the test advances to — the row asserts an ORDER of
 * operations (e.g. "the PUT started before the budget aborted the turn"), not that work
 * finished inside N real milliseconds. Pass `clock` in `runSynthesisBatch` /
 * `InvocationBudgetSpec` options; production defaults to REAL_INVOCATION_CLOCK.
 *
 * `advance()` fires every due timer, earliest first, letting each one's awaiters run before
 * the next, so an abort that is a CONSEQUENCE of a firing is observed before the caller reads
 * `signal.aborted`.
 */
import type { InvocationClock } from "../../src/synthesis/limits.ts";

export function controlledInvocationClock(startMs = 1_000_000) {
  let nowMs = startMs;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const clock: InvocationClock = {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const timer = { at: nowMs + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  return {
    clock,
    get nowMs() {
      return nowMs;
    },
    async advance(ms: number): Promise<void> {
      const target = nowMs + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        nowMs = Math.max(nowMs, due.at);
        due.fn();
        for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      nowMs = target;
    },
  };
}
