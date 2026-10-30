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
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { maskNonCode } from "../scripts/source-mask.ts";
import {
  census,
  censusSource,
  EVIDENCE_PREFIX,
  splitCreditedWrites,
  WRITE_CALLS,
} from "../scripts/evidence-census.ts";
import { collect } from "../scripts/evidence-run.ts";

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
    // audio-feed-lnnjd audit: this Deno.env.set is FIXTURE TEXT parsed by
    // censusSource, never executed — it mutates nothing.
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

/**
 * audio-feed-t5lb: A TARGET THE RESOLVER CANNOT FIND IS NOT A TARGET ELSEWHERE, and collapsing the two
 * made a real writer read as a non-writer: `scripts/evidence-compress.ts` renames over its evidence PNG
 * through a function parameter, and the census described it as writing no evidence directory.
 *
 * TWO ROWS, BECAUSE ONLY THE PAIR IS EVIDENCE: an unattributable destination must be REPORTED, and a
 * literal destination that is simply not under docs/evidence must stay SILENT - a change that reddened
 * both would be a change that reports everything.
 */
Deno.test("audio-feed-t5lb: a destination arriving through a parameter is reported as unattributable", () => {
  const source = [
    "// mentions audio-feed-syhu in prose so this script is ABOUT evidence",
    "async function compressOne(path: string) {",
    "  const tmp = `${path}.png8.tmp`;",
    "  await Deno.rename(tmp, path);",
    "}",
  ].join("\n");
  const result = censusSource(source);
  assertEquals(result.writes, [], "no write can be credited - the destination is unresolvable");
  assertEquals(
    result.unresolvedWrites,
    ["Deno.rename"],
    "and the call is REPORTED rather than dropped in silence",
  );
  assert(result.mentions.length > 0, "the file is about evidence, which is what puts it in scope");
});

Deno.test("audio-feed-t5lb: a LITERAL destination that is not evidence stays silent", () => {
  const source = [
    "// mentions audio-feed-syhu in prose",
    'await Deno.writeTextFile("/tmp/not-evidence.txt", "x");',
  ].join("\n");
  const result = censusSource(source);
  assertEquals(result.writes, [], "not an evidence write");
  assertEquals(
    result.unresolvedWrites,
    [],
    "a literal path we CAN see is not unattributable - reporting it would make the row meaningless",
  );
});

/**
 * audio-feed-t9w1: A PREDICATE VALIDATED ONLY ON POSITIVE EXAMPLES IS NOT VALIDATED.
 *
 * The census's cases all built REAL directories, so "an id named in source is an evidence directory" was
 * only ever evaluated on its true branch. Measured on the real tree at `cd525ef`: 36 ids credited and 0
 * without a directory - so the original red does NOT reproduce, and this case is built deliberately
 * rather than reproduced. IT IS A DETECTOR FOR A REINTRODUCTION, which is what the bead is now about.
 */
Deno.test("audio-feed-t9w1: an id named in source with NO directory is NOT credited - and is reported", () => {
  const named = { [dir("ghost-id")]: ["scripts/verify-thing.ts"] };
  const { credited, writesWithoutDirectory } = splitCreditedWrites(named, new Set());
  assertEquals(
    credited,
    {},
    "an id with no directory must NOT be credited - this is the whole bead",
  );
  assertEquals(
    writesWithoutDirectory,
    named,
    "and it is REPORTED rather than dropped in silence, so a proof that has not run yet stays visible",
  );
});

Deno.test("audio-feed-t9w1 MIRROR: an id WITH a directory is still credited, and not also reported", () => {
  const named = { [dir("real-id")]: ["scripts/proof.ts"] };
  const { credited, writesWithoutDirectory } = splitCreditedWrites(
    named,
    new Set([dir("real-id")]),
  );
  assertEquals(credited, named, "the fix must not pass by crediting nothing");
  assertEquals(writesWithoutDirectory, {}, "a backed write is not also reported as unbacked");
});

Deno.test("audio-feed-t9w1: mixed input splits exactly once, with no id in both buckets", () => {
  const backed = dir("has-dir");
  const unbacked = dir("no-dir");
  const named = { [backed]: ["scripts/a.ts"], [unbacked]: ["scripts/b.ts"] };
  const { credited, writesWithoutDirectory } = splitCreditedWrites(named, new Set([backed]));
  assertEquals(Object.keys(credited), [backed]);
  assertEquals(Object.keys(writesWithoutDirectory), [unbacked]);
});

Deno.test("audio-feed-n16x: four target browser proofs execute inside runProof and invoke evidence helpers", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const specimens = [
    "scripts/playback-position-browser-proof.ts",
    "scripts/spend-visibility-browser-proof.ts",
    "scripts/landing-tooltip-browser-proof.ts",
    "scripts/request-access-browser-proof.ts",
  ];
  for (const script of specimens) {
    const content = await Deno.readTextFile(`${root}/${script}`);
    assert(content.includes("runProof("), `${script} must execute inside runProof`);
    assert(
      content.includes("quantiseEvidencePng("),
      `${script} must process screenshots with quantiseEvidencePng`,
    );
    // audio-feed-s9z5: landing-tooltip shares 3xq with admin-module; sole tenants write README
    if (script !== "scripts/landing-tooltip-browser-proof.ts") {
      assert(
        content.includes("writeEvidenceReadme("),
        `${script} must write evidence README with writeEvidenceReadme`,
      );
    } else {
      assert(
        !content.includes("writeEvidenceReadme("),
        `${script} must not overwrite shared 3xq/README.md owned by admin-module (s9z5)`,
      );
    }

    assert(
      !content.includes("Deno.writeTextFile(`${OUT}README.md`"),
      `${script} must not write raw README.md directly`,
    );
    assert(
      content.includes("crashError"),
      `${script} must track unhandled exceptions to prevent misleading README generation`,
    );
    assert(
      content.includes(
        'checker.check("proof execution completed without unhandled exception", false,',
      ),
      `${script} must record crash failure on checker to suppress evidence publication`,
    );

    // audio-feed-0gbo: write targets must be resolvable at call sites (no blind spots)
    const result = censusSource(content);
    assertEquals(
      result.unresolvedWrites,
      [],
      `${script} must resolve all evidence write targets: ${result.unresolvedWrites.join(", ")}`,
    );
  }
});

// audio-feed-9yaq: explicitly pinned exemption set for browser proofs with unmediated evidence writes
// scripts/regenerate-browser-proof.ts is blocked by audio-feed-ebyy (P2 IN_REVIEW, passkey rotation auth migration)
const EXEMPT_UNMEDIATED_PROOFS = new Set([
  "scripts/regenerate-browser-proof.ts", // audio-feed-ebyy / fleet/ufg9
]);

// audio-feed-cp9j / audio-feed-7ulw: strictly pinned set of multi-tenant evidence contributors.
// These proofs contribute screenshots into a shared evidence directory (audio-feed-3xq) owned
// and declared by admin-module-browser-proof.ts. They must execute in runProof and process
// screenshots with quantiseEvidencePng, but must NOT call writeEvidenceReadme to avoid clobbering.
const MULTI_TENANT_CONTRIBUTOR_PROOFS = new Set([
  "scripts/landing-tooltip-browser-proof.ts", // audio-feed-3xq part 4c (audio-feed-s9z5)
  "scripts/home-module-browser-proof.ts", // audio-feed-3xq part 4b (audio-feed-7ulw)
]);

function checkProofCompliance(content: string, relative: string): string | null {
  const result = censusSource(content);
  // audio-feed-0gbo: unknown writes must not pass in silence
  const writesEvidence = result.writes.length > 0 || result.unresolvedWrites.length > 0;
  if (!writesEvidence) return null;

  // audio-feed-2hgp: mask comments and strings so mentions do not pass as helper calls
  const masked = maskNonCode(content);
  const hasRunProof = masked.includes("runProof(");
  const hasQuantise = masked.includes("quantiseEvidencePng(");
  const hasReadme = masked.includes("writeEvidenceReadme(");

  const isMultiTenant = MULTI_TENANT_CONTRIBUTOR_PROOFS.has(relative);
  if (isMultiTenant) {
    if (!hasRunProof || !hasQuantise) {
      return `${relative} (multi-tenant contributor must use runProof and quantiseEvidencePng: runProof=${hasRunProof}, quantise=${hasQuantise})`;
    }
    if (hasReadme) {
      return `${relative} (multi-tenant contributor must NOT call writeEvidenceReadme to protect shared README)`;
    }
  } else {
    // audio-feed-cp9j: sole-tenant proofs writing evidence MUST use runProof and writeEvidenceReadme;
    // quantiseEvidencePng alone without writeEvidenceReadme is not permitted for sole tenants.
    if (!hasRunProof || !hasReadme) {
      return `${relative} (sole tenant writing evidence must use runProof and writeEvidenceReadme: writes: ${
        result.writes.join(", ")
      }, unresolved: ${
        result.unresolvedWrites.join(", ")
      }, runProof: ${hasRunProof}, readme: ${hasReadme})`;
    }
  }
  return null;
}

export interface ProofScanEntry {
  name: string;
  isFile: boolean;
}

export interface ProofAuditReport {
  scanned: string[];
  unmediated: string[];
  exemptionsMatched: Set<string>;
}

export async function auditBrowserProofs(
  entries: AsyncIterable<ProofScanEntry> | Iterable<ProofScanEntry>,
  readFile: (relPath: string) => Promise<string>,
): Promise<ProofAuditReport> {
  const unmediated: string[] = [];
  const scanned: string[] = [];
  const exemptionsMatched = new Set<string>();

  for await (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith("-browser-proof.ts")) continue;
    const relative = `scripts/${entry.name}`;
    if (EXEMPT_UNMEDIATED_PROOFS.has(relative)) {
      exemptionsMatched.add(relative);
      continue;
    }

    scanned.push(relative);
    const content = await readFile(relative);
    const failure = checkProofCompliance(content, relative);
    if (failure) unmediated.push(failure);
  }

  // audio-feed-blm4: sweep must verify it actually scanned the corpus and matched exemptions
  assertEquals(
    exemptionsMatched,
    EXEMPT_UNMEDIATED_PROOFS,
    "Every pinned exemption must match an active browser proof in scripts/",
  );
  assert(
    scanned.length >= 20,
    `Sweep must examine all active non-exempt browser proofs (scanned ${scanned.length}, expected >= 20)`,
  );

  return { scanned, unmediated, exemptionsMatched };
}

Deno.test("audio-feed-0gbo / audio-feed-9yaq / audio-feed-blm4: browser proof scripts writing evidence use runProof and shared helpers (except pinned exemptions)", async () => {
  assertEquals(EXEMPT_UNMEDIATED_PROOFS.size, 1, "Exemption list is strictly pinned");
  const root = new URL("..", import.meta.url).pathname;

  const { unmediated } = await auditBrowserProofs(
    Deno.readDir(`${root}/scripts`),
    (rel) => Deno.readTextFile(`${root}/${rel}`),
  );

  assertEquals(
    unmediated,
    [],
    `All non-exempt browser proofs writing evidence must use runProof and writeEvidenceReadme: ${
      JSON.stringify(unmediated, null, 2)
    }`,
  );
});

Deno.test("audio-feed-8yki: NEGATIVE CONTROL - insufficient sweep scan fails audit via real auditBrowserProofs", async () => {
  // Feed synthetic entries with the pinned exemption satisfied but insufficient (< 20) scanned proofs:
  const syntheticEntries = [
    { name: "regenerate-browser-proof.ts", isFile: true },
    { name: "dummy-browser-proof.ts", isFile: true },
  ];
  await assertRejects(
    async () => {
      await auditBrowserProofs(
        syntheticEntries,
        () => Promise.resolve(""),
      );
    },
    Error,
    "Sweep must examine all active non-exempt browser proofs (scanned 1, expected >= 20)",
  );
});

Deno.test("audio-feed-0gbo / audio-feed-2hgp: NEGATIVE CONTROL - unresolved evidence write is detected and failure text names call", () => {
  // audio-feed-21od: THE FIXTURE HAD TO CHANGE, THE ASSERTION DID NOT. This row used a target derived
  // from an evidence binding (`const target = `${OUT}01-shot.png``), which the census CAN resolve - it
  // already substitutes a binding named in a write target, and it resolved exactly that shape for three
  // real scripts once the binding-to-binding hop was added. So the old fixture was passing by testing an
  // unattributability that was a gap rather than a fact, and the control now uses a target that is
  // genuinely assembled at runtime: nothing in the source names a slice, so nothing can attribute it.
  const syntheticProof = [
    'const OUT = "docs/evidence/audio-feed-test/";',
    "const target = Deno.args[0];",
    "await Deno.writeFile(target, new Uint8Array());",
  ].join("\n");

  const result = censusSource(syntheticProof);
  assertEquals(
    result.unresolvedWrites,
    ["Deno.writeFile"],
    "A runtime-assembled write target must be classified as an unresolved write",
  );
  assertEquals(result.writes, [], "nothing about this source is attributable as evidence");

  const failure = checkProofCompliance(syntheticProof, "scripts/synthetic-browser-proof.ts");
  assert(
    failure !== null,
    "Unresolved evidence write in proof without runProof must be caught, not skipped as false green",
  );
  assertStringIncludes(
    failure,
    "Deno.writeFile",
    "Failure message must specifically name the unresolved write call",
  );
});

Deno.test("audio-feed-21od: a bead-id comment cannot change what a script's writes resolve to", () => {
  // THE REGRESSION ROW FOR THIS BEAD, and it is the six-line case rather than a paraphrase of it. The
  // real proof declared its screenshot paths as consts derived from an evidence binding, wrote through
  // those consts, and gained a comment naming `audio-feed-<id>` - and the comment ALONE flipped the file
  // from "no unresolved writes" to five, because the mention opened the reporting gate in front of a
  // bucket the resolver had failed to fill. Both halves are pinned here: the write RESOLVES, and a
  // mention-bearing comment cannot change that. The mention itself is still expected to be reported,
  // because that is the bucket it belongs in.
  const base = [
    'const OUT = new URL("../docs/evidence/audio-feed-21od/", import.meta.url).pathname;',
    "await Deno.mkdir(OUT, { recursive: true });",
    "const shotPath = `${OUT}01-shot.png`;",
    "await Deno.writeFile(shotPath, new Uint8Array());",
  ].join("\n");
  const withComment = base.replace(
    "const shotPath",
    "// audio-feed-uiye: a comment that merely NAMES a bead, above the write it is near\nconst shotPath",
  );

  const before = censusSource(base);
  const after = censusSource(withComment);
  assertEquals(
    before.unresolvedWrites,
    [],
    "a const derived from an evidence binding is resolvable",
  );
  assertEquals(
    before.writes,
    ["audio-feed-21od"],
    "the derived target attributes the write to the slice",
  );
  assertEquals(
    after.unresolvedWrites,
    before.unresolvedWrites,
    "a comment carrying a bead id must not change write resolution",
  );
  assertEquals(after.writes, before.writes, "and must not change the credited writes either");
  assert(
    after.mentions.includes("audio-feed-uiye"),
    "the comment's token is still reported as a MENTION, which is where it belongs",
  );
});

Deno.test("audio-feed-2hgp: NEGATIVE CONTROL - mentioning helpers in a comment only fails audit", () => {
  const commentOnlyProof = [
    'const OUT = new URL("../docs/evidence/audio-feed-zzzz/", import.meta.url).pathname;',
    "// should use runProof( and writeEvidenceReadme( - see proof-helper.ts",
    "await Deno.writeFile(`${OUT}01-x.png`, new Uint8Array());",
  ].join("\n");

  const failure = checkProofCompliance(commentOnlyProof, "scripts/comment-only-browser-proof.ts");
  assert(
    failure !== null,
    "Proof only mentioning helpers in a comment must be flagged, not granted false green",
  );
  assertStringIncludes(failure, "runProof: false");
  assertStringIncludes(failure, "readme: false");
});

Deno.test("audio-feed-9yaq: NEGATIVE CONTROL - regenerate-browser-proof.ts fails compliance audit when evaluated without exemption", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const content = await Deno.readTextFile(`${root}/scripts/regenerate-browser-proof.ts`);
  const failure = checkProofCompliance(content, "scripts/regenerate-browser-proof.ts");
  assert(
    failure !== null,
    "regenerate-browser-proof.ts must fail compliance audit when evaluated without exemption",
  );
  assertStringIncludes(failure, "scripts/regenerate-browser-proof.ts");
  assertStringIncludes(failure, "runProof: false");
  assertStringIncludes(failure, "readme: false");
});

Deno.test("audio-feed-cp9j: multi-tenant contributor set is strictly pinned", () => {
  assertEquals(
    MULTI_TENANT_CONTRIBUTOR_PROOFS.size,
    2,
    "Multi-tenant contributor set is strictly pinned",
  );
});

Deno.test("audio-feed-cp9j: NEGATIVE CONTROL - sole tenant proof with quantiseEvidencePng but no README fails audit", () => {
  const syntheticProof = [
    'const OUT = "docs/evidence/audio-feed-sole/";',
    'await runProof("sole-browser-proof", async () => {',
    "  await Deno.writeFile(`${OUT}01-shot.png`, new Uint8Array());",
    "  await quantiseEvidencePng(`${OUT}01-shot.png`);",
    "});",
  ].join("\n");

  const failure = checkProofCompliance(syntheticProof, "scripts/synthetic-sole-browser-proof.ts");
  assert(
    failure !== null,
    "Sole tenant proof with quantiseEvidencePng but no writeEvidenceReadme must be rejected",
  );
  assertStringIncludes(
    failure,
    "sole tenant writing evidence must use runProof and writeEvidenceReadme",
  );
});

// ---------------------------------------------------------------------------
// UNREGISTERED-PROOF CENSUS (tracked as the "unregistered-proof census" bead; bd writes were
// failing when this landed): CLOSE THE CLASS, NOT AN INSTANCE. The audio-feed-zwqrx registration
// row reads ONE README and asserts strings the same commit wrote, so it can never see the class
// it was meant to catch: a FUTURE proof script with no declaring README passes unnoticed. This
// row walks the FILESYSTEM instead - every scripts/*-proof.ts, scripts/verify_*.ts and
// scripts/repro_*.ts must be either (a) declared by some docs/evidence/<id>/README.md `- Script:`
// line (the relation `deno task evidence` RUNS), or (b) pinned below as
// intentionally-unregistered WITH A REASON. Both directions are exact-set: a NEW unregistered
// script reds, and a pinned entry whose facts have moved (script deleted, or since declared) reds
// too. scripts/repro_*.ts was the known debt this row used to record as uncovered; it is covered
// now, so all three prefixes meet the same rule and the same remedy.
// ---------------------------------------------------------------------------

/**
 * The intentionally-unregistered proof scripts (scripts/*-proof.ts, scripts/verify_*.ts,
 * scripts/repro_*.ts), pinned by EXACT SET. An entry is a claim about
 * the tree RIGHT NOW, so the row re-derives each entry's facts: an entry whose script no longer
 * exists on disk, or which has meanwhile been declared by an evidence README, is a lie and must
 * be removed rather than trusted. Growing this set is a decision, not an edit.
 */
const INTENTIONALLY_UNREGISTERED: Record<string, string> = {
  "scripts/home-module-browser-proof.ts":
    "multi-tenant contributor (audio-feed-7ulw): writes into the SHARED audio-feed-3xq slice owned and declared by scripts/admin-module-browser-proof.ts - a declaring README of its own would clobber the shared one (see MULTI_TENANT_CONTRIBUTOR_PROOFS above)",
  "scripts/landing-tooltip-browser-proof.ts":
    "multi-tenant contributor (audio-feed-s9z5): audio-feed-3xq part 4c, owned and declared by scripts/admin-module-browser-proof.ts (see MULTI_TENANT_CONTRIBUTOR_PROOFS above)",
  "scripts/l7m1-determinism-proof.ts":
    "disposable determinism probe run by hand; the durable l7m1 assertions live in tests/l7m1_proof_test.ts and the slice's registered proof is scripts/verify_main_l7m1_e2e.ts",
  "scripts/regenerate-browser-proof.ts":
    "blocked by audio-feed-ebyy (P2 IN_REVIEW, passkey rotation auth migration); pinned for the same reason in EXEMPT_UNMEDIATED_PROOFS above",
  "scripts/uploads-six-type-browser-proof.ts":
    "browser acceptance proof for audio-feed-d82rv, NOT YET REGISTERED with an evidence slice; registration is a decision (run it so its own writeEvidenceReadme declares the slice), not a pinned fact",
  "scripts/verify_c0gj_scanner_divergence.ts":
    "one-off committed-artefact harness comparing scanner behaviour ACROSS pinned branches for audio-feed-diqd (investigating audio-feed-c0gj); not an ongoing proof of the current tree",
  "scripts/verify_i7vi_events.ts":
    "HISTORICAL per its own header (audio-feed-byh4j): no suite executes or reads this script, so it is NOT evidence of current behaviour; wire it into a suite or re-derive it before citing it",
  "scripts/verify_s3uk_real_browser.ts":
    "one-off real-browser INP investigation (audio-feed-s3uk); commits nothing to docs/evidence and is pinned as a mention-only probe by the census tests in this file",
  "scripts/verify_wzv9_capability_leak.ts":
    "HISTORICAL per its own header (audio-feed-byh4j): no suite executes or reads this script, so it is NOT evidence of current behaviour; re-derive before citing it",
};

Deno.test(
  "unregistered-proof census: every scripts/*-proof.ts, scripts/verify_*.ts and scripts/repro_*.ts is declared by an evidence README or pinned as intentionally-unregistered",
  async () => {
    const root = new URL("..", import.meta.url).pathname;

    // DISCOVERED, from the filesystem - not from any list a commit could assert about itself.
    const discovered: string[] = [];
    for await (const entry of Deno.readDir(`${root}/scripts`)) {
      if (!entry.isFile) continue;
      if (
        entry.name.endsWith("-proof.ts") || entry.name.startsWith("verify_") ||
        entry.name.startsWith("repro_")
      ) {
        discovered.push(`scripts/${entry.name}`);
      }
    }
    discovered.sort();

    // DECLARED, by the SAME walker the evidence tier runs (collect() parses every
    // docs/evidence/<id>/README.md `- Script:` line), so this row and `deno task evidence`
    // cannot disagree about what a declaration is. Filesystem only: no Chrome, no network.
    const { declarations } = await collect({
      list: true,
      timeoutMs: 300_000,
      root,
      explicitTimeout: false,
    });
    const declared = new Set(declarations.map((d) => d.declared));

    const unregistered = discovered.filter((s) =>
      !declared.has(s) && !Object.hasOwn(INTENTIONALLY_UNREGISTERED, s)
    );
    assertEquals(
      unregistered,
      [],
      `proof script(s) that NOTHING RUNS: ${unregistered.join(", ")}. This row covers EVERY ` +
        `scripts/*-proof.ts, scripts/verify_*.ts AND scripts/repro_*.ts, so for each one: ` +
        `add docs/evidence/<id>/README.md with a \`- Script:\` line declaring it, ` +
        `or list it as intentionally-unregistered with a reason in INTENTIONALLY_UNREGISTERED ` +
        `(tests/evidence_census_test.ts). A proof script no evidence README declares and no ` +
        `exemption names is a proof nothing is scheduled to run.`,
    );

    // THE EXEMPTION SET MUST NOT OUTLIVE ITS FACTS: an entry whose script is gone, or which has
    // meanwhile been declared, is a claim about a tree that no longer exists and reds here.
    for (const [script, reason] of Object.entries(INTENTIONALLY_UNREGISTERED)) {
      assert(
        reason.trim().length > 0,
        `intentionally-unregistered entry ${script} must carry a reason`,
      );
      assert(
        discovered.includes(script),
        `stale exemption: ${script} matches no scripts/*-proof.ts, scripts/verify_*.ts or scripts/repro_*.ts on disk - remove the entry`,
      );
      assert(
        !declared.has(script),
        `stale exemption: ${script} is now declared by an evidence README - remove the entry from INTENTIONALLY_UNREGISTERED`,
      );
    }
    assertEquals(
      Object.keys(INTENTIONALLY_UNREGISTERED).length,
      9,
      "the intentionally-unregistered set is pinned; growing it is a decision, not an edit",
    );

    // POSITIVE CONTROLS: the walk found a real corpus on both sides, or every exclusion above
    // would be satisfied by walking nothing - the same guard the other census rows carry.
    assert(
      discovered.length >= 40,
      `expected to discover the proof-script corpus, got ${discovered.length}`,
    );
    assert(
      declared.size >= 30,
      `expected the evidence READMEs to declare a real corpus, got ${declared.size}`,
    );
  },
);

Deno.test("audio-feed-7ulw: NEGATIVE CONTROL - multi-tenant proof calling writeEvidenceReadme fails audit", () => {
  const syntheticProof = [
    'const OUT = "docs/evidence/audio-feed-3xq/";',
    'await runProof("home-browser-proof", async () => {',
    "  await Deno.writeFile(`${OUT}part4b-home-1280x900.png`, new Uint8Array());",
    "  await quantiseEvidencePng(`${OUT}part4b-home-1280x900.png`);",
    "  await writeEvidenceReadme({ dir: OUT });",
    "});",
  ].join("\n");

  const failure = checkProofCompliance(syntheticProof, "scripts/home-module-browser-proof.ts");
  assert(
    failure !== null,
    "Multi-tenant contributor calling writeEvidenceReadme must be rejected to protect shared README",
  );
  assertStringIncludes(
    failure,
    "multi-tenant contributor must NOT call writeEvidenceReadme",
  );
});

Deno.test("audio-feed-zwqrx: playback-csp-browser-proof executes inside runProof and is registered in evidence declarations", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const script = "scripts/playback-csp-browser-proof.ts";
  const content = await Deno.readTextFile(`${root}/${script}`);
  assert(content.includes('runProof("playback-proof"'), `${script} must execute inside runProof`);

  const readme = await Deno.readTextFile(`${root}/docs/evidence/audio-feed-zwqrx/README.md`);
  assert(
    readme.includes("- Script: scripts/playback-csp-browser-proof.ts"),
    "audio-feed-zwqrx README must register scripts/playback-csp-browser-proof.ts",
  );
  assert(
    readme.includes("- Asserts:"),
    "audio-feed-zwqrx README must declare assertions",
  );
});
