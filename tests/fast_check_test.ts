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
import { nameMatchedTests, reachableTests } from "../scripts/fast-check.ts";

// A miniature of the repo's real shape: routes flow through the compose/app
// hubs into whole-app tests; the listen route additionally has direct
// importers and name-matched tests.
const GRAPH = new Map<string, string[]>([
  ["src/routes/listen.ts", ["src/compose/listen.ts", "tests/listen_reads_test.ts"]],
  ["src/compose/listen.ts", ["src/compose.ts"]],
  ["src/compose.ts", ["tests/listen_test.ts", "tests/app_test.ts"]],
  ["src/app.ts", ["tests/app_test.ts"]],
  ["src/routes/home.ts", ["src/app.ts", "tests/home_test.ts"]],
]);

Deno.test("a route change selects direct tests, not every app-booting test", () => {
  const { tests, uncovered } = reachableTests(GRAPH, ["src/routes/listen.ts"]);

  assertEquals([...tests].sort(), ["tests/listen_reads_test.ts"]);
  assertEquals(uncovered, [], "a covered change must not trigger the full-suite fallback");
});

Deno.test("the hub cut does not strand a change that only the hub sees", () => {
  // widgets.ts is imported by compose.ts but no test imports it directly and
  // no name-matched test exists: reachableTests alone must call it uncovered
  // so the runner falls back to the full suite.
  const { tests, uncovered } = reachableTests(GRAPH, ["src/routes/widgets.ts"]);

  assertEquals([...tests], []);
  assertEquals(uncovered, ["src/routes/widgets.ts"]);
});

Deno.test("scripts/ changes select no tests and are never 'uncovered'", () => {
  const { tests, uncovered } = reachableTests(GRAPH, ["scripts/smoke.ts"]);

  assertEquals([...tests], []);
  assertEquals(uncovered, [], "dev tooling is type-checked, not suite-tested");
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
