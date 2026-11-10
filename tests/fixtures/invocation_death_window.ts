/**
 * The marker-window bound shared by tests/fixtures/invocation_death_child.ts
 * (its default) and tests/synthesis_invocation_death_test.ts (its control).
 *
 * audio-feed-aqms-window: the child's marker window was a bare 8_000 - exactly
 * scripts/proof-cdp.ts MEASURED_STARVED_POLL_MS, the measured floor of one
 * starved poll (audio-feed-6gst1) - with ZERO headroom, so a host running a
 * full gate (loadavg 6-12 on this 8-core VM) expired it while the batch was
 * merely starved on its way to the upload stage and flaked the row. The two
 * roles that one constant conflated are now separate:
 *
 *   (a) DEFAULT_MARKER_WAIT_MS - the give-up bound a caller inherits: 15 x the
 *       measured starved-poll floor, the repo's standard HANG_BOUND_MS
 *       derivation. Headroom against a loaded host, not a latency expectation;
 *       it also sits above the hang rounds' 30s batch budget, so host slowness
 *       alone can never fire the give-up before the batch has had its whole
 *       widened budget to reach the marker.
 *   (b) MARKER_WAIT_MS_ENV - the caller's control. The test passes this env var
 *       explicitly on every hang spawn (no ambient-env coupling), and the
 *       red-path case sets 0, which stops the child WITHOUT the marker
 *       deterministically: the give-up becomes a controlled event instead of a
 *       race with host load.
 *
 * MEASURED_STARVED_POLL_MS is IMPORTED, not restated: it was a second literal
 * 8_000 here with nothing pinning it to the measured floor, so a change to
 * scripts/proof-cdp.ts would have left this 15x derivation silently deriving
 * from a stale number. proof-cdp.ts imports nothing and runs nothing at import
 * time (constants, a class and async helpers), so the import cannot cycle - and
 * tests/ already imports it (anchor_positioning_test.ts, proof_cdp_test.ts).
 */
import { MEASURED_STARVED_POLL_MS } from "../../scripts/proof-cdp.ts";

/** The repo's standard headroom multiplier over the starved floor (HANG_BOUND_MS). */
export const MARKER_WAIT_HEADROOM = 15;

/** The child's default give-up bound: 120s. */
export const DEFAULT_MARKER_WAIT_MS = MARKER_WAIT_HEADROOM * MEASURED_STARVED_POLL_MS;

/**
 * Env var overriding the marker window in milliseconds; 0 = give up immediately
 * (the red path), negative or non-integer = usage error.
 */
export const MARKER_WAIT_MS_ENV = "INVOCATION_DEATH_MARKER_WAIT_MS";

/**
 * The headroom multiplier over the starved floor for survive put start (audio-feed-wjtpb).
 *
 * 15 x MEASURED_STARVED_POLL_MS matches the repo's standard HANG_BOUND_MS derivation
 * (scripts/proof-cdp.ts) and DEFAULT_MARKER_WAIT_MS: 120s of headroom so a gate-loaded
 * VM never trips on scheduling delays while earlier stages run, but a genuine hang
 * is bounded.
 */
export const SURVIVE_PUT_START_HEADROOM = 15;

/** Function deriving the survive put-start wait from the starved-poll floor. */
export function survivePutStartWaitMs(floorMs: number): number {
  return SURVIVE_PUT_START_HEADROOM * floorMs;
}

/** The default give-up bound for the survive control put start: 120s (15 x 8_000ms). */
export const DEFAULT_SURVIVE_PUT_START_WAIT_MS = survivePutStartWaitMs(MEASURED_STARVED_POLL_MS);

/**
 * Env var overriding the survive put-start wait in milliseconds; 0 = give up immediately
 * (the red path), negative or non-integer = usage error.
 */
export const SURVIVE_PUT_START_WAIT_MS_ENV = "INVOCATION_DEATH_SURVIVE_PUT_START_WAIT_MS";

/**
 * The child's default per-turn estimate for the batch's budget preflight (1ms).
 *
 * audio-feed-zpyx0: this is the child's model of "one TTS turn", which the claim loop compares
 * against the budget REMAINING when it reaches the claim (`remaining < turnEstimate + flushMargin`
 * -> break without claiming). One millisecond is the production shape shrunken, kept so every
 * other row reaches the upload stage. Raising it past the child's `maxInvocationDurationMs` models
 * the STARVED host the settle-first abort exists for (earlier stages ate the budget, so one more
 * turn no longer fits) and settles the batch before any put - deterministically, with no sleep.
 */
export const DEFAULT_ESTIMATED_TURN_MS = 1;

/**
 * Env var overriding the child's per-turn estimate in milliseconds (non-negative integer).
 */
export const ESTIMATED_TURN_MS_ENV = "INVOCATION_DEATH_ESTIMATED_TURN_MS";

/**
 * Env var introducing an artificial delay in milliseconds before the put starts (for testing).
 */
export const STAGE_DELAY_MS_ENV = "INVOCATION_DEATH_STAGE_DELAY_MS";

/**
 * Env var forcing the child to wedge before starting the put (for testing the hang bound).
 */
export const STAGE_WEDGE_ENV = "INVOCATION_DEATH_STAGE_WEDGE";
