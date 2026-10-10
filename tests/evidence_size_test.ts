/**
 * audio-feed-39k1 — the evidence tree has a size budget.
 *
 * 18 of the 20 largest files in the repo were docs/evidence PNGs (~285KB
 * each; 15MB total) because the Functional Verification Mandate requires
 * screenshots and nothing bounded their size. The fix is a palette
 * compression pass (`deno task evidence:compress`) plus this check: any
 * evidence PNG over the budget fails the suite, with the remediation in the
 * message. The budget (150KB) sits comfortably above what a compressed
 * full-page 1280px screenshot lands at (~95-115KB) so a legitimate shot
 * passes and an uncompressed one does not.
 */

import { assertEquals } from "@std/assert";
import { EVIDENCE_PNG_BUDGET_BYTES } from "../scripts/evidence-compress.ts";

Deno.test("docs/evidence PNGs stay under the size budget", async () => {
  const oversized: string[] = [];

  async function scan(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await scan(path);
      } else if (entry.name.toLowerCase().endsWith(".png")) {
        const { size } = await Deno.stat(path);
        if (size > EVIDENCE_PNG_BUDGET_BYTES) {
          oversized.push(`${path} (${(size / 1024).toFixed(0)}KB)`);
        }
      }
    }
  }
  await scan("docs/evidence");

  assertEquals(
    oversized,
    [],
    `evidence PNGs exceed the ${(EVIDENCE_PNG_BUDGET_BYTES / 1024).toFixed(0)}KB budget — ` +
      "run `deno task evidence:compress` (see docs/evidence/README.md): " + oversized.join(", "),
  );
});
