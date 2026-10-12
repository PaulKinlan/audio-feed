/**
 * audio-feed-lm4d: the read-relation HINTS must be accurate, because ONE unresolved hint disables the inert
 * class for every change (scripts/fast-check.ts, planTests) - measured before this fix: a documentation-only
 * line in docs/ingest.md ran all 112 suites (125s) because eleven hints named paths that are not in the tree.
 *
 * THIS FILE DOES NOT WEAKEN THE GUARD, and the assertions are deliberately paired in both directions:
 *   - an inert change IS classified inert once the hints are accurate, and
 *   - a change touching something a suite is DERIVED to read STILL selects that suite, and
 *   - a genuinely missing hint is still reported and still blocks.
 * The overshoot half matters as much as the fix: a detector repaired by widening nothing would delete the
 * protection instead of repairing the hints, which is why "a real change still selects its readers" is here.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { couldBeTheChangedFile, couldHideInertRead, planTests } from "../scripts/fast-check.ts";
import { deriveReadRelationReport, ROOT, unclassifiedTail } from "../scripts/test-selection.ts";

const NO_MAP = new Map<string, string[]>();

/** A fixture tree laid out the way the detector expects: root ends in "/" and suites live under tests/. */
async function withTempTree(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = (await Deno.makeTempDir({ prefix: "lm4d-relation-" })) + "/";
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = `${root}${relPath}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, content);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("audio-feed-lm4d: a read call inside a string is DATA, a read inside an interpolation is CODE", async () => {
  // The detector scans text, so this suite's own fixtures look like read sites. They are not: string content
  // is data. Five of the eleven stale hints came from exactly this, because tests/fast_gate_subset_test.ts
  // carries synthetic module sources as fixtures and those fixtures read files.
  await withTempTree({
    "docs/present.md": "hello\n",
    "tests/mixed_test.ts": [
      "export async function readIt() {",
      '  const present = await Deno.readTextFile("../docs/present.md");',
      '  const fixture = "  return await Deno.readTextFile(`../docs/absent.html`);\\n";',
      "  const alsoFixture = `Deno.readTextFile('../docs/gone.md')`;",
      '  const live = `${await Deno.readTextFile("../docs/present.md")}`;',
      "  return { present, fixture, alsoFixture, live };",
      "}",
      "",
    ].join("\n"),
  }, async (root) => {
    const report = await deriveReadRelationReport(root, ["tests/mixed_test.ts"]);
    assertEquals(
      report.relations.get("docs/present.md"),
      ["tests/mixed_test.ts"],
      "the literal read AND the read inside the interpolation are real reads",
    );
    assertEquals(report.unresolved, [], "string content is not a read site");
    assertEquals(report.unattributed, [], "nor is it a fragment");
    assertEquals(report.outOfRepo, [], "nor is it out-of-repo");
    assert(
      !JSON.stringify(report).includes("absent.html") &&
        !JSON.stringify(report).includes("gone.md"),
      `reads inside strings must appear in NO bucket: ${JSON.stringify(report)}`,
    );
  });
});

Deno.test("audio-feed-lm4d: a base bound OUTSIDE the repo is reported, not offered as a repo path", async () => {
  await withTempTree({
    // `${dir}/state.json` with a temp dir was offered as the repo path `state.json`; the real read is of an
    // OS temp file that no change can touch.
    "tests/tempdir_test.ts": [
      "const dir = await Deno.makeTempDir();",
      "export async function readIt() {",
      "  return await Deno.readTextFile(`${dir}/state.json`);",
      "}",
      "",
    ].join("\n"),
    // `${home}/.cache/puppeteer/chrome` with home from the environment was offered as `.cache/...`.
    "tests/homedir_test.ts": [
      'const home = Deno.env.get("HOME") ?? "";',
      "const cache = `${home}/.cache/puppeteer/chrome`;",
      "export async function listIt() {",
      "  return await Deno.readDir(cache);",
      "}",
      "",
    ].join("\n"),
    // And the same shape with a base the detector cannot attribute: a SUFFIX that names nothing is a
    // fragment, reported rather than silent, and not counted as a read it could not resolve.
    "tests/fragment_test.ts": [
      "export async function readIt(prefix: string) {",
      "  return await Deno.readTextFile(`${prefix}/state.json`);",
      "}",
      "",
    ].join("\n"),
    // THE GUARD: an authored path that names nothing is still reported as unresolved, and still blocks.
    "tests/absent_test.ts": [
      "export async function readIt() {",
      '  return await Deno.readTextFile("../docs/absent.html");',
      "}",
      "",
    ].join("\n"),
  }, async (root) => {
    const temp = await deriveReadRelationReport(root, ["tests/tempdir_test.ts"]);
    assertEquals(temp.unresolved, []);
    assertEquals(temp.relations.size, 0);
    assert(
      temp.outOfRepo.includes("state.json"),
      `the temp-dir hint is REPORTED as out-of-repo: ${JSON.stringify(temp.outOfRepo)}`,
    );

    const home = await deriveReadRelationReport(root, ["tests/homedir_test.ts"]);
    assertEquals(home.unresolved, []);
    assert(
      home.outOfRepo.includes(".cache/puppeteer/chrome"),
      `the $HOME hint is REPORTED as out-of-repo: ${JSON.stringify(home.outOfRepo)}`,
    );

    const fragment = await deriveReadRelationReport(root, ["tests/fragment_test.ts"]);
    assertEquals(fragment.unresolved, [], "a suffix is not an authored path");
    assertEquals(
      fragment.unattributed,
      ["state.json"],
      "a missing fragment is reported, not dropped",
    );

    const absent = await deriveReadRelationReport(root, ["tests/absent_test.ts"]);
    assertEquals(
      absent.unresolved,
      ["docs/absent.html"],
      "an authored path that names nothing is STILL unresolved (the guard is untouched)",
    );
  });
});

Deno.test("audio-feed-lm4d: only a fragment that could hide an INERT-ELIGIBLE read blocks", () => {
  // The inert class is markdown (isDocumentation). A fragment with another extension cannot hide an
  // inert-eligible read: a change to a .json/.kv/.html file is unclassified and runs the full suite anyway,
  // so blocking on it buys nothing and costs every docs-only change the whole gate.
  assertEquals(couldHideInertRead("state.json"), false);
  assertEquals(couldHideInertRead("obs.kv"), false);
  assertEquals(couldHideInertRead("docs/absent.html"), false);
  // A markdown fragment could hide a suite that reads a .md file, and an extension-less fragment could be a
  // directory full of them: both keep the safe direction.
  assertEquals(couldHideInertRead("notes.md"), true);
  assertEquals(couldHideInertRead("docs/"), true);
});

Deno.test("audio-feed-7l9m: a markdown FRAGMENT blocks only when the change could be the file it names", () => {
  // The pairing that keeps the correction honest from BOTH sides. Suppression needs positive evidence (a
  // shadowed binding decides), and so does widening: a fragment may only disable the inert class when the file
  // being changed could actually be the thing that read consumes.
  assertEquals(
    couldBeTheChangedFile("digest.md", ["docs/ingest.md"]),
    false,
    "a temp-dir read's suffix cannot be the markdown file being changed",
  );
  assertEquals(couldBeTheChangedFile("digest.md", ["docs/digest.md"]), true);
  assertEquals(couldBeTheChangedFile("digest.md", ["digest.md"]), true);
  assertEquals(couldBeTheChangedFile("notes.md", ["docs/notes.md"]), true);
  assertEquals(
    couldBeTheChangedFile("docs/", ["docs/anything.md"]),
    true,
    "a directory-shaped fragment still blocks: any file under it could be the change",
  );
});

Deno.test("audio-feed-lm4d: on the REAL tree an inert change is inert, and a real change still selects its readers", async () => {
  const report = await deriveReadRelationReport(ROOT);
  // The invariant this bead restores: on an unchanged tree the relation is COMPLETE, so the inert class is
  // reachable. A red here means a hint is inaccurate again - fix the hint, do not widen the change.
  assertEquals(
    report.unresolved,
    [],
    "an unresolved hint disables the inert class for EVERY change; see the report's other buckets",
  );

  // PRODUCTION'S EXACT RULE (scripts/fast-check.ts): an authored miss always blocks, and a fragment blocks
  // only when it could hide an inert-eligible read AND could be the file being changed (audio-feed-7l9m).
  const blockFor = (changed: string[]) => [
    ...report.unresolved,
    ...report.unattributed.filter((hint) =>
      couldHideInertRead(hint) && couldBeTheChangedFile(hint, changed)
    ),
  ];

  // An inert change selects NOTHING, and says so (audio-feed-es8y condition 2: an empty selection must never
  // read like a pass - the reason has to carry the fact).
  const inert = planTests(
    ["docs/ingest.md"],
    NO_MAP,
    NO_MAP,
    report.relations,
    [],
    blockFor(["docs/ingest.md"]),
  );
  assertEquals(inert.testFiles, [], `a docs-only change must be inert now: ${inert.reason}`);
  assertStringIncludes(inert.reason, "inert");
  assertStringIncludes(inert.reason, "docs/ingest.md");

  // The mirror error, asserted so the fix cannot be "widen nothing": a file a suite is DERIVED to read still
  // selects exactly those suites.
  const real = planTests(
    ["src/assets/listen.js"],
    NO_MAP,
    NO_MAP,
    report.relations,
    [],
    blockFor(["src/assets/listen.js"]),
  );
  assertEquals(real.testFiles, report.relations.get("src/assets/listen.js"));
  assert((real.testFiles?.length ?? 0) > 0);

  // A data file under a directory the relation names a reader for selects that reader (over-selection is the
  // safe direction and is what the directory prefixes are for).
  const covered = planTests(
    ["docs/evidence/x.png"],
    NO_MAP,
    NO_MAP,
    report.relations,
    [],
    blockFor(["docs/evidence/x.png"]),
  );
  assertEquals(covered.testFiles, report.relations.get("docs/evidence/"));

  // And a data file with NO derived reader still widens rather than selecting nothing.
  const unread = planTests(
    ["docs/no-reader.png"],
    NO_MAP,
    NO_MAP,
    report.relations,
    [],
    blockFor(["docs/no-reader.png"]),
  );
  assertEquals(unread.testFiles, null);
  assertStringIncludes(unread.reason, "docs/no-reader.png");
});

Deno.test("audio-feed-7l9m: a SHADOWED binding decides, not the name (rev-27's fixture)", async () => {
  // THE FINDING, as a regression test. The first version of this fix collected NAMES, so `home` being bound
  // to $HOME anywhere in the file made every `home` in it out-of-repo - and this fixture's real read of
  // docs/notes.md was suppressed, which declared a markdown reader INERT. A false-green gate is the worst
  // finding a gate can have, because it makes the build faster by making it less true.
  await withTempTree({
    "docs/notes.md": "actual repo data\n",
    "tests/reader_test.ts": [
      'const home = Deno.env.get("HOME");',
      "export async function readIt() {",
      '  const home = new URL("../docs/", import.meta.url).pathname;',
      "  return await Deno.readTextFile(`${home}/notes.md`);",
      "}",
      "",
    ].join("\n"),
  }, async (root) => {
    const report = await deriveReadRelationReport(root, ["tests/reader_test.ts"]);
    assertEquals(
      report.relations.get("docs/"),
      ["tests/reader_test.ts"],
      "the INNER binding is a repo path, so the read still reaches the repository",
    );
    assert(
      !report.outOfRepo.includes("notes.md"),
      `a shadowed binding must not inherit the outer classification: ${JSON.stringify(report)}`,
    );
    // The outcome that matters: the change is NOT declared inert.
    // Production's rule, per change: only a fragment that could BE the changed file disables the inert class.
    const blocking = [
      ...report.unresolved,
      ...report.unattributed.filter((hint) =>
        couldHideInertRead(hint) && couldBeTheChangedFile(hint, ["docs/notes.md"])
      ),
    ];
    const plan = planTests(["docs/notes.md"], NO_MAP, NO_MAP, report.relations, [], blocking);
    assert(
      plan.testFiles === null || plan.testFiles.includes("tests/reader_test.ts"),
      `a real markdown reader must not be declared inert: ${JSON.stringify(plan)}`,
    );
  });
});

Deno.test("audio-feed-7l9m: the other direction - a genuinely out-of-repo binding still suppresses", async () => {
  // Two-sided on purpose: the fix must not turn "outside the repo" into "always offered", because those
  // eleven mis-parses were real and the speed gain came from them.
  await withTempTree({
    "docs/notes.md": "actual repo data\n",
    "tests/temp_reader_test.ts": [
      "export async function readIt() {",
      "  const home = await Deno.makeTempDir();",
      "  return await Deno.readTextFile(`${home}/notes.md`);",
      "}",
      "",
    ].join("\n"),
  }, async (root) => {
    const report = await deriveReadRelationReport(root, ["tests/temp_reader_test.ts"]);
    assertEquals(report.relations.size, 0, "a temp-dir read names nothing in the tree");
    assertEquals(report.outOfRepo, ["notes.md"], "and is still reported as out-of-repo");
    assertEquals(report.unresolved, [], "and is still not an unresolved path hint");
  });
});

Deno.test("audio-feed-7l9m: a PARAMETER shadows a module-level temp binding", async () => {
  // The conservative direction, applied to parameters: the module binds `dir` to a temp directory, and
  // readIt takes `dir` as a parameter and reads a repo-shaped file through it. The name match suppressed the
  // read; the scope lookup must not, so the fragment is OFFERED and reported instead of silently dropped.
  await withTempTree({
    "data/input.csv": "a,b\n",
    "tests/param_shadow_test.ts": [
      "const dir = await Deno.makeTempDir();",
      "export async function readIt(dir: string) {",
      "  return await Deno.readTextFile(`${dir}/input.csv`);",
      "}",
      "",
    ].join("\n"),
  }, async (root) => {
    const report = await deriveReadRelationReport(root, ["tests/param_shadow_test.ts"]);
    assert(
      !report.outOfRepo.includes("input.csv"),
      `the parameter is the innermost binding: ${JSON.stringify(report)}`,
    );
    assert(
      report.unattributed.includes("input.csv") || report.unresolved.includes("input.csv"),
      `the read must be offered rather than suppressed: ${JSON.stringify(report)}`,
    );
  });
});

/** The body of a reader whose parameter `home` shadows a module-level `home` from $HOME (audio-feed-i9ao). */
function shadowReader(signature: string, body: string[]): string {
  return ['const home = Deno.env.get("HOME") ?? "";', signature, ...body, "}", ""].join("\n");
}

Deno.test("audio-feed-i9ao: a PARAMETER never inherits the module-level out-of-repo binding, in ANY signature shape", async (t) => {
  // Round 2 found this with a 301-character signature: the detector looked back a fixed 300 characters for the
  // `(` of the parameter list, lost it, and let the read inherit `home` from $HOME - the same false green as
  // 7l9m, one shape later. The fix matches parens inside the enclosing scope instead, so length is not a
  // variable; these are the shapes that keep that honest, including the ones the reviewer did not construct.
  const shapes: Array<[string, string]> = [
    ["a short list", "export async function readIt(home: string) {"],
    [
      "a LONG list",
      `export async function readIt(home: string, filler: string = "${"x".repeat(400)}") {`,
    ],
    ["a destructured parameter", "export async function readIt({ home }: { home: string }) {"],
    [
      "a default holding a string with a comma and a paren",
      `export async function readIt(home = ["a","b"].join(",")) {`,
    ],
    [
      "a return type carrying its own parens",
      "export function readIt(home: string): (() => number) {",
    ],
    ["a bare arrow parameter", "const readIt = (home: string) => {"],
    ["a bare arrow parameter with no parens", "const readIt = home => {"],
  ];
  for (const [name, signature] of shapes) {
    await t.step(name, async () => {
      await withTempTree({
        "docs/notes.md": "actual repo data\n",
        "tests/reader_test.ts": shadowReader(signature, [
          "  return await Deno.readTextFile(`${home}/notes.md`);",
        ]),
      }, async (root) => {
        const report = await deriveReadRelationReport(root, ["tests/reader_test.ts"]);
        assert(
          !report.outOfRepo.includes("notes.md"),
          `${name}: a parameter must not inherit the module-level out-of-repo binding: ${
            JSON.stringify(report)
          }`,
        );
        assert(
          report.unattributed.includes("notes.md") || report.unresolved.includes("notes.md"),
          `${name}: the read must be OFFERED, never suppressed: ${JSON.stringify(report)}`,
        );
        const blocking = [
          ...report.unresolved,
          ...report.unattributed.filter((hint) =>
            couldHideInertRead(hint) && couldBeTheChangedFile(hint, ["docs/notes.md"])
          ),
        ];
        const plan = planTests(["docs/notes.md"], NO_MAP, NO_MAP, report.relations, [], blocking);
        assert(
          plan.testFiles === null || plan.testFiles.includes("tests/reader_test.ts"),
          `${name}: a real markdown reader must not be declared inert: ${JSON.stringify(plan)}`,
        );
      });
    });
  }
});

Deno.test("audio-feed-i9ao: the INVERSE - a control-flow block is not a signature, so it still inherits", async () => {
  // The net must not over-fire. `if (...) {` is a block, not a parameter list: the read inside it resolves to
  // the module-level `home` from $HOME and IS suppressed, exactly as before. If this test fails, the detector
  // will widen on every temp-directory read inside a branch, and the speed the bead exists to protect is gone.
  await withTempTree({
    "tests/branching_test.ts": shadowReader("export async function readIt() {", [
      '  if (Deno.env.get("X")) {',
      "    return await Deno.readTextFile(`${home}/state.json`);",
      "  }",
      '  return "";',
    ]),
  }, async (root) => {
    const report = await deriveReadRelationReport(root, ["tests/branching_test.ts"]);
    assert(
      report.outOfRepo.includes("state.json"),
      `a block inside a function is not a signature: ${JSON.stringify(report)}`,
    );
    assertEquals(report.unresolved, [], "and it must not be reported as a missing path");
  });
});

Deno.test("audio-feed-i9ao: a signature that cannot be parsed makes the scope NON-SUPPRESSIBLE", async () => {
  // The net under the paren matcher, and the reason this is a structural fix rather than a bigger number: a
  // return type containing braces defeats the signature-tail test, so the parameter list cannot be
  // established - and the scope then refuses to inherit instead of assuming it has no parameters.
  await withTempTree({
    "docs/notes.md": "actual repo data\n",
    "tests/reader_test.ts": shadowReader(
      "export async function readIt(home: string): Promise<{ b: string }> {",
      ["  return { b: await Deno.readTextFile(`${home}/notes.md`) };"],
    ),
  }, async (root) => {
    const report = await deriveReadRelationReport(root, ["tests/reader_test.ts"]);
    assert(
      !report.outOfRepo.includes("notes.md"),
      `an unparsed signature must not inherit: ${JSON.stringify(report)}`,
    );
    assert(
      report.unattributed.includes("notes.md") || report.unresolved.includes("notes.md"),
      `and the read must be offered: ${JSON.stringify(report)}`,
    );
  });
});

Deno.test("audio-feed-i9ao: the eleven mis-parses stay corrected, so no known hint blocks", async () => {
  // The speed anchor, stated as an invariant: every hint that was a mis-parse must be accounted for as
  // out-of-repo or as a fragment - if one of them comes back as an unresolved PATH hint, the inert class is
  // unreachable again for every change and a docs-only edit pays the full suite (125s, measured).
  const report = await deriveReadRelationReport(ROOT);
  // `beads` is deliberately absent from this list: it is one of the two hints `toRepoPath` drops for not being
  // path-shaped, which is audio-feed-snww's subject (a hint dropped in silence). It cannot BLOCK - a hint with
  // no slash and no extension is neither markdown nor a directory prefix (`couldHideInertRead` is false for it)
  // - so the invariant this test exists for still holds, and the assertion below states it directly.
  const known = [
    ".cache/puppeteer/chrome",
    "absent-puppeteer-chrome",
    "empty-puppeteer-chrome",
    "mock-cache/120.0.0",
    "mock-cache/121.0.0",
    "bd",
    "digest.md",
    "state.json",
    "obs.kv",
    "test.kv",
  ];
  const accounted = new Set([...report.outOfRepo, ...report.unattributed]);
  const missing = known.filter((hint) => !accounted.has(hint));
  assertEquals(
    missing,
    [],
    `mis-parse hints that are neither out-of-repo nor fragments (they block): ${
      JSON.stringify({
        missing,
        unresolved: report.unresolved,
      })
    }`,
  );
  assertEquals(report.unresolved, [], "and nothing may be an unresolved PATH hint");
});

Deno.test("audio-feed-snww: a runtime-assembled name is REPORTED, and still cannot block", async (t) => {
  // The silence this bead is about: a runtime-assembled read whose suffix is a bare name. `toRepoPath` cannot
  // place a name with no directory part, and before this bucket that refusal went NOWHERE - not to unresolved,
  // not to unattributed, not to outOfRepo - which is the one thing q0ky forbids. Reported and inert-neutral are
  // BOTH required, so both are asserted here, and the steps below cover the two binding contexts a tail can
  // have: a parameter (not provably out-of-repo, so the name cannot be placed) and a temp dir (provably so).
  await t.step("it appears in unclassified, and in no other bucket", async () => {
    await withTempTree({
      "tests/profile_test.ts": [
        "export async function readEntry(profileDir: string) {",
        "  return await Deno.readTextFile(`${profileDir}/DevToolsActivePort`);",
        "}",
        "",
      ].join("\n"),
    }, async (root) => {
      const report = await deriveReadRelationReport(root, ["tests/profile_test.ts"]);
      assertEquals(
        report.unclassified,
        ["DevToolsActivePort"],
        `a runtime-assembled bare name must be reported, not dropped in silence: ${
          JSON.stringify(report)
        }`,
      );
      for (const bucket of [report.unresolved, report.unattributed, report.outOfRepo]) {
        assert(
          !bucket.includes("DevToolsActivePort"),
          `the bare-name class is its own answer, not one of the others: ${JSON.stringify(report)}`,
        );
      }
    });
  });

  await t.step(
    "the SAME name with a temp-dir base is reported in outOfRepo - never in neither",
    async () => {
      // The pair that makes the promise complete. When the base IS provably outside the repo (makeTempDir),
      // suppression wins and the hint is printed in `outOfRepo` (audio-feed-lm4d); when it is only a parameter it
      // is printed in `bareNames`. What this bead exists to prevent is the third case: a name that reaches NEITHER
      // list and so leaves no trace.
      await withTempTree({
        "tests/profile_test.ts": [
          "const stateDir = await Deno.makeTempDir();",
          "export async function readEntry() {",
          "  return await Deno.readTextFile(`${stateDir}/DevToolsActivePort`);",
          "}",
          "",
        ].join("\n"),
      }, async (root) => {
        const report = await deriveReadRelationReport(root, ["tests/profile_test.ts"]);
        assertEquals(
          report.outOfRepo,
          ["DevToolsActivePort"],
          `a provably out-of-repo base reports it as such: ${JSON.stringify(report)}`,
        );
        assertEquals(report.unclassified, [], "and it is not also listed as an unplaceable name");
      });
    },
  );

  await t.step(
    "and it cannot disable the inert class, because it cannot be the changed file",
    () => {
      // The other side of the same coin. `bareNameHint` accepts it, so it is printed; `couldHideInertRead` and
      // `couldBeTheChangedFile` reject it - no extension, no directory - so no selection can depend on it. If
      // this step ever fails, a bare name can widen a run and the speed the buckets exist to protect is gone.
      assert(unclassifiedTail("DevToolsActivePort"), "the bucket must accept it");
      assert(
        !couldHideInertRead("DevToolsActivePort"),
        "it is not markdown and not a directory of one",
      );
      assert(
        !couldBeTheChangedFile("DevToolsActivePort", ["docs/ingest.md"]),
        "and no docs change can be it",
      );
    },
  );
});

Deno.test("audio-feed-snww: a LITERAL command name and its flags stay silent - the bucket is for reads", async () => {
  // The boundary that keeps the bucket readable, and the reason it is collected in the tail-candidate loop
  // rather than everywhere: `Deno.Command` is a read call in this detector, and its literals are a command
  // name, a flag and an argument - not files. They are rejected before any tail candidate exists (`beads` has
  // no slash and no extension either), so they must NOT appear as bare names.
  await withTempTree({
    "tests/command_test.ts": [
      "export async function runIt() {",
      '  const out = await new Deno.Command("beads", { args: ["--json", "list"] }).output();',
      "  return new TextDecoder().decode(out.stdout);",
      "}",
      "",
    ].join("\n"),
  }, async (root) => {
    const report = await deriveReadRelationReport(root, ["tests/command_test.ts"]);
    assertEquals(
      report.unclassified,
      [],
      `a command name and its flags are not reads: ${JSON.stringify(report)}`,
    );
  });
});

Deno.test("audio-feed-3ttu: EVERY runtime-assembled name is accounted for, and reported WHOLE", async (t) => {
  // rev-27's matrix, and the reason this bucket is defined by "unaccounted for" rather than by a shape. The shape
  // test that used to gate this bucket (`^[\w@.-]+$`, no slash, no extension) excluded `+`, `#` and non-ASCII, so
  // three of these four are REAL reads that landed in NO bucket at all - the silence the bead exists to remove.
  // The fourth was WORSE than silent: the whitespace split cut it, so a bucket that looked like it worked would
  // have reported `daily` for `${dir}/daily notes`.
  const cases: Array<[string, string]> = [
    ["plus", "notes+draft"],
    ["hash", "draft#1"],
    ["non-ascii", "déjà"],
    ["space", "daily notes"],
  ];
  for (const [label, name] of cases) {
    await t.step(`${label}: ${name}`, async () => {
      await withTempTree({
        "tests/reader_test.ts": [
          "export async function readIt(dir: string) {",
          `  return await Deno.readTextFile(\`\${dir}/${name}\`);`,
          "}",
          "",
        ].join("\n"),
      }, async (root) => {
        const report = await deriveReadRelationReport(root, ["tests/reader_test.ts"]);
        assertEquals(
          report.unclassified,
          [name],
          `${name} must be REPORTED (whole), never dropped in silence: ${JSON.stringify(report)}`,
        );
        for (const bucket of [report.unresolved, report.unattributed, report.outOfRepo]) {
          assert(
            bucket.length === 0,
            `and it belongs to no other bucket: ${JSON.stringify(report)}`,
          );
        }
      });
    });
  }
});
