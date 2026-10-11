/**
 * audio-feed-es8y — the fast gate's selection must be a PROVEN SUBSET of the full gate's.
 *
 * The full gate ends in `deno test` with no file arguments, so Deno discovers test modules by basename
 * pattern anywhere in the repo. The fast gate runs an explicit list. These tests pin the two properties the
 * fix rests on, and the ledger that replaced "not a .ts file, so no test can care":
 *
 *   1. every module the fast gate selects is a module the full gate runs;
 *   2. every module the full gate runs is selectable by the fast gate or justified by an exclusion, and a
 *      module that is neither is a NAMED failure (the case that used to be silent).
 *
 * The fixture-tree case in `discovery follows Deno's basename rule` is the empirical rule measured on Deno
 * 2.9.7 (a_test.ts / b.test.ts / c_test.mts / d_test.js and tests/sub/deep.test.ts ran; helper.ts and
 * tests/helper_in_tests.ts did not) written down as a test, so the rule cannot quietly change under us
 * without this failing.
 *
 * Nothing here spawns a subprocess EXCEPT the discovery proof, which needs `--allow-run=deno`; that test
 * declares the requirement and is skipped where the permission is not granted (`deno task test` grants no
 * --allow-run, the gate tasks do, and `deno task gate` also runs the same proof at the start via the CLI).
 */

import { assert, assertEquals } from "@std/assert";
import { allTestFiles, planTests, suiteMarker } from "../scripts/fast-check.ts";
import {
  auditSelection,
  auditUnreadDeclarations,
  classifyNonTsChanges,
  deriveDataReadRelations,
  discoverFullGateTestFiles,
  FAST_GATE_EXCLUSIONS,
  isFastGateSelectable,
  isTestModule,
  NEVER_WALKED,
  proveDiscoveryMatchesDeno,
  ROOT,
  universeDrift,
  UNREAD_DECLARATIONS,
} from "../scripts/test-selection.ts";

const NO_NAMED = new Map<string, string[]>();
const NO_GRAPH = new Map<string, string[]>();

// ---------------------------------------------------------------------------
// Deno's discovery rule, as a predicate
// ---------------------------------------------------------------------------

Deno.test("isTestModule pins Deno's basename rule ({*_,*.,}test.<ext>)", () => {
  for (
    const yes of [
      "tests/a_test.ts",
      "tests/b.test.ts",
      "tests/c_test.mts",
      "tests/d_test.js",
      "tests/sub/deep_test.ts",
      "tests/sub/deep.test.ts",
      "test.ts",
      "tests/thing_test.tsx",
    ]
  ) {
    assert(isTestModule(yes), `${yes} is a test module Deno discovers`);
  }
  for (
    const no of [
      "tests/helper_in_tests.ts",
      "tests/fixtures.ts",
      "src/server.ts",
      "tests/foo-test.ts", // the name-matching convention, NOT a Deno discovery pattern
      "docs/evidence/att-paging/measure.ts",
      "tests/foo_test.ts.bak",
    ]
  ) {
    assert(!isTestModule(no), `${no} is not a module Deno's runner picks up`);
  }
});

Deno.test("discovery follows Deno's basename rule and skips the unwalked trees", async () => {
  const dir = await Deno.makeTempDir({ prefix: "af-subset-" });
  try {
    const files: Record<string, string> = {
      "a_test.ts": "",
      "b.test.ts": "",
      "c_test.mts": "",
      "d_test.js": "",
      "helper.ts": "",
      "test.ts": "",
      "tests/t_test.ts": "",
      "tests/helper_in_tests.ts": "",
      "tests/sub/deep_test.ts": "",
      "tests/sub/deep.test.ts": "",
      "node_modules/dep/x_test.ts": "",
      ".beads/export_test.ts": "",
      "var/scratch_test.ts": "",
      "docs/evidence/measure.ts": "",
    };
    for (const [path, body] of Object.entries(files)) {
      const full = `${dir}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, body);
    }

    const discovered = await discoverFullGateTestFiles(`${dir}/`);
    assertEquals(discovered, [
      "a_test.ts",
      "b.test.ts",
      "c_test.mts",
      "d_test.js",
      "test.ts",
      "tests/sub/deep.test.ts",
      "tests/sub/deep_test.ts",
      "tests/t_test.ts",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the walk skips every directory deno.json excludes (audio-feed-es8y)", async () => {
  // A configured exclude the walk does not know about would add modules to the universe
  // that the full gate never runs - property 1 would be violated by configuration drift.
  const raw = await Deno.readTextFile(`${ROOT}deno.json`);
  const json = JSON.parse(
    raw.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"),
  ) as { exclude?: string[] };
  for (const entry of json.exclude ?? []) {
    const name = entry.replace(/\/$/, "");
    assert(
      NEVER_WALKED.includes(name),
      `deno.json excludes ${entry} but NEVER_WALKED does not: ${NEVER_WALKED.join(", ")}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Property 1: nothing the fast gate can select sits outside the full gate's universe
// ---------------------------------------------------------------------------

Deno.test("the fast gate's universe is a subset of the full gate's, measured on this repo", async () => {
  const full = await discoverFullGateTestFiles(ROOT);
  const fast = await allTestFiles();

  assert(full.length > 0, "the full gate runs something");
  assert(fast.length > 0, "the fast gate can select something");
  const fullSet = new Set(full);
  const outside = fast.filter((f) => !fullSet.has(f));
  assertEquals(
    outside,
    [],
    `the fast gate selects modules the full gate never runs: ${outside.join(", ")}`,
  );
  // The derivation is a filter, so this is structural; asserted anyway because the
  // structural claim is the whole point of the module.
  assertEquals(fast, full.filter(isFastGateSelectable));
});

Deno.test("a reachable test module outside the selectable universe is a full-suite fallback", () => {
  // tests/foo-test.ts is the NAME-MATCHING convention, not a Deno discovery pattern: the full gate
  // never runs it, so selecting it for a change would make the fast gate run something "more" than
  // the full gate - the mirror image of the gap this bead is about.
  const plan = planTests(
    ["src/routes/widgets.ts"],
    new Map([["src/routes/widgets.ts", ["tests/foo-test.ts"]]]),
    new Map([["src/routes/widgets.ts", ["tests/foo-test.ts"]]]),
  );
  assertEquals(plan.testFiles, null, plan.reason);
  assert(/outside the fast gate/.test(plan.reason), plan.reason);
});

// ---------------------------------------------------------------------------
// Property 2: an account of every full-gate module, and a NAMED failure when one is missing
// ---------------------------------------------------------------------------

Deno.test("every module the full gate runs is selectable or justified (this repo)", async () => {
  const full = await discoverFullGateTestFiles(ROOT);
  const audit = auditSelection(full);
  assertEquals(audit.unaccounted, []);
  assertEquals(audit.badExclusions, []);
  assertEquals(audit.ok, true, audit.message);
  assertEquals(audit.message, "");
  assertEquals(audit.fastGateUniverse.length, (await allTestFiles()).length);
  assertEquals(FAST_GATE_EXCLUSIONS, [], "the exclusion list is empty: nothing needs one today");
});

Deno.test("a `.test.ts` module the fast gate cannot select is a NAMED failure, not a silent gap", () => {
  const audit = auditSelection([
    "tests/origin_test.ts",
    "tests/future.test.ts",
    "src/inline_test.mts",
  ]);

  assertEquals(audit.ok, false);
  assertEquals(audit.unaccounted, ["tests/future.test.ts", "src/inline_test.mts"]);
  assert(audit.message.includes("SELECTION GAP"), audit.message);
  assert(audit.message.includes("tests/future.test.ts"), audit.message);
  assert(audit.message.includes("src/inline_test.mts"), audit.message);
  // The FILE-LEVEL fix comes first, because that is usually the whole fix: a lane under time pressure
  // should rename a module rather than edit the gate's own predicate.
  assert(audit.message.includes("tests/*_test.ts"), audit.message);
  assert(
    audit.message.indexOf("tests/*_test.ts") < audit.message.indexOf("isFastGateSelectable"),
    "the file-level fix must be named before the gate-level one",
  );
  assert(audit.message.includes("isFastGateSelectable"), audit.message);
  assert(audit.message.includes("FAST_GATE_EXCLUSIONS"), audit.message);
});

Deno.test("the audit cannot be defeated by the builder drifting from the run (es8y condition 1/2)", () => {
  // The audit and the run consume ONE walk; this is the check that keeps the exported builder honest.
  assertEquals(universeDrift(["tests/a_test.ts"], ["tests/a_test.ts"]), null);
  assertEquals(universeDrift(["tests/a_test.ts", "tests/a_test.ts"], ["tests/a_test.ts"]), null);

  const narrower = universeDrift(["tests/a_test.ts", "tests/b_test.ts"], ["tests/a_test.ts"]);
  assert(narrower !== null, "a builder that lost a module must be a named failure");
  assert(narrower.includes("SELECTION DRIFT"), narrower);
  assert(narrower.includes("only in the run's universe: 1: tests/b_test.ts"), narrower);

  const wider = universeDrift(["tests/a_test.ts"], ["tests/a_test.ts", "tests/c_test.ts"]);
  assert(wider !== null, "a builder that gained a module must be a named failure too");
  assert(wider.includes("only in allTestFiles(): 1: tests/c_test.ts"), wider);
});

Deno.test("an exclusion justifies itself or it is reported (a reason, and a module that exists)", () => {
  const full = ["tests/a_test.ts", "tests/b.test.ts"];

  const missingReason = auditSelection(full, [{ path: "tests/b.test.ts", reason: "   " }]);
  assertEquals(missingReason.ok, false);
  assertEquals(missingReason.badExclusions, ["tests/b.test.ts (no reason given)"]);

  const notAFullGateModule = auditSelection(full, [{
    path: "tests/nope.test.ts",
    reason: "run nightly",
  }]);
  assertEquals(notAFullGateModule.ok, false);
  assertEquals(notAFullGateModule.badExclusions, [
    "tests/nope.test.ts (the full gate does not run this module)",
  ]);

  const justified = auditSelection(full, [{
    path: "tests/b.test.ts",
    reason: "factory line runs it",
  }]);
  assertEquals(justified.ok, true, justified.message);
  assertEquals(justified.unaccounted, []);
});

// ---------------------------------------------------------------------------
// The data ledger: non-TypeScript changes that a suite can see
// ---------------------------------------------------------------------------

// The DERIVED read relation: non-TypeScript changes a suite can see
// ---------------------------------------------------------------------------

// Derived once from this repo, exactly as the gate derives it.
const RELATIONS = await deriveDataReadRelations(ROOT);

Deno.test("**DERIVATION**: the relation is read out of the suites, not listed beside them", async () => {
  // The two live instances of the gap this bead is about, derived rather than declared:
  assertEquals(RELATIONS.get("docs/evidence/"), ["tests/evidence_size_test.ts"]);
  assertEquals(RELATIONS.get("scripts/observability-agent-run.sh"), [
    "tests/observability_agent_poll_test.ts",
  ]);
  // A suite reading one file by name is found too, and every key is a real path.
  assert(RELATIONS.has("deno.json"), "deno.json is read by the suites that parse the task list");
  for (const path of RELATIONS.keys()) {
    const stat = await Deno.stat(`${ROOT}${path.replace(/\/$/, "")}`).catch(() => null);
    assert(stat !== null, `${path} should be a real path in the tree`);
  }
});

Deno.test("the relation is derived through a path CONSTANT and a default parameter (es8y)", async () => {
  // docs/evidence is read by evidencePngs(), whose directory comes from `EVIDENCE_DIR` in
  // scripts/evidence-compress.ts and reaches the read call through the `dir = EVIDENCE_DIR` default.
  // Break that chain and the derivation test above fails, which is the point: the relation must come
  // from the code rather than from a list that agrees today.
  const suite = await Deno.readTextFile(`${ROOT}tests/evidence_size_test.ts`);
  assert(suite.includes("evidencePngs"), "the suite must call evidencePngs()");
  const compress = await Deno.readTextFile(`${ROOT}scripts/evidence-compress.ts`);
  assert(
    /EVIDENCE_DIR\s*=\s*`\$\{import\.meta\.dirname\}\/\.\.\/docs\/evidence`/.test(compress),
    "EVIDENCE_DIR must still point at ../docs/evidence",
  );
  assert(/dir: string = EVIDENCE_DIR/.test(compress), "the read call must take it by default");
});

Deno.test("module-graph config runs the FULL suite even when a suite happens to read it (es8y)", () => {
  // Found while answering a review question about the allowlist-versus-property shape: the config check used
  // to be a two-filename list, so a NEW config file that some suite reads (add import_map.json, read it in
  // one suite) would select that one suite while every suite's module resolution moved. The family that can
  // move the graph is now checked by name, and the unclassified default still covers everything new.
  const relations = new Map([["import_map.json", ["tests/deno-task-coverage_test.ts"]]]);
  for (
    const config of [
      "deno.json",
      "deno.jsonc",
      "deno.lock",
      "import_map.json",
      "tsconfig.json",
    ]
  ) {
    const plan = planTests([config], NO_GRAPH, NO_NAMED, relations);
    assertEquals(plan.testFiles, null, `${config} must run the full suite: ${plan.reason}`);
    assert(plan.reason.includes("module-graph config"), plan.reason);
  }
});

Deno.test("a derivation that cannot run WIDENS to the full suite and says why (es8y, detector fail-safe)", () => {
  // The rule coord set for the detector: if it cannot understand, it must not answer "no read found". A
  // data file with no relation available is therefore UNCLASSIFIED, which runs the full suite - never a
  // silent zero. This pins the plan-level half; the gate-level half (the derivation THROWING) is proven by
  // running the gate with a mutated detector and is recorded on the bead.
  const noRelation = new Map<string, string[]>();
  const plan = planTests(["docs/evidence/x.png"], NO_GRAPH, NO_NAMED, noRelation);
  assertEquals(
    plan.testFiles,
    null,
    "a data file must not be silently dropped when no relation is known",
  );
  assert(plan.reason.includes("docs/evidence/x.png"), plan.reason);
  assert(plan.reason.includes("not read by any suite (derived)"), plan.reason);

  // And the inert exception stays exactly as narrow as it was: markdown is documentation (loud, empty run),
  // a declared-unread path is inert, and NOTHING else is.
  assertEquals(planTests(["README.md"], NO_GRAPH, NO_NAMED, noRelation).testFiles, []);
  assertEquals(planTests([".beads/issues.jsonl"], NO_GRAPH, NO_NAMED, noRelation).testFiles, []);
});

Deno.test("a changed evidence PNG selects the suite that asserts its budget (es8y)", () => {
  // Before this: planTests(["docs/evidence/x.png"]) returned [] and the gate said
  // "no tests to run" - a fast PASS on a tree where evidence_size_test.ts fails.
  const plan = planTests(
    ["docs/evidence/audio-feed-0jp/edit-1280-light.png"],
    NO_GRAPH,
    NO_NAMED,
    RELATIONS,
  );
  assertEquals(plan.testFiles, ["tests/evidence_size_test.ts"], plan.reason);
});

Deno.test("a changed shell runner selects the suite that executes it (es8y)", () => {
  const plan = planTests(["scripts/observability-agent-run.sh"], NO_GRAPH, NO_NAMED, RELATIONS);
  assertEquals(plan.testFiles, ["tests/observability_agent_poll_test.ts"], plan.reason);
});

Deno.test("a changed data file rides ALONGSIDE a code change", () => {
  const plan = planTests(
    ["src/routes/widgets.ts", "docs/evidence/x.png"],
    new Map(),
    new Map([["src/routes/widgets.ts", ["tests/widgets_test.ts"]]]),
    RELATIONS,
  );
  assertEquals(plan.testFiles, ["tests/evidence_size_test.ts", "tests/widgets_test.ts"]);
});

Deno.test("an undeclared non-TypeScript file runs the FULL suite and names itself", () => {
  const plan = planTests(["mystery/payload.bin"], NO_GRAPH, NO_NAMED, RELATIONS);
  assertEquals(plan.testFiles, null);
  assert(plan.reason.includes("mystery/payload.bin"), plan.reason);
  assert(plan.reason.includes("not read by any suite (derived)"), plan.reason);
  assert(plan.reason.includes("UNREAD_DECLARATIONS"), plan.reason);
});

Deno.test("documentation and declared-not-read files still run nothing", () => {
  assertEquals(planTests(["README.md"], NO_GRAPH, NO_NAMED).testFiles, []);
  assertEquals(planTests(["docs/observability-api.md"], NO_GRAPH, NO_NAMED).testFiles, []);
  assertEquals(planTests([".beads/issues.jsonl"], NO_GRAPH, NO_NAMED).testFiles, []);
});

Deno.test("classifyNonTsChanges sorts every changed non-.ts file into one of the buckets", () => {
  const classified = classifyNonTsChanges([
    "src/server.ts",
    "README.md",
    "docs/evidence/x.png",
    ".beads/issues.jsonl",
    "mystery/payload.bin",
  ], RELATIONS);
  assertEquals(classified.documentation, ["README.md"]);
  assertEquals(classified.suites, ["tests/evidence_size_test.ts"]);
  assertEquals(classified.inert, [".beads/issues.jsonl"]);
  assertEquals(classified.unclassified, ["mystery/payload.bin"]);
});

// ---------------------------------------------------------------------------
// Condition 2: an empty selection is a distinct, loud state, never a silent pass
// ---------------------------------------------------------------------------

Deno.test("an empty selection is allowed only for provably inert changes (es8y condition 2)", () => {
  // Declared inert: markdown documentation and the UNREAD_DECLARATIONS entries.
  for (
    const inert of [
      ["README.md"],
      ["CHANGELOG.md"],
      ["docs/observability-api.md"],
      [".beads/issues.jsonl"],
    ]
  ) {
    const plan = planTests(inert, NO_GRAPH, NO_NAMED);
    assertEquals(plan.testFiles, [], `${inert} should select nothing: ${plan.reason}`);
    assert(plan.reason.includes("declared inert"), plan.reason);
  }
  assertEquals(
    planTests([], NO_GRAPH, NO_NAMED).testFiles,
    null,
    "an empty change set is NOT proven inert (nothing was checked)",
  );
});

Deno.test("a standalone script nothing imports runs the FULL suite, not a silent zero (es8y)", () => {
  // scripts/smoke.ts has no importer and no name-matched suite: the old carve-out called the type-check
  // its gate and returned [], which is indistinguishable from "suites ran and passed".
  const plan = planTests(["scripts/smoke.ts"], NO_GRAPH, NO_NAMED);
  assertEquals(plan.testFiles, null, plan.reason);
  assert(plan.reason.includes("scripts/smoke.ts"), plan.reason);
  assert(plan.reason.includes("not inert by declaration"), plan.reason);
});

Deno.test("the empty state is marked `unmapped:` for the coverage line and said out loud", async () => {
  // The fleet's coverage reporter parses `fast-gate: .*unmapped:` into explicit_unmapped and turns a
  // non-empty list into a COVERAGE WARNING, so an all-inert change is visible in the coverage line
  // instead of reading like a green test run.
  const reporter = /(?:fast-gate:.*?)?unmapped:\s*(.*)/;
  const line = suiteMarker("unmapped", ["README.md", "docs/observability-api.md"]);
  const match = reporter.exec(line);
  assert(match !== null, line);
  assertEquals(match[1]!.split(/\s+/), ["README.md", "docs/observability-api.md"]);

  const source = await Deno.readTextFile(`${ROOT}scripts/fast-check.ts`);
  assert(source.includes("NO SUITES SELECTED"), "the fast gate must say the empty state out loud");
  assert(source.includes('suiteMarker("unmapped"'), "and mark it unmapped for the coverage line");
  assert(
    !source.includes("no tests to run"),
    "the old cheerful phrasing must be gone: it read like a pass",
  );
});

// ---------------------------------------------------------------------------
// Condition 4: the universe is PROVEN equal to Deno's discovery, by running Deno
// ---------------------------------------------------------------------------

const canRunDeno = (() => {
  try {
    return Deno.permissions.querySync({ name: "run", command: "deno" }).state === "granted";
  } catch {
    return false;
  }
})();

Deno.test({
  name:
    "discovery equals `deno test --no-run` over a planted corpus (needs --allow-run=deno; the gate grants it)",
  ignore: !canRunDeno,
  fn: async () => {
    const proof = await proveDiscoveryMatchesDeno();
    assert(proof.ok, proof.detail);
    assertEquals(proof.ours, proof.deno);
    // The corpus really does cover the patterns and the look-alikes:
    for (const planted of ["b.test.ts", "c_test.mts", "d_test.js", "src/inline.test.ts"]) {
      assert(
        proof.deno.includes(planted),
        `${planted} should be discovered: ${proof.deno.join(", ")}`,
      );
    }
    for (const notATest of ["tests/helper_in_tests.ts", "helper.ts"]) {
      assert(!proof.deno.includes(notATest), `${notATest} must not be discovered`);
    }
  },
});

// ---------------------------------------------------------------------------
// fastSelection(C) is inside the universe for an adversarial corpus
// ---------------------------------------------------------------------------

Deno.test("every selection in the adversarial corpus is inside the full gate's universe", async () => {
  const universe = new Set(await discoverFullGateTestFiles(ROOT));
  const corpus: string[][] = [
    ["docs/evidence/audio-feed-0jp/edit-1280-light.png"],
    ["scripts/observability-agent-run.sh"],
    ["docs/observability-api.md"],
    ["README.md"],
    ["scripts/smoke.ts"],
    ["src/storage/kv/runs.ts"],
    ["src/app.ts"],
    ["tests/fixtures.ts"],
    ["tests/fixtures/page.html"],
    ["deno.json"],
    ["mystery/payload.bin"],
    [],
  ];
  for (const changed of corpus) {
    const plan = planTests(changed, new Map(), NO_NAMED, RELATIONS);
    if (plan.testFiles === null) continue; // the full suite is trivially inside itself
    const outside = plan.testFiles.filter((f) => !universe.has(f));
    assertEquals(outside, [], `${changed.join(", ")} selected modules outside the universe`);
  }

  // The case that FAILS on the pre-fix code: the name-matching convention accepts tests/foo-test.ts, which
  // Deno never discovers - so selecting it makes the fast gate run something the full gate does not.
  const mirror = planTests(
    ["src/routes/widgets.ts"],
    new Map(),
    new Map([["src/routes/widgets.ts", ["tests/foo-test.ts"]]]),
  );
  assertEquals(mirror.testFiles, null, mirror.reason);
});

Deno.test("the unread declarations hold against the derived relation (es8y condition 1/2)", async () => {
  const full = await discoverFullGateTestFiles(ROOT);
  const fastUniverse = full.filter(isFastGateSelectable);
  assertEquals(
    await auditUnreadDeclarations(ROOT, UNREAD_DECLARATIONS, RELATIONS, fastUniverse),
    [],
  );

  // Bites: a declaration contradicted by a derived read, one naming nothing in the tree, and an empty reason.
  const contradicted = await auditUnreadDeclarations(
    ROOT,
    [{ pattern: "docs/evidence/", reason: "says nothing read this, but a suite does" }],
    RELATIONS,
    fastUniverse,
  );
  assert(
    contradicted.some((p) =>
      p.includes("declared read by nobody") && p.includes("tests/evidence_size_test.ts")
    ),
    contradicted.join("; "),
  );
  const missing = await auditUnreadDeclarations(
    ROOT,
    [
      { pattern: "no/such/dir/", reason: "made up" },
      { pattern: ".gitignore", reason: "   " },
    ],
    RELATIONS,
    fastUniverse,
  );
  assert(
    missing.some((p) => p.includes("no/such/dir/") && p.includes("does not exist")),
    missing.join("; "),
  );
  assert(
    missing.some((p) => p.includes(".gitignore") && p.includes("no reason")),
    missing.join("; "),
  );
});

Deno.test("the detector reads a fixture suite that reads a fixture data file (es8y)", async () => {
  // The detector is exercised on its own fixture tree, so the rules it claims to implement are visible here
  // rather than only in the live relation: a string literal, `new URL("<literal>", import.meta.url)`, and a
  // constant built from `${import.meta.dirname}` (the docs/evidence shape).
  const dir = await Deno.makeTempDir({ prefix: "af-relations-" });
  try {
    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    await Deno.mkdir(`${dir}/scripts`, { recursive: true });
    await Deno.mkdir(`${dir}/data`, { recursive: true });
    await Deno.writeTextFile(`${dir}/data/table.csv`, "a,b\n");
    await Deno.writeTextFile(`${dir}/fixtures.html`, "<p>fixture</p>");
    await Deno.writeTextFile(
      `${dir}/scripts/paths.ts`,
      "export const DATA_DIR = `${import.meta.dirname}/../data`;\n",
    );
    await Deno.writeTextFile(
      `${dir}/tests/fixture_read_test.ts`,
      `import { DATA_DIR } from "../scripts/paths.ts";
import { assertEquals } from "jsr:@std/assert";

Deno.test("reads", async () => {
  await Deno.readTextFile(\`\${DATA_DIR}/table.csv\`);
  await Deno.readTextFile(new URL("../fixtures.html", import.meta.url));
  await Deno.readTextFile("data/table.csv");
  assertEquals(1, 1);
});
`,
    );

    const relations = await deriveDataReadRelations(`${dir}/`);
    assertEquals(relations.get("data/table.csv"), ["tests/fixture_read_test.ts"]);
    assertEquals(relations.get("fixtures.html"), ["tests/fixture_read_test.ts"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
