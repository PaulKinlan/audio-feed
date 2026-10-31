import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";

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
 * The wall-clock bound on the nested gate this file spawns, and the legibility of its kill
 * (audio-feed-66crb).
 *
 * MEASURED DEFECT: the nested run was a bare `new Deno.Command("deno", ...).output()` with NO
 * bound - no timeout binary, no signal, no wall-clock guard. It embeds an entire fast gate in a
 * test row, so the row's cost is the clone's gate cost, which scales with host contention and is
 * invisible to the outer gate's accounting until it is spent: at loadavg 15.4 on 8 CPUs the row
 * ran 33m59s and then failed (bead audio-feed-66crb, job 55c752c1), and because the outer gate
 * waits on the row, its own 5400s bound was charged with time it cannot control - a live gate
 * projected 10578s against 5400s.
 *
 * WHY 1800s: the nested run IS a fast gate, so it gets the same ceiling the fleet's fast gate
 * applies to itself (`CHECK_FAST_TIMEOUT=1800`, docs/speed.md "Fast-gate bound: CHECK_FAST_TIMEOUT
 * is 1800 s"; the value lives in the fleet-side `~/fleet/bin/fleet-check:365`) - the bound the
 * filing bead names as the fair one. The quiet measured cost of the whole row is 0.3-1s
 * (audio-feed-66crb), and the clone+hooks+lint overhead was ~25s (audio-feed-2rr49, measured
 * 2026-10-26); 1800s clears those by orders of magnitude, so a legitimately slow-but-progressing
 * run survives a loaded host. The observed contention death (2040s) is capped at 1800s (+30s
 * SIGKILL grace), and the worst case - BOTH rows of this file at the bound, sharing one clone -
 * is 3660s, still inside the outer gate's 5400s. A ceiling is a failure bound, never a speed
 * budget (docs/speed.md): a row that legitimately needs this bound is already a landing problem;
 * the alternative was that it silently ate the landing gate.
 */
const NESTED_GATE_BOUND_SECONDS = 1800;

/**
 * Run `command` under GNU `timeout -k 30 <boundSeconds>`, and make a bound-kill LEGIBLE
 * (audio-feed-66crb).
 *
 * MECHANISM: the GNU `timeout` wrapper is this repo's existing child-process bound
 * (scripts/evidence-run.ts, scripts/exww-mutants.ts) and is chosen over a JavaScript kill timer
 * (the tests/tts_hardening_test.ts shape) deliberately: `timeout` without `--foreground` puts the
 * command in its own process group and signals the GROUP, and the nested gate spawns its own
 * children (`deno fmt`, `deno lint`, `deno test`) that a single-process kill would leave behind
 * holding the output pipes - the exact wedge scripts/evidence-run.ts documents. `-k 30` SIGKILLs
 * the group if the first signal is ignored, and SIGKILL cannot be ignored, so `.output()` unblocks
 * at <= bound + 30s by construction and no JS backstop is needed. Exit convention: 124 means the
 * bound was hit, and `timeout` passes every other exit status through unchanged.
 *
 * cwd is passed through to the spawn UNCHANGED (audio-feed-66crb review fix): undefined inherits
 * the caller's working directory, a string becomes Deno.Command's cwd. This is load-bearing — the
 * nested gate MUST run in the disposable clone (the row's scratch `.md` and its pinned origin/main
 * exist only there), and the 66crb proof row below asserts a command's reported cwd so a dropped
 * passthrough fails instead of silently rerunning the gate in the wrong tree.
 */
async function runBounded(
  command: readonly string[],
  boundSeconds: number,
  what: string,
  env?: Record<string, string>,
  cwd?: string,
): Promise<GateRun> {
  const out = await new Deno.Command("timeout", {
    args: ["-k", "30", `${boundSeconds}`, ...command],
    env: { ...Deno.env.toObject(), ...(env ?? {}) },
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  const run: GateRun = {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
  if (out.code === 124) {
    throw new Error(
      `BOUND KILL: ${what} was killed at its ${boundSeconds}s wall-clock bound (GNU timeout exit 124; ` +
        `-k 30 SIGKILLs the process group if it ignored SIGTERM). This is host contention or a hang, ` +
        `NOT a product failure - do not bisect product code for it. The nested run's partial output ` +
        `before the kill:\n${run.stdout}\n${run.stderr}`,
    );
  }
  return run;
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
  // accepted under audio-feed-kp7l / audio-feed-gw4k (see tests/fast_check_test.ts). The removeSync is
  // guarded (audio-feed-efgpr): an exit-time throw from an already-removed or unreadable dir must not
  // turn a passing module into a failing one.
  addEventListener("unload", () => {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // Exit-time best effort only; the temp dir residue is bounded and accepted.
    }
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
    // audio-feed-66crb (review fix): the nested gate runs under NESTED_GATE_BOUND_SECONDS via
    // runBounded - the SAME spawn as the pre-bound code (same binary, args, cwd and env, with cwd
    // now travelling through runBounded's own parameter after an intermediate revision dropped it
    // and silently ran the gate in the OUTER checkout), plus a wall-clock bound and a legible
    // bound-kill, so a loaded host cannot spend the outer gate's bound on one row.
    return await runBounded(
      [
        "deno",
        "run",
        "--allow-read",
        "--allow-run=git,deno",
        "--allow-env",
        "scripts/fast-check.ts",
        "--fmt-fixture",
        fixturePath,
        // audio-feed-efgpr: the clone's tree is byte-identical to the outer HEAD this module is
        // running inside, which the OUTER gate already type-checked; the in-clone `deno task check`
        // is ~4 minutes of cold-cache duplicate work per row (deno's check cache is keyed by
        // absolute path, and the clone's path is fresh). The flag is honoured only with
        // --fmt-fixture, and the run says SKIPPED out loud - the rows below assert that line so a
        // silently un-honoured flag is a failure, not a slowdown nobody notices.
        "--skip-type-check",
      ],
      NESTED_GATE_BOUND_SECONDS,
      `the nested fast gate in the disposable clone at ${dir} (fixture ${fixturePath})`,
      { IN_FAST_GATE_INTEGRATION_TEST: "1" },
      // The clone, not the test process's cwd: the scratch `.md`, the pinned origin/main and the
      // armed guard all live in the clone, so the inner gate's change-set resolution is only
      // correct if it runs there (the 66crb proof row asserts this passthrough).
      dir,
    );
  } finally {
    await Deno.remove(scratch).catch(() => {});
    // audio-feed-efgpr: the clone is SHARED with the next row, so a row must hand it over in the
    // state it received it: no scratch residue (a bypassed remove, an interrupted run) and no
    // tracked mutation the inner gate or a failed assertion path may have left. Without this the
    // second row's change set - the thing the assertion judges - is a function of the first row's
    // leftovers, the same machine-state defect the clone exists to close.
    const git = (args: string[]) =>
      new Deno.Command("git", { args, cwd: dir, stdout: "null", stderr: "null" }).output();
    await git(["reset", "--hard", "-q", "HEAD"]).catch(() => {});
    await git(["clean", "-fdq"]).catch(() => {});
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

      // (a2) the type-check opt-out must be HONOURED AND SAID (audio-feed-efgpr): a silently
      // un-honoured flag would leave this row paying the ~4-minute cold in-clone check again,
      // green and slow, which is the regression 2rr49/efgpr exist to close.
      assert(
        stdout.includes("fast-check: type-check SKIPPED"),
        `the inner run must say the type-check was skipped; output was: ${selectionOf(stdout)}`,
      );

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
      assert(
        stdout.includes("fast-check: type-check SKIPPED"),
        `the inner run must say the type-check was skipped (audio-feed-efgpr); output was: ${
          selectionOf(stdout)
        }`,
      );
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

Deno.test({
  name:
    "audio-feed-66crb: the nested gate's spawn carries a wall-clock bound, and a bound-kill says so itself",
  // This row proves the BOUND MECHANISM, not the gate: a 2s bound on a command that would sleep
  // 30s, so it costs ~2s and never spawns a gate (the 8qnu rows above keep the whole-gate cost).
  // It does not recurse, so unlike those rows it does not need the IN_FAST_GATE_INTEGRATION_TEST
  // ignore and runs everywhere.
  fn: async () => {
    // (a) A normal exit passes through the wrapper UNCHANGED, so the 8qnu rows' exit-code
    // assertions still mean the gate's own status, not the wrapper's.
    const passed = await runBounded(
      ["git", "--version"],
      60,
      "bound-proof passthrough",
      undefined,
      undefined,
    );
    assertEquals(passed.code, 0, "a command exiting 0 under a 60s bound must exit 0 unchanged");

    // (b) The bound fires, and the failure NAMES the bound and says the kill is contention or a
    // hang rather than a product failure, so the next reader does not bisect a product bug
    // (audio-feed-66crb).
    const error = await assertRejects(() =>
      runBounded(
        ["sleep", "30"],
        2,
        "bound-proof: sleep 30 under a 2s bound",
        undefined,
        undefined,
      )
    );
    assert(error instanceof Error, "a bound-kill must surface as an Error");
    assertStringIncludes(error.message, "BOUND KILL");
    assertStringIncludes(
      error.message,
      "killed at its 2s wall-clock bound",
      "the bound-kill message must name the bound",
    );
    assertStringIncludes(
      error.message,
      "NOT a product failure",
      "the bound-kill message must say the kill is host contention or a hang",
    );

    // (c) THE CWD REACHES THE COMMAND. The pre-bound spawn passed `cwd: dir` straight to
    // Deno.Command; runBounded must pass it through just as faithfully, because the nested gate is
    // only correct if it runs in the disposable clone (its scratch `.md`, pinned origin/main and
    // armed guard exist only there). This assertion is what was missing when the parameter was
    // dropped: (a) and (b) prove passthrough with commands (`git --version`, `sleep`) that behave
    // identically anywhere, so a missing cwd was invisible. A command that REPORTS its own working
    // directory makes the drop a loud red instead of a silently wrong gate.
    const cwdDir = await Deno.makeTempDir({ prefix: "audio-feed-bound-cwd-proof-" });
    try {
      const inDir = await runBounded(
        ["deno", "eval", "console.log(Deno.cwd())"],
        60,
        "bound-proof cwd passthrough",
        undefined,
        cwdDir,
      );
      assertEquals(inDir.code, 0, "deno eval reporting its cwd must exit 0 under the bound");
      assertStringIncludes(
        inDir.stdout,
        cwdDir,
        `the spawned command must run with cwd set to the temp dir; it reported: ${inDir.stdout.trim()}`,
      );
    } finally {
      await Deno.remove(cwdDir, { recursive: true }).catch(() => {});
    }
  },
});
