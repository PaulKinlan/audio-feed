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
 * Nothing here spawns a subprocess: `deno task test` grants no --allow-run (only the gate tasks do), so a
 * test that shelled out to `deno test --no-run` would pass in the gate and fail in `deno task test`.
 */

import { assert, assertEquals } from "@std/assert";
import { allTestFiles, planTests } from "../scripts/fast-check.ts";
import {
  auditDataLedger,
  auditSelection,
  classifyNonTsChanges,
  DATA_LEDGER,
  discoverFullGateTestFiles,
  FAST_GATE_EXCLUSIONS,
  isFastGateSelectable,
  isTestModule,
  NEVER_WALKED,
  ROOT,
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
  assert(audit.message.includes("isFastGateSelectable"), audit.message);
  assert(audit.message.includes("FAST_GATE_EXCLUSIONS"), audit.message);
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

Deno.test("a changed evidence PNG selects the suite that asserts its budget (es8y)", () => {
  // Before this: planTests(["docs/evidence/x.png"]) returned [] and the gate said
  // "no tests to run" - a fast PASS on a tree where evidence_size_test.ts fails.
  const plan = planTests(["docs/evidence/audio-feed-0jp/edit-1280-light.png"], NO_GRAPH, NO_NAMED);
  assertEquals(plan.testFiles, ["tests/evidence_size_test.ts"], plan.reason);
});

Deno.test("a changed shell runner selects the suite that executes it (es8y)", () => {
  const plan = planTests(["scripts/observability-agent-run.sh"], NO_GRAPH, NO_NAMED);
  assertEquals(plan.testFiles, ["tests/observability_agent_poll_test.ts"], plan.reason);
});

Deno.test("a changed data file rides ALONGSIDE a code change", () => {
  const plan = planTests(
    ["src/routes/widgets.ts", "docs/evidence/x.png"],
    new Map(),
    new Map([["src/routes/widgets.ts", ["tests/widgets_test.ts"]]]),
  );
  assertEquals(plan.testFiles, ["tests/evidence_size_test.ts", "tests/widgets_test.ts"]);
});

Deno.test("an undeclared non-TypeScript file runs the FULL suite and names itself", () => {
  const plan = planTests(["mystery/payload.bin"], NO_GRAPH, NO_NAMED);
  assertEquals(plan.testFiles, null);
  assert(plan.reason.includes("mystery/payload.bin"), plan.reason);
  assert(plan.reason.includes("DATA_LEDGER"), plan.reason);
});

Deno.test("documentation and declared-not-read files still run nothing", () => {
  assertEquals(planTests(["README.md"], NO_GRAPH, NO_NAMED).testFiles, []);
  assertEquals(planTests(["docs/observability-api.md"], NO_GRAPH, NO_NAMED).testFiles, []);
  assertEquals(planTests([".beads/issues.jsonl"], NO_GRAPH, NO_NAMED).testFiles, []);
  assertEquals(planTests([], NO_GRAPH, NO_NAMED).testFiles, []);
});

Deno.test("classifyNonTsChanges sorts every changed non-.ts file into one of the three buckets", () => {
  const classified = classifyNonTsChanges([
    "src/server.ts",
    "README.md",
    "docs/evidence/x.png",
    ".beads/issues.jsonl",
    "mystery/payload.bin",
  ]);
  assertEquals(classified.documentation, ["README.md"]);
  assertEquals(classified.suites, ["tests/evidence_size_test.ts"]);
  assertEquals(classified.unclassified, ["mystery/payload.bin"]);
});

Deno.test("the data ledger's own claims hold on this repo", async () => {
  const full = await discoverFullGateTestFiles(ROOT);
  assertEquals(await auditDataLedger(ROOT, DATA_LEDGER, full), []);

  // Bites: a suite that does not exist, and a pattern that names nothing in the tree.
  const problems = await auditDataLedger(
    ROOT,
    [
      { pattern: "docs/evidence/", readBy: ["tests/ghost_test.ts"], reason: "made up" },
      { pattern: "no/such/dir/", readBy: [], reason: "made up" },
    ],
    full,
  );
  assert(problems.some((p) => p.includes("tests/ghost_test.ts")), problems.join("; "));
  assert(problems.some((p) => p.includes("no/such/dir/")), problems.join("; "));
});

Deno.test("the evidence-ledger entry is anchored in the suite's own code, not in prose", async () => {
  // The ledger says the evidence tree is read by tests/evidence_size_test.ts. If that suite
  // stops reading it, the entry must be revisited - so the anchor is asserted here.
  const suite = await Deno.readTextFile(`${ROOT}tests/evidence_size_test.ts`);
  assert(suite.includes("evidencePngs"), "evidence_size_test.ts must still use evidencePngs()");
  const compress = await Deno.readTextFile(`${ROOT}scripts/evidence-compress.ts`);
  assert(
    /EVIDENCE_DIR\s*=\s*`\$\{import\.meta\.dirname\}\/\.\.\/docs\/evidence`/.test(compress),
    "evidence-compress.ts must still point EVIDENCE_DIR at docs/evidence",
  );
});
