/**
 * audio-feed-p2la — MEASURE whether this clone's pre-push guard is armed.
 *
 * `deno task hooks:verify` runs THIS file as a step in BOTH gate tasks, under
 * `--allow-read --allow-run=git` — a narrower permission set than the gate that hosts it. The
 * envelope matters: the installation used to be launched from scripts/fast-check.ts behind
 * `Deno.permissions.querySync`, always DENIED under test:fast's `--allow-run=git,deno`, with the
 * child's exit status discarded — so a clone with no guard gated green. A check that cannot run
 * under the permissions the gate actually has is not a check, so this one runs on its own, with the
 * permissions it needs and no more.
 *
 * scripts/fast-check.ts also calls prepushGuardStatus() in-process (the same function, a second
 * call site) so that DELETING either gate task's verify step still turns that gate RED: the task
 * step covers `deno task gate`, the in-process call covers `deno task test:fast` and a bare
 * `deno run scripts/fast-check.ts`, and both run the same measurement rather than a copy of it.
 *
 * What it reads is what git will actually execute: the hooks directory from
 * `git rev-parse --path-format=absolute --git-path hooks` (so a core.hooksPath that moves it cannot
 * buy a false "armed"), the chain marker in that directory's pre-push, and the executable standalone
 * guard the chain block runs. It deliberately does NOT compare the standalone copy against this
 * tree's scripts/hooks/pre-push: that freshness check belongs to the installer
 * (scripts/hooks/install-hooks.sh), because doing it here would make one worktree's gate depend on
 * the last install performed by a different worktree.
 *
 * Exit codes: 0 = armed, or not a git worktree (which cannot push, and is said out loud rather than
 * silently treated as armed); 1 = NOT armed, naming the file that is missing or wrong.
 *
 * NO IMPORTS, ON PURPOSE: tests/pre_push_hook_test.ts copies this one file into a scratch clone and
 * runs it with the shipped flags, so it has to work there on its own.
 */

/** The marker scripts/hooks/install-hooks.sh writes into the chained hook. */
const PREPUSH_CHAIN_MARKER = "# audio-feed-p2la: chain repo pre-push hook";

/** What measuring a clone's pre-push guard found. */
export type PrepushGuardStatus =
  | { state: "armed"; hooksDir: string; standalone: string }
  | { state: "not-a-worktree" }
  | { state: "not-armed"; hooksDir: string; detail: string };

/** The one sentence both call sites report, so a reader sees the same claim in tests and in gates. */
export function guardNotArmedMessage(
  status: Extract<PrepushGuardStatus, { state: "not-armed" }>,
): string {
  return `the pre-push guard is NOT armed (audio-feed-p2la): ${status.detail}. ` +
    "The gate refuses to vouch for a tree whose pushes are unguarded: run 'deno task hooks:install' " +
    "(the first step of 'deno task test:fast' and 'deno task gate') and fix whatever made it fail.";
}

export function guardVerifiedMessage(
  status: Extract<PrepushGuardStatus, { state: "armed" }>,
): string {
  return `pre-push guard verified: ${status.hooksDir}/pre-push runs ${status.standalone}`;
}

/** Measure whether `root`'s clone has the guard installed where git will look for it. */
export async function prepushGuardStatus(root: string): Promise<PrepushGuardStatus> {
  // A check that cannot ASK git must say so, rather than die with a NotCapable stack trace (which is
  // what the review of audio-feed-p2la measured on the old installer) or quietly continue.
  const canRunGit = Deno.permissions.querySync({ name: "run", command: "git" });
  if (canRunGit.state !== "granted") {
    return {
      state: "not-armed",
      hooksDir: "",
      detail:
        `finding the hooks directory git uses needs to run 'git', and the run permission is '${canRunGit.state}' in this process, so the guard cannot be verified as armed`,
    };
  }

  const runGit = async (args: string[]): Promise<Deno.CommandOutput | null> =>
    await new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "null" })
      .output().catch(() => null);

  const revParse = async (...args: string[]): Promise<string | null> => {
    const out = await runGit(["rev-parse", "--path-format=absolute", ...args]);
    return out?.success ? new TextDecoder().decode(out.stdout).trim() : null;
  };

  const commonDir = await revParse("--git-common-dir");
  const hooksDir = await revParse("--git-path", "hooks");
  if (!commonDir || !hooksDir) {
    // Distinguish "git cannot resolve absolute paths here" (a failure to verify: fail closed) from
    // "this is not a worktree" (cannot push, so there is nothing to guard: a stated limit).
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"]);
    const isWorkTree = inside?.success === true &&
      new TextDecoder().decode(inside.stdout).trim() === "true";
    if (!isWorkTree) return { state: "not-a-worktree" };
    return {
      state: "not-armed",
      hooksDir: "",
      detail:
        "git reported no absolute hooks directory (is --path-format=absolute unsupported here?), so the guard cannot be verified as armed",
    };
  }

  const chainHook = `${hooksDir}/pre-push`;
  const chain = await Deno.readTextFile(chainHook).catch(() => null);
  if (chain === null || !chain.includes(PREPUSH_CHAIN_MARKER)) {
    return {
      state: "not-armed",
      hooksDir,
      detail: `'${chainHook}' does not carry the chain block ('${PREPUSH_CHAIN_MARKER}')`,
    };
  }

  const standalone = `${commonDir}/hooks/audio-feed-pre-push`;
  const stat = await Deno.stat(standalone).catch(() => null);
  if (!stat?.isFile) {
    return {
      state: "not-armed",
      hooksDir,
      detail: `'${standalone}' (the guard the chain block runs) is missing`,
    };
  }
  if (((stat.mode ?? 0) & 0o111) === 0) {
    return {
      state: "not-armed",
      hooksDir,
      detail: `'${standalone}' (the guard the chain block runs) is not executable`,
    };
  }
  return { state: "armed", hooksDir, standalone };
}

/**
 * The repo this file guards, from its own location: <repo>/scripts/hooks/guard-status.ts.
 *
 * A copy that is not in that place is a NAMED failure, not a measurement of whatever directory it
 * happens to sit in — the whole point of this file is that it must not announce a guard it did not
 * look for.
 */
function repoRootForThisFile(): string {
  const here = import.meta.dirname ?? "";
  if (!/[/\\]scripts[/\\]hooks$/.test(here)) {
    console.error(
      `pre-push guard verify FAILED (audio-feed-p2la): this file must live in <repo>/scripts/hooks/ to know which clone it is guarding; it is at '${here}'.`,
    );
    Deno.exit(1);
  }
  return here.replace(/[/\\]scripts[/\\]hooks$/, "") + "/";
}

if (import.meta.main) {
  const status = await prepushGuardStatus(repoRootForThisFile());
  if (status.state === "not-a-worktree") {
    console.error(
      "pre-push guard verify: NOT armed (audio-feed-p2la): not a git worktree, so this tree cannot push and there is nothing to guard; continuing.",
    );
    Deno.exit(0);
  }
  if (status.state === "not-armed") {
    console.error(`pre-push guard verify FAILED: ${guardNotArmedMessage(status)}`);
    Deno.exit(1);
  }
  console.log(guardVerifiedMessage(status));
}
