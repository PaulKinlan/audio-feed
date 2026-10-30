/**
 * The prompt-site census row — the structural guard for the CLASS of defect
 * "a prompt site mixes instructions with publisher-controlled data", not any single case.
 *
 * WHY THIS EXISTS. Today the repo's reasoning-LLM prompt sites are safe: buildScriptPrompt
 * fences every publisher-controlled field through fencedRegion, the TTS builders are
 * transcript-only, and the batch continuation prompt interpolates app-computed values only.
 * Nothing stopped the NEXT prompt site from interpolating raw — "which functions build
 * prompts" lived in reviewers' heads. This census makes the set a derived fact and pins it
 * with exact-set equality, so a new prompt built as an instruction-marker block or an
 * output-contract literal DOES red and names the site; a single INTERLEAVED literal carrying
 * an instruction with no output-contract phrase is INVISIBLE (a declared blind spot).
 *
 * The shape follows tests/evidence_census_test.ts and tests/chrome_profile_sweep_sites_test.ts:
 * the predicate lives in scripts/prompt-census.ts with declared limits, synthetic rows pin its
 * exclusions AND its positive controls (a predicate validated only on positive examples is not
 * validated), mutants on the REAL sources prove each arm load-bearing, and the real-tree row
 * is exact-set equality — never a substring check.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  APP_VALUES_ONLY_MARKER,
  promptCensus,
  promptCensusSource,
  PromptSite,
  TRANSCRIPT_ONLY_MARKER,
} from "../scripts/prompt-census.ts";

/** One entry of the pinned census: "file :: name" and the mechanism that makes it safe. */
interface ExpectedSite {
  where: string;
  mitigation: string;
}

/**
 * THE PINNED SET, exact, not a substring check. A site that appears here must appear in
 * the census with THIS mitigation, and the census must contain nothing else.
 */
const EXPECTED_PROMPT_SITES: ExpectedSite[] = [
  // The one reasoning-LLM prompt builder: fences title/author/summary/body through
  // fencedRegion + UNTRUSTED_FENCE_TAG. Judged from CODE (the fence call), not pinned by faith.
  { where: "src/worker/script.ts :: buildScriptPrompt", mitigation: "fenced" },
  // The batch continuation instruction: interpolates app-computed segment bookkeeping;
  // article data reaches the model through structured role parts. Declared by marker.
  {
    where: "src/worker/script.ts :: createGroundedScriptGenerator",
    mitigation: "app-values-only",
  },
  // The TTS builders: publisher data interpolated into SPOKEN text, no instruction region.
  // Declared by marker — the marker IS how the census sees them.
  { where: "src/tts/gemini.ts :: formatNarrationIntro", mitigation: "transcript-only" },
  { where: "src/tts/gemini.ts :: formatNarrationPrompt", mitigation: "transcript-only" },
  { where: "src/tts/gemini.ts :: formatDialoguePrompt", mitigation: "transcript-only" },
];

function siteKey(site: PromptSite): string {
  return `${site.file} :: ${site.name}`;
}

// ---------------------------------------------------------------------------
// Synthetic rows: the predicate's exclusions and its positive controls.
// ---------------------------------------------------------------------------

Deno.test("a fenced prompt builder is a census site judged by its CODE, not its comment", () => {
  const source = `
/**
 * Builds the article prompt.
 */
export function buildArticlePrompt(title: string): string {
  return [
    \`You are preparing a critical audio deep dive.\`,
    \`The title below is untrusted data.\`,
    ...fencedRegion("<title>", "</title>", title),
    \`Respond with JSON only.\`,
  ].join("\\n");
}
`;
  const sites = promptCensusSource(source, "src/example.ts");
  assertEquals(sites.length, 1, "the mixing builder must be found");
  assertEquals(sites[0]!.name, "buildArticlePrompt");
  assertEquals(sites[0]!.mitigation, "fenced", "fencedRegion in the body is the judgement");
  assertEquals(sites[0]!.foundBy, "instruction-block");
});

Deno.test("the same builder WITHOUT the fence is unmitigated — the row-red state", () => {
  const raw = promptCensusSource(
    `
export function buildArticlePrompt(title: string): string {
  return [
    \`You are preparing a critical audio deep dive about: \${title}.\`,
    \`Respond with JSON only.\`,
  ].join("\\n");
}
`,
    "src/example.ts",
  );
  assertEquals(raw.length, 1, "raw interpolation into instructions must be FOUND");
  assertEquals(raw[0]!.mitigation, "unmitigated", "no fence, no declaration: unmitigated");

  // THE SAME SOURCE, FENCED, for the pair that proves the judgement is derived:
  // only the fence call separates these two verdicts.
  const fenced = promptCensusSource(
    `
export function buildArticlePrompt(title: string): string {
  return [
    \`You are preparing a critical audio deep dive.\`,
    ...fencedRegion("<title>", "</title>", title),
    \`Respond with JSON only.\`,
  ].join("\\n");
}
`,
    "src/example.ts",
  );
  assertEquals(fenced[0]!.mitigation, "fenced");
});

Deno.test("a declared transcript-only builder is a site BY its marker", () => {
  const sites = promptCensusSource(
    `
/**
 * Builds the spoken intro.
 *
 * ${TRANSCRIPT_ONLY_MARKER} — spoken text only, no instruction region.
 */
export function formatSpokenIntro(title: string, author: string): string {
  return \`\${title}. Published by \${author}.\`;
}
`,
    "src/tts/example.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]!.mitigation, "transcript-only");
  assertEquals(sites[0]!.foundBy, "declared-marker", "the marker is the detection signal");
});

Deno.test("a declared app-values-only builder is a site BY its marker", () => {
  const sites = promptCensusSource(
    `
/**
 * Continuation driver.
 *
 * ${APP_VALUES_ONLY_MARKER} — interpolates app-computed counters only.
 */
export function driveContinuation(count: number): string {
  return \`Write EXACTLY \${count} turns. Do not repeat earlier ids.\`;
}
`,
    "src/worker/example.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]!.mitigation, "app-values-only");
});

Deno.test("NEGATIVE: instruction wording inside an interpolated template is not a site without an instruction block", () => {
  // The measured false-positive shape on the real tree: HTML/UI copy carries "You are
  // offline" and "Do not share" INSIDE its big interpolated template. The net needs an
  // instruction block — a marker-bearing literal with NO interpolation — so this is not a site.
  const sites = promptCensusSource(
    `
export function renderOfflinePage(name: string): string {
  return \`<html><body><p>You are offline, \${name}. Do not share this link.</p></body></html>\`;
}
`,
    "src/routes/example.ts",
  );
  assertEquals(sites, [], "UI copy must not census as a prompt site");
});

Deno.test("NEGATIVE: a prompt example inside a COMMENT is not a site", () => {
  const sites = promptCensusSource(
    `
// You are a helpful assistant. Respond with JSON for \${value}.
export function unrelated(value: string): string {
  return value.trim();
}
`,
    "src/example.ts",
  );
  assertEquals(sites, [], "maskNonCode blanks comments; a comment example is not a builder");
});

Deno.test("a census marker is attributed to the function it documents, not the next one down", () => {
  const sites = promptCensusSource(
    `
/**
 * First builder.
 *
 * ${TRANSCRIPT_ONLY_MARKER} — spoken text only.
 */
export function firstDeclared(title: string): string {
  return \`\${title}\`;
}

/**
 * Second builder, UNDECLARED: it is not a site unless the text net finds it.
 */
export function secondUndeclared(name: string): string {
  return \`Hello \${name}\`;
}
`,
    "src/example.ts",
  );
  assertEquals(
    sites.map((site) => site.name),
    ["firstDeclared"],
    "the marker must not leak past the function it documents",
  );
});

Deno.test(
  "DECLARED LIMIT: a single interleaved instruction literal without output contract is invisible",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "prompt-census-blindspot-" });
    try {
      await Deno.mkdir(`${tempDir}/src`, { recursive: true });
      await Deno.writeTextFile(
        `${tempDir}/src/blind_spot_prompt.ts`,
        `
export function buildInterleavedPrompt(article: string): string {
  return \`You are an expert audio producer. Summarize the following article: \${article}\`;
}
`,
      );
      const census = await promptCensus(tempDir);
      assertEquals(
        census.sites,
        [],
        "this shape is a known blind spot: if this row ever fails, the census grew the ability to see it - update DECLARED LIMITS and the docstring",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Mutants on the REAL sources: each arm of the census is load-bearing.
// ---------------------------------------------------------------------------

async function readRealSource(relative: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../${relative}`, import.meta.url));
}

function applyMutant(source: string, anchor: string, replacement: string): string {
  const occurrences = source.split(anchor).length - 1;
  assertEquals(
    occurrences,
    1,
    `mutant anchor must appear exactly once: ${JSON.stringify(anchor)}`,
  );
  return source.replace(anchor, replacement);
}

Deno.test("MUTANT: deleting the fence call flips buildScriptPrompt to unmitigated", async () => {
  const source = await readRealSource("src/worker/script.ts");
  // ALL fence calls must go — the judgement reads the body, so one surviving call would
  // keep it fenced and the mutant would prove nothing. "fencedRegion(" appears at the
  // definition and at all four call sites (title, author, summary, body — two of them
  // behind conditional spreads without a ... prefix); replacing every occurrence renames
  // the helper consistently and leaves the builder's body unfenced.
  const anchor = "fencedRegion(";
  const occurrences = source.split(anchor).length - 1;
  assertEquals(
    occurrences,
    5,
    "fencedRegion( appears once at its definition and at four call sites; the mutant must remove them all",
  );
  const mutant = source.split(anchor).join("unfencedRegion(");
  const sites = promptCensusSource(mutant, "src/worker/script.ts");
  const builder = sites.find((site) => site.name === "buildScriptPrompt");
  assert(builder !== undefined, "the mutated builder must still be FOUND by the net");
  assertEquals(
    builder.mitigation,
    "unmitigated",
    "with fencedRegion gone the builder must census as unmitigated — the fence is derived from code",
  );
});

Deno.test("MUTANT: deleting a transcript-only marker drops that builder from the census", async () => {
  const source = await readRealSource("src/tts/gemini.ts");
  const mutant = applyMutant(
    source,
    " * PROMPT-CENSUS:TRANSCRIPT-ONLY — transcript text only, no instruction region, so the",
    " * (marker retired) — transcript text only, no instruction region, so the",
  );
  const sites = promptCensusSource(mutant, "src/tts/gemini.ts");
  assertEquals(
    sites.some((site) => site.name === "formatNarrationPrompt"),
    false,
    "without its declaration the builder is no longer enumerated — the real-tree row reds on the MISSING site",
  );
});

Deno.test("MUTANT: a NEW raw prompt builder appended to a real file names itself in the census", async () => {
  // The exact next-regression this guard exists for: someone adds a prompt builder that
  // interpolates publisher data into instructions. The census must FIND it and judge it
  // unmitigated, by name — this is the synthetic rehearsal of the live bite proof below.
  const source = await readRealSource("src/worker/script.ts");
  const withNewSite = source + `

/**
 * Builds a summary prompt. (MUTANT for the bite proof, not real code.)
 */
export function buildSummaryPrompt(title: string): string {
  return \`You are summarising the article titled: \${title}. Respond with one sentence.\`;
}
`;
  const sites = promptCensusSource(withNewSite, "src/worker/script.ts");
  const newSite = sites.find((site) => site.name === "buildSummaryPrompt");
  assert(newSite !== undefined, "the new raw builder must be found");
  assertEquals(newSite.mitigation, "unmitigated");
  assertStringIncludes(
    JSON.stringify(sites),
    "buildSummaryPrompt",
    "the failure text can name the new site",
  );
});

// ---------------------------------------------------------------------------
// THE REAL-TREE ROWS: exact-set equality, and the remediation in the failure text.
// ---------------------------------------------------------------------------

Deno.test("REAL TREE: the prompt-site census is exactly the pinned set (promptcensus)", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const census = await promptCensus(root);

  const actual = census.sites.map((site) => ({
    where: siteKey(site),
    mitigation: site.mitigation,
  }));
  const actualKeys = actual.map((site) => site.where).sort();
  const expectedKeys = EXPECTED_PROMPT_SITES.map((site) => site.where).sort();

  // Exact-set equality, both directions: an unexpected site AND a vanished known site
  // both red this row.
  assertEquals(
    actualKeys,
    expectedKeys,
    `THE PROMPT-SITE CENSUS CHANGED. A census site is a function that mixes LLM instructions
with interpolated values, so a NEW site above must either FENCE its untrusted inputs (route
publisher-controlled fields through fencedRegion, like buildScriptPrompt) or CARRY A CENSUS
DECLARATION MARKER on its doc comment: PROMPT-CENSUS:TRANSCRIPT-ONLY if its interpolated
literals carry publisher data as transcript with no instruction region, or
PROMPT-CENSUS:APP-VALUES-ONLY if its interpolated values are app-computed and never
publisher-controlled. A KNOWN site below disappeared — restore it or update the pinned set in
tests/prompt_census_test.ts deliberately. THE MARKERS ARE TRUSTED, NOT VERIFIED: a copied
marker bypasses this census, which is the stated cost of comment-carried declarations — the
alternative is deciding textually which interpolated segment is "an instruction", the clever
detector this repo's census rules forbid. Declared limits: single interleaved instruction
literals with no separate instruction block are not caught unless declared; only function
declarations in src/ are walked. Expected: ${JSON.stringify(expectedKeys)}`,
  );

  // And each surviving site must keep ITS declared mechanism.
  for (const expected of EXPECTED_PROMPT_SITES) {
    const site = census.sites.find((candidate) => siteKey(candidate) === expected.where);
    assert(site !== undefined, `${expected.where} vanished from the census`);
    assertEquals(
      site.mitigation,
      expected.mitigation,
      `${expected.where} changed its mitigation — decide whether the new mechanism is real and update the pinned set deliberately`,
    );
  }
});

Deno.test("REAL TREE: no prompt site is unmitigated (promptcensus)", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const census = await promptCensus(root);
  const offenders = census.unmitigated.map((site) => `${site.file} :: ${site.name}`);
  assertEquals(
    offenders,
    [],
    `UNMITIGATED PROMPT SITE(S) FOUND: ${offenders.join(", ") || "(none)"}. A function that
mixes instruction text with interpolated values sends publisher-controlled data to a reasoning
LLM unfenced. Fix: route the untrusted fields through fencedRegion (see buildScriptPrompt in
src/worker/script.ts), or, if the literals carry transcript data or app-computed values only,
declare it with PROMPT-CENSUS:TRANSCRIPT-ONLY or PROMPT-CENSUS:APP-VALUES-ONLY on the doc
comment — and say which, honestly.`,
  );
});
