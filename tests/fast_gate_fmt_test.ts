import { assert, assertEquals } from "@std/assert";

/**
 * A repo-relative, already-formatted, inert scratch file (audio-feed-otc9).
 *
 * The fmt fixture above is deliberately OUTSIDE the repo, so a SIGKILL cannot strand an unformatted
 * file that fails the next gate's bare `deno fmt --check`. That is right, and it stays. But it also
 * means `changedFiles()` - three git queries rooted at ROOT - sees an EMPTY change set for this run,
 * and an empty change set is not inert documentation: the plan cannot claim anything about it, so the
 * gate widens to the FULL suite. That made this formatting control's verdict a function of every other
 * suite's health, and it cost a five-minute full run to answer a formatting question.
 *
 * This file is what makes the change set non-empty. A formatted `.md` is documentation, so the plan is
 * zero suites BY CLASSIFICATION rather than by accident, and if a SIGKILL strands it the next gate's
 * bare fmt step still passes on it (which is the whole reason the fmt fixture lives outside).
 */
function scratchChange(): string {
  const path = new URL(`../.fast-gate-otc9-scratch-${crypto.randomUUID()}.md`, import.meta.url)
    .pathname;
  Deno.writeTextFileSync(
    path,
    "# fast-gate control scratch\n\nRemoved in finally; formatted on purpose.\n",
  );
  return path;
}

Deno.test({
  name: "audio-feed-8qnu: fmt failure does not stop the gate before coverage",
  ignore: !!Deno.env.get("IN_FAST_GATE_INTEGRATION_TEST"),
  fn: async () => {
    // Keep the fixture outside the repo: SIGKILL bypasses finally, but cannot
    // strand an untracked file that breaks the next gate's bare fmt step.
    const file = await Deno.makeTempFile({ prefix: "audio-feed-unformatted-", suffix: ".ts" });
    await Deno.writeTextFile(file, "Deno.test('x', ()=>{})");
    const scratch = scratchChange();
    try {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-run=git,deno",
          "--allow-env",
          "scripts/fast-check.ts",
          "--fmt-fixture",
          file,
        ],
        env: {
          ...Deno.env.toObject(),
          IN_FAST_GATE_INTEGRATION_TEST: "1",
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
      // (c) and the selection must be HONEST rather than accidental: a formatting control that
      // widens to the full suite passes or fails with every unrelated suite (audio-feed-otc9).
      assert(
        !stdout.includes("fast-check: FULL suite"),
        `the fmt control must not widen to the FULL suite; selection was: ${
          stdout.split("\n").filter((l) => l.includes("fast-check:") || l.includes("NO SUITES"))
            .join(" | ")
        }`,
      );
    } finally {
      await Deno.remove(file).catch(() => {});
      await Deno.remove(scratch).catch(() => {});
    }
  },
});

Deno.test({
  name: "audio-feed-8qnu control: formatted file passes gate without extra work",
  ignore: !!Deno.env.get("IN_FAST_GATE_INTEGRATION_TEST"),
  fn: async () => {
    const file = await Deno.makeTempFile({ prefix: "audio-feed-formatted-", suffix: ".ts" });
    await Deno.writeTextFile(file, 'Deno.test("x", () => {});\n');
    const scratch = scratchChange();
    try {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-run=git,deno",
          "--allow-env",
          "scripts/fast-check.ts",
          "--fmt-fixture",
          file,
        ],
        env: {
          ...Deno.env.toObject(),
          IN_FAST_GATE_INTEGRATION_TEST: "1",
        },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      const stdout = new TextDecoder().decode(out.stdout);
      assertEquals(out.code, 0, "gate must pass on formatted file");
      // The point of this control: the gate answers a formatting question WITHOUT the full suite.
      assert(
        !stdout.includes("fast-check: FULL suite"),
        `the formatted control must not widen to the FULL suite; selection was: ${
          stdout.split("\n").filter((l) => l.includes("fast-check:") || l.includes("NO SUITES"))
            .join(" | ")
        }`,
      );
    } finally {
      await Deno.remove(file).catch(() => {});
      await Deno.remove(scratch).catch(() => {});
    }
  },
});
