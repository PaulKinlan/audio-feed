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

import { assertEquals } from "@std/assert";
import { nameMatchedTests, planTests, reachableTests } from "../scripts/fast-check.ts";

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

Deno.test("planTests: docs-only and empty change sets run no tests", () => {
  assertEquals(planTests(["README.md"], GRAPH, NO_NAMED).testFiles, []);
  assertEquals(planTests([], GRAPH, NO_NAMED).testFiles, []);
});

Deno.test("planTests: a changed test file runs itself without the graph", () => {
  const plan = planTests(["tests/http_test.ts"], new Map(), NO_NAMED);
  assertEquals(plan.testFiles, ["tests/http_test.ts"]);
});

Deno.test("planTests: the bqd4 repro — changing the selection algorithm runs its own tests", () => {
  const plan = planTests(
    ["scripts/fast-check.ts"],
    new Map([["scripts/fast-check.ts", ["tests/fast_check_test.ts"]]]),
    new Map(),
  );

  assertEquals(plan.testFiles, ["tests/fast_check_test.ts"], "must NOT select zero");
});
