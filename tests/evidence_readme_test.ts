/**
 * Unit tests for the marker-delimited generated region (audio-feed-pluv).
 *
 * These are the gate-runnable half of the fix: the r97 generator is a browser proof and cannot run in
 * the fast gate, so the properties that make a two-writer README safe have to be pinned here, on a
 * fixture, rather than by hoping a browser run agrees with a committed file.
 *
 *   deno test --allow-net --allow-env --allow-read --allow-write --allow-run --unstable-kv \
 *     tests/evidence_readme_test.ts
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  GENERATED_BEGIN,
  GENERATED_END,
  hasGeneratedRegion,
  isRegenerationStable,
  mergeGeneratedRegion,
  splitGeneratedRegion,
  wrapGeneratedRegion,
} from "../scripts/evidence-readme.ts";
import { formatEvidenceReadme } from "../scripts/proof-helper.ts";
import { PLAYBACK_POSITION_EVIDENCE } from "../scripts/playback-position-evidence.ts";

const GENERATED_BODY = "PASS  a generated row\nPASS  another generated row";

/** The shape the real evidence READMEs have: curated prose a generator knows nothing about, plus a log. */
const CURATED = `# Browser Proof: request access (fixture)

- Script: scripts/some-proof.ts

## Why this exists

A human wrote this paragraph and it must survive every regeneration - this is the class of content the
r97 run destroyed (measured: 36 committed lines reduced to 4).

${GENERATED_BEGIN}
${GENERATED_BODY}
${GENERATED_END}

## Criteria

1. A human-curated criterion that no generator knows about.
`;

Deno.test("audio-feed-pluv: merging the SAME generated body twice is a no-op (idempotent)", () => {
  const once = mergeGeneratedRegion(CURATED, GENERATED_BODY);
  const twice = mergeGeneratedRegion(once, GENERATED_BODY);
  assertEquals(twice, once, "a second run must not change the file");
  assertEquals(isRegenerationStable(once, GENERATED_BODY), true);
});

Deno.test("audio-feed-pluv: content OUTSIDE the region survives regeneration byte-for-byte", () => {
  const merged = mergeGeneratedRegion(CURATED, "PASS  a fresh row");
  assertStringIncludes(
    merged,
    "A human wrote this paragraph and it must survive every regeneration",
  );
  assertStringIncludes(merged, "1. A human-curated criterion that no generator knows about.");
  assertStringIncludes(merged, "- Script: scripts/some-proof.ts");
  assert(!merged.includes("another generated row"), "the superseded generated body must be gone");
  assertStringIncludes(merged, "PASS  a fresh row");
});

Deno.test("audio-feed-pluv: the byte-identity pin can FAIL, or it pins nothing", () => {
  assertEquals(isRegenerationStable(CURATED, GENERATED_BODY), true);
  assertEquals(
    isRegenerationStable(CURATED, "PASS  a DIFFERENT row"),
    false,
    "a README that disagrees with the generator must be reported unstable",
  );
  assertEquals(
    isRegenerationStable(mergeGeneratedRegion(CURATED, "x"), GENERATED_BODY),
    false,
    "an edited region must be reported unstable",
  );
});

Deno.test("audio-feed-pluv: a marker MENTIONED inline is not a marker (whole-line matching)", () => {
  const doc = `# t

A README may talk about \`${GENERATED_BEGIN}\` in the middle of a sentence.

${GENERATED_BEGIN}
body
${GENERATED_END}
`;
  const split = splitGeneratedRegion(doc);
  assertEquals(split.generated, "body");
  assertStringIncludes(split.before, "in the middle of a sentence");
  assertEquals(
    mergeGeneratedRegion(doc, "body"),
    doc,
    "the inline mention is human text and must round-trip untouched",
  );
});

Deno.test("audio-feed-pluv: KNOWN LIMIT, pinned on purpose - a marker alone on a line inside a fence IS a marker", () => {
  // Text alone cannot say whether a standalone marker line is a fence's contents or the real marker,
  // and this module deliberately does not parse markdown. The contract is therefore "never paste the
  // marker alone on a line", and this row exists so the limit is a decision rather than a surprise:
  // if someone later teaches the splitter to skip fenced regions, this test failing is the intended
  // signal that the contract changed.
  const doc = `# t

\`\`\`
${GENERATED_END}
\`\`\`

${GENERATED_BEGIN}
body
${GENERATED_END}
`;
  assertThrows(
    () => splitGeneratedRegion(doc),
    Error,
    "appears 2 times",
    "the fenced copy is counted as a second marker, which is why the contract says not to paste one",
  );
});

Deno.test("audio-feed-pluv: malformed marker sets are LOUD, never guessed", () => {
  assertThrows(
    () => splitGeneratedRegion("# no markers at all\n"),
    Error,
    "is missing",
  );
  assertThrows(
    () => splitGeneratedRegion(`${GENERATED_BEGIN}\nx\n${GENERATED_END}\n${GENERATED_END}\n`),
    Error,
    "appears 2 times",
  );
  assertThrows(
    () => splitGeneratedRegion(`${GENERATED_END}\nx\n${GENERATED_BEGIN}\n`),
    Error,
    "precedes the begin",
  );
});

Deno.test("audio-feed-pluv: the wrapper emits the markers as their own lines", () => {
  assertEquals(wrapGeneratedRegion("body\n"), `${GENERATED_BEGIN}\nbody\n${GENERATED_END}`);
});

Deno.test("audio-feed-fied: a marker-delimited README with NO final newline round-trips byte-for-byte", () => {
  // rev-19's finding, pinned in both directions: the merge used to append a newline to any file whose
  // end marker was its last line, so `isRegenerationStable` reported an unstable file that was already
  // correct - and the first regeneration would have dirtied it. A README's final-newline convention is
  // its own; this module must preserve whichever one the committed file has.
  const noFinalNewline = `${GENERATED_BEGIN}\nbody\n${GENERATED_END}`;
  assertEquals(mergeGeneratedRegion(noFinalNewline, "body"), noFinalNewline);
  assertEquals(isRegenerationStable(noFinalNewline, "body"), true);

  const withFinalNewline = `${noFinalNewline}\n`;
  assertEquals(mergeGeneratedRegion(withFinalNewline, "body"), withFinalNewline);
  assertEquals(isRegenerationStable(withFinalNewline, "body"), true);

  // and a human tail is preserved with or without a final newline
  const tailNoNewline = `${GENERATED_BEGIN}\nbody\n${GENERATED_END}\n\n## Criteria\n1. x`;
  assertEquals(mergeGeneratedRegion(tailNoNewline, "body"), tailNoNewline);
  assertEquals(isRegenerationStable(tailNoNewline, "body"), true);
  const tailWithNewline = `${tailNoNewline}\n`;
  assertEquals(mergeGeneratedRegion(tailWithNewline, "body"), tailWithNewline);
  assertEquals(isRegenerationStable(tailWithNewline, "body"), true);
});

Deno.test(
  "audio-feed-i98g1: the committed kzi README is regeneration-stable against the proof's ACTUAL options",
  async () => {
    // THE ACCEPTANCE, GATE-RUNNABLE. The proof itself is a browser script, so the fast gate cannot
    // run it twice and diff; instead the options it generates its README from are shared
    // (scripts/playback-position-evidence.ts) and pinned here against the committed file. If the
    // script's asserts change and the committed file is not regenerated in the same commit, this
    // row goes red BEFORE a run can silently dirty the two-writer file.
    const committed = await Deno.readTextFile(
      new URL("../docs/evidence/audio-feed-kzi/README.md", import.meta.url),
    );
    const generated = formatEvidenceReadme({
      ...PLAYBACK_POSITION_EVIDENCE,
      dir: new URL("../docs/evidence/audio-feed-kzi/", import.meta.url).pathname,
    });
    assertEquals(hasGeneratedRegion(committed), true, "the kzi README must be migrated to markers");
    assertEquals(
      isRegenerationStable(committed, generated),
      true,
      "the committed README must survive a regeneration unchanged - run scripts/playback-position-browser-proof.ts and commit its README if the asserts moved",
    );
    // and the human prose the markers exist to protect is actually there. The `- Debt: admitted
    // (audio-feed-tgnu)` line is deliberately GONE (audio-feed-t5gt): the directory now carries a valid
    // declaration, and an admitted directory with a valid declaration must remove its debt admission -
    // the debt list is shrink-only and its length is the debt number.
    for (
      const prose of [
        "## Feature",
        "## Real-Browser CDP Verification",
        "## Artifacts",
      ]
    ) {
      assertStringIncludes(committed, prose);
    }
    assert(
      !committed.includes("- Debt: admitted"),
      "a declaring directory must not also carry a debt admission (audio-feed-t5gt)",
    );
  },
);
