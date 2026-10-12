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
  EVIDENCE_PNG_BUDGET_BYTES,
  EVIDENCE_TOTAL_BUDGET_BYTES,
  evidencePngs,
} from "../scripts/evidence-compress.ts";

Deno.test("docs/evidence PNGs stay under the per-file and aggregate budgets", async () => {
  const oversized: string[] = [];
  let total = 0;

  for await (const path of evidencePngs()) {
    const { size } = await Deno.stat(path);
    total += size;
    if (size > EVIDENCE_PNG_BUDGET_BYTES) {
      oversized.push(`${path} (${(size / 1024).toFixed(0)}KB)`);
    }
  }

  assertEquals(
    oversized,
    [],
    `evidence PNGs exceed the ${(EVIDENCE_PNG_BUDGET_BYTES / 1024).toFixed(0)}KB budget — ` +
      "run `deno task evidence:compress` (see docs/evidence/README.md): " + oversized.join(", "),
  );
  assertEquals(
    total > EVIDENCE_TOTAL_BUDGET_BYTES,
    false,
    `evidence tree is ${(total / 1024 / 1024).toFixed(1)}MB, over the ` +
      `${(EVIDENCE_TOTAL_BUDGET_BYTES / 1024 / 1024).toFixed(0)}MB aggregate budget — ` +
      "prune stale evidence (docs/evidence/README.md)",
  );
});

/**
 * audio-feed-fnrp — every evidence directory declares what it asserts (docs/evidence/README.md, "Honesty").
 *
 * WHY: the audio-feed-q45b audit found nine proof scripts that fail on main, twelve that leak the browser they
 * claim to clean up, and three whose `check()` could not fail the run — and every one of those was invisible to a
 * reader who trusted the README. This check cannot verify that a claim is TRUE (only a mutation can, which is why
 * the reviewer asks for the mutant); it makes the claim set explicit and keeps the pointer to the tool honest, so
 * judging evidence is reading two lines instead of reading a script.
 *
 * THE GRANDFATHER LIST IS DEBT, NOT A POLICY. The 52 directories below predate the rule and are listed so the
 * suite stays green while they are retrofitted; they must SHRINK. A new evidence directory goes on this list only
 * over the author's dead body — the whole point is that new evidence complies from its first commit, and that an
 * explicit diff adding an entry is what a reviewer sees when it does not. Retrofitting the existing ones is a
 * separate pass (see the bead), because a claim has to come from the script that makes it, never from a guess.
 *
 * The check is two-directional (audio-feed-tp4x): an undeclared and unlisted directory fails, and a directory
 * that already has a valid declaration while remaining listed in EVIDENCE_UNDECLARED also fails.
 */
const EVIDENCE_UNDECLARED: string[] = [
  "audio-feed-0cmu",
  "audio-feed-3h1",
  "audio-feed-9mp",
  "audio-feed-bp6r",
  "audio-feed-icl4",
  "audio-feed-kzi",
  "audio-feed-r97",
  "audio-feed-ytg",
];

async function checkEvidenceDeclaration(name: string): Promise<string | null> {
  const dir = `docs/evidence/${name}`;
  const readme = `${dir}/README.md`;
  const body = await Deno.readTextFile(readme).catch(() => null);
  if (body === null) {
    return `${dir}: no README.md`;
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
    const stat = await Deno.stat(script.startsWith("scripts/") ? script : `scripts/${script}`)
      .catch(() => null);
    if (!stat?.isFile) return `${dir}: Script: names ${script}, which does not exist`;
  }
  return null;
}

/** Repo root, so the git query does not depend on the caller's cwd (scripts/fast-check.ts does the same). */
const ROOT = import.meta.dirname!.replace(/\/tests$/, "") + "/";

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
async function carriedEvidenceDirs(): Promise<Set<string>> {
  const out = await new Deno.Command("git", {
    args: ["ls-files", "-z", "--", "docs/evidence"],
    cwd: ROOT,
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

Deno.test("every evidence directory declares what it asserts (audio-feed-fnrp)", async () => {
  const undeclared: string[] = [];

  for await (const entry of Deno.readDir("docs/evidence")) {
    if (!entry.isDirectory || EVIDENCE_UNDECLARED.includes(entry.name)) continue;
    const err = await checkEvidenceDeclaration(entry.name);
    if (err) undeclared.push(err);
  }

  const declaredDebt: string[] = [];
  const staleDebt: string[] = [];
  // audio-feed-9qvz: asked of the INDEX, not of the working directory - see carriedEvidenceDirs.
  const carried = await carriedEvidenceDirs();
  for (const name of EVIDENCE_UNDECLARED) {
    // audio-feed-237f: the list is SHRINK-ONLY and its length is the debt number that gets quoted,
    // so an entry naming a directory the tree does not carry is not harmless clutter - it is a
    // directory that was removed and did not take its entry with it, which inflates the debt and
    // hides that the list did not shrink. `checkEvidenceDeclaration` cannot see the difference: it
    // reports "no README.md" for a missing directory and for a real directory that has no README
    // alike, so the declared case below is the only one it can flag. Listed must imply the TREE
    // CARRIES IT, and listed must imply NOT DECLARED (tp4x) - the two directions of one predicate.
    if (!carried.has(name)) {
      staleDebt.push(name);
      continue;
    }
    const err = await checkEvidenceDeclaration(name);
    if (err === null) {
      declaredDebt.push(name);
    }
  }

  assertEquals(
    undeclared,
    [],
    "evidence must declare its own coverage in docs/evidence/<bead>/README.md (see docs/evidence/README.md, " +
      '"Honesty"): add "- Script: scripts/<proof>.ts" plus "- Asserts: <the claims the script fails on>", or ' +
      '"- Capture: no assertions" when the artifact only records state: ' + undeclared.join("; "),
  );
  assertEquals(
    declaredDebt,
    [],
    "evidence directories listed in EVIDENCE_UNDECLARED already have valid declarations and must be removed from the debt list: " +
      declaredDebt.join(", "),
  );
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
});
