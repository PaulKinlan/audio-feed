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
  changedFiles,
  classifyChangedFileCoverage,
  detectStaleRun,
  evaluateGateCoverageRecord,
  extractExecutedSuitesFromLog,
  extractFailingTests,
  failureMarkers,
  findCandidateTestsForFile,
  findHiddenTrackedMutations,
  formatCheckStep,
  formatFailureOutput,
  hasExecReference,
  hasImportReference,
  ignoredSummary,
  nameMatchedTests,
  planTests,
  reachableTests,
  reverseGraph,
  run,
  staleMarker,
  stripCapturedTestOutput,
  suiteMarker,
  testSuiteSummary,
  withoutRouteAuditFixture,
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

Deno.test("hqer: known route and logger changes select their behaviour suites without crossing hubs", async () => {
  const dir = await Deno.makeTempDir();
  const paths = [
    "src/routes/observability.ts",
    "src/log.ts",
    "src/routes/admin_issues.ts",
    "src/routes/admin_subscribers.ts",
  ] as const;
  const expected = new Map([
    [paths[0], "tests/observability_api_test.ts"],
    [paths[1], "tests/log_test.ts"],
    [paths[2], "tests/admin_subpages_test.ts"],
    [paths[3], "tests/admin_subpages_test.ts"],
  ]);
  const graph = new Map<string, string[]>(paths.map((path) => [path, ["src/compose.ts"]]));
  try {
    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    for (const suite of new Set(expected.values())) {
      await Deno.writeTextFile(`${dir}/${suite}`, "");
    }
    const matched = await nameMatchedTests([...paths], `${dir}/tests`);
    for (const path of paths.slice(2)) {
      assertEquals(
        matched.get(path),
        ["tests/admin_subpages_test.ts"],
        "missing optional WebMCP reader is not invented",
      );
    }
    for (const [path, suite] of expected) {
      assert(
        matched.get(path)?.includes(suite),
        `${path} must remain mapped to a present suite exercising its actual behaviour`,
      );
      const plan = planTests([path], graph, matched);
      assert(
        plan.testFiles?.includes(suite),
        `${path} must select ${suite}, not widen: ${plan.reason}`,
      );
    }

    // The separate WebMCP branch adds a second real reader of both admin forms.
    // Select it once present without requiring that branch to land before this fix.
    await Deno.writeTextFile(`${dir}/tests/webmcp_admin_forms_test.ts`, "");
    const withWebmcp = await nameMatchedTests([paths[2], paths[3]], `${dir}/tests`);
    for (const path of paths.slice(2)) {
      assertEquals(
        withWebmcp.get(path)?.sort(),
        ["tests/admin_subpages_test.ts", "tests/webmcp_admin_forms_test.ts"],
      );
    }
    await Deno.remove(`${dir}/tests/webmcp_admin_forms_test.ts`);

    // Never mistake a removed target test or an unrecognised route for a narrow green run.
    await Deno.remove(`${dir}/tests/admin_subpages_test.ts`);
    const missing = await nameMatchedTests([paths[2], paths[3]], `${dir}/tests`);
    for (const path of paths.slice(2)) {
      assertEquals(missing.has(path), false, "missing map target is not treated as coverage");
      assertEquals(
        planTests([path], graph, missing).testFiles,
        null,
        "no present reader means FULL",
      );
    }
    assertEquals(planTests(["src/routes/unmapped.ts"], graph, matched).testFiles, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("hqer: the real repo graph selects the admin route's exercising suite, not everything", async () => {
  const paths = [
    "src/routes/observability.ts",
    "src/log.ts",
    "src/routes/admin_issues.ts",
    "src/routes/admin_subscribers.ts",
  ];
  const reverse = await reverseGraph();
  const selectedFor = async (path: string) =>
    planTests([path], reverse, await nameMatchedTests([path])).testFiles;
  // These two were ALREADY graph-reachable; a host reporter's "unmapped" warning
  // must not be mistaken for the selector's "no test reaches" full-suite fallback.
  assert(reverse.get("src/routes/observability.ts")?.includes("tests/observability_api_test.ts"));
  assert(reverse.get("src/log.ts")?.includes("tests/log_test.ts"));
  for (const path of paths) {
    const selected = await selectedFor(path);
    assert(selected !== null, `${path} must not widen to the full suite`);
  }
  for (const path of paths.slice(2)) {
    const selected = await selectedFor(path);
    assert(selected !== null, `${path} must not widen`);
    assert(
      selected.includes("tests/admin_subpages_test.ts"),
      `${path} must run its HTTP route test`,
    );
    assert(selected.length < 20, `${path} should not consume the full suite: ${selected.length}`);
  }
  assert(
    (await selectedFor("src/routes/observability.ts"))?.includes("tests/observability_api_test.ts"),
  );
  assert((await selectedFor("src/log.ts"))?.includes("tests/log_test.ts"));
});

Deno.test("abh1: route registrations discover the complete HTTP test set before narrowing", async () => {
  const app = await Deno.readTextFile(new URL("../src/app.ts", import.meta.url));
  const accountRoutes = [
    ...app.matchAll(/router\.(?:get|post|delete)\("([^"]+)", account\("[^"]+"\)\);/g),
  ]
    .map((match) => match[1]!);
  assert(accountRoutes.length > 0, "no account() route registrations were discovered");
  for (
    const [method, path, handler] of [
      ["get", "/login", "handleLogin"],
      ["get", "/admin/observability/telemetry", "handleAdminTelemetry"],
      ["get", "/.well-known/webauthn", "handleWebAuthnRelatedOrigins"],
    ]
  ) {
    assert(
      app.includes(`router.${method}("${path}", ${handler})`),
      `route ownership moved: ${path}`,
    );
  }
  assert(app.includes('router.post("/api/reports/csp", handlers.cspReports ?? handleCspReports)'));

  const spec = [
    {
      file: "src/routes/account_api.ts",
      exercises: [
        "tests/account_regenerate_test.ts",
        "tests/admin_throttle_test.ts",
        "tests/auth_routes_test.ts",
        "tests/feed_discovery_test.ts",
        "tests/webmcp_admin_forms_test.ts",
      ],
      mentionsOnly: [],
      mentions: (source: string) =>
        accountRoutes.some((path) =>
          source.includes(path.includes(":") ? path.slice(0, path.indexOf(":")) : path)
        ),
    },
    {
      file: "src/routes/login.ts",
      exercises: [
        "tests/account_pages_test.ts",
        "tests/security_audit_test.ts",
        "tests/speculation_rules_test.ts",
      ],
      mentionsOnly: [
        "tests/admin_session_test.ts",
        "tests/auth_routes_test.ts",
        "tests/bookmarklet_test.ts",
        "tests/csp_reporting_test.ts",
        "tests/home_test.ts",
        "tests/origin_test.ts",
        "tests/share_target_test.ts",
      ],
      // The non-HTTP references above are links, redirect assertions, or a Host-gate 421 before the handler.
      mentions: (source: string) => /(?<!\/api\/auth)\/login(?=[/?#"'`])/.test(source),
    },
    {
      file: "src/routes/admin_telemetry.ts",
      exercises: ["tests/admin_subpages_test.ts"],
      mentionsOnly: [],
      mentions: (source: string) => source.includes("/admin/observability/telemetry"),
    },
    {
      file: "src/routes/webauthn.ts",
      exercises: ["tests/passkeys_test.ts"],
      mentionsOnly: [],
      mentions: (source: string) => source.includes("/.well-known/webauthn"),
    },
    {
      file: "src/routes/reports.ts",
      exercises: ["tests/csp_reporting_test.ts"],
      mentionsOnly: ["tests/admin_subpages_test.ts"], // seeded report log; no POST to handler
      mentions: (source: string) => source.includes("/api/reports/csp"),
    },
  ];
  // Exclude only THIS audit's URL-literal fixture block, never the entire file:
  // a future real HTTP test in fast_check_test.ts must still become a candidate.
  const discovered = await allTestFiles();
  assert(discovered.length > 0, "full-gate test discovery returned ZERO modules");
  const sources = new Map<string, string>();
  for (const file of discovered) {
    sources.set(file, withoutRouteAuditFixture(file, await Deno.readTextFile(file)));
  }
  assert(sources.size > 0, "route-reference audit examined ZERO test modules");
  assertEquals(
    sources.size,
    discovered.length,
    `route-reference audit examined ${sources.size}/${discovered.length} discovered test modules; no duplicate or dropped module may yield a clean scan`,
  );
  const population =
    `${accountRoutes.length} account routes; ${sources.size}/${discovered.length} discovered test modules examined (only this audit's fixture block redacted)`;
  console.log(`route-reference audit: ${population}`);
  const self = await Deno.readTextFile(new URL("./fast_check_test.ts", import.meta.url));
  const futureHandlerRequest = self +
    '\nDeno.test("new login reader", async () => await fetch(new Request("https://example.test/login")));\n';
  assert(
    /(?<!\/api\/auth)\/login(?=[/?#"'`])/.test(
      withoutRouteAuditFixture("tests/fast_check_test.ts", futureHandlerRequest),
    ),
    "a future HTTP test in the same module must remain visible outside the fixture block",
  );
  for (const path of accountRoutes) {
    const stem = path.includes(":") ? path.slice(0, path.indexOf(":")) : path;
    assert(
      [...sources.values()].some((source) => source.includes(stem)),
      `${population}: new account route ${path} has NO test candidate; do not narrow until one exercises it`,
    );
  }
  for (const route of spec) {
    const candidates = [...sources].filter(([, source]) => route.mentions(source))
      .map(([file]) => file).sort();
    assert(
      route.exercises.length > 0 && route.exercises.some((file) => candidates.includes(file)),
      `${population}: ${route.file} has no exercising candidate suite; do not narrow`,
    );
    assertEquals(
      candidates,
      [...route.exercises, ...route.mentionsOnly].sort(),
      `${population}: ${route.file} has a new or missing URL reference; audit its real handler before narrowing`,
    );
    const named = await nameMatchedTests([route.file]);
    assertEquals(
      (named.get(route.file) ?? []).sort(),
      candidates,
      `${population}: ${route.file} must select the entire URL candidate UNION, including mention-only suites that could grow real handler tests`,
    );
  }
});

Deno.test("wb7h: conservative URL candidate union includes existing mention-only modules", async () => {
  const reverse = await reverseGraph();
  const login = "src/routes/login.ts";
  const reports = "src/routes/reports.ts";
  const loginPlan = planTests([login], reverse, await nameMatchedTests([login]));
  const reportsPlan = planTests([reports], reverse, await nameMatchedTests([reports]));
  assert(
    loginPlan.testFiles?.includes("tests/bookmarklet_test.ts"),
    "a new login exerciser within bookmarklet_test.ts must not be silently omitted",
  );
  assert(
    reportsPlan.testFiles?.includes("tests/admin_subpages_test.ts"),
    "a future CSP-report handler test inside this already-mentioned module must run",
  );
});

const VFE9_EXERCISING_SUITES = [
  ["src/routes/admin_telemetry.ts", ["tests/admin_subpages_test.ts"]],
  ["src/routes/login.ts", [
    "tests/account_pages_test.ts",
    "tests/security_audit_test.ts",
    "tests/speculation_rules_test.ts",
  ]],
  ["src/routes/account_api.ts", [
    "tests/account_regenerate_test.ts",
    "tests/admin_throttle_test.ts",
    "tests/auth_routes_test.ts",
    "tests/feed_discovery_test.ts",
    "tests/webmcp_admin_forms_test.ts",
  ]],
  ["src/routes/webauthn.ts", ["tests/passkeys_test.ts"]],
  ["src/routes/reports.ts", ["tests/csp_reporting_test.ts"]],
] as const;

Deno.test("vfe9: five hub-cut routes select all present HTTP readers or widen when none remain", async () => {
  const dir = await Deno.makeTempDir();
  const paths = VFE9_EXERCISING_SUITES.map(([path]) => path);
  const graph = new Map<string, string[]>(paths.map((path) => [path, ["src/app.ts"]]));
  try {
    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    for (const [, suites] of VFE9_EXERCISING_SUITES) {
      for (const suite of suites) await Deno.writeTextFile(`${dir}/${suite}`, "");
    }
    for (const [path, suites] of VFE9_EXERCISING_SUITES) {
      const named = await nameMatchedTests([path], `${dir}/tests`);
      assertEquals(
        named.get(path)?.sort(),
        [...suites].sort(),
        `${path} must name ALL present readers`,
      );
      assertEquals(planTests([path], graph, named).testFiles, [...suites].sort());

      // A lost reader cannot remain listed as covered. Other existing readers still run;
      // once every reader is gone, the route must widen to FULL, never a narrow green.
      for (const missingSuite of suites) {
        await Deno.remove(`${dir}/${missingSuite}`);
        const remaining = [...suites].filter((suite) => suite !== missingSuite).sort();
        const withoutOne = await nameMatchedTests([path], `${dir}/tests`);
        assertEquals(withoutOne.get(path)?.sort(), remaining.length ? remaining : undefined);
        assertEquals(
          planTests([path], graph, withoutOne).testFiles,
          remaining.length ? remaining : null,
        );
        await Deno.writeTextFile(`${dir}/${missingSuite}`, "");
      }
      for (const suite of suites) await Deno.remove(`${dir}/${suite}`);
      const none = await nameMatchedTests([path], `${dir}/tests`);
      assertEquals(none.has(path), false);
      assertEquals(planTests([path], graph, none).testFiles, null);
      for (const suite of suites) await Deno.writeTextFile(`${dir}/${suite}`, "");
    }
    assertEquals(planTests(["src/routes/new_unmapped.ts"], graph, new Map()).testFiles, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wb7h: an added URL reader is selected, including within an already-mentioned module", async () => {
  const dir = await Deno.makeTempDir();
  const login = "src/routes/login.ts";
  const newSuite = "tests/new_candidate_test.ts";
  const mentioned = "tests/bookmarklet_test.ts";
  const url = "/lo" + "gin"; // Do not make this selector test itself a route candidate.
  try {
    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${newSuite}`, "unrelated route");
    await Deno.writeTextFile(`${dir}/${mentioned}`, "unrelated route");
    assertEquals((await nameMatchedTests([login], `${dir}/tests`)).get(login), undefined);

    await Deno.writeTextFile(`${dir}/${mentioned}`, `const href = '${url}';`);
    assertEquals((await nameMatchedTests([login], `${dir}/tests`)).get(login), [mentioned]);

    await Deno.writeTextFile(
      `${dir}/${mentioned}`,
      `await fetch(new Request('https://example.test${url}'));`,
    );
    assertEquals((await nameMatchedTests([login], `${dir}/tests`)).get(login), [mentioned]);

    await Deno.writeTextFile(
      `${dir}/${newSuite}`,
      `await fetch(new Request('https://example.test${url}'));`,
    );
    assertEquals(
      (await nameMatchedTests([login], `${dir}/tests`)).get(login)?.sort(),
      [mentioned, newSuite].sort(),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wb7h: real graph keeps verified readers and additional URL candidates bounded", async () => {
  const reverse = await reverseGraph();
  const discovered = await allTestFiles();
  assert(discovered.length > 0, "no test modules discovered");
  for (const [path, verifiedExercisers] of VFE9_EXERCISING_SUITES) {
    const plan = planTests([path], reverse, await nameMatchedTests([path]));
    assert(plan.testFiles !== null, `${path} must not force FULL: ${plan.reason}`);
    for (const suite of verifiedExercisers) {
      assert(plan.testFiles.includes(suite), `${path}: lost verified handler exerciser ${suite}`);
    }
    assert(plan.testFiles.length < discovered.length, `${path}: must remain narrower than FULL`);
  }
  assertEquals(planTests(["src/routes/new_unmapped.ts"], reverse, new Map()).testFiles, null);
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

Deno.test("audio-feed-2h5f: production fmt covers deno.json's configured include scope", async () => {
  // Read the configured scope at the use site: neither directories nor line width belong
  // in this assertion. Bare `deno fmt --check` delegates both to deno.json.
  const jsonc = await Deno.readTextFile(new URL("../deno.json", import.meta.url));
  const config = JSON.parse(
    jsonc.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"),
  ) as {
    fmt?: { include?: string[] };
  };
  const configuredPaths = config.fmt?.include ?? [];
  assert(configuredPaths.length > 0, "deno.json must declare a formatting scope to compare");
  const gateSource = await Deno.readTextFile(new URL("../scripts/fast-check.ts", import.meta.url));
  assert(
    /const\s+fmtStep\s*=\s*formatCheckStep\s*\(\s*fmtFixture\s*\)/.test(gateSource),
    "the production gate must use the tested formatter command, not leave an unused helper",
  );

  const production = formatCheckStep(null);
  assertEquals(production.slice(0, 3), ["deno", "fmt", "--check"]);
  // Explicit paths override the configuration-derived scope. They are valid only if they
  // cover EVERY configured path, rather than silently narrowing production to one file.
  const explicitPaths = production.slice(3);
  const normalize = (path: string) => path.replace(/\/+$/, "");
  assertEquals(
    (explicitPaths.length ? explicitPaths : configuredPaths).map(normalize).sort(),
    configuredPaths.map(normalize).sort(),
    `production fmt must cover every deno.json fmt.include path: ${production.join(" ")}`,
  );
  assertEquals(formatCheckStep("/tmp/fmt-fixture.ts"), [
    "deno",
    "fmt",
    "--check",
    "/tmp/fmt-fixture.ts",
  ], "only the integration-test fixture may narrow formatting to one file");
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
    const passed = /^fast-gate:\s*(?:passed|completed):\s*(.*)/.exec(line);
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
    9,
    "pass/fail for both paths, the inert case, and four pre-harness stops",
  );
  assert(
    source.includes("the gate stopped before the test harness"),
    "the pre-harness UNKNOWN must name what stopped it",
  );
  // The consumed contract stays intact: passed:/ran: are still emitted where they always were.
  assertEquals((source.match(/console\.log\(\s*suiteMarker\("passed"/g) ?? []).length, 2);
  assertEquals((source.match(/console\.log\(\s*suiteMarker\("ran"/g) ?? []).length, 2);
});

// ---------------------------------------------------------------------------
// audio-feed-48b7: a suite that ran NOTHING must not be reportable as a pass.
// Deno counts IGNORED tests separately from passed ones, and the gate is silent
// on success - so the ignored count was unobservable in the gate log, which is
// how the fast gate's own recursion-guard suite reported "ok" while executing
// zero assertions. Note this is a NARROW EXCEPTION to the pinned contract above
// ("run remains completely quiet on success", pkv1): quiet UNLESS Deno says
// something was skipped, and then only the line that says so.
// ---------------------------------------------------------------------------

Deno.test("audio-feed-48b7: the ignored summary is BOUNDED to the line carrying it", () => {
  // A large successful suite with ONE ignored test must not dump every per-test
  // line into the gate log - the row rev-56 asked for ("preserve bounded output
  // where possible"), which the first version of this passthrough failed by
  // printing stdout.trim() whole.
  const stdout = [
    "running 3 tests from ./tests/example_test.ts",
    "a real test that ran ... ok (12ms)",
    "another real test ... ok (7ms)",
    "a test that was skipped ... ignored (0ms)",
    "",
    "ok | 2 passed | 0 failed | 1 ignored (19ms)",
    "",
  ].join("\n");
  assertEquals(ignoredSummary(stdout), "ok | 2 passed | 0 failed | 1 ignored (19ms)");
  // Controls: an ordinary quiet pass STAYS quiet, because the guard is [1-9], not \d.
  assertEquals(ignoredSummary("ok | 3 passed | 0 failed (19ms)"), "");
  assertEquals(ignoredSummary("ok | 3 passed | 0 failed | 0 ignored (19ms)"), "");
  assertEquals(ignoredSummary(""), "");
});

Deno.test("audio-feed-48b7: run surfaces the ignored count but NOT the rest of stdout", async () => {
  const logged: string[] = [];
  const res = await run(
    [
      "deno",
      "eval",
      "console.log('UNRELATED_PASSING_TEST_DETAILS'); console.log('ok | 0 passed | 0 failed | 2 ignored (6ms)');",
    ],
    { onOutput: (msg) => logged.push(msg) },
  );
  assertEquals(res.code, 0);
  const combined = logged.join("\n");
  assert(
    combined.includes("2 ignored"),
    `the ignored count must be surfaced on a successful run; got: ${JSON.stringify(combined)}`,
  );
  assert(
    !combined.includes("UNRELATED_PASSING_TEST_DETAILS"),
    `the passthrough must stay BOUNDED to the summary line; got: ${JSON.stringify(combined)}`,
  );
});

Deno.test("audio-feed-48b7: nothing ignored means the success path stays silent", async () => {
  const logged: string[] = [];
  const res = await run(
    [
      "deno",
      "eval",
      "console.log('QUIET_PASS_DETAIL'); console.log('ok | 2 passed | 0 failed (9ms)');",
    ],
    { onOutput: (msg) => logged.push(msg) },
  );
  assertEquals(res.code, 0);
  assertEquals(logged, [], "no ignored tests means the pkv1 quiet contract is intact");
});

// ---------------------------------------------------------------------------
// audio-feed-8otq & audio-feed-8rz5: Gate-integrity checks for synthetic selection.
// ---------------------------------------------------------------------------

Deno.test("audio-feed-8rz5: old ambient env var names are completely absent from scripts/fast-check.ts executable code", () => {
  const content = Deno.readTextFileSync(new URL("../scripts/fast-check.ts", import.meta.url));
  const code = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  assert(
    !code.includes("IN_FAST_GATE_INTEGRATION_TEST"),
    "IN_FAST_GATE_INTEGRATION_TEST must be absent from scripts/fast-check.ts code",
  );
  assert(
    !code.includes("FAST_GATE_FMT_FIXTURE"),
    "FAST_GATE_FMT_FIXTURE must be absent from scripts/fast-check.ts code",
  );
});

Deno.test("audio-feed-ylg6: committed paths survive ambient environment variables even on clean main", async () => {
  // rev-91 & audio-feed-ylg6: A dynamic test using only untracked files is blind to mutations
  // that drop committed files when executed on an empty delta (e.g. clean checkout of origin/main).
  // This test clones a shared repo fixture, pins refs/remotes/origin/main to HEAD~1, and asserts
  // that committed paths are present in baseline and survive ambient environment variables.
  //
  // audio-feed-kp7l / audio-feed-gw4k: A startup sweep was evaluated to clean orphaned clones
  // left behind by SIGKILLed runs. However, process liveness inspection (/proc/<pid>) is denied
  // under deno test sandbox permissions without --allow-all, causing an age-only sweep that could
  // delete active sibling runs' clones under high load. The sweep was removed in favor of accepting
  // the bounded residue (~16MB per SIGKILLed run, cleaned up normally on success/failure in finally).
  const tmpDir = await Deno.makeTempDir({ prefix: "fast-check-test-clone-" });
  try {
    const cloneProc = await new Deno.Command("git", {
      args: ["clone", "--shared", "-q", ".", tmpDir],
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(cloneProc.success, "git clone --shared must succeed");

    const updateRefProc = await new Deno.Command("git", {
      args: ["update-ref", "refs/remotes/origin/main", "HEAD~1"],
      cwd: tmpDir,
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(updateRefProc.success, "update-ref to HEAD~1 must succeed");

    const evalProc = await new Deno.Command("deno", {
      args: [
        "eval",
        `
        import { changedFiles } from "./scripts/fast-check.ts";
        import { assert, assertEquals } from "@std/assert";
        const baseline = await changedFiles();
        assert(baseline !== null && baseline.length > 0, "baseline must contain committed files vs HEAD~1");
        
        Deno.env.set("IN_FAST_GATE_INTEGRATION_TEST", "1");
        Deno.env.set("FAST_GATE_FMT_FIXTURE", "/tmp/nonexistent-fixture.ts");
        const withEnv = await changedFiles();
        assertEquals(withEnv, baseline, "committed files must not be dropped by ambient env vars");
        `,
      ],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();

    const stderr = new TextDecoder().decode(evalProc.stderr);
    assertEquals(evalProc.code, 0, `eval failed with code ${evalProc.code}: ${stderr}`);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-hkco: flagged tracked mutation makes changedFiles unknown, not empty", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "fast-check-index-flag-" });
  const path = "src/observability/error_screen.ts";
  try {
    const clone = await new Deno.Command("git", {
      args: ["clone", "--shared", "-q", ".", tmpDir],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(clone.code, 0, new TextDecoder().decode(clone.stderr));
    const baseline = await new Deno.Command("git", {
      args: ["update-ref", "refs/remotes/origin/main", "HEAD"],
      cwd: tmpDir,
      stderr: "piped",
    }).output();
    assertEquals(baseline.code, 0, new TextDecoder().decode(baseline.stderr));
    const child = await new Deno.Command("deno", {
      args: [
        "eval",
        `
        import { changedFiles } from "./scripts/fast-check.ts";
        import { assert, assertEquals } from "@std/assert";
        const path = "${path}";
        const git = async (...args: string[]) => {
          const out = await new Deno.Command("git", { args, stdout: "piped" }).output();
          assertEquals(out.code, 0, args.join(" "));
          return new TextDecoder().decode(out.stdout).trim();
        };
        const original = await Deno.readTextFile(path);
        const diagnostics: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
          diagnostics.push(args.map(String).join(" "));
          originalLog(...args);
        };
        try {
          assertEquals(await changedFiles(), [], "a clean tree must retain its empty selection");
          assertEquals(diagnostics, [], "a clean tree must emit NO index-flag diagnostic");
          await git("update-index", "--assume-unchanged", path);
          await Deno.writeTextFile(path, original + "\\n// hkco mutant\\n");
          assertEquals(await git("status", "--porcelain"), "", "Git must hide this mutation");
          assertEquals(await git("diff", "--name-only", "HEAD"), "", "git diff must miss it");
          assertEquals((await git("ls-files", "-v", path)).slice(0, 2), "h ");
          assertEquals(await changedFiles(), null, "a lowercase tag means UNKNOWN, not no change");
          assert(
            diagnostics.some((line) => line.includes("tracked index flag(s)") && line.includes(path)),
            "the assume-unchanged diagnostic must NAME the hidden path",
          );
          await git("update-index", "--no-assume-unchanged", path);
          assertEquals(await changedFiles(), [path], "the visible mutation must still be selected");
          await git("update-index", "--skip-worktree", path);
          const beforeSkip = diagnostics.length;
          assertEquals(await changedFiles(), null, "skip-worktree also means UNKNOWN");
          assert(
            diagnostics.slice(beforeSkip).some((line) => line.includes(path)),
            "the skip-worktree diagnostic must NAME the hidden path",
          );
        } finally {
          console.log = originalLog;
          await git("update-index", "--no-assume-unchanged", path);
          await git("update-index", "--no-skip-worktree", path);
          await Deno.writeTextFile(path, original);
        }
      `,
      ],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(child.stdout);
    assertEquals(child.code, 0, new TextDecoder().decode(child.stderr));
    assert(
      stdout.includes("tracked index flag(s) may hide mutations") && stdout.includes(path),
      `index-flag widening must be explicit and name the path: ${stdout}`,
    );
  } finally {
    // Defence if the child exits before its finally: never leave a flagged clone, even temporarily.
    for (const flag of ["--no-assume-unchanged", "--no-skip-worktree"]) {
      await new Deno.Command("git", {
        args: ["update-index", flag, path],
        cwd: tmpDir,
        stdout: "null",
        stderr: "null",
      }).output().catch(() => {});
    }
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test(
  "audio-feed-8rz5: synthetic selection fails closed with non-zero exit code 2 unconditionally",
  async () => {
    // audio-feed-ffav & audio-feed-45r9: The exit-2 refusal is unconditional at script entry (scripts/fast-check.ts:839),
    // so child execution cannot recurse into test runners. We explicitly inject IN_FAST_GATE_INTEGRATION_TEST: "1"
    // into the child environment to prove the refusal is enforced even when the ambient variable is present,
    // while omitting any 'ignore' guard so the refusal is always exercised in every parent environment.
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-run=git,deno",
        "--allow-env",
        "scripts/fast-check.ts",
        "--untracked-only",
      ],
      env: {
        ...Deno.env.toObject(),
        IN_FAST_GATE_INTEGRATION_TEST: "1",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);

    // Must fail closed with non-zero exit code (code 2)
    assertEquals(
      out.code,
      2,
      "synthetic selection must exit non-zero (code 2)",
    );
    assert(
      stderr.includes("fast-gate: failed: synthetic selection refused"),
      `stderr must report refusal: ${stderr}`,
    );
    assert(
      !stdout.includes("fast-check: ok in"),
      `stdout must NOT contain passing verdict: ${stdout}`,
    );
  },
);

Deno.test("audio-feed-vdys: changedFiles API cannot be short-circuited programmatically", () => {
  // audio-feed-vdys: changedFiles accepts 0 arguments; untrackedOnly option is eliminated
  // entirely from the API so synthetic selection cannot be requested programmatically.
  assertEquals(changedFiles.length, 0, "changedFiles must accept zero arguments");
});

Deno.test("audio-feed-m4vi: failing test names in fast-gate: failed: lines are never scraped as suite names", () => {
  const log = [
    "fast-gate: ran: tests/a_test.ts tests/b_test.ts",
    "fast-gate: failed: tests/b_test.ts (some assertion with passed: words and spaces)",
    "fast-gate: failed: lint",
    "fast-gate: coverage: ran 2 suite(s): tests/a_test.ts tests/b_test.ts",
  ].join("\n");

  assertEquals(
    extractExecutedSuitesFromLog(log),
    ["tests/a_test.ts", "tests/b_test.ts"],
    "must extract only real suite paths and never scrape words from the parenthesized failing test name",
  );
  assertEquals(
    coverageNoteFromLog(log),
    "2 suite(s) ran: tests/a_test.ts tests/b_test.ts",
    "a failing test name containing 'passed:' must not pollute the coverage note",
  );
});

// ---------------------------------------------------------------------------
// audio-feed-97m0: Cached fast-gate log surfaces per-suite test output on
// clean success while stripping inner captured test output blocks.
// ---------------------------------------------------------------------------

Deno.test("audio-feed-97m0: testSuiteSummary surfaces per-suite running headers and ok summary while stripping inner captured output", () => {
  const stdout = [
    "running 58 tests from ./tests/fast_check_test.ts",
    "a passing test ... ok (4ms)",
    "audio-feed-48b7: run surfaces the ignored count ...",
    "------- output -------",
    "$ deno eval console.log('UNRELATED_PASSING_TEST_DETAILS'); console.log('ok | 0 passed | 0 failed | 2 ignored (6ms)');",
    "ok | 0 passed | 0 failed | 2 ignored (6ms)",
    "----- output end -----",
    "audio-feed-48b7: run surfaces the ignored count ... ok (65ms)",
    "running 8 tests from ./tests/fast_gate_subset_test.ts",
    "subset test ... ok (12ms)",
    "",
    "ok | 66 passed | 0 failed (412ms)",
  ].join("\n");

  // 1. stripCapturedTestOutput removes the inner ------- output ------- block completely
  const stripped = stripCapturedTestOutput(stdout);
  assert(!stripped.includes("UNRELATED_PASSING_TEST_DETAILS"));
  assert(!stripped.includes("$ deno eval"));

  // 2. ignoredSummary does not match the inner captured `$ deno eval ... | 2 ignored` line
  assertEquals(ignoredSummary(stdout), "");
  assertEquals(
    ignoredSummary(
      "$ deno eval console.log('ok | 0 passed | 0 failed | 2 ignored (6ms)');",
    ),
    "",
  );

  // 3. testSuiteSummary surfaces each suite's `running N tests from ...` line and the `ok | ...` summary
  assertEquals(
    testSuiteSummary(stdout),
    [
      "running 58 tests from ./tests/fast_check_test.ts",
      "running 8 tests from ./tests/fast_gate_subset_test.ts",
      "ok | 66 passed | 0 failed (412ms)",
    ].join("\n"),
  );
});

Deno.test("audio-feed-97m0: run surfaces per-suite running headers and final ok summary on clean test success", async () => {
  const logged: string[] = [];
  const res = await run(
    [
      "deno",
      "eval",
      [
        "console.log('running 3 tests from ./tests/alpha_test.ts');",
        "console.log('test one ... ok (2ms)');",
        "console.log('------- output -------');",
        "console.log('$ deno eval inner_command | 2 ignored');",
        "console.log('----- output end -----');",
        "console.log('running 2 tests from ./tests/beta_test.ts');",
        "console.log('ok | 5 passed | 0 failed (14ms)');",
      ].join(" "),
    ],
    { onOutput: (msg) => logged.push(msg) },
  );
  assertEquals(res.code, 0);
  assertEquals(logged, [
    [
      "running 3 tests from ./tests/alpha_test.ts",
      "running 2 tests from ./tests/beta_test.ts",
      "ok | 5 passed | 0 failed (14ms)",
    ].join("\n"),
  ]);
});

// ---------------------------------------------------------------------------
// audio-feed-bycd: A STALE fast-gate run emits no false failure line and no
// coverage suite list parsed from a torn log.
// ---------------------------------------------------------------------------

Deno.test("audio-feed-bycd: detectStaleRun and failureMarkers emit STALE marker without false failure line", () => {
  const before = {
    headSha: "1bf1129",
    headTree: "aaaaaaaa11111111222222223333333344444444",
    status: "",
  };
  const afterSuperseded = {
    headSha: "b1ffbe0",
    headTree: "bbbbbbbb11111111222222223333333344444444",
    status: "",
  };
  const reason = detectStaleRun(before, afterSuperseded);
  assertEquals(reason, "superseded by b1ffbe0 (started on 1bf1129)");

  // Even when stdout contains a test failure from a torn worktree, failureMarkers with staleReason
  // emits ONLY the STALE marker and never a false `fast-gate: failed:` line.
  const tornStdout = [
    "failures:",
    "\t torn assertion => ./tests/fast_check_test.ts:42:5",
  ].join("\n");
  const markers = failureMarkers(tornStdout, ["tests/fast_check_test.ts"], reason);
  assertEquals(markers, [
    "fast-gate: STALE: superseded by b1ffbe0 (started on 1bf1129), verdict not evaluated",
  ]);
  assert(
    markers.every((m) => !m.startsWith("fast-gate: failed:")),
    "STALE run must never emit a false fast-gate: failed: marker",
  );
});

Deno.test("audio-feed-bycd: extractExecutedSuitesFromLog returns empty list when log is marked STALE or coverage UNKNOWN", () => {
  const tornStaleLog = [
    "fast-gate: ran: tests/a_test.ts tests/b_test.ts",
    "fast-gate: coverage: UNKNOWN - run was invalidated while tests were executing (superseded by b1ffbe0 (started on 1bf1129))",
    staleMarker("superseded by b1ffbe0 (started on 1bf1129)"),
  ].join("\n");
  assertEquals(
    extractExecutedSuitesFromLog(tornStaleLog),
    [],
    "STALE log must not produce a coverage suite list from a torn run",
  );
});

// ---------------------------------------------------------------------------
// audio-feed-dp30: Candidate finder avoids false positives from directory path
// segments or string literal values, and distinguishes omitted from unmapped.
// ---------------------------------------------------------------------------

Deno.test("audio-feed-dp30: candidate finder does not treat directory segment or string literal value as a dependency on src/worker/synthesis.ts", async () => {
  const seamSource = await Deno.readTextFile(
    new URL("../tests/seam_boundaries_test.ts", import.meta.url),
  );
  const adminStatsSource = await Deno.readTextFile(
    new URL("../tests/admin_stats_test.ts", import.meta.url),
  );

  // Neither tests/seam_boundaries_test.ts (which imports ../src/synthesis/limits.ts)
  // nor tests/admin_stats_test.ts (which passes { kind: "synthesis" } to its local run() helper)
  // references src/worker/synthesis.ts.
  assertEquals(
    hasImportReference(
      "tests/seam_boundaries_test.ts",
      seamSource,
      "src/worker/synthesis.ts",
    ),
    false,
  );
  assertEquals(
    hasExecReference(
      "tests/admin_stats_test.ts",
      adminStatsSource,
      "src/worker/synthesis.ts",
    ),
    false,
  );

  // Positive controls: real imports in those same files ARE matched accurately.
  assertEquals(
    hasImportReference(
      "tests/seam_boundaries_test.ts",
      seamSource,
      "src/synthesis/limits.ts",
    ),
    true,
  );
  assertEquals(
    hasImportReference(
      "tests/seam_boundaries_test.ts",
      seamSource,
      "src/worker/script.ts",
    ),
    true,
  );

  const testSources = new Map<string, string>([
    ["tests/seam_boundaries_test.ts", seamSource],
    ["tests/admin_stats_test.ts", adminStatsSource],
  ]);
  assertEquals(
    findCandidateTestsForFile("src/worker/synthesis.ts", testSources),
    [],
    "neither seam_boundaries_test.ts nor admin_stats_test.ts is a candidate for src/worker/synthesis.ts",
  );
  assertEquals(
    findCandidateTestsForFile("src/synthesis/limits.ts", testSources),
    ["tests/seam_boundaries_test.ts"],
  );
});

Deno.test("audio-feed-dp30: classifyChangedFileCoverage distinguishes unmapped files from files with omitted candidate suites", () => {
  const candidatesByFile = new Map<string, readonly string[]>([
    ["src/worker/synthesis.ts", ["tests/synthesis_worker_test.ts", "tests/worker_loop_test.ts"]],
    ["docs/notes.md", []],
  ]);

  const report = classifyChangedFileCoverage(
    ["src/worker/synthesis.ts", "docs/notes.md"],
    ["tests/synthesis_worker_test.ts"],
    candidatesByFile,
  );

  assertEquals(
    report.unmapped,
    ["docs/notes.md"],
    "only files with zero candidate suites are unmapped ('no mapping exists')",
  );
  assertEquals(
    report.omitted,
    ["tests/worker_loop_test.ts"],
    "suites that mapped to a changed file but did not run are reported in omitted ('candidate suites did not run')",
  );
  assertEquals(
    report.omittedByFile.get("src/worker/synthesis.ts"),
    ["tests/worker_loop_test.ts"],
  );
});

// ---------------------------------------------------------------------------
// audio-feed-43lf (plus 0l3a / tyt5): Gate coverage record evaluation never
// hides omitted/unmapped suites or nested PARTIAL reasons behind a shallow
// coverage_verified=true.
// ---------------------------------------------------------------------------

Deno.test("audio-feed-43lf: evaluateGateCoverageRecord falsifies coverage_verified and lifts qualifiers on both real repro records", () => {
  // Record 1 (a958570bde05ec97a334663532639f67e19c4b0e.fast.json):
  // unmapped + omitted non-empty alongside shallow coverage_verified=true
  const recA95 = evaluateGateCoverageRecord({
    state: "PASS",
    kind: "fast",
    tree: "a958570bde05ec97a334663532639f67e19c4b0e",
    coverage_verified: true,
    partial_reason:
      "changed file(s) not placed in any suite: src/worker/synthesis.ts; 2 candidate suite(s) did not run",
    unmapped: ["src/worker/synthesis.ts"],
    omitted: ["tests/admin_stats_test.ts", "tests/seam_boundaries_test.ts"],
    coverage: {
      indeterminate: false,
      coverage: "PARTIAL",
      partial_reason:
        "changed file(s) not placed in any suite: src/worker/synthesis.ts; 2 candidate suite(s) did not run",
      unmapped: ["src/worker/synthesis.ts"],
      omitted: ["tests/admin_stats_test.ts", "tests/seam_boundaries_test.ts"],
    },
  });
  assertEquals(recA95.coverageVerified, false);
  assertEquals(recA95.normalizedRecord.coverage_verified, false);
  assert(
    recA95.statusLabel !== "PASS (fast gate)",
    `must never render unqualified PASS (fast gate): got ${recA95.statusLabel}`,
  );
  assert(recA95.statusLabel.includes("coverage PARTIAL"));

  // Record 2 (aa29d46de2eb2c8e1837352f41677944dd714645.fast.json):
  // top-level coverage_verified=true and partial_reason=null while nested coverage is PARTIAL
  const recAa2 = evaluateGateCoverageRecord({
    state: "PASS",
    kind: "fast",
    tree: "aa29d46de2eb2c8e1837352f41677944dd714645",
    coverage_verified: true,
    partial_reason: null,
    unmapped: [],
    omitted: [],
    coverage: {
      indeterminate: false,
      coverage: "PARTIAL",
      partial_reason:
        "changed file(s) not placed in any suite: scripts/hooks/install-hooks.sh, scripts/hooks/pre-push",
      unmapped: ["scripts/hooks/install-hooks.sh", "scripts/hooks/pre-push"],
      omitted: [],
    },
  });
  assertEquals(recAa2.coverageVerified, false);
  assertEquals(recAa2.normalizedRecord.coverage_verified, false);
  assertEquals(
    recAa2.normalizedRecord.partial_reason,
    "changed file(s) not placed in any suite: scripts/hooks/install-hooks.sh, scripts/hooks/pre-push",
  );
  assertEquals(recAa2.normalizedRecord.unmapped, [
    "scripts/hooks/install-hooks.sh",
    "scripts/hooks/pre-push",
  ]);
  assert(
    recAa2.statusLabel !== "PASS (fast gate)",
    `must never render unqualified PASS (fast gate): got ${recAa2.statusLabel}`,
  );

  // Control: a genuinely verified record renders PASS (fast gate)
  const cleanRec = evaluateGateCoverageRecord({
    state: "PASS",
    kind: "fast",
    coverage_verified: true,
    partial_reason: null,
    unmapped: [],
    omitted: [],
    coverage: {
      indeterminate: false,
      coverage: "FULL",
      partial_reason: null,
      unmapped: [],
      omitted: [],
    },
  });
  assertEquals(cleanRec.coverageVerified, true);
  assertEquals(cleanRec.statusLabel, "PASS (fast gate)");

  // Control (audio-feed-0l3a): a synthetic record never verifies as PASS
  const syntheticRec = evaluateGateCoverageRecord({
    state: "PASS",
    kind: "fast",
    synthetic: true,
  });
  assertEquals(syntheticRec.coverageVerified, false);
  assertEquals(syntheticRec.statusLabel, "SYNTHETIC (fast gate)");
});

Deno.test("audio-feed-tyt5: findHiddenTrackedMutations detects assume-unchanged and skip-worktree index flags", () => {
  const lsOutput = [
    "H README.md",
    "h src/routes/admin.ts",
    "S scripts/fast-check.ts",
    "s src/combined flag.ts",
    "H tests/fast_check_test.ts",
  ].join("\n");
  assertEquals(findHiddenTrackedMutations(lsOutput), [
    "scripts/fast-check.ts",
    "src/combined flag.ts",
    "src/routes/admin.ts",
  ]);
  assertEquals(
    findHiddenTrackedMutations("H README.md\0h src/multi\nline.ts\0S src/skip.ts\0"),
    ["src/multi\nline.ts", "src/skip.ts"],
    "NUL-separated Git output must not split a tracked path containing a newline",
  );
});
