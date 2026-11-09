/**
 * Determinism row for a browser capture (audio-feed-xsvti): run the same declared proof on one tree
 * and assert the artefact it writes is the artefact THE COMMIT HOLDS. A capture that is an instant of
 * playback cannot pass this; a capture that is a state of the page can.
 *
 * WHAT IS COMPARED, AND WHY IT IS THE COMMIT (review of fleet/proof-determinism, P2): the first cut of
 * this row compared the fresh runs to EACH OTHER, which is blind to the drift it was filed for - the
 * committed py5 PNG is 7f655249, two fresh runs both produced 070c5cd8, and "identical to each other,
 * different from the commit" PASSED. Comparing runs to the commit is the only reading that fails on
 * drift, so that is the comparison: the committed bytes are snapshotted before anything runs, and each
 * fresh artefact is measured against them. `bytes` (sha256 of the file) for a binary artefact;
 * `canonical` (the record's own volatile-free projection, see canonicalDigest) for JSON, so a proof
 * that stamps the wall clock into its artefact is still comparable. Run-to-run agreement is reported
 * beside it, because "this machine drifts between runs" and "this machine differs from the commit"
 * are different findings and the operator should not have to guess which one they have.
 *
 * WHY THIS IS A ROW AND NOT A UNIT TEST: the only thing that can vary is real Chrome rendering the
 * real player, so the check has to drive the committed proof against the committed evidence dir. A
 * test in the gate would do the same work while REWRITING tracked artefacts under every parallel
 * suite, so this runs as an explicit row and always puts the committed bytes back, leaving the tree
 * exactly as it found it.
 *
 * HOW THE CAPTURE IS HELD STILL (mechanism, not luck): the proof pauses #audio at 0s BEFORE the shot
 * and re-reads `paused`/`currentTime` AFTER it, and finishes the finite paint transitions and waits
 * for `getAnimations()` to report none running. Every varying input is therefore a value the proof
 * sets and re-asserts, not a clock it races - if the element had resumed, the proof reds instead of
 * writing a shot that differs from the last one.
 *
 * EXITS: 0 pass, 1 the artefact differs (or the proof run failed), 2 bad flags, 3 the tree came back
 * DIRTY - never an expected outcome, and distinct from 1 so the self-check below can tell "the
 * comparison red" from "the restore broke".
 *
 * MUTANTS (this row must be able to fail): delete the pause/finish block in
 * scripts/listen-browser-proof.ts so the shot is taken during playback - the fresh shots then differ
 * from the commit and from each other (the measured shift was 175 px across the player row,
 * audio-feed-xsvti). Point `--dir` at an evidence dir whose committed artefact was written by a
 * different machine and the row reds on the commit comparison alone, which is the defect this
 * version exists to stop passing.
 *
 *   deno run --allow-read --allow-write --allow-run=deno,timeout,git --allow-env \
 *     scripts/capture-determinism-check.ts [--dir audio-feed-py5] [--runs 2]
 *     scripts/capture-determinism-check.ts --self-check   # the clean-tree row, see below
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { canonicalDigest, hashEvidenceDir, sha256Hex } from "./evidence-run.ts";

const ROOT = dirname(fromFileUrl(new URL("../deno.json", import.meta.url)));
const SELF = fromFileUrl(import.meta.url);

function arg(name: string, fallback: string): string {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 && Deno.args[at + 1] ? Deno.args[at + 1]! : fallback;
}

const dirName = arg("dir", "audio-feed-py5");
const dir = `docs/evidence/${dirName}`;
const dirAbs = join(ROOT, dir);
const runs = Number(arg("runs", "2"));
if (!Number.isInteger(runs) || runs < 2) {
  console.error(
    `[determinism] --runs must be an integer >= 2 (got ${JSON.stringify(arg("runs", "2"))})`,
  );
  Deno.exit(2);
}

async function runProofOnce(): Promise<void> {
  const command = new Deno.Command("deno", {
    args: ["task", "evidence", "--only", dirName],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (output.code !== 0) {
    throw new Error(
      `[determinism] the proof run failed (exit ${output.code}):\n` +
        new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr),
    );
  }
}

/**
 * Every file in the evidence dir, verbatim, README.md and run.json included - not just the artefacts
 * `hashEvidenceDir` scopes. Restoring only the hashed set would leave anything the proof rewrites
 * outside it (the record) in the tree, which is the dirty exit 3 this row exists to prevent.
 */
async function snapshotDir(): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const kept = new Map<string, Uint8Array<ArrayBuffer>>();
  async function walk(rel: string): Promise<void> {
    const abs = rel === "" ? dirAbs : join(dirAbs, rel);
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(abs)) entries.push(entry);
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.isSymlink) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory) await walk(childRel);
      else kept.set(childRel, await Deno.readFile(join(dirAbs, childRel)));
    }
  }
  await walk("");
  return kept;
}

async function restore(kept: Map<string, Uint8Array<ArrayBuffer>>): Promise<void> {
  const now = await snapshotDir();
  for (const name of now.keys()) {
    if (!kept.has(name)) await Deno.remove(join(dirAbs, name));
  }
  for (const [name, bytes] of kept) await Deno.writeFile(join(dirAbs, name), bytes);
}

/**
 * What "the same artefact" means for one file: a JSON artefact by its canonical digest (so a proof
 * that stamps a wall clock into it is still comparable, audio-feed-fufd0), anything else by its
 * bytes. The prefix stays in the compared string so a JSON and a binary artefact can never read as
 * equal by sharing a digest, and so a failure line says which reading failed.
 */
async function comparableDigest(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (name.endsWith(".json")) {
    const canonical = await canonicalDigest(name, bytes);
    if (canonical !== null) return `canonical ${canonical}`;
  }
  return `bytes ${await sha256Hex(bytes)}`;
}

/**
 * The artefacts under comparison: the union of what the commit holds and what the run wrote, so a
 * fresh run that stops writing an artefact is a difference rather than an absent row. README.md and
 * run.json are out of scope - `hashEvidenceDir` defines that scope, and the record's own stamps move
 * on every run by design.
 */
async function comparableDigests(
  files: Map<string, Uint8Array<ArrayBuffer>>,
  scope: Set<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of [...scope].sort()) {
    const bytes = files.get(name);
    if (bytes === undefined) continue;
    out.set(name, await comparableDigest(name, bytes));
  }
  return out;
}

/** `git status --porcelain` for this evidence dir only, so the comparison is about what we touched. */
async function porcelain(): Promise<string> {
  const output = await new Deno.Command("git", {
    args: ["status", "--porcelain", "--", dir],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    throw new Error(
      `[determinism] git status failed (exit ${output.code}):\n` +
        new TextDecoder().decode(output.stderr),
    );
  }
  return new TextDecoder().decode(output.stdout);
}

/**
 * ROW (review of fleet/proof-determinism, P2): the FAIL path must leave the tree exactly as it found
 * it. `Deno.exit(1)` does not run a `finally`, so the pre-review code restored on a PASS and left the
 * freshly captured artefact in the working tree on a FAIL - the one outcome that rewrites tracked
 * bytes is the one that did not put them back. This runs the check AGAIN as a child with
 * `--force-fail`, which reds the comparison after the last run without needing a mutant proof, and
 * asserts two things: the child exits 1 (it red the comparison, not the tree - a dirty tree is exit 3),
 * and `git status --porcelain` for the dir is IDENTICAL before and after.
 *
 * MUTANT: put `Deno.exit(1)` back on the fail path. The child still exits 1, so the exit code alone
 * cannot tell the difference - which is why the porcelain comparison is here and not in the child -
 * and this row then reds naming the artefact the child left modified.
 */
async function selfCheckFailPath(): Promise<void> {
  const before = await porcelain();
  const child = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run=deno,timeout,git",
      "--allow-env",
      SELF,
      "--dir",
      dirName,
      "--runs",
      String(runs),
      "--force-fail",
    ],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const after = await porcelain();
  const problems: string[] = [];
  if (child.code !== 1) {
    problems.push(
      `the forced-failure child must exit 1 (the comparison red), got ${child.code}` +
        (child.code === 3 ? " - the child itself reported a dirty tree" : ""),
    );
  }
  if (before !== after) {
    problems.push(
      "the forced-failure child left the tree dirty - the FAIL path did not restore:\n" +
        `  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`,
    );
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[determinism] ${problem}`);
    console.error(
      "[determinism] FAIL self-check: a failing run of this check must leave the tree as it found it " +
        "(review of fleet/proof-determinism, P2)",
    );
    Deno.exitCode = 1;
    return;
  }
  console.log(
    `[determinism] PASS self-check ${dir}: a forced-failing run exited 1 and left ${dir} byte- and ` +
      `status-identical (git status --porcelain unchanged, review of fleet/proof-determinism, P2)`,
  );
}

if (Deno.args.includes("--self-check")) {
  await selfCheckFailPath();
} else {
  const forceFail = Deno.args.includes("--force-fail");
  const committedFiles = await snapshotDir();
  const committedScope = new Set(Object.keys(await hashEvidenceDir(dirAbs)));
  const committed = await comparableDigests(committedFiles, committedScope);
  const before = await porcelain();

  const perRun: Map<string, string>[] = [];
  let failure: string | null = null;
  try {
    for (let run = 1; run <= runs; run++) {
      await runProofOnce();
      const freshFiles = await snapshotDir();
      const scope = new Set([...committedScope, ...Object.keys(await hashEvidenceDir(dirAbs))]);
      perRun.push(await comparableDigests(freshFiles, scope));
    }

    const names = [...new Set(perRun.flatMap((map) => [...map.keys()]))].sort();
    const fromCommit: string[] = [];
    const betweenRuns: string[] = [];
    for (const name of names) {
      const fresh = perRun.map((map) => map.get(name) ?? "<absent>");
      const held = committed.get(name) ?? "<absent in the commit>";
      const seen = new Set(fresh);
      const moved = fresh.some((digest) => digest !== held);
      console.log(
        `[determinism] ${name}: committed ${held}; fresh ${fresh.join(" vs ")}` +
          `${moved ? " MOVED FROM THE COMMIT" : ""}${seen.size > 1 ? " RUNS DISAGREE" : ""}`,
      );
      if (moved) fromCommit.push(name);
      if (seen.size > 1) betweenRuns.push(name);
    }
    if (fromCommit.length > 0) {
      failure =
        `[determinism] FAIL ${dir}: ${fromCommit.length} artefact(s) differ from the COMMITTED ` +
        `artefact - the committed evidence was not reproducible from this tree, so it is not a ` +
        `statement about this code (review of fleet/proof-determinism, P2)`;
    }
    if (betweenRuns.length > 0) {
      failure =
        `[determinism] FAIL ${dir}: ${betweenRuns.length} artefact(s) differ between ${runs} runs ` +
        `of the same tree - the capture is an instant, not a state (audio-feed-xsvti)`;
    }
    if (forceFail) {
      failure =
        `[determinism] FAIL ${dir}: --force-fail, by request: the comparison is failed after the ` +
        `last run so the FAIL path (restore + non-zero exit) runs on a real tree. ` +
        `${failure ?? "Nothing differed."}`;
    }
    if (failure === null) {
      console.log(
        `[determinism] PASS ${dir}: ${names.length} artefact(s) reproduced the COMMITTED artefact ` +
          `across ${runs} runs of the same tree (audio-feed-xsvti)`,
      );
    }
  } catch (err) {
    failure = `[determinism] FAIL ${dir}: ${(err as Error).message}`;
  } finally {
    await restore(committedFiles);
  }

  const after = await porcelain();
  if (failure !== null) console.error(failure);
  if (before !== after) {
    console.error(
      `[determinism] DIRTY TREE ${dir}: the check did not put the tree back, so its result cannot ` +
        `be trusted.\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`,
    );
    Deno.exitCode = 3;
  } else if (failure !== null) {
    Deno.exitCode = 1;
  }
}
