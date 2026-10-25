/**
 * Child fixture for tests/proof_helper_test.ts (audio-feed-57ape).
 * Never prints READY, never binds, never answers /health: it pins
 * spawnHarness's fail-fast timeout path behind a SMALL bound, so the
 * mechanism is verified deterministically without racing a loaded host's
 * cold start. spawnHarness is expected to kill this child on timeout.
 * (A pending interval keeps the event loop alive; a top-level await of a
 * never-resolving promise makes Deno exit with an error instead.)
 */
setInterval(() => {}, 1000);
