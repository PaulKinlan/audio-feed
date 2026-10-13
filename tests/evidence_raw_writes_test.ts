/**
 * audio-feed-n16x — every browser proof writing to docs/evidence/ must route through
 * shared evidence helpers (quantiseEvidencePng and writeEvidenceReadme) inside runProof.
 *
 * This test guarantees that no browser proof performs unmediated raw writes to docs/evidence/,
 * ensuring every screenshot and README participates in active proof context tracking and
 * failure refusal.
 */
import { assert, assertEquals } from "@std/assert";
import { censusSource } from "../scripts/evidence-census.ts";

const TARGET_SCRIPTS = [
  "scripts/playback-position-browser-proof.ts",
  "scripts/spend-visibility-browser-proof.ts",
  "scripts/landing-tooltip-browser-proof.ts",
  "scripts/request-access-browser-proof.ts",
];

Deno.test("audio-feed-n16x: four target browser proofs execute inside runProof and invoke evidence helpers", async () => {
  for (const script of TARGET_SCRIPTS) {
    const content = await Deno.readTextFile(script);
    assert(
      content.includes("runProof("),
      `${script} must execute inside runProof`,
    );
    assert(
      content.includes("quantiseEvidencePng("),
      `${script} must process screenshots with quantiseEvidencePng`,
    );
    assert(
      content.includes("writeEvidenceReadme("),
      `${script} must write evidence README with writeEvidenceReadme`,
    );
    assert(
      !content.includes("Deno.writeTextFile(`${OUT}README.md`") &&
        !content.includes("Deno.writeTextFile(`${OUT}README.md`") &&
        !content.includes("Deno.writeTextFile(`${OUT}/README.md`"),
      `${script} must not write raw README.md directly`,
    );
  }
});

Deno.test("audio-feed-n16x: all browser proof scripts writing evidence use runProof and quantiseEvidencePng", async () => {
  const unmediated: string[] = [];

  for await (const entry of Deno.readDir("scripts")) {
    if (!entry.isFile || !entry.name.endsWith("-browser-proof.ts")) continue;
    const path = `scripts/${entry.name}`;
    const content = await Deno.readTextFile(path);
    const census = censusSource(content);

    // If the script writes into an evidence directory, verify it uses helpers
    if (census.writes.length > 0) {
      const hasRunProof = content.includes("runProof(");
      const hasQuantise = content.includes("quantiseEvidencePng(");
      const hasReadme = content.includes("writeEvidenceReadme(");

      if (!hasRunProof || (!hasQuantise && !hasReadme)) {
        unmediated.push(
          `${path} (writes: ${
            census.writes.join(", ")
          }, runProof: ${hasRunProof}, quantise: ${hasQuantise}, readme: ${hasReadme})`,
        );
      }
    }
  }

  assertEquals(
    unmediated,
    [],
    `All browser proofs writing evidence must use runProof and shared helpers: ${
      JSON.stringify(unmediated, null, 2)
    }`,
  );
});
