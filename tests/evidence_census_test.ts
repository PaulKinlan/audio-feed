/**
 * audio-feed-t9w1 — the census predicate is validated on NEGATIVE examples.
 *
 * The predicate this replaces matched the presence of an `audio-feed-*` string
 * in a script's source, which is a proxy for "writes evidence" and not the thing
 * itself. It fired falsely four times in the real tree (two bead ids, two
 * browser probes that commit nothing), and a 31/31 check against real
 * directories could not have caught any of them, because every case it looked at
 * was a real directory. So the fixtures below are mostly EXCLUSIONS, and one of
 * them is a POSITIVE CONTROL of the same shape: a predicate narrowed until it
 * never fires would pass every exclusion here and must fail that control.
 *
 * The last test is the real tree, which cost nothing to add and is the strongest
 * negative control available: the four scripts named on the bead must come out
 * with a mention and no write.
 */
import { assert, assertEquals } from "@std/assert";
import { census, censusSource, EVIDENCE_PREFIX, WRITE_CALLS } from "../scripts/evidence-census.ts";

const dir = (id: string) => `audio-feed-${id}`;
/**
 * A docs/evidence path COMPOSED AT RUNTIME (audio-feed-vex8).
 *
 * WHY THIS HELPER EXISTS, because it looks like pointless indirection: the gate's read relation
 * resolves FULLY LITERAL paths, and a suite whose source carries one is recorded as observing it.
 * Writing `"docs/evidence/audio-feed-x/y.png"` here made THIS TEST FILE an observer of every
 * evidence PNG, which selected it for changes to files it has nothing to do with and broke five
 * pinned assertions in tests/fast_gate_subset_test.ts (the observed-by sets gained this file).
 * Composing the path narrows the relation without touching a single pinned set, which is the rule
 * for a false positive: narrow the derivation, never loosen the fixture. The fixture string still
 * contains the literal at runtime, which is what the census under test needs to see.
 */
const ev = (rest: string) => `${EVIDENCE_PREFIX}/${rest}`;

Deno.test("a write call whose target is an evidence directory is a writer", () => {
  // Both real shapes: the helper may name the slice directly, because naming it
  // IS its contract, and a generic write must sit under docs/evidence.
  const helper = `
    await writeEvidenceReadme({ dir: "audio-feed-abcd", title: "x", assertions: [] });
  `;
  assertEquals(censusSource(helper).writes, [dir("abcd")]);
  const generic = `
    await Deno.writeTextFile("${ev(dir("wxyz") + "/README.md")}", content);
  `;
  assertEquals(censusSource(generic).writes, [dir("wxyz")]);
});

Deno.test("a bead id in a COMMENT is not a writer (the s3uk/i7vi false positive)", () => {
  const source = `
    /**
     * audio-feed-abcd — this script drives a real browser and asserts results.
     */
    const result = await page.title();
    console.log(result);
  `;
  const result = censusSource(source);
  assertEquals(result.writes, []);
  assertEquals(result.mentions, [dir("abcd")]);
});

Deno.test("a bead id in a STRING that is not a write target is not a writer", () => {
  const source = `
    const key = \`audio-feed-positions:\${TOKEN}\`;
    Deno.env.set("REPORT_DIR", "audio-feed-abcd");
    const raw = localStorage.getItem("audio-feed-abcd");
  `;
  const result = censusSource(source);
  assertEquals(result.writes, []);
  assert(result.mentions.length > 0, "the mention must still be visible as a mention");
});

Deno.test("a READ from an evidence directory is not a writer", () => {
  const source = `
    const readme = await Deno.readTextFile("${ev(dir("abcd") + "/README.md")}");
    const bytes = await Deno.readFile("${EVIDENCE_PREFIX}/audio-feed-abcd/01-x.png");
  `;
  assertEquals(censusSource(source).writes, []);
});

Deno.test("a write to somewhere that is not docs/evidence is not an evidence writer", () => {
  const source = `
    await Deno.writeTextFile("/tmp/audio-feed-abcd-report.txt", report);
    await Deno.writeTextFile("docs/notes.md", "audio-feed-abcd is described here");
  `;
  assertEquals(censusSource(source).writes, []);
});

Deno.test("a browser probe that asserts but commits nothing is not an evidence slice", () => {
  const source = `
    // audio-feed-abcd — probe only, this script commits nothing
    await page.click("#open");
    assertEquals(await page.textContent("#panel"), "Disclosure");
    await chrome.close();
  `;
  const result = censusSource(source);
  assertEquals(result.writes, []);
  assertEquals(result.mentions, [dir("abcd")]);
});

Deno.test("POSITIVE CONTROL: the same shapes AS A WRITE TARGET still fire", () => {
  // If a narrowing of the predicate ever switched it off, the exclusions above
  // would all still pass and this would fail.
  const source = `
    const OUT = new URL("../${ev(dir("efgh") + "/")}", import.meta.url).pathname;
    await Deno.mkdir(OUT, { recursive: true });
    await Deno.writeFile(OUT + "01-shot.png", png);
    await writeEvidenceReadme({ dir: "${ev(dir("ijkl"))}", title: "t", assertions: [] });
  `;
  const result = censusSource(source);
  assertEquals(result.writes.sort(), [dir("efgh"), dir("ijkl")].sort());
});

Deno.test("a write whose evidence target is assembled at runtime is REPORTED, not dropped", () => {
  const source = `
    const name = "audio-feed-" + suffix;
    await Deno.writeFile(\`docs/evidence/\${name}/01-shot.png\`, png);
  `;
  const result = censusSource(source);
  assertEquals(result.writes, []);
  assertEquals(result.runtimeAssembled.length, 1);
});

Deno.test("THE REAL TREE: the four scripts named on the bead write nothing", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const result = await census(root);
  const specimens = [
    "scripts/verify_s3uk_real_browser.ts",
    "scripts/verify_i7vi_events.ts",
    "scripts/verify_i7vi_browser.ts",
    "scripts/verify_s2pi_errors_api.ts",
  ];
  for (const script of specimens) {
    const writes = Object.entries(result.writers)
      .filter(([, scripts]) => scripts.includes(script))
      .map(([dirName]) => dirName);
    assertEquals(writes, [], `${script} must not be counted as a writer`);
    assert(
      result.namingButNotWriting[script]?.length,
      `${script} must still be visible as a mention-only script`,
    );
  }
  // ...and the predicate still finds real writers, or the exclusions above would
  // be satisfied by a predicate that never fires at all.
  assert(
    Object.keys(result.writers).length > 10,
    `expected the real tree to have writers, got ${Object.keys(result.writers).length}`,
  );
});

// ---------------------------------------------------------------------------
// audio-feed-ehon: the RAW-source and WHOLE-argument-text holes. The tests above
// all passed while the predicate still counted three shapes that write nothing, so
// these are the reviewer's three cases, the same controls as above, and the
// POSITIVE CONTROL in the same source set - because a narrowing that stopped the
// predicate firing would satisfy every exclusion below and must fail that control.
// ---------------------------------------------------------------------------

Deno.test("audio-feed-ehon: a write PAYLOAD, a COMMENT example and a STRING example are mentions, not writes", () => {
  const sources: Record<string, string> = {
    // Writes /tmp; the id is in the second argument, which is data.
    payload: `await Deno.writeTextFile("/tmp/report.txt", "docs/evidence/${dir("abcd")}");\n`,
    lineComment: `// await Deno.writeFile("docs/evidence/${dir("wxyz")}/shot.png", png);\n`,
    blockComment: `/* await Deno.writeFile("docs/evidence/${dir("blk")}/shot.png", png); */\n`,
    stringLiteral: `const example = 'Deno.writeFile("docs/evidence/${
      dir("efgh")
    }/shot.png", png)';\n`,
    templateText: 'const t = `Deno.writeFile("docs/evidence/' + dir("tpl") + '/s.png")`;\n',
  };
  for (const [name, source] of Object.entries(sources)) {
    const result = censusSource(source);
    assertEquals(
      result.writes,
      [],
      `${name} writes no evidence and must not be counted as a writer`,
    );
    assertEquals(
      result.mentions.length,
      1,
      `${name} still MENTIONS the id, which is the honest word for it`,
    );
  }

  // THE POSITIVE CONTROLS, same source set: a first argument that really is an
  // evidence path, the module-scope `OUT + literal` shape the census resolves, the
  // evidence helper's contract, and a write inside a template EXPRESSION (which is
  // code, not template text - the masker must not blank it).
  const positives: Record<string, [string, string]> = {
    firstArgument: [
      `await Deno.writeFile("docs/evidence/${dir("real")}/shot.png", png);\n`,
      dir("real"),
    ],
    moduleScopeOut: [
      `const OUT = new URL("../docs/evidence/${dir("ep1")}/", import.meta.url).pathname;\n` +
      `await Deno.writeTextFile(OUT + "01-x.txt", "hi");\n`,
      dir("ep1"),
    ],
    evidenceHelper: [`writeEvidenceReadme({ dir: "${dir("hlp1")}" });\n`, dir("hlp1")],
    templateExpression: [
      'const t = `${await Deno.writeFile("docs/evidence/' + dir("expr") + '/s.png", b)}`;\n',
      dir("expr"),
    ],
  };
  for (const [name, [source, id]] of Object.entries(positives)) {
    assertEquals(
      censusSource(source).writes,
      [id],
      `${name} really writes evidence and must keep its write`,
    );
  }
});

// ---------------------------------------------------------------------------
// audio-feed-vex8: THE MIRROR DIRECTION AGAIN. ehon pinned the false positives
// (payload, comment, string) and the helper's contract only with `dir` FIRST, so
// the predicate's answer depended on an object's PROPERTY ORDER - a thing with no
// runtime meaning. The firstArgument helper counted `(` and `)` alone, which makes
// the comma BETWEEN PROPERTIES look like the argument separator. These are the
// mirrors, and the pair that must AGREE is the one that proves the fix is
// load-bearing: with comma splitting, `dir` first counts and `dir` second does not.
// ---------------------------------------------------------------------------

/** Every one of these has a comma at depth > 0 inside the FIRST argument. */
const DEPTH_MIRRORS: Record<string, [string, string]> = {
  "a nested call in an object value": [
    'writeEvidenceReadme({ title: name.toUpperCase(), dir: "audio-feed-nested" });\n',
    "nested",
  ],
  "a comma inside a STRING in the object": [
    'writeEvidenceReadme({ note: "a, b", dir: "audio-feed-strcomma" });\n',
    "strcomma",
  ],
  "an object in the SECOND argument": [
    'await Deno.writeTextFile("' + ev(dir("secondarg") + "/x.txt") + '", { a: 1, b: 2 });\n',
    "secondarg",
  ],
  "an ARRAY literal as the first argument": [
    'await Deno.writeTextFile(["' + ev(dir("arr") + "/x.txt") + '"][0], "x");\n',
    "arr",
  ],
  "a comma inside a template EXPRESSION": [
    "await Deno.writeTextFile(`" + ev(dir("tplc") + "/x.txt") + "`, `a, ${b}, c`);\n",
    "tplc",
  ],
  "a nested call as the first argument": [
    'await Deno.writeTextFile(path.join("' + ev(dir("nestedcall") + "/x.txt") + '"), "x");\n',
    "nestedcall",
  ],
};

Deno.test("audio-feed-vex8: property ORDER does not change whether an evidence helper writes", () => {
  const dirFirst = censusSource(
    'writeEvidenceReadme({ dir: "audio-feed-abcd", title: "hello" });\n',
  );
  const dirSecond = censusSource(
    'writeEvidenceReadme({ title: "hello", dir: "audio-feed-abcd" });\n',
  );

  assertEquals(dirSecond.writes, ["audio-feed-abcd"], "dir SECOND is the finding: it is a write");
  assertEquals(
    dirFirst.writes,
    ["audio-feed-abcd"],
    "dir FIRST was the only shape the old tests covered",
  );
  // THE ASSERTION THAT MAKES THE FIX LOAD-BEARING: two calls that differ only in an object's property
  // order must produce the SAME answer. Under comma splitting they disagree, so this goes red.
  assertEquals(
    dirSecond.writes,
    dirFirst.writes,
    "the same call with two properties swapped must not be classified differently",
  );
  assertEquals(
    dirSecond.runtimeAssembled,
    [],
    "a helper that names its slice is a write, not unresolved",
  );
  assertEquals(dirSecond.mentions, [], "and it is not a mention");
});

Deno.test("audio-feed-vex8: a comma at depth > 0 is not an argument separator", () => {
  for (const [name, [source, id]] of Object.entries(DEPTH_MIRRORS)) {
    const result = censusSource(source);
    assertEquals(result.writes, [dir(id)], `${name}: the write must survive its own commas`);
    assertEquals(result.mentions, [], `${name}: a write is not a mention`);
  }

  // THE OTHER HALF OF THE FIX, AND THE REASON A DEPTH-AWARE COMMA SCAN ALONE IS NOT
  // ENOUGH: once the WHOLE object is the first argument, its other properties are in
  // scope, and they are PROSE - the helper's own option type is
  // `{ dir: string; title: string; script?: string; ... }`. Measured on the real tree,
  // scanning the whole object brought 26 directories back that the previous version had
  // correctly excluded (audio-feed-0jp and audio-feed-ktn from a proof that writes
  // audio-feed-8fc and lists them in `bead:`/`also:` fields, and 24 more of that shape).
  const prose = censusSource(
    'writeEvidenceReadme({ title: "hello", dir: "audio-feed-abcd", also: "audio-feed-sibling" });\n',
  );
  assertEquals(prose.writes, [dir("abcd")], "only the slice the helper is told to write");
  assertEquals(prose.mentions, [dir("sibling")], "a sibling property is a mention, not a write");

  // The target property also works quoted, and a first-argument object with NO target
  // property falls back to the whole argument rather than to nothing - a MISS is the
  // silent direction, and this bead's whole lineage is about silences.
  assertEquals(
    censusSource('writeEvidenceReadme({ "title": "x", "dir": "audio-feed-quoted" });\n').writes,
    [dir("quoted")],
    "a quoted target property names the slice just as a bare one does",
  );
  assertEquals(
    censusSource(
      'await Deno.writeTextFile({ path: "' + ev(dir("fallback") + "/x") + '" }, "x");\n',
    ).writes,
    [dir("fallback")],
    "an object with no target property falls back to the whole argument",
  );
});

// ---------------------------------------------------------------------------
// audio-feed-vex8 (vac2's axis): THE TARGET IS NOT ARGUMENT 1 FOR EVERY ENTRY.
// Deno.copyFile(fromPath, toPath) writes its SECOND argument, so resolving the
// first dropped that write call ENTIRELY - a false negative on a WRITER, which is
// invisible, where the mention false positives this file fixes are over-reporting
// and visible. No comma-depth fix touches this shape: the first argument is a
// perfectly well-formed single token, correctly parsed.
// ---------------------------------------------------------------------------

/**
 * One sample per WRITE_CALLS entry. The coverage test below fails if an entry has
 * no sample, so a write call cannot be added to the set without its target argument
 * being stated and exercised - the bad state is unrepresentable rather than absent.
 */
const TARGET_SAMPLES: Record<string, { source: string; expected: string }> = {
  "writeEvidenceReadme(": {
    source: 'await writeEvidenceReadme({ dir: "audio-feed-hlp", title: "t" });\n',
    expected: "hlp",
  },
  "writeEvidencePng(": {
    source: 'await writeEvidencePng({ dir: "audio-feed-png", name: "01.png" });\n',
    expected: "png",
  },
  "Deno.writeTextFile(": {
    source: 'await Deno.writeTextFile("' + ev(dir("wtf") + "/x.md") + '", "body");\n',
    expected: "wtf",
  },
  "Deno.writeFile(": {
    source: 'await Deno.writeFile("' + ev(dir("wf") + "/x.png") + '", bytes);\n',
    expected: "wf",
  },
  "Deno.mkdir(": {
    source: 'await Deno.mkdir("' + ev(dir("mkd") + "/") + '", { recursive: true });\n',
    expected: "mkd",
  },
  // THE FINDING: the target is the SECOND argument. The first names the SOURCE, which this
  // call READS - crediting it would be a false positive of the same kind the bead is about.
  "Deno.copyFile(": {
    source: 'await Deno.copyFile("' + dir("src-bean") + '.png", "' + ev(dir("dst") + "/shot.png") +
      '");\n',
    expected: "dst",
  },
  "Deno.writeTextFileSync(": {
    source: 'Deno.writeTextFileSync("' + ev(dir("wts") + "/x.md") + '", "body");\n',
    expected: "wts",
  },
  "Deno.writeFileSync(": {
    source: 'Deno.writeFileSync("' + ev(dir("wfs") + "/x.png") + '", bytes);\n',
    expected: "wfs",
  },
  "Deno.mkdirSync(": {
    source: 'Deno.mkdirSync("' + ev(dir("mks") + "/") + '");\n',
    expected: "mks",
  },
  // `Deno.rename(old, new)` creates its SECOND argument. The source is where the bytes CAME FROM, so
  // crediting it would credit the temp path instead of the slice.
  "Deno.rename(": {
    source: 'await Deno.rename("/tmp/scratch.png", "' + ev(dir("ren") + "/shot.png") + '");\n',
    expected: "ren",
  },
  "Deno.copyFileSync(": {
    source: 'Deno.copyFileSync("' + dir("src-sync") + '.png", "' + ev(dir("ds2") + "/s.png") +
      '");\n',
    expected: "ds2",
  },
};

Deno.test("audio-feed-vex8: EVERY write call resolves its REAL target argument, per Deno's signature", () => {
  // Coverage first: a new entry in WRITE_CALLS with no sample here fails this, by construction.
  for (const { pattern } of WRITE_CALLS) {
    const covered = Object.keys(TARGET_SAMPLES).some((name) => pattern.test(name));
    pattern.lastIndex = 0;
    assert(covered, `WRITE_CALLS entry ${pattern} has no sample: state its target argument`);
  }
  for (const [name, { source, expected }] of Object.entries(TARGET_SAMPLES)) {
    const result = censusSource(source);
    assertEquals(result.writes, [dir(expected)], `${name} must resolve its real target argument`);
  }
  // ...and the same table must cover the whole set, not a subset of it.
  assertEquals(
    Object.keys(TARGET_SAMPLES).length,
    WRITE_CALLS.length,
    "every WRITE_CALLS entry needs exactly one sample",
  );
});

Deno.test("audio-feed-vex8: copyFile counts the DESTINATION and not the source it reads", () => {
  const source = 'await Deno.copyFile("' + dir("src-bean") + '.png", "' +
    ev(dir("dst") + "/shot.png") +
    '");\n';
  const result = censusSource(source);
  assertEquals(result.writes, [dir("dst")], "the destination is the write target");
  assert(
    !result.writes.includes(dir("src-bean")),
    "the source is read, not written: crediting it would be the false positive shape",
  );
  // A copy whose DESTINATION is outside docs/evidence is not an evidence writer at all.
  assertEquals(
    censusSource('await Deno.copyFile("' + dir("src-bean") + '.png", "/tmp/out.png");\n').writes,
    [],
    "copying an evidence file OUT to /tmp writes no evidence",
  );
});

Deno.test("audio-feed-vex8: rename credits its DESTINATION, and a rename OUT of evidence writes no evidence", () => {
  // The site rev-46 found: ten of eleven rename callers move INTO evidence, and the census credited none
  // of those sites. The destination is the write; the source is where the bytes came from.
  const intoEvidence = censusSource(
    'await Deno.rename("/tmp/scratch.png", "' + ev(dir("ren2") + "/out.png") + '");\n',
  );
  assertEquals(intoEvidence.writes, [dir("ren2")], "rename creates its SECOND argument");
  assert(
    !intoEvidence.writes.includes("tmp/scratch.png") &&
      !intoEvidence.writes.some((w) => w.includes("scratch")),
    "the temp source is not a write target: crediting it credits the wrong path",
  );
  // ...and the mirror: a rename OUT of evidence is a write to the destination, not to the slice it left.
  assertEquals(
    censusSource(
      'await Deno.rename("' + ev(dir("ren3") + "/out.png") + '", "/tmp/archive.png");\n',
    ).writes,
    [],
    "moving an evidence file out to /tmp writes no evidence",
  );
});
