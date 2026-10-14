import { assert, assertEquals } from "@std/assert";

/**
 * A DISPOSABLE CLONE WHOSE CHANGE SET THIS SUITE OWNS (audio-feed-dqrw).
 *
 * The fmt fixture is deliberately OUTSIDE the repo, so a SIGKILL cannot strand an unformatted file
 * that fails the next gate's bare `deno fmt --check`. That is right, and it stays. But it also means
 * `changedFiles()` - three git queries rooted at ROOT - saw an EMPTY change set for this run, and an
 * empty change set is not inert documentation: the plan cannot claim anything about it, so the gate
 * widened to the FULL suite. A scratch `.md` in the repo root fixed that, because a formatted `.md` is
 * documentation and the plan is then zero suites BY CLASSIFICATION rather than by accident.
 *
 * IT DID NOT FIX THE REAL DEFECT, WHICH IS THAT THIS SUITE'S VERDICT WAS A FUNCTION OF OTHER LANES'
 * FILES (audio-feed-8qnu, audio-feed-otc9). The suite runs the selector and then asserts a property
 * about the SELECTION, so with the ambient change set in play any branch that touches a shared helper
 * made it red for reasons of its own - and it could not tell that apart from a real regression in the
 * formatting control it guards. That is a machine-state-dependent test, which the fleet's rules name
 * as a defect rather than an inconvenience: it turns every such branch red, for no reason of its own.
 *
 * So the selector now runs in a clone that this suite constructs and pins. `refs/remotes/origin/main`
 * is set to the clone's own HEAD, so the committed diff is EMPTY, and the scratch `.md` is the ONLY
 * change the clone can see. The change set the assertion judges is therefore the one the test owns.
 *
 * THE PROPERTY IS NOT WEAKENED, AND THE ASSERTION IS NOT A TAUTOLOGY. It still demands that a
 * formatting-only change classify to ZERO SUITES rather than widen to a full run, which is what
 * audio-feed-otc9 built it for; it is now simply a claim about a change set the test controls instead
 * of one ambient luck happened to supply. Note this does NOT short-circuit `changedFiles()`: that is
 * forbidden by landed design - scripts/fast-check.ts records that "audio-feed-8rz5 / audio-feed-vdys:
 * Ambient environment variables and programmatic options CANNOT short-circuit changedFiles" - so the
 * gate still resolves its own change set, in a directory where that resolution is deterministic.
 *
 * The clone idiom (git clone --shared, git update-ref) follows tests/fast_check_test.ts.
 */
interface GateRun {
  code: number;
  stdout: string;
  stderr: string;
  cleanup: () => Promise<void>;
}

async function runGateInDisposableClone(
  fixturePath: string,
): Promise<GateRun> {
  const dir = await Deno.makeTempDir({ prefix: "fast-gate-fmt-clone-" });
  const git = (args: string[]) =>
    new Deno.Command("git", { args, cwd: dir, stdout: "null", stderr: "piped" }).output();

  const cloned = await new Deno.Command("git", {
    args: ["clone", "--shared", "-q", ".", dir],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!cloned.success) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw new Error("git clone --shared must succeed");
  }

  // Pin origin/main to the clone's own HEAD: the committed diff is then EMPTY by construction, so no
  // other branch's commits can reach the selection this test is about to assert a property of.
  const pinned = await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (!pinned.success) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw new Error("update-ref origin/main -> HEAD must succeed");
  }

  // The scratch is repo-relative INSIDE THE CLONE, and untracked, so it is the only file the plan can
  // see. A formatted `.md` is documentation: zero suites by classification.
  const scratch = `${dir}/.fast-gate-dqrw-scratch-${crypto.randomUUID()}.md`;
  await Deno.writeTextFile(
    scratch,
    "# fast-gate control scratch\n\nIn the clone; removed in finally; formatted on purpose.\n",
  );

  const out = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-run=git,deno",
      "--allow-env",
      "scripts/fast-check.ts",
      "--fmt-fixture",
      fixturePath,
    ],
    cwd: dir,
    env: {
      ...Deno.env.toObject(),
      IN_FAST_GATE_INTEGRATION_TEST: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();

  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

Deno.test({
  name: "audio-feed-8qnu: fmt failure does not stop the gate before coverage",
  ignore: !!Deno.env.get("IN_FAST_GATE_INTEGRATION_TEST"),
  fn: async () => {
    // Keep the fixture outside the repo: SIGKILL bypasses finally, but cannot
    // strand an untracked file that breaks the next gate's bare fmt step.
    const file = await Deno.makeTempFile({ prefix: "audio-feed-unformatted-", suffix: ".ts" });
    await Deno.writeTextFile(file, "Deno.test('x', ()=>{})");
    const run = await runGateInDisposableClone(file);
    try {
      const out = { code: run.code };
      const stdout = run.stdout;

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
      await run.cleanup();
    }
  },
});

Deno.test({
  name: "audio-feed-8qnu control: formatted file passes gate without extra work",
  ignore: !!Deno.env.get("IN_FAST_GATE_INTEGRATION_TEST"),
  fn: async () => {
    const file = await Deno.makeTempFile({ prefix: "audio-feed-formatted-", suffix: ".ts" });
    await Deno.writeTextFile(file, 'Deno.test("x", () => {});\n');
    const run = await runGateInDisposableClone(file);
    try {
      const stdout = run.stdout;
      assertEquals(run.code, 0, "gate must pass on formatted file");
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
      await run.cleanup();
    }
  },
});
