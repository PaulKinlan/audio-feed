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
 *
 * ONE CLONE PER RUN OF THIS FILE, SHARED BY BOTH ROWS (audio-feed-2rr49). Each row used to build its
 * own disposable clone, and a fresh clone's inner gate run pays a COLD whole-repo `deno task check`:
 * deno's type-check cache is keyed by absolute path, so a new temp dir is never warm. Measured on the
 * fleet VM, 2026-10-26, identical tree: cold check 237s, warm check 3s (plus ~25s of clone + hooks +
 * lint per row). Two rows therefore spent ~9-13 minutes of a full-gate window here - the rows the
 * merger measured at 9m3s and 4m0s+ when the 3600s ceiling killed the gate at 1256/2358 rows. Sharing
 * the clone pays the cold check ONCE; the second row's inner gate runs the same check over the same
 * paths and it is warm. The sharing changes no verdict: the rows run sequentially, each writes a
 * uniquely-named scratch file and removes it in `finally`, and the clone's pinned origin/main is the
 * same for both. The clone directory itself is removed when this test module's process exits.
 */
interface GateRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The selector's own statement about what it selected, for failure messages (audio-feed-9bco).
 *
 * Extracted so the assertions can QUOTE the plan's decision instead of a re-derivation of it, and so a
 * failure names the selection rather than only the assertion. This reads the selector's own lines; it is
 * not a second classifier, and it never decides anything - it only reports.
 */
function selectionOf(stdout: string): string {
  const lines = stdout.split("\n").filter((l) =>
    l.includes("fast-check:") || l.includes("NO SUITES") || l.includes("coverage: ran")
  );
  return lines.length ? lines.join(" | ") : "(no selection line found in the gate's output)";
}

/**
 * The shared clone for this file's rows, created on first use (audio-feed-2rr49). Deno runs each test
 * MODULE in its own subprocess, so this singleton is per-file: there is exactly one clone per gate
 * run, and no other suite can observe it.
 */
let sharedCloneDir: string | null = null;

async function sharedClone(): Promise<string> {
  if (sharedCloneDir) return sharedCloneDir;
  const dir = await Deno.makeTempDir({ prefix: "fast-gate-fmt-clone-" });
  const cleanup = () => Deno.remove(dir, { recursive: true }).catch(() => {});

  const cloned = await new Deno.Command("git", {
    args: ["clone", "--shared", "-q", ".", dir],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!cloned.success) {
    await cleanup();
    throw new Error("git clone --shared must succeed");
  }

  // audio-feed-p2la: THE SELECTOR REFUSES TO RUN IN A CLONE WHOSE PRE-PUSH GUARD IS NOT ARMED — a
  // gate must not vouch for a tree whose pushes are unguarded — and a fresh clone has no installed
  // hooks (`git clone` does not copy them). So arm it first, with the same step both gate tasks run
  // (`deno task hooks:install`). This is a precondition of the selector now, not an extra assertion:
  // without it the run below stops with "the pre-push guard is NOT armed" and reports no selection
  // at all, which this suite would otherwise read as a formatting regression.
  const armed = await new Deno.Command("deno", {
    args: ["task", "hooks:install"],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...Deno.env.toObject(), GIT_DIR: `${dir}/.git` },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!armed.success) {
    const detail = new TextDecoder().decode(armed.stdout) + new TextDecoder().decode(armed.stderr);
    await cleanup();
    throw new Error(`arming the clone's pre-push guard must succeed: ${detail}`);
  }

  // Pin origin/main to the clone's own HEAD: the committed diff is then EMPTY by construction, so no
  // other branch's commits can reach the selection this test is about to assert a property of.
  const pinned = await new Deno.Command("git", {
    args: ["update-ref", "refs/remotes/origin/main", "HEAD"],
    cwd: dir,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!pinned.success) {
    await cleanup();
    throw new Error("update-ref origin/main -> HEAD must succeed");
  }

  sharedCloneDir = dir;
  // The clone outlives a single row by design, so per-row `finally` cannot own it; the module's
  // process exit does. A SIGKILL strands it exactly as the per-row version did - the bounded residue
  // accepted under audio-feed-kp7l / audio-feed-gw4k (see tests/fast_check_test.ts).
  addEventListener("unload", () => {
    Deno.removeSync(dir, { recursive: true });
  });
  return dir;
}

async function runGateInDisposableClone(
  fixturePath: string,
): Promise<GateRun> {
  const dir = await sharedClone();

  // The scratch is repo-relative INSIDE THE CLONE, and untracked, so it is the only file the plan can
  // see. A formatted `.md` is documentation: zero suites by classification. Unique per row, removed in
  // `finally`, so the row that follows still sees exactly one change.
  const scratch = `${dir}/.fast-gate-dqrw-scratch-${crypto.randomUUID()}.md`;
  await Deno.writeTextFile(
    scratch,
    "# fast-gate control scratch\n\nIn the clone; removed in finally; formatted on purpose.\n",
  );

  try {
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
    };
  } finally {
    await Deno.remove(scratch).catch(() => {});
  }
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
      //
      // ASSERTED POSITIVELY, NOT AS AN ABSENCE (audio-feed-9bco). This used to be only
      // `!stdout.includes("fast-check: FULL suite")`, which a PARTIAL widening satisfies: a selector
      // regression selecting some other subset leaves that string out, so the row goes green while the
      // plan is no longer the one this test exists to check. The absence of a marker is not evidence of
      // a classification. The assertions now read what the selector POSITIVELY reports about this change
      // set - a formatted .md inside the clone, which no suite observes - and the zero count comes from
      // the selector's own coverage line. The negative is kept BELOW as a guard, not as the assertion.
      assert(
        stdout.includes("fast-check: NO SUITES SELECTED"),
        `the fmt control must positively classify to ZERO SUITES; selection was: ${
          selectionOf(stdout)
        }`,
      );
      assert(
        /coverage: ran 0 suite\(s\)/.test(stdout),
        `the coverage line must positively report 0 suites, not merely omit the full-suite marker; it said: ${
          selectionOf(stdout)
        }`,
      );
      assert(
        !stdout.includes("fast-check: FULL suite"),
        `the fmt control must not widen to the FULL suite; selection was: ${selectionOf(stdout)}`,
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
    const run = await runGateInDisposableClone(file);
    try {
      const stdout = run.stdout;
      assertEquals(run.code, 0, "gate must pass on formatted file");
      // The point of this control: the gate answers a formatting question WITHOUT the full suite, and it
      // must SAY SO POSITIVELY rather than merely not saying the opposite (audio-feed-9bco). Same
      // reasoning as the row above: an absence check is satisfied by a partial widening.
      assert(
        stdout.includes("fast-check: NO SUITES SELECTED"),
        `the formatted control must positively classify to ZERO SUITES; selection was: ${
          selectionOf(stdout)
        }`,
      );
      assert(
        /coverage: ran 0 suite\(s\)/.test(stdout),
        `the formatted control's coverage line must positively report 0 suites; it said: ${
          selectionOf(stdout)
        }`,
      );
      assert(
        !stdout.includes("fast-check: FULL suite"),
        `the formatted control must not widen to the FULL suite; selection was: ${
          selectionOf(stdout)
        }`,
      );
    } finally {
      await Deno.remove(file).catch(() => {});
    }
  },
});
