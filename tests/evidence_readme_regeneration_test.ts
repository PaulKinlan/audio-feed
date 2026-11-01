/**
 * The committed README of an evidence directory must carry NO heading that its proof's own
 * writeEvidenceReadme call fails to reproduce (audio-feed-vavnp): at seeding time the guard REFUSES
 * the regeneration and turns the whole run RED, and before that guard existed the same drift
 * silently deleted a hand-written section (the 2026-10-31 audio-feed-8eh seeding run). This suite is
 * the commit-time half of that guard for the five directories migrated on audio-feed's
 * fleet/readme-migrate branch: it reads each proof script's writeEvidenceReadme options as TEXT,
 * evaluates them with the runtime-dependent values stubbed, and asserts the guard passes.
 *
 * WHY TEXT EXTRACTION AND NOT AN IMPORT: the options live inline inside runProof() callbacks of
 * browser proofs, which cannot be imported without launching Chrome. Only heading-bearing content
 * matters here, and headings are static literals in those calls; the stubs only satisfy evaluation.
 *
 * KNOWN LIMIT, STATED PLAINLY: the Execution Log bodies are stubbed, so this pins HEADINGS, not
 * run-dependent log bytes - byte-stability of a log is what a real proof run proves (the
 * committed-vs-generated comparison for a real run is writeEvidenceReadme's own guard).
 *
 * The evidence paths are COMPOSED AT RUNTIME on purpose (the audio-feed-t9w1 rule): a literal
 * docs/evidence path in this file would make this suite an observer of evidence files it only
 * guards indirectly, and bloating the observed-by sets breaks the pinned subsets in
 * tests/fast_gate_subset_test.ts.
 *
 *   deno test --allow-read tests/evidence_readme_regeneration_test.ts
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { headingsNotReproduced } from "../scripts/evidence-readme.ts";
import { formatEvidenceReadme } from "../scripts/proof-helper.ts";

const ROOT = new URL("..", import.meta.url).pathname;
// Composed at runtime: see the header. `EVIDENCE_PREFIX` is spelled out here rather than imported
// from scripts/evidence-census.ts so this suite's static relations stay exactly the two harness
// modules below.
const evidenceDir = (id: string) => `${"docs/evidence"}/audio-feed-${id}`;
const proofScript = (name: string) => `${"scripts"}/${name}`;

/** Runtime values that never carry a heading: one log row, one assert, an empty checker, a path. */
const STUBS: Record<string, unknown> = {
  OUT: "/tmp/evidence-readme-regeneration-stub/",
  checker: {},
  steps: [{ name: "stub", pass: true, detail: "stub" }],
  checks: [{ name: "stub", pass: true, detail: "stub" }],
  audioBytes: { byteLength: 0 },
  ASSERTS: ["stub assert"],
};

interface Case {
  /** Evidence directory id, e.g. "9mp". */
  id: string;
  script: string;
}

const CASES: Case[] = [
  { id: "8eh", script: "bootstrap-browser-proof.ts" },
  { id: "exww", script: "exww-live-claims-browser-proof.ts" },
  { id: "l7m1", script: "verify_main_l7m1_e2e.ts" },
  { id: "wzv9", script: "repro_wzv9_claim_forensics.ts" },
  { id: "9mp", script: "spend-visibility-browser-proof.ts" },
];

/**
 * Re-emit the README the proof's own options would produce. Slices the `await writeEvidenceReadme({
 * ... })` literal out of the script and evaluates it with STUBS in scope; a slice that is not one
 * balanced object literal throws loudly rather than guessing (the house rule for malformed input).
 */
function generatorOutput(c: Case): string {
  const text = Deno.readTextFileSync(`${ROOT}/${proofScript(c.script)}`);
  const marker = "await writeEvidenceReadme(";
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`${proofScript(c.script)}: no writeEvidenceReadme call found`);
  const open = text.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`${proofScript(c.script)}: unbalanced writeEvidenceReadme literal`);
  const options = new Function(...Object.keys(STUBS), `return (${text.slice(open, end)});`)(
    ...Object.values(STUBS),
  );
  return formatEvidenceReadme({
    ...options,
    dir: STUBS.OUT as string,
    allowOutsideProof: true,
  });
}

function committedReadme(c: Case): string {
  return Deno.readTextFileSync(`${ROOT}/${evidenceDir(c.id)}/README.md`);
}

for (const c of CASES) {
  Deno.test(
    `audio-feed-${c.id}: the proof's own README call reproduces every heading in the committed README`,
    () => {
      assertEquals(
        headingsNotReproduced(committedReadme(c), generatorOutput(c)),
        [],
        `writeEvidenceReadme would refuse docs/evidence/audio-feed-${c.id}: fold the section into ` +
          `the proof's notes/sections (audio-feed-vavnp) rather than editing the README by hand`,
      );
    },
  );
}

const MP9: Case = { id: "9mp", script: "spend-visibility-browser-proof.ts" };

Deno.test("audio-feed-9mp: every fact the README carried before the migration survives regeneration", () => {
  const facts = [
    "Debt: admitted (audio-feed-tgnu)",
    "#synthesisBody",
    "#statSynthesis",
    "#newDailyBudget",
    "01-admin-spend-visibility.png",
    "Spend visibility and per-user daily episode budget",
    "Episodes synthesised",
    "daily budget input in the subscriber creation form",
  ];
  for (const fact of facts) {
    assertStringIncludes(committedReadme(MP9), fact);
    assertStringIncludes(generatorOutput(MP9), fact);
  }
});
