/**
 * Product-latency budgets for browser proofs, kept apart from the hang ceiling.
 *
 * `HANG_BOUND_MS` (scripts/proof-cdp.ts) answers ONE question: how long a starved host may take
 * before we call the gate hung. It says nothing about the product, so a wait that asks "did
 * playback start" or "did the redirect land" must not be spelled as a fraction or a multiple of
 * it: moving the starved-poll floor would then silently reshape a product budget. fleet/until-4
 * did exactly that - `/admin` redirect waits went from a 10s literal to `HANG_BOUND_MS` (12x),
 * and the playback start wait from 15s to `HANG_BOUND_MS / 8` (audio-feed-c0l7b).
 *
 * Every budget here is derived from the behaviour it measures out of numbers already named in
 * this repository, and every one is strictly below the hang bound, so a stuck page still fails
 * fast. Where no measurement exists the comment says so and the value is a FLOOR, not a proof.
 */
import { HANG_BOUND_MS, MEASURED_STARVED_POLL_MS } from "./proof-cdp.ts";

/**
 * The advance sample window the playback assertion already uses: playback-csp-browser-proof.ts
 * reads `currentTime` twice 1.2s apart and requires the second read to have MOVED by more than
 * 0.25s, i.e. the element plays at 1x real time once started. 1.2s is therefore the granularity
 * at which "playback has started" becomes observable.
 */
export const PLAYBACK_ADVANCE_SAMPLE_MS = 1_200;

/**
 * How long the play press is given to START playback: the deadline on the poll loop, and on the
 * ONE evaluate each of its polls sends.
 *
 * FLOOR, NOT A PROVEN BOUND: no measurement of time-to-first-audio exists in this repository. The
 * arithmetic names the waits the span actually encloses (audio-feed-v9uz5):
 *
 *   1 x MEASURED_STARVED_POLL_MS (the `currentTime`/`readyState` evaluate a poll sends; 8s,
 *   measured under eight-way CPU saturation, audio-feed-6gst1)
 *   + PLAYBACK_ADVANCE_SAMPLE_MS (overhead, not a wait: room for the poll to see the element move
 *     after its first answer, at the 1.2s granularity the sample above defines)
 *
 * The poll loop clamps each evaluate to what is LEFT of this deadline, the way `until()` clamps a
 * poll: a total-only budget over an unclamped `await js(...)` is not a bound on the evaluate that
 * is in flight when the loop test next runs, so a host that takes 8s to answer reported "did not
 * start inside 9200ms" for a press it had answered. This budget covers the START stage only; the
 * two `currentTime` reads that judge whether it MOVED are the sample budget below.
 */
export const PLAYBACK_ADVANCE_WAIT_MS = MEASURED_STARVED_POLL_MS + PLAYBACK_ADVANCE_SAMPLE_MS;

/**
 * How long the "playback has started" SAMPLE is given: the two `currentTime` reads and the 1.2s
 * window between them.
 *
 * FLOOR, NOT A PROVEN BOUND, but the count is derived rather than picked: the assertion needs TWO
 * evaluates of the page (a first read and a second after the window), so the span encloses
 *
 *   2 x MEASURED_STARVED_POLL_MS + PLAYBACK_ADVANCE_SAMPLE_MS = 17_200ms
 *
 * One starved poll would bound one of those reads and leave the other to the 120s hang ceiling,
 * which is the sum-reads-as-a-hang failure this split exists to prevent (audio-feed-v9uz5). Both
 * reads are clamped to what is left of this deadline; the window between them is skipped only if
 * the first read has already eaten the budget, which the row then reports by name.
 */
export const PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS = 2 * MEASURED_STARVED_POLL_MS +
  PLAYBACK_ADVANCE_SAMPLE_MS;

/**
 * How long the bootstrap POST is given to answer and the browser to land on /admin.
 *
 * FLOOR, NOT A PROVEN BOUND: no measurement of the bootstrap POST -> redirect latency exists in
 * this repository. 10_000ms is the literal this wait carried before fleet/until-4 replaced it with
 * HANG_BOUND_MS, i.e. the value the row was green under. The work being waited on is one POST to
 * the in-process server over loopback, with the WebAuthn ceremony served by a virtual
 * authenticator, so the measured 8s starved poll is the dominant term and this budget sits above
 * it.
 */
export const BOOTSTRAP_REDIRECT_LATENCY_MS = 10_000;

/**
 * The rule every product budget has to satisfy: a budget at or above the hang ceiling is a wait
 * that outlives the bound it is supposed to fail under, so fail by name and by value.
 *
 * Exported to be TESTABLE, not to be reused: `ceilMs` defaults to the one `HANG_BOUND_MS` in
 * force, so the import-time check below applies the real ceiling, while a test row can hand the
 * rule a ceiling of its own and see it reject a budget without mutating a source constant at
 * test time (a mutation that was previously invisible with sane budgets - audio-feed-zkto5).
 * Nothing under src/ calls it; it guards proof scripts' budgets, and its callers are the import
 * check below and that row.
 */
export function assertBudgetBelowHang(
  name: string,
  budgetMs: number,
  ceilMs: number = HANG_BOUND_MS,
): void {
  if (budgetMs >= ceilMs) {
    throw new Error(
      `${name} = ${budgetMs}ms must be strictly below the hang ceiling = ${ceilMs}ms ` +
        "(a product budget at or above the ceiling is a wait that outlives the bound it fails under)",
    );
  }
}

// Fail at import, by name, instead of at a browser row nobody re-derives.
const PRODUCT_BUDGETS: Record<string, number> = {
  PLAYBACK_ADVANCE_WAIT_MS,
  PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS,
  BOOTSTRAP_REDIRECT_LATENCY_MS,
};
for (const [name, budgetMs] of Object.entries(PRODUCT_BUDGETS)) {
  assertBudgetBelowHang(name, budgetMs);
}

/** Which sample evaluate starved when reading playback state. */
export type StarvedSampleRead = {
  read: "first" | "second";
  elapsedMs: number;
  remainingMs: number;
};

/**
 * Build the message for the PLAYING check in playback-csp-browser-proof.ts (audio-feed-wwvny).
 *
 * When neither read starved, formats start observation, sample window, and currentTime progression.
 * When a sample read starved, names the sample window and budget, which read starved (first or
 * second currentTime), the elapsed time, and the remaining budget it got no answer in.
 */
export function buildPlaybackPlayingMessage(options: {
  advanced: boolean;
  startPolls: number;
  starvedStartPollMs?: number;
  sampleWindowMs: number;
  starvedSampleRead?: StarvedSampleRead | null;
  first?: {
    currentTime: number;
    readyState: number;
  } | null;
  second?: {
    currentTime: number;
    readyState: number;
    networkState: number;
    paused: boolean;
  } | null;
}): string {
  const {
    advanced,
    startPolls,
    starvedStartPollMs = 0,
    sampleWindowMs,
    starvedSampleRead = null,
    first = null,
    second = null,
  } = options;

  let msg =
    `start observed inside ${PLAYBACK_ADVANCE_WAIT_MS}ms after ${startPolls} poll(s): ${advanced}` +
    (starvedStartPollMs
      ? ` (the final poll's evaluate got no answer in the ${starvedStartPollMs}ms left of ` +
        "that budget, so the host starved the poll rather than the page refusing to start)"
      : "") +
    `; sample window ${sampleWindowMs}ms of the ${PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS}ms budget`;

  if (starvedSampleRead) {
    const whichRead = starvedSampleRead.read === "first"
      ? "first currentTime"
      : "second currentTime";
    msg += `: the ${whichRead} read got no answer in the ${starvedSampleRead.remainingMs}ms ` +
      `left of that budget (${starvedSampleRead.elapsedMs}ms elapsed), so the host starved the sample rather than playback failing to advance`;
    return msg;
  }

  if (first && second) {
    msg += `; currentTime ${first.currentTime.toFixed(3)}s -> ${second.currentTime.toFixed(3)}s ` +
      `(+${(second.currentTime - first.currentTime).toFixed(3)}s), ` +
      `readyState ${first.readyState} -> ${second.readyState}, networkState ${second.networkState}, paused ${second.paused}`;
  }

  return msg;
}
