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

Deno.test("every evidence directory declares what it asserts (audio-feed-fnrp)", async () => {
  const undeclared: string[] = [];

  for await (const entry of Deno.readDir("docs/evidence")) {
    if (!entry.isDirectory || EVIDENCE_UNDECLARED.includes(entry.name)) continue;
    const err = await checkEvidenceDeclaration(entry.name);
    if (err) undeclared.push(err);
  }

  const declaredDebt: string[] = [];
  for (const name of EVIDENCE_UNDECLARED) {
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
});
