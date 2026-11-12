/**
 * Shared CDP client for browser proofs (audio-feed-t6o2).
 *
 * Extracted verbatim from proof harness implementations:
 * establishes DevTools WebSocket connection, manages message-id dispatch,
 * and provides js() evaluate and until() poll helpers.
 *
 * Every wait in here is a HANG bound, never a latency promise about the page. The two
 * numbers below are the fleet-wide derivation (sweeps `fleet/proof-waits`,
 * `fleet/measure-waits`, `fleet/js-waits`, `fleet/until-sweep-*`) applied at the one place
 * this file's importers all share:
 *
 * - `MEASURED_STARVED_POLL_MS = 8_000` is MEASURED, not guessed: under eight-way CPU
 *   saturation a bare `document.readyState === "complete"` evaluate legitimately exceeded
 *   8s on this host (audio-feed-6gst1).
 * - `HANG_BOUND_MS = 15 x` that floor = 120s. A page that never answers still fails, in two
 *   minutes instead of eight, and it fails by name instead of waiting for the lane's killer.
 *
 * ALL THREE helpers default to `HANG_BOUND_MS`, including `until()`, whose old default was the
 * un-derived 8s. That default is what a caller who states no budget inherits, and on this host
 * it is a false-failure generator: it fires while a healthy page is merely starved. Changing it
 * is a behaviour change ONLY for a call site that omits the third argument, and an arity census
 * of every importer at the time of writing (2026-10-31, `scripts/call-arity.ts until`, 5 files
 * scanned) found none: 3 waits in `listen-browser-proof.ts`, 2 in `playback-csp-browser-proof.ts`,
 * 3 in `tooltip-top-layer-browser-proof.ts` and 1 in `tests/anchor_positioning_test.ts` all pass
 * an explicit 15x-derived bound, and `tests/proof_cdp_test.ts` passes explicit 500/150ms bounds.
 * No existing wait moves by a millisecond; the default only decides what the next caller inherits.
 *
 * `cdp()` ITSELF is bounded too (audio-feed-54f8j): it used to await a promise only a WebSocket
 * reply could settle, so `Page.navigate`, `Page.captureScreenshot` and `WebAuthn.*` were unbounded
 * for whichever proof awaited them - a browser that never answered parked that proof until the
 * lane's killer arrived (measured: a proof printed 11/11 PASS and never exited). The bound is now
 * INSIDE the client rather than at each of the 280-odd raw call sites, because a call site cannot
 * forget a bound it never has to write. It carries the same `HANG_BOUND_MS` default as the other
 * two, and a caller whose command is genuinely slow opts into a longer one with the third argument
 * (`cdp("Page.navigate", { url }, 2 * HANG_BOUND_MS)`), the same trailing-budget shape `js()` and
 * `until()` already use. No per-method table: `Page.navigate` resolves on navigation COMMIT, so
 * the derived 120s already absorbs a host starved for 8s fifteen times over, and inventing a
 * second set of numbers nobody measured is how a bound becomes a flake.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The measured starved-poll floor: 8s of host starvation is not 8s of page work. */
export const MEASURED_STARVED_POLL_MS = 8_000;

/** The hang bound every wait in this file defaults to: 15 x the measured starved-poll floor. */
export const HANG_BOUND_MS = 15 * MEASURED_STARVED_POLL_MS;

/**
 * One `Runtime.evaluate` got no answer inside the hang bound in force.
 *
 * A class, not a bare `Error`, so a caller can separate "the host never answered" from "the
 * expression threw" (which `js()` still reports as a plain `Error` carrying exceptionDetails)
 * without parsing a message. `js()` rejects with this; `until()` catches ONLY this class, and
 * only to report its own deadline, so no other failure is swallowed or retried.
 */
export class CdpHangBoundExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpHangBoundExceeded";
  }
}

/** Render a polled expression's last value for a timeout message without throwing on it. */
function renderValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Render an evaluated expression for a timeout message: one line, head-truncated.
 *
 * The proofs evaluate multi-line IIFEs of 40+ lines; a message that pastes one whole is
 * unreadable in a gate log, and a message that names nothing at all cannot be acted on.
 */
function renderExpression(expression: string): string {
  const oneLine = expression.replace(/\s+/g, " ").trim();
  const limit = 200;
  return oneLine.length <= limit
    ? oneLine
    : `${oneLine.slice(0, limit)}... (${oneLine.length} chars in full)`;
}

/**
 * Reduce one stack frame to `scripts/file.ts:line:col`, or "" if it holds no position.
 *
 * A gate log is read line by line, and the question a hung command raises is "which proof step
 * sent it": an absolute URL to a worktree path answers that only after the reader strips it.
 */
function renderFrame(frame: string): string {
  const match = frame.match(/((?:scripts|tests)\/[^\s)]+:\d+:\d+)/) ??
    frame.match(/([^\s/()]+:\d+:\d+)/);
  return match?.[1] ?? "";
}

/**
 * Where a CDP command was sent from, for the failure message: `scripts/x-proof.ts:112:9`.
 *
 * `omit` is the framing function to leave out of the trace - the client's own `cdp()` - so what
 * is reported is the CALLER's line rather than the wrapper that bounded the wait. Frames inside
 * this file are skipped for the same reason: when `js()` sends its single evaluate through
 * `cdp()`, the honest answer is the proof line that asked for the evaluate, not `js()`'s body.
 * Returns "" when no frame is readable, and the message then simply omits the clause.
 */
export function cdpCallSite(omit: (...args: never[]) => unknown): string {
  const holder: { stack?: string } = {};
  const capture = (Error as unknown as {
    captureStackTrace?: (target: object, constructorOpt?: (...args: never[]) => unknown) => void;
  }).captureStackTrace;
  if (capture) capture(holder, omit);
  else holder.stack = new Error().stack;
  for (const frame of (holder.stack ?? "").split("\n").slice(1)) {
    const site = renderFrame(frame);
    if (site && !site.startsWith("scripts/proof-cdp.ts")) return site;
  }
  return "";
}

/** The one spelling of "this CDP reply never arrived" (audio-feed-54f8j). */
function replyHangMessage(method: string, timeoutMs: number, sentFrom: string): string {
  return (
    `cdp: the \`${method}\` reply never arrived within ${timeoutMs}ms - the hang bound ` +
    `in force (${HANG_BOUND_MS}ms by default, 15 x the ${MEASURED_STARVED_POLL_MS}ms ` +
    `measured starved-poll floor, audio-feed-6gst1)` +
    (sentFrom ? `, for the command sent at ${sentFrom}` : "") +
    `. This is a HANG bound on ONE CDP ` +
    `reply, not a latency bound: the command was sent exactly once and the browser ` +
    `never answered it, so the browser's main thread (or the DevTools socket) stalled ` +
    `rather than the page being slow.`
  );
}

/**
 * Bound ONE reply from a client's own `cdp()` and name the proof line that sent it.
 *
 * Exported because proofs still carry private DevTools clients (`ws.send` + a pending map) whose
 * reply wait is the same unbounded promise; `omit` lets each of those bound its OWN `cdp()` at
 * the single place its call sites go through, which is what stops a new call site forgetting.
 */
export function boundedCdpReply<T>(
  method: string,
  reply: Promise<T>,
  omit: (...args: never[]) => unknown,
  timeoutMs = HANG_BOUND_MS,
): Promise<T> {
  // Captured NOW, while the sender's frame is still on the stack; the timer callback below runs
  // with a stack that names nothing useful.
  const sentFrom = cdpCallSite(omit);
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CdpHangBoundExceeded(replyHangMessage(method, timeoutMs, sentFrom))),
      timeoutMs,
    );
  });
  return Promise.race([reply, expired]).finally(() => clearTimeout(timer));
}

export interface CdpClient {
  ws: WebSocket;
  /**
   * Send ONE command and wait for its reply, bounded by `timeoutMs`.
   *
   * The bound is not optional: a call site that states no budget inherits `HANG_BOUND_MS`, so a
   * new proof cannot be written unbounded by forgetting to pass one. Pass a LARGER budget only
   * for a command that is genuinely slow (see the module comment); a shorter one keeps a cheap
   * step cheap when the row is already under its own deadline.
   */
  // deno-lint-ignore no-explicit-any
  cdp: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
  // deno-lint-ignore no-explicit-any
  js: (expression: string, timeoutMs?: number) => Promise<any>;
  until: (expr: string, desc: string, timeoutMs?: number) => Promise<void>;
  close: () => void;
}

export async function connectCdp(target: number | { port: number }): Promise<CdpClient> {
  const port = typeof target === "number" ? target : target.port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t: { type: string }) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  let nextId = 0;
  const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });

  async function cdp(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = HANG_BOUND_MS,
    // deno-lint-ignore no-explicit-any
  ): Promise<any> {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    const reply = new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r));
    let msg: { result?: unknown; error?: unknown };
    try {
      // `omit: cdp` so a reply that never comes names the proof line that sent the command, not
      // this wrapper (audio-feed-54f8j). The command above was sent exactly once either way.
      msg = await boundedCdpReply(method, reply, cdp, timeoutMs);
    } catch (err) {
      // The reply will never be dispatched: forget the entry instead of holding it for the life
      // of the client, so a stalled command cannot accumulate map entries across a hung sweep.
      pending.delete(id);
      throw err;
    }
    if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }

  // deno-lint-ignore no-explicit-any
  async function js(expression: string, timeoutMs = HANG_BOUND_MS): Promise<any> {
    // The bound is applied by RACING the one evaluate against a timer, the way
    // `fleet/measure-waits` bounded its layout reads: a poll would re-run the read and could
    // report a value from a later state than the call asked about, which is a measurement
    // change, not a bound. Exactly one `Runtime.evaluate` is sent either way, so what is
    // measured is unchanged; only an answer that never comes now fails by name.
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CdpHangBoundExceeded(
              `js: the evaluate of \`${renderExpression(expression)}\` got no answer in ` +
                `${timeoutMs}ms - the hang bound in force (${HANG_BOUND_MS}ms by default, ` +
                `15 x the ${MEASURED_STARVED_POLL_MS}ms measured starved-poll floor, ` +
                `audio-feed-6gst1). This is a HANG bound on ONE Runtime.evaluate, not a latency ` +
                `bound, and this was NOT polled: the expression was evaluated exactly once and ` +
                `that single evaluate is the one that never came back, so the page's main ` +
                `thread never answered it.`,
            ),
          ),
        timeoutMs,
      );
    });
    const evaluate = cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    // deno-lint-ignore no-explicit-any
    let r: any;
    try {
      r = await Promise.race([evaluate, expired]);
    } finally {
      clearTimeout(timer);
    }
    if (r.exceptionDetails) {
      throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
    }
    return r.result?.value;
  }

  async function until(expr: string, desc: string, timeoutMs = HANG_BOUND_MS) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let polls = 0;
    let last: unknown;
    let starvedPollMs = 0;
    while (Date.now() - startedAt < timeoutMs) {
      // EACH poll is bounded by what is left of THIS wait's budget. Without that, `await js(expr)`
      // could outlive the deadline it was serving: an evaluate that never answers is awaited
      // before the loop test runs again, so a 15s wait could hang for as long as the lane lives -
      // the timeoutMs never reached a pending evaluate. The bound changes nothing about what is
      // measured (same expression, same 50ms poll interval, same truthiness test); it only makes
      // the deadline in force a deadline.
      const remainingMs = Math.max(1, deadline - Date.now());
      try {
        last = await js(expr, remainingMs);
      } catch (err) {
        // ONLY our own hang bound becomes the deadline error below. A thrown expression or a
        // syntax error is the caller's bug and still escapes immediately, unwrapped and
        // unretried - converting it would turn one error into two thousand polls.
        if (!(err instanceof CdpHangBoundExceeded)) throw err;
        starvedPollMs = remainingMs;
        break;
      }
      if (last) return;
      polls++;
      await sleep(50);
    }
    // audio-feed-ev6wj: never a bare "timed out waiting for: <desc>". A reader of a gate log
    // could not tell the 8s default from the 120s budget a slow row passes explicitly, could
    // not see WHICH expression never held, and could not see whether the poll ran once (the
    // host never gave the page a slice) or two thousand times (the page really never got
    // there) - the two failures need opposite responses.
    throw new Error(
      `until: '${desc}' did not hold within ${timeoutMs}ms of entry ` +
        `(expression \`${expr}\`, entry ${new Date(startedAt).toISOString()}, ` +
        `deadline ${new Date(deadline).toISOString()}, ` +
        `elapsed ${Date.now() - startedAt}ms, polls ${polls}, ` +
        `last value ${renderValue(last)}` +
        (starvedPollMs
          ? `; the final poll's evaluate got no answer in the ${starvedPollMs}ms left of that ` +
            "budget, so the host starved the poll rather than the page refusing to get there"
          : "") +
        ")",
    );
  }

  function close() {
    try {
      ws.close();
    } catch { /* ignore */ }
  }

  return { ws, cdp, js, until, close };
}

/**
 * Bound ONE raw CDP round-trip that has no `Runtime.evaluate` to carry `js()`'s race.
 *
 * `js()` bounds evaluates, but proofs also send raw commands through `cdp()` -
 * `Emulation.setEmulatedMedia`, `Emulation.setDeviceMetricsOverride`, `Page.captureScreenshot`,
 * `WebAuthn.*` - and each of those waits on the same kind of bare reply promise. One screenshot
 * request the browser never answers would hang the caller for as long as the lane lives (measured:
 * account-browser-proof printed 11/11 PASS and never exited). This wraps any single reply promise
 * in the SAME derived bound js() uses and rejects with the SAME class, so a caller's catch block
 * can treat a starved screenshot exactly like a starved evaluate. The command itself is sent
 * exactly once by the caller; this only bounds the wait for its answer.
 *
 * The shared client's own `cdp()` no longer needs this wrapper - it bounds itself - but proofs
 * that build a reply promise by hand, and callers that already race their own deadline, still
 * reach for it: it is one spelling of the bound, so both paths fail with one message.
 */
export async function withHangBound<T>(
  what: string,
  reply: Promise<T>,
  timeoutMs?: number,
): Promise<T>;
export async function withHangBound<T>(
  reply: Promise<T>,
  what: string,
  timeoutMs?: number,
): Promise<T>;
export function withHangBound<T>(
  first: string | Promise<T>,
  second: Promise<T> | string,
  timeoutMs = HANG_BOUND_MS,
): Promise<T> {
  const what = typeof first === "string" ? first : (second as string);
  const reply = (typeof first === "string" ? second : first) as Promise<T>;
  // `omit: withHangBound` so the message names the line that sent the command, not this wrapper.
  return boundedCdpReply(what, reply, withHangBound, timeoutMs);
}
