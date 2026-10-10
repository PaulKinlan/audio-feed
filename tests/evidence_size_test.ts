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
