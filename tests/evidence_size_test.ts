/**
 * audio-feed-39k1 — the evidence tree has a size budget.
 *
 * 18 of the 20 largest files in the repo were docs/evidence PNGs (~285KB
 * each; 15MB total) because the Functional Verification Mandate requires
 * screenshots and nothing bounded their size. The fix is a palette
 * compression pass (`deno task evidence:compress`) plus this check: any
 * evidence PNG over the per-file budget, or a tree over the aggregate budget,
 * fails the suite with the remediation in the message. Per-file alone is not
 * enough: 100 files just under a per-file cap would reproduce the original
 * problem by count (fp4r-style review on the bead).
 */

import { assertEquals } from "@std/assert";
import {
  auditEvidenceSizes,
  EVIDENCE_PNG_BUDGET_BYTES,
  EVIDENCE_TOTAL_BUDGET_BYTES,
  reportEvidenceSizeAudit,
} from "../scripts/evidence-compress.ts";

Deno.test("docs/evidence PNGs stay under the per-file and aggregate budgets", async () => {
  // audio-feed-3teu: the budget is measured on what GIT CARRIES (index, else HEAD), so re-running a proof - which
  // writes a raw 250-500KB screenshot over a compressed committed one - does not redden this gate on a delta that
  // has nothing to do with compression. Over-budget content that IS staged or committed still fails, with the
  // remediation naming the SCOPED command (an unscoped `evidence:compress` rewrites other beads' artefacts).
  const audit = await auditEvidenceSizes();
  reportEvidenceSizeAudit(audit);

  assertEquals(
    audit.oversizedCarried,
    [],
    `evidence PNGs exceed the ${(EVIDENCE_PNG_BUDGET_BYTES / 1024).toFixed(0)}KB budget IN GIT — ` +
      "run `deno task evidence:compress <the directory you changed>` (see docs/evidence/README.md): " +
      audit.oversizedCarried.join(", "),
  );
  assertEquals(
    audit.totalCarried > EVIDENCE_TOTAL_BUDGET_BYTES,
    false,
    `committed evidence is ${(audit.totalCarried / 1024 / 1024).toFixed(1)}MB, over the ` +
      `${(EVIDENCE_TOTAL_BUDGET_BYTES / 1024 / 1024).toFixed(0)}MB aggregate budget — ` +
      "prune stale evidence (docs/evidence/README.md)",
  );
});

/** Repo root, so the git query does not depend on the caller's cwd (scripts/fast-check.ts does the same). */
export const ROOT = import.meta.dirname!.replace(/\/tests$/, "") + "/";

/**
 * audio-feed-fnrp, audio-feed-tgnu, audio-feed-npai — every evidence directory declares what it asserts (docs/evidence/README.md, "Honesty").
 *
 * WHY: the audio-feed-q45b audit found nine proof scripts that fail on main, twelve that leak the browser they
 * claim to clean up, and three whose `check()` could not fail the run — and every one of those was invisible to a
 * reader who trusted the README. This check cannot verify that a claim is TRUE (only a mutation can, which is why
 * the reviewer asks for the mutant); it makes the claim set explicit and keeps the pointer to the tool honest, so
 * judging evidence is reading two lines instead of reading a script.
 *
 * ASK THE TREE (audio-feed-npai): README contents and Script: existence are answered from the same source as the
 * carried set - the git index (`git show :<readme>`, `git cat-file -e :<script>`) - rather than the working
 * directory. A directory git carries whose folder is deleted from the worktree (an unstaged `rm -rf`) reads its
 * declaration from the index and stays green, rather than erroneously failing as "no README.md".
 *
 * THE GRANDFATHER LIST WAS DEBT, NOW DERIVED (audio-feed-tgnu). The grandfather list EVIDENCE_UNDECLARED was a
 * single hand-maintained array that every retrofit slice edited, causing retrofit landings to serialise and
 * conflict textually on this test file. The fix derives the undeclared debt set from git index and README
 * declarations rather than enumerating it. Each directory's README declaration is the source of truth, and git
 * index (carriedEvidenceDirs) is the source of truth for what the tree carries (audio-feed-9qvz, audio-feed-a7e8).
 * Retrofit slices now edit only their own directory's README without touching this shared test file.
 */
export async function checkEvidenceDeclaration(
  name: string,
  root: string = ROOT,
): Promise<string | null> {
  const dir = `${root}docs/evidence/${name}`;
  const readmeRel = `docs/evidence/${name}/README.md`;
  const readmeCmd = await new Deno.Command("git", {
    args: ["show", `:${readmeRel}`],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!readmeCmd.success) {
    return `${dir}: no README.md`;
  }
  const body = new TextDecoder().decode(readmeCmd.stdout);
  const asserts = body.match(/^- Asserts:\s*(.+)$/m)?.[1]?.trim() ?? "";
  // The capture hatch is an ADMISSION, not free text: it must be the literal sentence, otherwise a README can
  // say "- Capture: fully tested and guaranteed", assert nothing and pass (audio-feed-6piu, found in review).
  const capture = /^- Capture:\s*no assertions\s*$/m.test(body);
  const script = body.match(/^- Script:\s*(\S+)/m)?.[1];
  if (!asserts && !capture) {
    return `${dir}: needs a "- Asserts: <claims>" or "- Capture: no assertions" line`;
  }
  if (asserts && !script) {
    return `${dir}: declares Asserts: with no "- Script: scripts/<proof>.ts" to attach them to`;
  }
  if (script) {
    const scriptRel = script.startsWith("scripts/") ? script : `scripts/${script}`;
    const scriptCmd = await new Deno.Command("git", {
      args: ["cat-file", "-e", `:${scriptRel}`],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!scriptCmd.success) return `${dir}: Script: names ${script}, which does not exist`;
  }
  return null;
}

/**
 * audio-feed-9qvz — the evidence directories the TREE carries, asked of git rather than of the working directory.
 *
 * WHY THIS IS A GIT QUERY AND NOT `Deno.stat`: the debt list is a claim about what the REPOSITORY contains, while
 * the working directory is private to whoever is running the suite. A directory that exists on disk but is not in
 * the index - an untracked scratch directory, or the empty folder residue `git rm -r` leaves behind - made the
 * filesystem predicate answer YES for an entry the tree does not carry, so the stale entry this check exists to
 * reject passed locally and failed on a clean clone. The inverse is wrong in the other direction too: a directory
 * the index carries whose folder has been deleted from the worktree (an unstaged `rm -rf`) answered NO, reddening a
 * run for a tree that is perfectly fine.
 *
 * `git ls-files` reads the INDEX, which is what the next commit carries - the same source of truth the evidence
 * size audit uses on audio-feed-3teu. Unknown must not read as a pass, so a failed git call throws: without git we
 * cannot tell a carried directory from a scratch one, and "nothing is carried" would redden every entry for the
 * wrong reason.
 */
export async function carriedEvidenceDirs(root: string = ROOT): Promise<Set<string>> {
  const out = await new Deno.Command("git", {
    args: ["ls-files", "-z", "--", "docs/evidence"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `git ls-files docs/evidence failed, so what the tree carries is unknown: ` +
        new TextDecoder().decode(out.stderr).trim(),
    );
  }
  const names = new Set<string>();
  for (const path of new TextDecoder().decode(out.stdout).split("\0")) {
    if (!path.startsWith("docs/evidence/")) continue;
    const rest = path.slice("docs/evidence/".length);
    const slash = rest.indexOf("/");
    // A tracked directory always has at least one tracked file under it (git cannot store an empty
    // directory), so the first path segment is the directory and a bare file is not one.
    if (slash > 0) names.add(rest.slice(0, slash));
  }
  return names;
}

/**
 * audio-feed-tgnu — check whether a directory carries an explicit debt admission in its README.
 *
 * An admitted directory carries legacy debt that has not yet been retrofitted with assertions.
 * Like declarations, admissions are read FROM THE GIT INDEX (`git show :<readme>`) rather than the
 * working directory, so a worktree-deleted directory (an unstaged `rm -rf`) still reads correctly.
 */
export async function checkEvidenceAdmission(
  name: string,
  root: string = ROOT,
): Promise<boolean> {
  const readmeRel = `docs/evidence/${name}/README.md`;
  const readmeCmd = await new Deno.Command("git", {
    args: ["show", `:${readmeRel}`],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!readmeCmd.success) {
    return false;
  }
  const body = new TextDecoder().decode(readmeCmd.stdout);
  return /^- Debt:\s*admitted\s*\(audio-feed-tgnu\)\s*$/m.test(body);
}

/**
 * audio-feed-tgnu — the set of evidence directories that admit debt in their README.
 *
 * The debt meter is the set of READMEs that admit, rather than a hand-maintained list.
 * A slice removing its debt edits ONLY its own README (removing the admission and adding a
 * declaration), leaving shared test files untouched.
 */
export async function admittedEvidenceDirs(root: string = ROOT): Promise<Set<string>> {
  const carried = await carriedEvidenceDirs(root);
  const admitted = new Set<string>();
  for (const name of carried) {
    if (await checkEvidenceAdmission(name, root)) {
      admitted.add(name);
    }
  }
  return admitted;
}

/**
 * audio-feed-tgnu — the undeclared evidence directories, derived from the git index and READMEs.
 *
 * `undeclared` is redefined as a carried directory that DECLARES NOTHING AND ADMITS NOTHING.
 * Each directory's README is the source of truth for declarations and debt admissions, and the
 * git index (carriedEvidenceDirs) is the source of truth for what the tree carries (audio-feed-9qvz, audio-feed-a7e8).
 */
export async function undeclaredEvidenceDirs(root: string = ROOT): Promise<Set<string>> {
  const carried = await carriedEvidenceDirs(root);
  const undeclared = new Set<string>();
  for (const name of carried) {
    if (await checkEvidenceAdmission(name, root)) continue;
    const err = await checkEvidenceDeclaration(name, root);
    if (err !== null) {
      undeclared.add(name);
    }
  }
  return undeclared;
}

Deno.test("every evidence directory declares what it asserts (audio-feed-fnrp)", async () => {
  // audio-feed-9qvz: asked of the INDEX, not of the working directory - see carriedEvidenceDirs.
  const carried = await carriedEvidenceDirs();

  // audio-feed-237f, audio-feed-9qvz: directories on disk under docs/evidence must be carried by git.
  // An untracked scratch directory or residue from git rm is forbidden.
  const staleDebt: string[] = [];
  for await (const entry of Deno.readDir("docs/evidence")) {
    if (!entry.isDirectory) continue;
    if (!carried.has(entry.name)) {
      staleDebt.push(entry.name);
    }
  }

  assertEquals(
    staleDebt,
    [],
    "EVIDENCE_UNDECLARED may only name evidence directories the TREE carries (audio-feed-237f, " +
      "audio-feed-9qvz): the list is shrink-only and its length is the debt number, so an entry for a " +
      "directory that has been removed inflates the debt and hides that the list did not shrink. " +
      "Existence is asked of git (the index), not of the working directory, so a directory that is " +
      "merely present on disk - untracked, or the residue `git rm` leaves - does not count. Remove " +
      "these entries: " + staleDebt.join(", "),
  );

  // audio-feed-tgnu FIX 1: assert the SET of undeclared is empty.
  // Undeclared directories are those that declare nothing AND admit nothing.
  const undeclared = await undeclaredEvidenceDirs();
  assertEquals(
    undeclared,
    new Set<string>(),
    "undeclared evidence directories (carrying neither a declaration nor a debt admission) must be empty: " +
      Array.from(undeclared).join(", "),
  );

  // audio-feed-tgnu FIX 2: non-circular check.
  // The declaration check runs over all carried directories that have not admitted legacy debt.
  // Any directory claiming to be declared must pass checkEvidenceDeclaration (audio-feed-fnrp).
  const admitted = await admittedEvidenceDirs();
  const declaredErrors: string[] = [];
  for (const name of carried) {
    if (admitted.has(name)) continue;
    const err = await checkEvidenceDeclaration(name);
    if (err) declaredErrors.push(err);
  }

  assertEquals(
    declaredErrors,
    [],
    "declared evidence directories must have valid declarations: " + declaredErrors.join("; "),
  );
});

async function gitCmd(args: string[], cwd: string): Promise<void> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
}

async function gitInit(root: string): Promise<void> {
  await gitCmd(["init", "-q", "-b", "main"], root);
  await gitCmd(["config", "user.email", "t@example.com"], root);
  await gitCmd(["config", "user.name", "t"], root);
}

async function commitAll(root: string, message: string): Promise<void> {
  await gitCmd(
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", message],
    root,
  );
}

Deno.test("audio-feed-tgnu: derived undeclared set rejects unmerged, untracked, and git-rm residue directories", async () => {
  // Case A: directory name exists ONLY on an unmerged branch
  {
    const root = await Deno.makeTempDir({ prefix: "tgnu-unmerged-" });
    try {
      await gitInit(root);
      await Deno.mkdir(`${root}/docs/evidence/audio-feed-tracked`, { recursive: true });
      await Deno.writeFile(
        `${root}/docs/evidence/audio-feed-tracked/repro.json`,
        new TextEncoder().encode("{}"),
      );
      await gitCmd(["add", "."], root);
      await commitAll(root, "commit on main");

      await gitCmd(["checkout", "-q", "-b", "unmerged-branch"], root);
      await Deno.mkdir(`${root}/docs/evidence/audio-feed-unmerged`, { recursive: true });
      await Deno.writeFile(
        `${root}/docs/evidence/audio-feed-unmerged/repro.json`,
        new TextEncoder().encode("{}"),
      );
      await gitCmd(["add", "."], root);
      await commitAll(root, "commit on unmerged branch");

      await gitCmd(["checkout", "-q", "main"], root);
      const derived = await undeclaredEvidenceDirs(root + "/");
      assertEquals(
        derived.has("audio-feed-tracked"),
        true,
        "tracked undeclared directory is in derived set",
      );
      assertEquals(
        derived.has("audio-feed-unmerged"),
        false,
        "a directory name that exists ONLY on an unmerged branch must be rejected from the derived undeclared set",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }

  // Case B: untracked scratch directory
  {
    const root = await Deno.makeTempDir({ prefix: "tgnu-scratch-" });
    try {
      await gitInit(root);
      await Deno.mkdir(`${root}/docs/evidence/audio-feed-tracked`, { recursive: true });
      await Deno.writeFile(
        `${root}/docs/evidence/audio-feed-tracked/repro.json`,
        new TextEncoder().encode("{}"),
      );
      await gitCmd(["add", "."], root);
      await commitAll(root, "commit on main");

      // Untracked scratch directory on disk
      await Deno.mkdir(`${root}/docs/evidence/audio-feed-scratch`, { recursive: true });
      await Deno.writeFile(
        `${root}/docs/evidence/audio-feed-scratch/note.txt`,
        new TextEncoder().encode("scratch"),
      );

      const derived = await undeclaredEvidenceDirs(root + "/");
      assertEquals(
        derived.has("audio-feed-scratch"),
        false,
        "an untracked scratch directory must be rejected from the derived undeclared set",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }

  // Case C: git-rm'd directory whose folder residue remains on disk
  {
    const root = await Deno.makeTempDir({ prefix: "tgnu-gitrm-" });
    try {
      await gitInit(root);
      await Deno.mkdir(`${root}/docs/evidence/audio-feed-deleted`, { recursive: true });
      await Deno.writeFile(
        `${root}/docs/evidence/audio-feed-deleted/repro.json`,
        new TextEncoder().encode("{}"),
      );
      await gitCmd(["add", "."], root);
      await commitAll(root, "commit before deletion");

      // Remove from git index, but leave folder residue on disk
      await gitCmd(["rm", "-r", "--cached", "docs/evidence/audio-feed-deleted"], root);
      await commitAll(root, "commit deletion");

      const derived = await undeclaredEvidenceDirs(root + "/");
      assertEquals(
        derived.has("audio-feed-deleted"),
        false,
        "a git-rm'd directory whose folder residue remains on disk must be rejected from the derived undeclared set",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("audio-feed-npai: carried directory whose worktree files are deleted passes declaration check", async () => {
  const root = await Deno.makeTempDir({ prefix: "npai-deleted-worktree-" });
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof");
    await Deno.mkdir(`${root}/docs/evidence/audio-feed-carried`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/audio-feed-carried/README.md`,
      "- Script: scripts/proof.ts\n- Asserts: test claim\n",
    );
    await gitCmd(["add", "."], root);
    await commitAll(root, "commit carried evidence");

    // Delete the evidence directory and script from the worktree (simulating deleted folder on disk)
    await Deno.remove(`${root}/docs/evidence/audio-feed-carried`, { recursive: true });
    await Deno.remove(`${root}/scripts/proof.ts`);

    // checkEvidenceDeclaration must query git index, not the filesystem, so it succeeds (audio-feed-npai)
    const err = await checkEvidenceDeclaration("audio-feed-carried", root + "/");
    assertEquals(
      err,
      null,
      "a directory carried in the index whose worktree folder is gone must pass declaration check",
    );

    // undeclaredEvidenceDirs must not flag it as undeclared
    const derived = await undeclaredEvidenceDirs(root + "/");
    assertEquals(
      derived.has("audio-feed-carried"),
      false,
      "carried directory whose worktree folder is deleted must not be classified as undeclared",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-tgnu: admitted directory is excluded from undeclared set and passes when worktree files are deleted", async () => {
  const root = await Deno.makeTempDir({ prefix: "tgnu-admitted-worktree-" });
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/docs/evidence/audio-feed-admitted`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/audio-feed-admitted/README.md`,
      "# Evidence: audio-feed-admitted\n\n- Debt: admitted (audio-feed-tgnu)\n",
    );
    await gitCmd(["add", "."], root);
    await commitAll(root, "commit admitted evidence");

    // Admitted directory must be recognized as admitted
    assertEquals(
      await checkEvidenceAdmission("audio-feed-admitted", root + "/"),
      true,
      "admitted directory is detected as carrying debt admission",
    );
    const admittedBefore = await admittedEvidenceDirs(root + "/");
    assertEquals(
      admittedBefore.has("audio-feed-admitted"),
      true,
      "admitted directory is in admittedEvidenceDirs set",
    );

    // Admitted directory must NOT enter undeclared set
    const derivedBefore = await undeclaredEvidenceDirs(root + "/");
    assertEquals(
      derivedBefore.has("audio-feed-admitted"),
      false,
      "admitted directory must not enter undeclared set",
    );

    // Delete worktree folder (simulating unstaged rm -rf)
    await Deno.remove(`${root}/docs/evidence/audio-feed-admitted`, { recursive: true });

    // checkEvidenceAdmission must read from index, not worktree
    assertEquals(
      await checkEvidenceAdmission("audio-feed-admitted", root + "/"),
      true,
      "admitted directory whose worktree folder is gone still passes admission check from index",
    );
    const derivedAfter = await undeclaredEvidenceDirs(root + "/");
    assertEquals(
      derivedAfter.has("audio-feed-admitted"),
      false,
      "admitted directory whose worktree folder is deleted must still be excluded from undeclared",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-tgnu: rogue directory with neither declaration nor admission is flagged in undeclared set", async () => {
  const root = await Deno.makeTempDir({ prefix: "tgnu-rogue-" });
  try {
    await gitInit(root);
    // 1. Declared directory
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof");
    await Deno.mkdir(`${root}/docs/evidence/audio-feed-declared`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/audio-feed-declared/README.md`,
      "- Script: scripts/proof.ts\n- Asserts: test claim\n",
    );

    // 2. Admitted directory
    await Deno.mkdir(`${root}/docs/evidence/audio-feed-admitted`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/audio-feed-admitted/README.md`,
      "- Debt: admitted (audio-feed-tgnu)\n",
    );

    // 3. Rogue directory: carried in index, but neither declared nor admitted
    await Deno.mkdir(`${root}/docs/evidence/audio-feed-rogue`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/audio-feed-rogue/evidence.png`,
      "bytes",
    );

    await gitCmd(["add", "."], root);
    await commitAll(root, "commit mixed evidence");

    const undeclared = await undeclaredEvidenceDirs(root + "/");
    assertEquals(
      undeclared,
      new Set(["audio-feed-rogue"]),
      "undeclared set must contain exactly the rogue directory (declared and admitted are excluded)",
    );

    const admitted = await admittedEvidenceDirs(root + "/");
    assertEquals(
      admitted,
      new Set(["audio-feed-admitted"]),
      "admitted set must contain exactly the admitted directory",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
