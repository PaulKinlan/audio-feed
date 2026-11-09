/**
 * A PER-ROW hang bound for `deno test` (audio-feed-g7vfw).
 *
 * deno test has NO per-row timeout. One row that blocks takes the whole suite with it, and a
 * parked suite is indistinguishable from a slow one until somebody reads the last line of the
 * log. Measured on the union gate for 12a283f7: ~50 minutes spent on ONE row
 * ("audio-feed-aqms control: the same put outlasts the invocation budget mid-await when the
 * isolate SURVIVES") at 4.2% CPU, killed by hand - while the same row passed in 326ms in
 * isolation on the same tree. The only bounds that existed were the gate's own 7000s wall
 * (about two hours of a scarce CPU slot) and an incidental reaper that killed a leaked browser
 * at 45 minutes. Neither reddens the row.
 *
 * `boundedRow(name, body)` is `Deno.test(name, ...)` with the body raced against a timer, so a
 * row that parks reds AS THAT ROW, by name, in ROW_HANG_BOUND_MS. Nothing it asserts changes:
 * a passing body returns as before, a failing body's own error propagates untouched.
 *
 * ROW_HANG_BOUND_MS is DERIVED, not chosen - ROW_HANG_HEADROOM (15) x MEASURED_STARVED_POLL_MS,
 * the repo's standard HANG_BOUND_MS derivation (scripts/proof-cdp.ts). It is a BOUND, not a
 * latency expectation: no row in this repo asserts elapsed time, and 120s sits far above what
 * any of them costs while still being minutes rather than an afternoon.
 *
 * WHAT THIS CANNOT DO, and why the gate still needs more than it: Deno exposes no global
 * per-test hook (no timeout option on Deno.test, no runner hook that can abort a single row),
 * so a row that never calls `boundedRow` still parks its suite. The smallest thing that would
 * protect EVERY row without opting in is a supervisor around the gate's `deno test` that reads
 * the streamed output, tracks the row whose result has not printed, and kills the run naming
 * that row once ROW_HANG_BOUND_MS passes without a new result line. That is gate plumbing, not
 * a test helper, so it is not built here - it is the named next step on audio-feed-g7vfw.
 */
import { MEASURED_STARVED_POLL_MS } from "../../scripts/proof-cdp.ts";

/** The repo's standard headroom multiplier over the starved floor (HANG_BOUND_MS). */
export const ROW_HANG_HEADROOM = 15;

/** The row hang bound for a given starved-poll floor. */
export function rowHangBoundMs(floorMs: number): number {
  return ROW_HANG_HEADROOM * floorMs;
}

/** The default row hang bound: 120s (15 x 8_000ms). */
export const ROW_HANG_BOUND_MS = rowHangBoundMs(MEASURED_STARVED_POLL_MS);

/**
 * The red a parked row produces. It names the row, the bound, and how the bound is derived, so
 * the next reader does not have to re-derive what a hung gate means.
 */
export function rowHangMessage(name: string, boundMs: number): string {
  return `row "${name}" exceeded the row hang bound of ${boundMs}ms ` +
    `(${ROW_HANG_HEADROOM} x the ${MEASURED_STARVED_POLL_MS}ms measured starved-poll floor ` +
    `in tests/fixtures/row_watchdog.ts): the row never settled. A row that reaches this bound ` +
    `is PARKED, not slow - suspect an await whose only waker is a callback that never runs, and ` +
    `bound that await by name rather than raising this one (audio-feed-g7vfw).`;
}

/**
 * Run `body` under the row bound. `boundMs` is injectable so a proof of the bound costs
 * milliseconds instead of the default 120s.
 */
export async function withRowBound<T>(
  name: string,
  body: () => T | Promise<T>,
  boundMs: number = ROW_HANG_BOUND_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    // NOT unref'd on purpose: an unref'd timer does not hold the event loop, so a row parked
    // with nothing else pending lets Deno's sanitizer end the run with "Promise resolution is
    // still pending but the event loop has already resolved" BEFORE the bound fires - a red that
    // names the sanitizer instead of the row. The timer is cleared in the finally below, so it
    // cannot outlive a row that settles first.
    timer = setTimeout(() => reject(new Error(rowHangMessage(name, boundMs))), boundMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(body), bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `Deno.test` with the body under the row hang bound. */
export function boundedRow(
  name: string,
  body: () => void | Promise<void>,
  boundMs: number = ROW_HANG_BOUND_MS,
): void {
  Deno.test(name, () => withRowBound(name, body, boundMs));
}
