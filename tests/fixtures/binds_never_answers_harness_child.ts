/**
 * Child fixture for tests/proof_helper_test.ts (audio-feed-57ape).
 * Binds an ephemeral port and logs its READY line, but NEVER answers: every
 * request is accepted and hangs. Pins the second named timeout case in
 * spawnHarness ("the child bound port N but /health never answered OK")
 * behind a small bound; spawnHarness kills this child on timeout.
 */
Deno.serve(
  {
    port: 0,
    onListen: ({ port }) => console.log(`READY port=${port}`),
  },
  () => new Promise<Response>(() => {}),
);
