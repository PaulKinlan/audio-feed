/**
 * Tests for proof-helper port and profile hygiene (audio-feed-9se).
 *
 * Verifies:
 * - Temporary Chrome profiles are uniquely allocated via mkdtemp and removed by cleanup()
 * - Harness processes bind ephemeral port 0 and report assigned port
 * - Output (stdout and stderr) is retained rather than discarded
 * - Premature harness exit before /health is detected and fails fast
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createTempChromeProfile, spawnHarness } from "../scripts/proof-helper.ts";

Deno.test("proof-helper: createTempChromeProfile creates and cleanly removes temp dir", async () => {
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-test-profile-");
  const stat = await Deno.stat(profileDir);
  assertEquals(stat.isDirectory, true);

  await cleanup();
  await assertRejects(
    async () => await Deno.stat(profileDir),
    Deno.errors.NotFound,
  );
});

Deno.test({
  name: "proof-helper: spawnHarness binds ephemeral port 0 and answers health check",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const harness = await spawnHarness("scripts/account-harness.ts");
    try {
      assertEquals(harness.port > 0, true, `assigned port ${harness.port} must be > 0`);
      const health = await fetch(`${harness.base}/health`);
      assertEquals(health.ok, true);

      const logs = harness.getLogs();
      assertStringIncludes(logs.stdout, `READY port=${harness.port}`);
    } finally {
      harness.kill();
    }
  },
});

Deno.test({
  name: "proof-helper: spawnHarness fails fast if child process exits prematurely",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    // Test with non-existent or failing script argument
    await assertRejects(
      async () => {
        await spawnHarness("scripts/non-existent-script.ts", [], { timeoutMs: 3000 });
      },
      Error,
      "exited prematurely",
    );
  },
});
