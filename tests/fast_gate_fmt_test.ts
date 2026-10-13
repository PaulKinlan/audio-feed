import { assert, assertEquals } from "@std/assert";

Deno.test({
  name: "audio-feed-8qnu: fmt failure does not stop the gate before coverage",
  ignore: !!Deno.env.get("IN_FAST_GATE_INTEGRATION_TEST"),
  fn: async () => {
    // Keep the fixture outside the repo: SIGKILL bypasses finally, but cannot
    // strand an untracked file that breaks the next gate's bare fmt step.
    const file = await Deno.makeTempFile({ prefix: "audio-feed-unformatted-", suffix: ".ts" });
    await Deno.writeTextFile(file, "Deno.test('x', ()=>{})");
    try {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-run=git,deno",
          "--allow-env",
          "scripts/fast-check.ts",
        ],
        env: {
          ...Deno.env.toObject(),
          IN_FAST_GATE_INTEGRATION_TEST: "1",
          FAST_GATE_FMT_FIXTURE: file,
        },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      const stdout = new TextDecoder().decode(out.stdout);

      // (a) gate must still fail
      assertEquals(out.code, 1, "gate must fail on unformatted file");

      // (b) coverage result must be reported
      assert(
        stdout.includes("fast-gate: coverage: ran "),
        "gate must report coverage even when fmt fails",
      );
      assert(
        !stdout.includes("UNKNOWN - the gate stopped before the test harness"),
        "gate must not report UNKNOWN coverage",
      );
    } finally {
      await Deno.remove(file).catch(() => {});
    }
  },
});

Deno.test({
  name: "audio-feed-8qnu control: formatted file passes gate without extra work",
  ignore: !!Deno.env.get("IN_FAST_GATE_INTEGRATION_TEST"),
  fn: async () => {
    const file = await Deno.makeTempFile({ prefix: "audio-feed-formatted-", suffix: ".ts" });
    await Deno.writeTextFile(file, 'Deno.test("x", () => {});\n');
    try {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-run=git,deno",
          "--allow-env",
          "scripts/fast-check.ts",
        ],
        env: {
          ...Deno.env.toObject(),
          IN_FAST_GATE_INTEGRATION_TEST: "1",
          FAST_GATE_FMT_FIXTURE: file,
        },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      assertEquals(out.code, 0, "gate must pass on formatted file");
    } finally {
      await Deno.remove(file).catch(() => {});
    }
  },
});
