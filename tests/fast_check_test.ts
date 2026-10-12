/**
 * audio-feed-pubd — the fast tier's selection logic.
 *
 * These pin the two rules a broken "optimisation" would silently walk back:
 * the hub cut (without it a route change selects every app-booting test and
 * the tier saves nothing) and the name-convention backstop (without it the
 * route's OWN test, which boots the app through the hub, is deselected).
 * The scripts/ exemption matters too: a proof-script change must not pay for
 * the suite it can never affect.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  allTestFiles,
  extractFailingTests,
  failureMarkers,
  formatFailureOutput,
  nameMatchedTests,
  planTests,
  reachableTests,
  run,
  suiteMarker,
} from "../scripts/fast-check.ts";

// A miniature of the repo's real shape: routes flow through the compose/app
// hubs into whole-app tests; the listen route additionally has direct
// importers and name-matched tests.
const GRAPH = new Map<string, string[]>([
  ["src/routes/listen.ts", ["src/compose/listen.ts", "tests/listen_reads_test.ts"]],
  ["src/compose/listen.ts", ["src/compose.ts"]],
  ["src/compose.ts", ["tests/listen_test.ts", "tests/app_test.ts"]],
  ["src/app.ts", ["tests/app_test.ts"]],
  ["src/routes/home.ts", ["src/app.ts", "tests/home_test.ts"]],
  // widgets.ts is reachable ONLY through the hub: the walk must refuse to
  // cross into app.ts and must report the file uncovered.
  ["src/routes/widgets.ts", ["src/app.ts"]],
  // A TESTED script: its change must select the test (audio-feed-bqd4).
  ["scripts/tool.ts", ["tests/tool_test.ts"]],
  // A script imported only by another script: importers exist, no test
  // reaches it — cannot be scoped safely.
  ["scripts/helper.ts", ["scripts/other.ts"]],
  // scripts/standalone.ts has no entry: nothing imports it at all.
]);

Deno.test("a route change selects direct tests, not every app-booting test", () => {
  const { tests, uncovered } = reachableTests(GRAPH, ["src/routes/listen.ts"]);

  assertEquals([...tests].sort(), ["tests/listen_reads_test.ts"]);
  assertEquals(uncovered, [], "a covered change must not trigger the full-suite fallback");
});

Deno.test("the hub cut does not strand a change that only the hub sees", () => {
  const { tests, uncovered } = reachableTests(GRAPH, ["src/routes/widgets.ts"]);

  assertEquals([...tests], [], "app_test boots the app but never exercises widgets");
  assertEquals(uncovered, ["src/routes/widgets.ts"]);
});

Deno.test("a TESTED script change selects its importing test (bqd4)", () => {
  const { tests, uncovered } = reachableTests(GRAPH, ["scripts/tool.ts"]);

  assertEquals([...tests], ["tests/tool_test.ts"]);
  assertEquals(uncovered, []);
});

Deno.test("a script with importers but no reachable test falls back to full", () => {
  const { tests, uncovered } = reachableTests(GRAPH, ["scripts/helper.ts"]);

  assertEquals([...tests], []);
  assertEquals(uncovered, ["scripts/helper.ts"], "a guess is not a proof");
});

Deno.test("a script NOTHING imports is exempt — zero tests is correct", () => {
  const { tests, uncovered } = reachableTests(GRAPH, ["scripts/standalone.ts"]);

  assertEquals([...tests], []);
  assertEquals(uncovered, [], "the always-run type-check is a standalone tool's gate");
});

Deno.test("a changed test file runs itself", () => {
  const { tests, uncovered } = reachableTests(GRAPH, ["tests/http_test.ts"]);

  assertEquals([...tests], ["tests/http_test.ts"]);
  assertEquals(uncovered, []);
});

Deno.test("the name convention finds the route's own whole-app test", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/tests/auth`, { recursive: true });
    await Deno.writeTextFile(`${dir}/tests/listen_test.ts`, "");
    await Deno.writeTextFile(`${dir}/tests/listen_filter_test.ts`, "");
    await Deno.writeTextFile(`${dir}/tests/listening_test.ts`, ""); // decoy: prefix is not stem
    await Deno.writeTextFile(`${dir}/tests/auth/passkeys_test.ts`, "");

    const matched = await nameMatchedTests(
      ["src/routes/listen.ts", "src/auth/passkeys.ts"],
      `${dir}/tests`,
    );

    assertEquals(
      (matched.get("src/routes/listen.ts") ?? []).sort(),
      ["tests/listen_filter_test.ts", "tests/listen_test.ts"],
      "the stem rule, and not the bare prefix, matches",
    );
    assertEquals(
      matched.get("src/auth/passkeys.ts"),
      ["tests/auth/passkeys_test.ts"],
      "the mirrored subdirectory matches",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// planTests: every fallback class, pinned
// ---------------------------------------------------------------------------

const NO_NAMED = new Map<string, string[]>();

Deno.test("planTests: a graph-uncovered file rescued by a name-matched test", () => {
  // widgets.ts is uncovered by the graph (hub-only), but a widgets_test.ts
  // exists by convention: covered, selected, no full-suite fallback.
  const named = new Map([["src/routes/widgets.ts", ["tests/widgets_test.ts"]]]);
  const plan = planTests(["src/routes/widgets.ts"], GRAPH, named);

  assertEquals(plan.testFiles, ["tests/widgets_test.ts"]);
});

Deno.test("planTests: graph-uncovered with NO name match falls back to the full suite", () => {
  const plan = planTests(["src/routes/widgets.ts"], GRAPH, NO_NAMED);
  assertEquals(plan.testFiles, null);
});

Deno.test("planTests: deno.json, a core file, a test helper, and a non-ts asset all fall back", () => {
  for (
    const changed of [
      ["deno.json"],
      ["deno.lock"],
      ["src/router.ts"],
      ["src/app.ts"],
      ["src/compose/access.ts"],
      ["tests/fixtures.ts"],
      ["src/assets/listen.js"],
      ["tests/fixtures/page.html"],
    ]
  ) {
    const plan = planTests(changed, GRAPH, NO_NAMED);
    assertEquals(plan.testFiles, null, `${changed} must run the full suite: ${plan.reason}`);
  }
});

Deno.test("planTests: docs-only runs nothing; an EMPTY change set runs the full suite (es8y)", () => {
  // Markdown with no DERIVED reader is the one legal empty selection - and the gate says so loudly instead
  // of reading like a pass (audio-feed-es8y). audio-feed-r9fe removed the declarations, so markdown is the
  // only inert class left; a tooling path (.beads/, .github/, .gitignore) now runs the full suite.
  const docs = planTests(["README.md"], GRAPH, NO_NAMED);
  assertEquals(docs.testFiles, []);
  assert(docs.reason.includes("inert, no suite is derived to read it"), docs.reason);

  // An empty change set proves nothing about anything, so it is NOT inert: it gets the full suite. This
  // used to select zero suites, which is exactly the shape that reads as a green test run.
  assertEquals(planTests([], GRAPH, NO_NAMED).testFiles, null);
});

Deno.test("planTests: a changed test file runs itself and the relation-policing suite (audio-feed-x4kc)", () => {
  const plan = planTests(["tests/http_test.ts"], new Map(), NO_NAMED);
  assertEquals(plan.testFiles, ["tests/fast_gate_subset_test.ts", "tests/http_test.ts"]);
});

Deno.test("planTests: audio-feed-x4kc — a changed test file always selects tests/fast_gate_subset_test.ts", () => {
  // A test-only change (like fnrp's edit to tests/evidence_size_test.ts) can alter what a suite reads,
  // changing the derived read relation without touching test-selection.ts.
  // Rule (a) guarantees that tests/fast_gate_subset_test.ts is always selected so the relation invariants
  // are never blindly bypassed.
  const plan = planTests(["tests/evidence_size_test.ts"], new Map(), NO_NAMED);
  assertEquals(
    plan.testFiles,
    ["tests/evidence_size_test.ts", "tests/fast_gate_subset_test.ts"],
    "Must select the changed test and the relation-policing suite fast_gate_subset_test.ts",
  );
});

Deno.test("planTests: the bqd4 repro — changing the selection algorithm runs its own tests", () => {
  const plan = planTests(
    ["scripts/fast-check.ts"],
    new Map([["scripts/fast-check.ts", ["tests/fast_check_test.ts"]]]),
    new Map(),
  );

  assertEquals(plan.testFiles, ["tests/fast_check_test.ts"], "must NOT select zero");
});

// ---------------------------------------------------------------------------------------------
// audio-feed-dywc: the suite marker the fleet's coverage reporter parses
// ---------------------------------------------------------------------------------------------

Deno.test("the suite marker matches the shape the fleet reporter parses (dywc)", () => {
  // The reporter's own pattern, copied from remote/check-coverage.py:257-258. If this stops matching,
  // every lane's coverage report goes back to reporting false "unmapped" files.
  const reporter = /fast-gate:.*?(?:passed|completed):\s*(.*)/;
  const line = suiteMarker("passed", ["tests/a_test.ts", "tests/b_test.ts"]);
  const m = reporter.exec(line);
  assert(m !== null, `the reporter must recognise this line: ${line}`);
  assertEquals(m![1]!.split(/\s+/), ["tests/a_test.ts", "tests/b_test.ts"]);
});

Deno.test("a failing run never claims to have passed (dywc)", () => {
  const line = suiteMarker("ran", ["tests/a_test.ts"]);
  assert(!/passed/.test(line), `a failed run must not claim a pass: ${line}`);
  assert(line.startsWith("fast-gate: ran:"), line);
});

Deno.test("the gate actually emits the marker on both success paths (dywc)", async () => {
  // A source-level assertion, deliberately: running the script from a test would recurse into the suite.
  // It bites when the emission is deleted, which is the regression that matters - the marker being
  // present in the helper but never called was exactly the bug being fixed.
  const src = await Deno.readTextFile(new URL("../scripts/fast-check.ts", import.meta.url));
  // console.log matters: matching the symbol alone also matches a call whose result is discarded, which
  // is how the first version of this test failed to bite when the emission was deleted.
  const passed = src.match(/console\.log\(suiteMarker\("passed"/g) ?? [];
  const ran = src.match(/console\.log\(suiteMarker\("ran"/g) ?? [];
  assertEquals(passed.length, 2, "both the FULL and the scoped path must emit passed");
  assertEquals(ran.length, 2, "and both failure paths must emit ran rather than staying silent");
  const files = await allTestFiles();
  assert(
    files.length > 0 && files.every((f) => f.startsWith("tests/")),
    "paths must be repo-relative",
  );
  assert(files.includes("tests/fast_check_test.ts"), "and must include real test files");
});

// ---------------------------------------------------------------------------------------------
// audio-feed-dq08: hyphen-to-underscore normalization pins
// ---------------------------------------------------------------------------------------------

Deno.test("the name convention normalises hyphen and underscore both ways (dq08)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    await Deno.writeTextFile(`${dir}/tests/fast_check_test.ts`, "");
    await Deno.writeTextFile(`${dir}/tests/other-tool_test.ts`, "");

    // 1. fast-check (hyphen) -> fast_check_test (underscore)
    const matchedHyphen = await nameMatchedTests(
      ["scripts/fast-check.ts"],
      `${dir}/tests`,
    );
    assertEquals(
      matchedHyphen.get("scripts/fast-check.ts"),
      ["tests/fast_check_test.ts"],
      "hyphenated source maps to underscored test",
    );

    // 2. other_tool (underscore) -> other-tool_test (hyphen)
    const matchedUnderscore = await nameMatchedTests(
      ["scripts/other_tool.ts"],
      `${dir}/tests`,
    );
    assertEquals(
      matchedUnderscore.get("scripts/other_tool.ts"),
      ["tests/other-tool_test.ts"],
      "underscored source maps to hyphenated test",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the fleet reporter stem normalization matches both ways (dq08)", () => {
  // Pins the reporter's normalize_stem_variants contract from check-coverage.py
  const normalize = (st: string) => {
    const variants = new Set([st]);
    if (st.includes("-")) variants.add(st.replace(/-/g, "_"));
    if (st.includes("_")) variants.add(st.replace(/_/g, "-"));
    const names = new Set<string>();
    for (const v of variants) {
      names.add(v);
      names.add(`test_${v}`);
      names.add(`${v}_test`);
      names.add(`test-${v}`);
      names.add(`${v}-test`);
      names.add(`${v}.test`);
      names.add(`${v}.spec`);
    }
    return names;
  };

  // Hyphen to underscore
  const hyphenSource = normalize("fast-check");
  assert(hyphenSource.has("fast_check_test"), "fast-check must match fast_check_test");
  assert(hyphenSource.has("test_fast_check"), "fast-check must match test_fast_check");

  // Underscore to hyphen
  const underscoreSource = normalize("fast_check");
  assert(underscoreSource.has("fast-check_test"), "fast_check must match fast-check_test");
  assert(underscoreSource.has("test-fast-check"), "fast_check must match test-fast-check");
});

// ---------------------------------------------------------------------------------------------
// audio-feed-pkv1: failure output streams and failing test attribution
// ---------------------------------------------------------------------------------------------

Deno.test("formatFailureOutput includes both stdout and stderr with stdout first (pkv1)", () => {
  const stdout =
    "test_failure_on_stdout ... FAILED\n\n ERRORS \n\ntest_failure_on_stdout => ./tests/example_test.ts:1:1";
  const stderr = "error: Test failed";

  const outBoth = formatFailureOutput(stdout, stderr);
  assert(outBoth.includes("test_failure_on_stdout ... FAILED"));
  assert(outBoth.includes("error: Test failed"));
  assert(
    outBoth.indexOf("test_failure_on_stdout") < outBoth.indexOf("error: Test failed"),
    "stdout must come before stderr so test failure reports precede error notes",
  );

  // Single-stream edge cases
  assertEquals(formatFailureOutput(stdout, ""), stdout);
  assertEquals(formatFailureOutput("", stderr), stderr);
  assertEquals(formatFailureOutput("", ""), "");
});

Deno.test("run includes STDOUT in failure output when a command fails (pkv1)", async () => {
  const logged: string[] = [];
  const res = await run(
    ["deno", "eval", "console.log('RECOGNISABLE_TEST_FAILURE_ON_STDOUT'); Deno.exit(1);"],
    { onOutput: (msg) => logged.push(msg) },
  );

  assertEquals(res.code, 1, "command must exit non-zero on failure");
  const combined = logged.join("\n");
  assert(
    combined.includes("RECOGNISABLE_TEST_FAILURE_ON_STDOUT"),
    `failure output must preserve stdout; got: ${JSON.stringify(combined)}`,
  );
});

Deno.test("run preserves STDERR alongside STDOUT on command failure (pkv1)", async () => {
  const logged: string[] = [];
  const res = await run(
    [
      "deno",
      "eval",
      "console.log('STDOUT_REPORT'); console.error('STDERR_DEBUG'); Deno.exit(1);",
    ],
    { onOutput: (msg) => logged.push(msg) },
  );

  assertEquals(res.code, 1);
  const combined = logged.join("\n");
  assert(combined.includes("STDOUT_REPORT"), "must contain stdout report");
  assert(combined.includes("STDERR_DEBUG"), "must contain stderr debug output");
  assert(
    combined.indexOf("STDOUT_REPORT") < combined.indexOf("STDERR_DEBUG"),
    "stdout must precede stderr",
  );
});

Deno.test("run remains completely quiet on success (pkv1)", async () => {
  const logged: string[] = [];
  const res = await run(
    ["deno", "eval", "console.log('SHOULD_NOT_LEAK'); Deno.exit(0);"],
    { onOutput: (msg) => logged.push(msg) },
  );

  assertEquals(res.code, 0, "successful command must return 0");
  assertEquals(logged, [], "success path must not print stdout or stderr");
});

Deno.test("extractFailingTests parses Deno test summary FAILURES block (pkv1)", () => {
  const sample = `
running 2 tests from ./tests/account_test.ts
account creation passes ... ok (1ms)
account deletion fails ... FAILED (2ms)

 ERRORS 

account deletion fails => ./tests/account_test.ts:42:6
error: AssertionError: Values not equal
  throw new AssertionError();
        ^

 FAILURES 

account deletion fails => ./tests/account_test.ts:42:6

FAILED | 1 passed | 1 failed (5ms)
`;

  const parsed = extractFailingTests(sample);
  assertEquals(parsed, [
    { name: "account deletion fails", file: "tests/account_test.ts" },
  ]);

  const markers = failureMarkers(sample, ["tests/account_test.ts"]);
  assertEquals(markers, [
    "fast-gate: failed: tests/account_test.ts (account deletion fails)",
  ]);
});

Deno.test("extractFailingTests parses uncaught module error in FAILURES block (pkv1)", () => {
  const sample = `
Uncaught error from ./tests/corrupt_test.ts FAILED

 ERRORS 

./tests/corrupt_test.ts (uncaught error)
error: top level boom

 FAILURES 

./tests/corrupt_test.ts (uncaught error)

FAILED | 0 passed | 1 failed
`;

  const parsed = extractFailingTests(sample);
  assertEquals(parsed, [
    { name: "(uncaught error)", file: "tests/corrupt_test.ts" },
  ]);

  const markers = failureMarkers(sample);
  assertEquals(markers, [
    "fast-gate: failed: tests/corrupt_test.ts ((uncaught error))",
  ]);
});

Deno.test("extractFailingTests falls back to inline failure when summary block is missing (pkv1)", () => {
  const sample = `
running 1 test from ./tests/interrupted_test.ts
interrupted test case ... FAILED (10ms)
`;

  const parsed = extractFailingTests(sample);
  assertEquals(parsed, [{ name: "interrupted test case" }]);

  const markers = failureMarkers(sample, ["tests/interrupted_test.ts"]);
  assertEquals(markers, [
    "fast-gate: failed: tests/interrupted_test.ts (interrupted test case)",
  ]);
});

Deno.test("failureMarkers emits unextracted diagnostic without fragile heuristics (pkv1)", () => {
  // Single suite known
  assertEquals(
    failureMarkers("", ["tests/single_test.ts"]),
    ["fast-gate: failed: tests/single_test.ts (unextracted test)"],
  );

  // Multiple suites (cannot guess)
  assertEquals(
    failureMarkers("", ["tests/a_test.ts", "tests/b_test.ts"]),
    ["fast-gate: failed: (unextracted test)"],
  );
});

Deno.test("the gate emits failureMarkers in the tail on both test failure paths (pkv1)", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/fast-check.ts", import.meta.url));
  const failureCalls = src.match(/for \(const \w+ of failureMarkers\(/g) ?? [];
  assertEquals(
    failureCalls.length,
    2,
    "both the FULL and the scoped failure paths must emit failure markers in the tail",
  );
});

// ---------------------------------------------------------------------------
// audio-feed-psjb: the fleet's coverage NOTE must never turn "I could not tell"
// into "nothing ran". These tests encode the REPORTER'S parse rules in-repo,
// because a rule that lives only in another repository drifts silently - and it
// already did: the reporter matches `unmapped:` ANYWHERE in a line, so a test
// NAME was harvested as a list of changed files.
// ---------------------------------------------------------------------------

/** The reporter's rules as they stand today (`remote/check-coverage.py`: `passed|completed` and `unmapped`
 * matched anywhere in a line), PLUS the uniform `coverage:` marker this gate now emits on every path. */
function coverageNoteFromLog(log: string): string {
  const executed = new Set<string>();
  let unknown: string | null = null;
  let none: string | null = null;
  for (const line of log.split("\n")) {
    const passed = /fast-gate:.*?(?:passed|completed):\s*(.*)/.exec(line);
    if (passed) { for (const f of passed[1]!.split(/\s+/)) if (f) executed.add(f); }
    const uniform = /^fast-gate: coverage:\s*(.*)$/.exec(line);
    if (uniform) {
      const payload = uniform[1]!.trim();
      if (payload.startsWith("UNKNOWN")) unknown = payload;
      else if (/^ran 0 suite\(s\)/.test(payload)) none = payload;
      else {
        // One dialect for one concept: the marker's executed case uses the RUNNER'S OWN wording
        // (`coverage: ran N suite(s): <files>`), so the parse is a parse of the vocabulary the fleet
        // already prints - not a second phrasing invented for the same fact (coord, audio-feed-psjb).
        const ran = /^ran (\d+) suite\(s\)(?::\s*(.*))?$/.exec(payload);
        if (ran) { for (const f of (ran[2] ?? "").split(/\s+/)) if (f) executed.add(f); }
      }
    }
  }
  if (unknown) return `no information: ${unknown}`;
  if (none) return `no suites ran: ${none}`;
  if (executed.size === 0) return "0 suite(s) ran";
  return `${executed.size} suite(s) ran: ${[...executed].sort().join(" ")}`;
}

/** The OLD rule, kept so the mutation is a function rather than a claim: only the passing marker counts. */
function coverageNoteWithPassedOnlyRule(log: string): string {
  const executed = new Set<string>();
  for (const line of log.split("\n")) {
    const passed = /fast-gate:.*?(?:passed|completed):\s*(.*)/.exec(line);
    if (passed) { for (const f of passed[1]!.split(/\s+/)) if (f) executed.add(f); }
  }
  return executed.size === 0 ? "0 suite(s) ran" : `${executed.size} suite(s) ran`;
}

Deno.test("psjb: a FAILING run's coverage note names the suites that ran, not zero", () => {
  const failingLog = [
    "fast-gate: selection audit ok: 103 full-gate module(s), 103 fast-selectable",
    "fast-check: 2 test file(s) (affected by: src/a.ts, tests/b_test.ts)",
    "fast-gate: ran: tests/a_test.ts tests/b_test.ts",
    "fast-gate: failed: tests/b_test.ts (some assertion)",
    "fast-gate: coverage: ran 2 suite(s): tests/a_test.ts tests/b_test.ts",
  ].join("\n");

  // The uniform marker means the same thing after a failure as after a pass: these suites EXECUTED.
  assertEquals(
    coverageNoteFromLog(failingLog),
    "2 suite(s) ran: tests/a_test.ts tests/b_test.ts",
  );

  // The marker speaks the RUNNER'S dialect for the executed case - `ran N suite(s)` - so a reader who has
  // seen the fleet's own coverage line does not have to learn a second phrasing for the same fact.
  const markerLine = failingLog.split("\n").find((l) => l.startsWith("fast-gate: coverage:"))!;
  assertMatch(markerLine, /^fast-gate: coverage: ran \d+ suite\(s\)(: .+)?$/);

  // MUTATION, as a function: the old passed|completed-only rule reports ZERO suites for the same log,
  // which is exactly the defect this bead is about - an inability to know rendered as a zero.
  assertEquals(coverageNoteWithPassedOnlyRule(failingLog), "0 suite(s) ran");
});

Deno.test("psjb: a gate that never reached the harness says NO INFORMATION, not zero suites", () => {
  // A lint failure means the note has no information rather than no coverage; saying so is what stops a
  // lane reading "unmapped: everything" after a lint error and hunting a coverage bug that does not exist.
  const stoppedLog = [
    "fast-gate: failed: lint",
    "fast-gate: coverage: UNKNOWN - the gate stopped before the test harness: lint",
  ].join("\n");
  const note = coverageNoteFromLog(stoppedLog);
  assert(note.startsWith("no information:"), note);
  assert(note.includes("lint"), note);
  assertEquals(note.includes("0 suite"), false, "an unknown must never be rendered as a zero");

  // And the inert case is a THIRD state: the harness ran and selected nothing, which is a fact.
  const noneLog = [
    "fast-check: NO SUITES SELECTED — 0 of 103 test module(s) ran.",
    "fast-gate: unmapped: README.md",
    "fast-gate: coverage: ran 0 suite(s) - no suite observes the changed files",
  ].join("\n");
  const noneNote = coverageNoteFromLog(noneLog);
  assert(noneNote.startsWith("no suites ran:"), noneNote);
  // Here a ZERO is a fact rather than an inability to know, so the note says zero AND says why: the harness
  // ran and selected nothing. That is the whole difference between this state and the UNKNOWN one above.
  assert(noneNote.includes("0 suite"), noneNote);
  assert(noneNote.includes("no suite observes"), noneNote);
});

Deno.test("psjb: the uniform marker is emitted on EVERY path, not only the passing one", () => {
  // The gate must not require the reader to infer the state from an ABSENT line: every exit emits it.
  const source = Deno.readTextFileSync(new URL("../scripts/fast-check.ts", import.meta.url));
  const emissions = source.match(/console\.log\(\s*coverageMarker\(/g) ?? [];
  assertEquals(
    emissions.length,
    5,
    "pass/fail for both paths, and the inert case",
  );
  // The consumed contract stays intact: passed:/ran: are still emitted where they always were.
  assertEquals((source.match(/console\.log\(\s*suiteMarker\("passed"/g) ?? []).length, 2);
  assertEquals((source.match(/console\.log\(\s*suiteMarker\("ran"/g) ?? []).length, 2);
});
