/**
 * A per-attempt deadline that can be disposed, and that cannot outlive the request it bounds.
 *
 * WHY NOT `AbortSignal.timeout` + `AbortSignal.any` (audio-feed-0cmu)
 *
 * `AbortSignal.timeout`'s timer cannot be cancelled, and Deno re-refs an input's timer once the
 * composite built by `AbortSignal.any` has ABORTED. So the composite that paired the caller's
 * long-lived signal (the worker's claim lease, up to ~14 minutes; the script stage, up to 6) with
 * a short per-attempt deadline ended up holding the event loop for the LONG timer, not the
 * deadline that fired. Measured on this VM:
 *
 *   AbortSignal.timeout(600_000)                                  -> exits in 0.02s
 *   AbortSignal.any([AbortSignal.timeout(600_000)])               -> exits in 0.02s
 *   AbortSignal.any([AbortSignal.timeout(600_000), timeout(100)])
 *     that then aborts                                           -> alive for the 600s timer
 *
 * The practical effect was that a one-shot process — a CLI, a repro harness, a future worker tick
 * — finished its work and then stayed alive until the lease expired, looking like a stuck lane.
 *
 * This builds the same signal without the composite: one controller for our own bound, one
 * listener forwarding the caller's abort. Dispose it at the end of the attempt (`using`, or
 * `clear()` in a `finally`) so neither the timer nor the listener outlives the request.
 */
export interface AttemptDeadline {
  /** Hand this to fetch. It aborts on our timeout or on the caller's abort, whichever is first. */
  readonly signal: AbortSignal;
  /** True once OUR timeout fired. A caller abort never sets it. */
  timedOut(): boolean;
  /** Cancels the timer and drops the caller listener. Safe to call more than once. */
  clear(): void;
  /** `clear()`, for `using` declarations (the attempt scope disposes the deadline). */
  [Symbol.dispose](): void;
}

export function attemptDeadline(timeoutMs: number, caller?: AbortSignal): AttemptDeadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // The same reason shape `AbortSignal.timeout` produced, so anything reading `signal.reason`
    // (and the messages that quote it) is unchanged.
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);
  // The caller's signal still wins: whichever aborts first is the reason the request fails with.
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  };
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear,
    [Symbol.dispose]: clear,
  };
}
