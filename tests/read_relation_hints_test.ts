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
import { couldHideInertRead, planTests } from "../scripts/fast-check.ts";
import { deriveReadRelationReport, ROOT } from "../scripts/test-selection.ts";

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

Deno.test("audio-feed-lm4d: on the REAL tree an inert change is inert, and a real change still selects its readers", async () => {
  const report = await deriveReadRelationReport(ROOT);
  // The invariant this bead restores: on an unchanged tree the relation is COMPLETE, so the inert class is
  // reachable. A red here means a hint is inaccurate again - fix the hint, do not widen the change.
  assertEquals(
    report.unresolved,
    [],
    "an unresolved hint disables the inert class for EVERY change; see the report's other buckets",
  );

  const blocking = [
    ...report.unresolved,
    ...report.unattributed.filter(couldHideInertRead),
  ];

  // An inert change selects NOTHING, and says so (audio-feed-es8y condition 2: an empty selection must never
  // read like a pass - the reason has to carry the fact).
  const inert = planTests(["docs/ingest.md"], NO_MAP, NO_MAP, report.relations, [], blocking);
  assertEquals(inert.testFiles, [], `a docs-only change must be inert now: ${inert.reason}`);
  assertStringIncludes(inert.reason, "inert");
  assertStringIncludes(inert.reason, "docs/ingest.md");

  // The mirror error, asserted so the fix cannot be "widen nothing": a file a suite is DERIVED to read still
  // selects exactly those suites.
  const real = planTests(["src/assets/listen.js"], NO_MAP, NO_MAP, report.relations, [], blocking);
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
    blocking,
  );
  assertEquals(covered.testFiles, report.relations.get("docs/evidence/"));

  // And a data file with NO derived reader still widens rather than selecting nothing.
  const unread = planTests(["docs/no-reader.png"], NO_MAP, NO_MAP, report.relations, [], blocking);
  assertEquals(unread.testFiles, null);
  assertStringIncludes(unread.reason, "docs/no-reader.png");
});
