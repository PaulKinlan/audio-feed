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
 */
export const MEASURED_STARVED_POLL_MS = 8_000;

/** The repo's standard headroom multiplier over the starved floor (HANG_BOUND_MS). */
export const MARKER_WAIT_HEADROOM = 15;

/** The child's default give-up bound: 120s. */
export const DEFAULT_MARKER_WAIT_MS = MARKER_WAIT_HEADROOM * MEASURED_STARVED_POLL_MS;

/**
 * Env var overriding the marker window in milliseconds; 0 = give up immediately
 * (the red path), negative or non-integer = usage error.
 */
export const MARKER_WAIT_MS_ENV = "INVOCATION_DEATH_MARKER_WAIT_MS";
