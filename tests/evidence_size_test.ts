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
 */
const EVIDENCE_UNDECLARED: string[] = [
  "att-paging",
  "audio-feed-0cmu",
  "audio-feed-0jp",
  "audio-feed-0r0s",
  "audio-feed-0rmn",
  "audio-feed-25t",
  "audio-feed-3asd",
  "audio-feed-3h1",
  "audio-feed-3xq",
  "audio-feed-6y9",
  "audio-feed-7jsl",
  "audio-feed-8eh",
  "audio-feed-8fc",
  "audio-feed-8oz",
  "audio-feed-9mp",
  "audio-feed-9vns",
  "audio-feed-9yu8",
  "audio-feed-b6nr",
  "audio-feed-b75q",
  "audio-feed-bp6r",
  "audio-feed-dc2y",
  "audio-feed-e1d",
  "audio-feed-fydf",
  "audio-feed-gueb",
  "audio-feed-i7vi",
  "audio-feed-icl4",
  "audio-feed-khk3",
  "audio-feed-kzi",
  // Landed on main from another lane while fnrp was in review, i.e. before the rule existed: it belongs to
  // the same debt as the rest of this list. Its README also carries an ephemeral port and a commit sha in its
  // title line, which is the audio-feed-1zfv class recorded on that bead.
  "audio-feed-l7m1",
  "audio-feed-ldsb",
  "audio-feed-ls92",
  "audio-feed-m182",
  "audio-feed-msw",
  "audio-feed-np5",
  "audio-feed-o9kc",
  "audio-feed-py5",
  "audio-feed-r97",
  "audio-feed-s2pi",
  "audio-feed-sa4g",
  "audio-feed-syhu",
  "audio-feed-u2ve",
  "audio-feed-u60a",
  "audio-feed-vpw",
  "audio-feed-wzv9",
  "audio-feed-xw7",
  "audio-feed-ytg",
  "c5n-dock-reserve",
  "ct1-run-history",
  "ingest",
  "linkbacks",
];

Deno.test("every evidence directory declares what it asserts (audio-feed-fnrp)", async () => {
  const undeclared: string[] = [];

  for await (const entry of Deno.readDir("docs/evidence")) {
    if (!entry.isDirectory || EVIDENCE_UNDECLARED.includes(entry.name)) continue;
    const dir = `docs/evidence/${entry.name}`;
    const readme = `${dir}/README.md`;
    const body = await Deno.readTextFile(readme).catch(() => null);
    if (body === null) {
      undeclared.push(`${dir}: no README.md`);
      continue;
    }
    const asserts = body.match(/^- Asserts:\s*(.+)$/m)?.[1]?.trim() ?? "";
    // The capture hatch is an ADMISSION, not free text: it must be the literal sentence, otherwise a README can
    // say "- Capture: fully tested and guaranteed", assert nothing and pass (audio-feed-6piu, found in review).
    const capture = /^- Capture:\s*no assertions\s*$/m.test(body);
    const script = body.match(/^- Script:\s*(\S+)/m)?.[1];
    if (!asserts && !capture) {
      undeclared.push(`${dir}: needs a "- Asserts: <claims>" or "- Capture: no assertions" line`);
      continue;
    }
    if (asserts && !script) {
      undeclared.push(
        `${dir}: declares Asserts: with no "- Script: scripts/<proof>.ts" to attach them to`,
      );
      continue;
    }
    if (script) {
      const stat = await Deno.stat(script.startsWith("scripts/") ? script : `scripts/${script}`)
        .catch(() => null);
      if (!stat?.isFile) undeclared.push(`${dir}: Script: names ${script}, which does not exist`);
    }
  }

  assertEquals(
    undeclared,
    [],
    "evidence must declare its own coverage in docs/evidence/<bead>/README.md (see docs/evidence/README.md, " +
      '"Honesty"): add "- Script: scripts/<proof>.ts" plus "- Asserts: <the claims the script fails on>", or ' +
      '"- Capture: no assertions" when the artifact only records state: ' + undeclared.join("; "),
  );
});
