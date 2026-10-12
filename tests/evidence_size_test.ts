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
  const dirRoot = root.endsWith("/") ? root : `${root}/`;
  const dir = `${dirRoot}docs/evidence/${name}`;
  const readme = `${dir}/README.md`;
  let body = await Deno.readTextFile(readme).catch(() => null);
  if (body === null) {
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
    body = new TextDecoder().decode(readmeCmd.stdout);
  }
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
    const stat = await Deno.stat(`${dirRoot}${scriptRel}`).catch(() => null);
    const existsOnDisk = stat?.isFile === true;
    const scriptCmd = await new Deno.Command("git", {
      args: ["cat-file", "-e", `:${scriptRel}`],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const existsInIndex = scriptCmd.success;

    // audio-feed-vaaj: Script is index-OR-disk so that an unstaged rm does not produce a false negative
    // (audio-feed-npai, audio-feed-xr7v); the executor field below requires BOTH.
    // If absent from BOTH, classic does not exist; if on disk but absent from index, untracked failure.
    // A script present in the Git index passes whether or not the working-tree copy is present on disk.
    if (!existsOnDisk && !existsInIndex) {
      return `${dir}: Script: names ${script}, which does not exist`;
    }
    if (existsOnDisk && !existsInIndex) {
      return `${dir}: Script: names ${script}, which exists on disk but is absent from the Git index`;
    }
  }
  const executedByMatch = body.match(/^[ \t]*-[ \t]*Executed by:[ \t]*(.+)$/m);
  if (executedByMatch) {
    const raw = executedByMatch[1]!.trim();
    if (!raw) {
      return `${dir}: Executed by: line is empty`;
    }
    if (!script) {
      return `${dir}: declares Executed by: with no "- Script: scripts/<proof>.ts" to attach it to`;
    }
    const targets = raw.split(",").map((s) => s.replace(/[`"']/g, "").trim()).filter(Boolean);
    if (targets.length === 0) {
      return `${dir}: Executed by: line is empty`;
    }
    for (const target of targets) {
      const execRel = target.startsWith("tests/") ? target : `tests/${target}`;
      const stat = await Deno.stat(`${dirRoot}${execRel}`).catch(() => null);
      const existsOnDisk = stat?.isFile === true;
      const execCmd = await new Deno.Command("git", {
        args: ["cat-file", "-e", `:${execRel}`],
        cwd: root,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const existsInIndex = execCmd.success;

      if (!existsOnDisk && !existsInIndex) {
        return `${dir}: Executed by: names ${target}, which does not exist`;
      }
      if (existsOnDisk && !existsInIndex) {
        return `${dir}: Executed by: names ${target}, which exists on disk but is absent from the Git index`;
      }
      if (!existsOnDisk && existsInIndex) {
        return `${dir}: Executed by: names ${target}, which exists in the Git index but is missing from disk`;
      }
    }
  } else if (/^[ \t]*-[ \t]*Executed by:[ \t]*$/m.test(body)) {
    return `${dir}: Executed by: line is empty`;
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
  const dir = `${root}docs/evidence/${name}`;
  const readme = `${dir}/README.md`;
  let body = await Deno.readTextFile(readme).catch(() => null);
  if (body === null) {
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
    body = new TextDecoder().decode(readmeCmd.stdout);
  }
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

/**
 * audio-feed-01k7, audio-feed-t5gt — the condition of an evidence directory.
 *
 * For undeclared directories, the derivation reports WHICH condition failed:
 *   - "the directory is not carried"
 *   - "has no README"
 *   - "the README declares nothing and admits nothing"
 *   - "the README's Script line names a file that does not exist"
 *   - "the README declares but the declaration is malformed"
 *   - "it is admitted but something else is wrong"
 * And for valid directories:
 *   - "declared" (valid declaration)
 *   - "admitted" (clean admitted legacy debt)
 */
export type EvidenceCondition =
  | "the directory is not carried"
  | "has no README"
  | "the README declares nothing and admits nothing"
  | "the README's Script line names a file that does not exist"
  | "the README declares but the declaration is malformed"
  | "it is admitted but something else is wrong"
  | "declared"
  | "admitted";

export interface EvidenceDerivation {
  name: string;
  condition: EvidenceCondition;
  carried: boolean;
  hasReadme: boolean;
  admitted: boolean;
  declares: boolean;
  detail: string | null;
}

/**
 * audio-feed-01k7, audio-feed-t5gt — derive the condition of an evidence directory.
 *
 * Unlike raw error strings, this derivation distinguishes the exact cause of non-declaration
 * or defect, including distinguishing clean admitted legacy debt from admitted debt with broken
 * declarations (e.g. audio-feed-bp6r) or debt with valid declarations (t5gt).
 */
export async function deriveEvidenceDirectory(
  name: string,
  root: string = ROOT,
): Promise<EvidenceDerivation> {
  const dirRoot = root.endsWith("/") ? root : `${root}/`;
  const carriedDirs = await carriedEvidenceDirs(dirRoot);
  const isCarried = carriedDirs.has(name);
  if (!isCarried) {
    return {
      name,
      condition: "the directory is not carried",
      carried: false,
      hasReadme: false,
      admitted: false,
      declares: false,
      detail: null,
    };
  }

  const dir = `${dirRoot}docs/evidence/${name}`;
  const readme = `${dir}/README.md`;
  let body = await Deno.readTextFile(readme).catch(() => null);
  if (body === null) {
    const readmeRel = `docs/evidence/${name}/README.md`;
    const readmeCmd = await new Deno.Command("git", {
      args: ["show", `:${readmeRel}`],
      cwd: dirRoot,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (readmeCmd.success) {
      body = new TextDecoder().decode(readmeCmd.stdout);
    }
  }

  if (body === null) {
    return {
      name,
      condition: "has no README",
      carried: true,
      hasReadme: false,
      admitted: false,
      declares: false,
      detail: `${dir}: no README.md`,
    };
  }

  const isAdmitted = /^- Debt:\s*admitted\s*\(audio-feed-tgnu\)\s*$/m.test(body);
  const hasAsserts = /^- Asserts:/m.test(body);
  const hasCapture = /^- Capture:/m.test(body);
  const hasScript = /^- Script:/m.test(body);
  const declares = hasAsserts || hasCapture || hasScript;

  if (!isAdmitted && !declares) {
    return {
      name,
      condition: "the README declares nothing and admits nothing",
      carried: true,
      hasReadme: true,
      admitted: false,
      declares: false,
      detail: `${dir}: needs a "- Asserts: <claims>" or "- Capture: no assertions" line`,
    };
  }

  const declErr = await checkEvidenceDeclaration(name, dirRoot);

  if (isAdmitted) {
    if (!declares) {
      return {
        name,
        condition: "admitted",
        carried: true,
        hasReadme: true,
        admitted: true,
        declares: false,
        detail: null,
      };
    }
    if (declErr === null) {
      return {
        name,
        condition: "it is admitted but something else is wrong",
        carried: true,
        hasReadme: true,
        admitted: true,
        declares: true,
        detail:
          "carries a valid declaration while retaining debt admission; debt admission must be removed",
      };
    }
    return {
      name,
      condition: "it is admitted but something else is wrong",
      carried: true,
      hasReadme: true,
      admitted: true,
      declares: true,
      detail: declErr,
    };
  }

  if (declErr === null) {
    return {
      name,
      condition: "declared",
      carried: true,
      hasReadme: true,
      admitted: false,
      declares: true,
      detail: null,
    };
  }

  const isMissingScript = declErr.includes("Script: names") &&
    declErr.includes("which does not exist");
  return {
    name,
    condition: isMissingScript
      ? "the README's Script line names a file that does not exist"
      : "the README declares but the declaration is malformed",
    carried: true,
    hasReadme: true,
    admitted: false,
    declares: true,
    detail: declErr,
  };
}

/**
 * audio-feed-01k7 — derive reasons for all undeclared evidence directories.
 *
 * For each undeclared directory, reports WHICH condition failed.
 */
export async function deriveUndeclaredEvidence(
  root: string = ROOT,
): Promise<Map<string, EvidenceDerivation>> {
  const undeclared = await undeclaredEvidenceDirs(root);
  const map = new Map<string, EvidenceDerivation>();
  for (const name of undeclared) {
    map.set(name, await deriveEvidenceDirectory(name, root));
  }
  return map;
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

  // audio-feed-tgnu FIX 1, audio-feed-01k7: assert the SET of undeclared is empty.
  // Undeclared directories are those that declare nothing AND admit nothing.
  // When undeclared directories exist, the derivation reports WHICH condition failed per directory.
  const undeclared = await undeclaredEvidenceDirs();
  const undeclaredReasons: string[] = [];
  for (const name of undeclared) {
    const d = await deriveEvidenceDirectory(name);
    undeclaredReasons.push(`${name} [${d.condition}]: ${d.detail ?? d.condition}`);
  }
  assertEquals(
    undeclared,
    new Set<string>(),
    "undeclared evidence directories (carrying neither a declaration nor a debt admission) must be empty:\n" +
      undeclaredReasons.join("\n"),
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

  // audio-feed-t5gt: two-directional contract for admitted debt.
  // An admitted directory carrying a VALID declaration has completed retrofit and must remove its
  // debt admission; retaining both permanently inflates admitted debt (audio-feed-237f, audio-feed-tp4x).
  const admittedWithValidDeclaration: string[] = [];
  const admittedWithDefect: string[] = [];
  for (const name of admitted) {
    const err = await checkEvidenceDeclaration(name);
    if (err === null) {
      admittedWithValidDeclaration.push(name);
    } else {
      const d = await deriveEvidenceDirectory(name);
      if (d.condition === "it is admitted but something else is wrong") {
        admittedWithDefect.push(`${name} (${d.detail})`);
      }
    }
  }

  assertEquals(
    admittedWithValidDeclaration,
    [],
    "admitted directories carrying a valid declaration must remove debt admission (audio-feed-t5gt): " +
      admittedWithValidDeclaration.join(", "),
  );

  // Surface admitted directories with broken declarations (legacy debt):
  if (admittedWithDefect.length > 0) {
    console.log(
      `note: ${admittedWithDefect.length} admitted evidence directory/directories carry broken declarations (legacy debt): ` +
        admittedWithDefect.join("; "),
    );
  }
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

Deno.test("audio-feed-01k7: derivation distinguishes all six conditions", async () => {
  const root = await Deno.makeTempDir({ prefix: "derive-conditions-" });
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof");

    // Declared directory
    await Deno.mkdir(`${root}/docs/evidence/case-declared`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-declared/README.md`,
      "- Script: scripts/proof.ts\n- Asserts: test claim\n",
    );

    // Clean admitted directory
    await Deno.mkdir(`${root}/docs/evidence/case-admitted`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-admitted/README.md`,
      "- Debt: admitted (audio-feed-tgnu)\n",
    );

    // Condition 2: has no README
    await Deno.mkdir(`${root}/docs/evidence/case-no-readme`, { recursive: true });
    await Deno.writeTextFile(`${root}/docs/evidence/case-no-readme/evidence.png`, "bytes");

    // Condition 3: declares nothing and admits nothing
    await Deno.mkdir(`${root}/docs/evidence/case-empty`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-empty/README.md`,
      "# Empty Evidence\n\nNo declarations or admissions.\n",
    );

    // Condition 4: script line names nonexistent file
    await Deno.mkdir(`${root}/docs/evidence/case-bad-script`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-bad-script/README.md`,
      "- Script: scripts/nonexistent.ts\n- Asserts: ghost claims\n",
    );

    // Condition 5: malformed declaration (asserts without script)
    await Deno.mkdir(`${root}/docs/evidence/case-malformed`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-malformed/README.md`,
      "- Asserts: claims with no script\n",
    );

    // Condition 6a: admitted with broken declaration
    await Deno.mkdir(`${root}/docs/evidence/case-admitted-broken`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-admitted-broken/README.md`,
      "- Debt: admitted (audio-feed-tgnu)\n- Script: scripts/nonexistent.ts\n- Asserts: claims\n",
    );

    // Condition 6b: admitted with valid declaration
    await Deno.mkdir(`${root}/docs/evidence/case-admitted-valid`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-admitted-valid/README.md`,
      "- Debt: admitted (audio-feed-tgnu)\n- Script: scripts/proof.ts\n- Asserts: valid claims\n",
    );

    await gitCmd(["add", "."], root);
    await commitAll(root, "commit all cases");

    // Condition 1: not carried
    const dNotCarried = await deriveEvidenceDirectory("not-carried-dir", root);
    assertEquals(dNotCarried.condition, "the directory is not carried");
    assertEquals(dNotCarried.carried, false);

    // Condition 2: has no README
    const dNoReadme = await deriveEvidenceDirectory("case-no-readme", root);
    assertEquals(dNoReadme.condition, "has no README");
    assertEquals(dNoReadme.hasReadme, false);

    // Condition 3: declares nothing and admits nothing
    const dEmpty = await deriveEvidenceDirectory("case-empty", root);
    assertEquals(dEmpty.condition, "the README declares nothing and admits nothing");

    // Condition 4: script line names nonexistent file
    const dBadScript = await deriveEvidenceDirectory("case-bad-script", root);
    assertEquals(dBadScript.condition, "the README's Script line names a file that does not exist");

    // Condition 5: malformed declaration
    const dMalformed = await deriveEvidenceDirectory("case-malformed", root);
    assertEquals(dMalformed.condition, "the README declares but the declaration is malformed");

    // Condition 6a: admitted with broken declaration
    const dAdmittedBroken = await deriveEvidenceDirectory("case-admitted-broken", root);
    assertEquals(dAdmittedBroken.condition, "it is admitted but something else is wrong");
    assertEquals(dAdmittedBroken.admitted, true);
    assertEquals(dAdmittedBroken.declares, true);

    // Condition 6b: admitted with valid declaration
    const dAdmittedValid = await deriveEvidenceDirectory("case-admitted-valid", root);
    assertEquals(dAdmittedValid.condition, "it is admitted but something else is wrong");
    assertEquals(dAdmittedValid.admitted, true);
    assertEquals(dAdmittedValid.declares, true);
    assertEquals(dAdmittedValid.detail?.includes("debt admission must be removed"), true);

    // Valid states
    assertEquals((await deriveEvidenceDirectory("case-declared", root)).condition, "declared");
    assertEquals((await deriveEvidenceDirectory("case-admitted", root)).condition, "admitted");

    // deriveUndeclaredEvidence map check
    const undeclaredMap = await deriveUndeclaredEvidence(root);
    assertEquals(undeclaredMap.has("case-no-readme"), true);
    assertEquals(undeclaredMap.has("case-empty"), true);
    assertEquals(undeclaredMap.has("case-bad-script"), true);
    assertEquals(undeclaredMap.has("case-malformed"), true);
    assertEquals(undeclaredMap.has("case-declared"), false);
    assertEquals(undeclaredMap.has("case-admitted"), false);
    // Admitted directories are excluded from undeclared set
    assertEquals(undeclaredMap.has("case-admitted-broken"), false);
    assertEquals(undeclaredMap.has("case-admitted-valid"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-t5gt: bp6r broken declaration is visible via derivation and does not red the tree", async () => {
  // 1. bp6r is admitted and carries legacy debt
  const admitted = await admittedEvidenceDirs();
  assertEquals(admitted.has("audio-feed-bp6r"), true, "bp6r is admitted debt");

  // 2. bp6r is excluded from undeclared set (does not red the tree)
  const undeclared = await undeclaredEvidenceDirs();
  assertEquals(undeclared.has("audio-feed-bp6r"), false, "bp6r does not enter undeclared set");

  // 3. bp6r's broken declaration is VISIBLE via deriveEvidenceDirectory
  const derivation = await deriveEvidenceDirectory("audio-feed-bp6r");
  assertEquals(
    derivation.condition,
    "it is admitted but something else is wrong",
    "bp6r defect is visible via derivation",
  );
  assertEquals(derivation.admitted, true);
  assertEquals(derivation.declares, true);
  assertEquals(typeof derivation.detail, "string");

  // 4. Two-directional contract: in a temp repo, an admitted directory with valid declaration is rejected
  const root = await Deno.makeTempDir({ prefix: "t5gt-twoway-" });
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof");
    await Deno.mkdir(`${root}/docs/evidence/audio-feed-both`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/audio-feed-both/README.md`,
      "- Debt: admitted (audio-feed-tgnu)\n- Script: scripts/proof.ts\n- Asserts: valid\n",
    );
    await gitCmd(["add", "."], root);
    await commitAll(root, "commit both admitted and declared");

    const bothAdmitted = await admittedEvidenceDirs(root);
    assertEquals(bothAdmitted.has("audio-feed-both"), true);
    const declErr = await checkEvidenceDeclaration("audio-feed-both", root);
    assertEquals(declErr, null, "declaration itself is valid");

    // Derivation identifies it as admitted with defect
    const dBoth = await deriveEvidenceDirectory("audio-feed-both", root);
    assertEquals(dBoth.condition, "it is admitted but something else is wrong");
    assertEquals(dBoth.detail?.includes("debt admission must be removed"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-01k7: the three rejection shapes redden the suite and report their conditions", async () => {
  const root = await Deno.makeTempDir({ prefix: "rejection-shapes-" });
  try {
    await gitInit(root);

    // Shape 1: no README at all
    await Deno.mkdir(`${root}/docs/evidence/shape-no-readme`, { recursive: true });
    await Deno.writeTextFile(`${root}/docs/evidence/shape-no-readme/capture.png`, "bytes");

    // Shape 2: a README that neither declares nor admits
    await Deno.mkdir(`${root}/docs/evidence/shape-empty-readme`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/shape-empty-readme/README.md`,
      "# Shape 2\n\nNo assertions or admissions.\n",
    );

    // Shape 3: a README that declares a nonexistent script
    await Deno.mkdir(`${root}/docs/evidence/shape-ghost-script`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/shape-ghost-script/README.md`,
      "- Script: scripts/ghost.ts\n- Asserts: something\n",
    );

    await gitCmd(["add", "."], root);
    await commitAll(root, "commit three rejection shapes");

    const undeclared = await undeclaredEvidenceDirs(root);
    assertEquals(undeclared.has("shape-no-readme"), true, "Shape 1 is undeclared");
    assertEquals(undeclared.has("shape-empty-readme"), true, "Shape 2 is undeclared");
    assertEquals(undeclared.has("shape-ghost-script"), true, "Shape 3 is undeclared");

    assertEquals(
      (await deriveEvidenceDirectory("shape-no-readme", root)).condition,
      "has no README",
    );
    assertEquals(
      (await deriveEvidenceDirectory("shape-empty-readme", root)).condition,
      "the README declares nothing and admits nothing",
    );
    assertEquals(
      (await deriveEvidenceDirectory("shape-ghost-script", root)).condition,
      "the README's Script line names a file that does not exist",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-4oe2: checkEvidenceDeclaration validates 'Executed by' field and catches stale executor", async () => {
  const root = (await Deno.makeTempDir({ prefix: "4oe2-exec-" })) + "/";
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.mkdir(`${root}/tests`, { recursive: true });
    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof");
    await Deno.writeTextFile(`${root}/tests/valid_test.ts`, "// test");

    // Case 1: valid declaration with existing executor
    await Deno.mkdir(`${root}/docs/evidence/case-valid-exec`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-valid-exec/README.md`,
      "- Script: scripts/proof.ts\n- Executed by: tests/valid_test.ts\n- Asserts: valid\n",
    );

    // Case 2: stale executor naming nonexistent test file
    await Deno.mkdir(`${root}/docs/evidence/case-stale-exec`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-stale-exec/README.md`,
      "- Script: scripts/proof.ts\n- Executed by: tests/ghost_test.ts\n- Asserts: valid\n",
    );

    // Case 3: negative control - declaration without Executed by passes cleanly
    await Deno.mkdir(`${root}/docs/evidence/case-no-exec`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-no-exec/README.md`,
      "- Script: scripts/proof.ts\n- Asserts: valid\n",
    );

    // Case 4: Executed by without Script line
    await Deno.mkdir(`${root}/docs/evidence/case-no-script`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-no-script/README.md`,
      "- Executed by: tests/valid_test.ts\n- Capture: no assertions\n",
    );

    // Case 5: Executed by line is empty
    await Deno.mkdir(`${root}/docs/evidence/case-empty-exec`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-empty-exec/README.md`,
      "- Script: scripts/proof.ts\n- Executed by:\n- Asserts: valid\n",
    );

    await gitCmd(["add", "."], root);
    await commitAll(root, "commit 4oe2 cases");

    // Case 1 passes
    const errValid = await checkEvidenceDeclaration("case-valid-exec", root);
    assertEquals(errValid, null, "valid Executed by must pass");

    // Case 2 fails with detectable staleness error
    const errStale = await checkEvidenceDeclaration("case-stale-exec", root);
    assertEquals(
      errStale?.includes("Executed by: names tests/ghost_test.ts, which does not exist"),
      true,
      "stale Executed by must produce detectable error",
    );

    // Case 3 passes (negative direction: absent field does not fail)
    const errNoExec = await checkEvidenceDeclaration("case-no-exec", root);
    assertEquals(errNoExec, null, "absent Executed by must pass");

    // Case 4 fails (Executed by without Script)
    const errNoScript = await checkEvidenceDeclaration("case-no-script", root);
    assertEquals(
      errNoScript?.includes('declares Executed by: with no "- Script: scripts/<proof>.ts"'),
      true,
      "Executed by without Script must fail",
    );

    // Case 5 fails (empty Executed by line)
    const errEmpty = await checkEvidenceDeclaration("case-empty-exec", root);
    assertEquals(
      errEmpty?.includes("Executed by: line is empty"),
      true,
      "empty Executed by must fail",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-rmhi: checkEvidenceDeclaration requires executor to exist BOTH on disk AND in Git index", async () => {
  const root = (await Deno.makeTempDir({ prefix: "rmhi-exec-" })) + "/";
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.mkdir(`${root}/tests`, { recursive: true });
    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof");

    // Case 1 (audio-feed-rmhi finding): executor written to disk but NOT added to git index (untracked)
    await Deno.mkdir(`${root}/docs/evidence/case-untracked-exec`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-untracked-exec/README.md`,
      "- Script: scripts/proof.ts\n- Executed by: tests/untracked_test.ts\n- Asserts: valid\n",
    );
    await Deno.writeTextFile(`${root}/tests/untracked_test.ts`, "// untracked test");

    // Case 2 (deliberate index-only decision): executor committed in git index but deleted from disk
    await Deno.mkdir(`${root}/docs/evidence/case-index-only-exec`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-index-only-exec/README.md`,
      "- Script: scripts/proof.ts\n- Executed by: tests/deleted_test.ts\n- Asserts: valid\n",
    );
    await Deno.writeTextFile(`${root}/tests/deleted_test.ts`, "// deleted test");

    // Case 3 (control): executor exists BOTH on disk AND in git index
    await Deno.mkdir(`${root}/docs/evidence/case-both-exec`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-both-exec/README.md`,
      "- Script: scripts/proof.ts\n- Executed by: tests/both_test.ts\n- Asserts: valid\n",
    );
    await Deno.writeTextFile(`${root}/tests/both_test.ts`, "// both test");

    // Case 4 (control): executor totally absent (neither on disk nor in git index)
    await Deno.mkdir(`${root}/docs/evidence/case-neither-exec`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-neither-exec/README.md`,
      "- Script: scripts/proof.ts\n- Executed by: tests/neither_test.ts\n- Asserts: valid\n",
    );

    // Commit scripts/proof.ts, the READMEs, deleted_test.ts, and both_test.ts,
    // but deliberately do NOT git add tests/untracked_test.ts.
    await gitCmd([
      "add",
      "scripts/proof.ts",
      "docs/evidence",
      "tests/deleted_test.ts",
      "tests/both_test.ts",
    ], root);
    await commitAll(root, "commit rmhi baseline");

    // Now remove tests/deleted_test.ts from disk so it exists only in index
    await Deno.remove(`${root}/tests/deleted_test.ts`);

    // Case 1: untracked on disk -> MUST FAIL
    const errUntracked = await checkEvidenceDeclaration("case-untracked-exec", root);
    assertEquals(
      errUntracked?.includes(
        "Executed by: names tests/untracked_test.ts, which exists on disk but is absent from the Git index",
      ),
      true,
      `untracked executor must fail with missing from index reason, got: ${errUntracked}`,
    );

    // Case 2: index only (missing on disk) -> MUST FAIL
    const errIndexOnly = await checkEvidenceDeclaration("case-index-only-exec", root);
    assertEquals(
      errIndexOnly?.includes(
        "Executed by: names tests/deleted_test.ts, which exists in the Git index but is missing from disk",
      ),
      true,
      `deleted executor must fail with missing from disk reason, got: ${errIndexOnly}`,
    );

    // Case 3: both on disk and in index -> PASSES (null)
    const errBoth = await checkEvidenceDeclaration("case-both-exec", root);
    assertEquals(errBoth, null, "executor in both disk and index must pass");

    // Case 4: neither on disk nor in index -> FAILS with classic does not exist
    const errNeither = await checkEvidenceDeclaration("case-neither-exec", root);
    assertEquals(
      errNeither?.includes("Executed by: names tests/neither_test.ts, which does not exist"),
      true,
      `absent executor must fail with does not exist, got: ${errNeither}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-rmhi mirror: committed executor present in Git index and on disk passes declaration check", async () => {
  const root = (await Deno.makeTempDir({ prefix: "rmhi-mirror-" })) + "/";
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.mkdir(`${root}/tests`, { recursive: true });
    await Deno.mkdir(`${root}/docs/evidence/audio-feed-mirror`, { recursive: true });

    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof script");
    await Deno.writeTextFile(`${root}/tests/mirror_suite_test.ts`, "// mirror suite");
    await Deno.writeTextFile(
      `${root}/docs/evidence/audio-feed-mirror/README.md`,
      "- Script: scripts/proof.ts\n- Executed by: tests/mirror_suite_test.ts\n- Asserts: valid\n",
    );

    await gitCmd(["add", "."], root);
    await commitAll(root, "commit mirror evidence case");

    const err = await checkEvidenceDeclaration("audio-feed-mirror", root);
    assertEquals(
      err,
      null,
      "an executor legitimately committed in the Git index and present on disk must pass the audit",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-vaaj: checkEvidenceDeclaration requires script in Git index and rejects untracked scripts", async () => {
  const root = (await Deno.makeTempDir({ prefix: "vaaj-script-" })) + "/";
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof");

    // Case 1 (audio-feed-vaaj defect / reason 2): script written to disk but NOT added to git index (untracked)
    await Deno.mkdir(`${root}/docs/evidence/case-untracked-script`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-untracked-script/README.md`,
      "- Script: scripts/untracked_proof.ts\n- Asserts: valid\n",
    );
    await Deno.writeTextFile(`${root}/scripts/untracked_proof.ts`, "// untracked proof");

    // Case 2 (audio-feed-npai asymmetry / unstaged rm): script committed in git index but deleted from disk -> PASSES
    await Deno.mkdir(`${root}/docs/evidence/case-index-only-script`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-index-only-script/README.md`,
      "- Script: scripts/deleted_proof.ts\n- Asserts: valid\n",
    );
    await Deno.writeTextFile(`${root}/scripts/deleted_proof.ts`, "// deleted proof");

    // Case 3 (control): script exists BOTH on disk AND in git index -> PASSES
    await Deno.mkdir(`${root}/docs/evidence/case-both-script`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-both-script/README.md`,
      "- Script: scripts/both_proof.ts\n- Asserts: valid\n",
    );
    await Deno.writeTextFile(`${root}/scripts/both_proof.ts`, "// both proof");

    // Case 4 (reason 1): script totally absent (neither on disk nor in git index) -> FAILS
    await Deno.mkdir(`${root}/docs/evidence/case-neither-script`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/evidence/case-neither-script/README.md`,
      "- Script: scripts/neither_proof.ts\n- Asserts: valid\n",
    );

    // Commit scripts/proof.ts, docs/evidence, deleted_proof.ts, both_proof.ts,
    // but deliberately do NOT git add scripts/untracked_proof.ts.
    await gitCmd([
      "add",
      "scripts/proof.ts",
      "docs/evidence",
      "scripts/deleted_proof.ts",
      "scripts/both_proof.ts",
    ], root);
    await commitAll(root, "commit vaaj baseline");

    // Now remove scripts/deleted_proof.ts from disk so it exists only in git index (simulating unstaged rm)
    await Deno.remove(`${root}/scripts/deleted_proof.ts`);

    // Case 1: untracked on disk -> MUST FAIL (reason 2)
    const errUntracked = await checkEvidenceDeclaration("case-untracked-script", root);
    assertEquals(
      errUntracked?.includes(
        "Script: names scripts/untracked_proof.ts, which exists on disk but is absent from the Git index",
      ),
      true,
      `untracked script must fail with missing from index reason, got: ${errUntracked}`,
    );

    // Case 2: index-present script deleted from disk (unstaged rm) -> MUST PASS (npai contract)
    const errIndexOnly = await checkEvidenceDeclaration("case-index-only-script", root);
    assertEquals(
      errIndexOnly,
      null,
      `index-present script deleted from disk must pass (audio-feed-npai contract), got: ${errIndexOnly}`,
    );

    // Case 3: both on disk and in index -> PASSES (null)
    const errBoth = await checkEvidenceDeclaration("case-both-script", root);
    assertEquals(errBoth, null, "script in both disk and index must pass");

    // Case 4: neither on disk nor in index -> FAILS with classic does not exist (reason 1)
    const errNeither = await checkEvidenceDeclaration("case-neither-script", root);
    assertEquals(
      errNeither?.includes("Script: names scripts/neither_proof.ts, which does not exist"),
      true,
      `absent script must fail with does not exist, got: ${errNeither}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-vaaj mirror: committed script present in Git index and on disk passes declaration check", async () => {
  const root = (await Deno.makeTempDir({ prefix: "vaaj-mirror-" })) + "/";
  try {
    await gitInit(root);
    await Deno.mkdir(`${root}/scripts`, { recursive: true });
    await Deno.mkdir(`${root}/docs/evidence/audio-feed-script-mirror`, { recursive: true });

    await Deno.writeTextFile(`${root}/scripts/proof.ts`, "// proof script");
    await Deno.writeTextFile(
      `${root}/docs/evidence/audio-feed-script-mirror/README.md`,
      "- Script: scripts/proof.ts\n- Asserts: valid\n",
    );

    await gitCmd(["add", "."], root);
    await commitAll(root, "commit mirror evidence case");

    const err = await checkEvidenceDeclaration("audio-feed-script-mirror", root);
    assertEquals(
      err,
      null,
      "a script legitimately committed in the Git index and present on disk must pass the audit",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
