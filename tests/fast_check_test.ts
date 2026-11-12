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
import { HANG_BOUND_MS } from "../scripts/proof-cdp.ts";
// audio-feed-v527x: the one place that knows quote and comment state. Comment-stripping and
// literal-masking cannot be two ordered regex passes, either way round.
import { blankCommentsOnly, maskNonCode } from "../scripts/source-mask.ts";
import {
  allTestFiles,
  changedFiles,
  detectStaleRun,
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
  PROCESS_GLOBAL_SUITES,
  reachableTests,
  reverseGraph,
  run,
  splitProcessGlobalSuites,
  stripCapturedTestOutput,
  suiteMarker,
  testSuiteSummary,
  unmappedMarker,
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

// audio-feed-dzrx2 / audio-feed-v46l5: the direct-gate exception's justification is pinned BEHAVIOURALLY.
// The suite prints the audit's fresh nonce only after the bootstrap success assertions.
// The bound is a HANG ceiling, not an expected latency: five child runs on this VM took
// 0.49-0.72s warm. The old 8s starved-browser-poll floor did not measure this Deno child
// (spawn + module graph + four tests) and even that browser poll exceeded 8s under load.
// Reuse the existing 120s hang ceiling to avoid rejecting cold-cache or saturated runs.
export const DIRECT_GATE_SPAWN_BOUND_MS = HANG_BOUND_MS;

/**
 * Run the one direct-gate suite and report whether it printed the earned proof line. Runs once per
 * audit: the exception is a single (route, file) pair, so there is one spawn, not one per route.
 *
 * The abort signal bounds a hang and names the ceiling. A fresh nonce passed to the child
 * must come back on the success path; the old constant-value checksum is not proof of execution.
 */
export async function directGateProof(
  timeoutMs = DIRECT_GATE_SPAWN_BOUND_MS,
  overrideArgs?: string[],
): Promise<{ ok: boolean; detail: string }> {
  // `<repo>/tests/` -> repo root, the cwd the gate itself runs the suite from.
  const root = import.meta.dirname!.replace(/\/tests$/, "");
  const signal = AbortSignal.timeout(timeoutMs);
  const nonce = crypto.randomUUID();
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(Deno.execPath(), {
      // Written out literally so the derived execute relation names the suite (audio-feed-spawnlit:
      // the construction must be STARTED, which .output() below does).
      args: overrideArgs ?? [
        "test",
        "--no-check",
        "--allow-env=LOCKOUT_PROOF_NONCE",
        "tests/lockout_order_test.ts",
      ],
      env: { LOCKOUT_PROOF_NONCE: nonce },
      cwd: root,
      stdout: "piped",
      stderr: "piped",
      signal,
    }).output();
  } catch (err) {
    if (signal.aborted) {
      return {
        ok: false,
        detail: `child process was killed by ${timeoutMs}ms bound (${
          signal.reason instanceof Error ? signal.reason.message : "timeout"
        })`,
      };
    }
    throw err;
  }

  if (signal.aborted || output.signal === "SIGTERM" || output.code === 143) {
    return {
      ok: false,
      detail: `child process was killed by ${timeoutMs}ms bound (exit code ${output.code}, signal ${
        output.signal ?? "SIGTERM"
      })`,
    };
  }

  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    const tail = (stdout + stderr).trim().split("\n").slice(-4).join(" | ");
    return { ok: false, detail: `exit ${output.code}; ${tail}` };
  }

  const match = stdout.match(
    /lockout-order-proof row2:\s+bootstrap status=(\d+)\s+delta=(\d+)\s+total=(\d+)\s+remaining=(\d+)\s+nonce=([0-9a-f-]+)/,
  );
  if (!match) {
    const tail = (stdout + stderr).trim().split("\n").slice(-4).join(" | ");
    return {
      ok: false,
      detail:
        `unearned or malformed proof line (expected earned lockout-order-proof row2 format); ${tail}`,
    };
  }

  const status = Number(match[1]);
  const delta = Number(match[2]);
  const total = Number(match[3]);
  const remaining = Number(match[4]);
  const echoedNonce = match[5];

  if (status !== 200 || delta !== 1 || total !== 4 || remaining !== 0) {
    return {
      ok: false,
      detail:
        `unearned proof values: status=${status} delta=${delta} total=${total} remaining=${remaining}`,
    };
  }

  if (echoedNonce !== nonce) {
    return {
      ok: false,
      detail: `unearned proof nonce: child did not echo this audit run's nonce`,
    };
  }

  return { ok: true, detail: match[0] };
}

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

  // Derivation of route exercise vs mention:
  // Instead of a hand-maintained list of suites that ambushes unrelated landings whenever
  // a new suite is added (audio-feed-jmq5b), we derive whether a candidate test file genuinely
  // exercises the route handler or merely mentions it.
  //
  // A suite is classified as EXERCISING if it constructs an HTTP Request or invokes an HTTP
  // test dispatch helper targeting the route URL (outside of comments, test names, mock/stub
  // responders like service worker harnesses, host-spoof checks like evil.example, or log metadata).
  // Otherwise it is classified as MENTION-ONLY.
  //
  // What this catches:
  // - A route with ZERO exercising suites fails the gate.
  // - An account route with NO exercising candidate fails the gate.
  // - Removing an exercising suite so a route or subroute is left unexercised fails the gate.
  // - scripts/fast-check.ts failing to select the complete candidate union in nameMatchedTests fails.
  // - A suite classified as exercising that builds Requests but never calls fetch( fails: a
  //   constructed Request that is never dispatched cannot exercise a handler.
  // - A classification FLIP for an already-pinned suite fails until a human audits it
  //   (ABH1_PINNED_CLASSIFICATION), which is the job the deleted hand lists used to do.
  //
  // What this does not catch / accepted limits (P2, audio-feed-jmq5b):
  // - This is a STATIC heuristic over source text. It never executes a suite, so "exercising"
  //   means "has the shape of a dispatch", not "was observed to dispatch". The one place the
  //   audit does execute anything is the direct-gate exception, which audio-feed-dzrx2 runs and
  //   pins on a printed proof line.
  // - The exclusions in DO_NOT_EXERCISE are string literals pinned to today's identifiers: the
  //   host-spoof rows (evil.example), the service-worker harness shape (harness.dispatch,
  //   request.url.endsWith), log metadata (route: + path), table fixtures (expected + path) and
  //   predicate unit pins (isTrustedReportOrigin). A new harness name, spoof host or fixture
  //   key rots them. Rot shows up as a mention promoted to an exerciser, which the pinned
  //   classification turns into a red to audit, not a silent narrowing.
  // - A suite that dispatches through an abstraction this file cannot see - a helper that
  //   calls fetch internally without being defined in the same module, e.g. the send() shape
  //   at tests/observability_cwv_test.ts:262 - classifies as MENTION-ONLY. The audit accepts
  //   that direction of error deliberately: it under-counts exercisers and produces a false
  //   RED on the pin (a human is asked to look), never a false green that lets a gate narrow
  //   past a route whose only exerciser went unseen.
  const DO_NOT_EXERCISE = [
    "evil.example",
    "harness.dispatch",
    "request.url.endsWith",
    "isTrustedReportOrigin",
  ] as const;
  const DISPATCH_FORM =
    /(?:new\s+Request|\breq|\bt\.(?:post|get)|(?<![.\w])(?:get|post|call))\s*\(/;

  // A dispatch must be ANCHORED in this file, not merely named. `call("/login")` reads the
  // same whether call() fetches the app or formats a string, so a helper call only counts when
  // this file defines that helper and its body reaches fetch(. Without that anchor, a match on
  // a bare helper name silently promoted a mention to an exerciser (audio-feed-jmq5b review).
  //
  // The reviewer's simpler rule - every exercising line must contain `fetch(` or
  // `new Request(` - was evaluated and rejected against this tree: tests/account_pages_test.ts:62
  // dispatches as `get(fetch, "/login")` (the app's fetch is handed to a helper) and
  // tests/account_regenerate_test.ts:73 as `t.post(...)` into a local post() helper that calls
  // fetch(new Request(...)). Both genuinely exercise the handler; neither carries the primitive
  // on its own line, so that rule would demote two real exercisers.
  //
  // audio-feed-em9ib: tighten the dispatch check beyond bare substring includes("fetch(").
  // Strips comments and string literals, then requires a call to fetch(...) rather than
  // matching an incidental comment, string literal, or prefetch(...) identifier.

  // audio-feed-v527x: the strip is scripts/source-mask.ts maskNonCode(), NOT a chain of regexes.
  // Comment-stripping and literal-masking are MUTUALLY DEPENDENT and cannot be ordered into a
  // correct pair of whole-file passes either way round: comment-first is what broke the union
  // gate - the RSS fixture at tests/source_error_disclosure_test.ts:39-41 carries
  // `<link>https://example.com/p1</link>`, the `//` read as a comment start, the rest of that line
  // went with it INCLUDING the template's closing backtick, and the literal masker then paired
  // that backtick with one 40 lines later and swallowed all four real `fetch(` calls (4 raw, 0
  // after masking). Mask-first is no better: an apostrophe in prose (`// don't dispatch yet`)
  // would open a string. maskNonCode walks the source once and knows which of code / line
  // comment / block comment / string / template it is in, so neither can corrupt the other.
  const hasDispatch = (source: string): boolean => /(?<!\w)fetch\s*\(/.test(maskNonCode(source));
  const helperDispatches = (source: string, callee: string): boolean => {
    const name = callee.replace(/^.*\./, "");
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
    const at = source.search(
      new RegExp(
        `(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\())`,
      ),
    );
    if (at < 0) return false;
    // A fixed window, not a parse: the helper's dispatch must be visible near its definition.
    return source.slice(at, at + 1_500).includes("fetch(");
  };
  const dispatched = (line: string, source: string): boolean => {
    if (/new\s+Request\s*\(/.test(line)) return true;
    if (/(?<![.\w])fetch(?![.\w])/.test(line)) return true;
    for (const [, callee] of line.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g)) {
      if (callee && helperDispatches(source, callee)) return true;
    }
    return false;
  };
  const exercisesRoute = (
    _file: string,
    source: string,
    paths: readonly string[],
    isLogin = false,
  ): boolean => {
    // audio-feed-anqjk: the strip is scripts/source-mask.ts blankCommentsOnly(), NOT a chain of
    // regexes and NOT maskNonCode(). A whole-file `//`-to-end-of-line strip has no quote state, so
    // a `//` INSIDE a string truncated the rest of that line - and a route URL carrying its
    // protocol (`new Request("https://host/login")`, tests/login_conditional_mediation_test.ts:269)
    // lost the very path this classifier looks for. maskNonCode() is not a drop-in for the
    // opposite reason: it blanks literal BODIES and a route path IS a literal body. The two
    // policies are the two arms of one walk in that module, so they cannot drift on quote state.
    let stripped = blankCommentsOnly(source);
    stripped = stripped.replace(
      /Deno\.test\s*\(\s*(?:"[^"]*"|`[^`]*`|'[^']*')\s*,/g,
      "Deno.test('',",
    );

    return paths.some((p) => {
      const lines = stripped.split("\n");
      return lines.some((line) => {
        for (const literal of DO_NOT_EXERCISE) if (line.includes(literal)) return false;
        if (line.includes("route:") && line.includes(p)) return false;
        if (line.includes("expected") && line.includes(p)) return false;

        const hasPath = isLogin
          ? /(?<!\/api\/auth)\/login(?=[/?#"'`])/.test(line)
          : line.includes(p);
        if (!hasPath) return false;
        if (!DISPATCH_FORM.test(line)) return false;

        return dispatched(line, stripped);
      });
    });
  };

  // The classifier's own falsification rows: each one is a shape that must be classified the
  // stated way. They go red if the classifier collapses to "anything naming the path" (the
  // promotion direction) or to "anything with a helper-shaped call" (the anchoring direction).
  const CLASSIFIER_ROWS: {
    why: string;
    source: string;
    exercising: boolean;
    // Defaults to the login route, which is the one with a path-shape regex.
    paths?: string[];
    isLogin?: boolean;
  }[] = [
    {
      why: "dispatches through the app fetch with a constructed Request",
      source: 'await fetch(new Request("/login"));',
      exercising: true,
    },
    {
      why: "live tests/login_conditional_mediation_test.ts:269 dispatches /login through app.fetch",
      source: 'const res = await app.fetch(new Request("https://audio.example.com/login"));',
      exercising: true,
    },
    {
      why: "dispatches through the app fetch with a Request whose URL carries its protocol",
      // audio-feed-anqjk: the protocol prefix is the point of this row - `https://` must not
      // truncate the line before the path (tests/login_conditional_mediation_test.ts:269).
      source: 'await fetch(new Request("https://audio.example.com/login"));',
      exercising: true,
    },
    {
      why: "live tests/passkeys_test.ts:188 dispatches webauthn via victim.com Request URL",
      paths: ["/.well-known/webauthn"],
      isLogin: false,
      source: "const res1 = await fetch(\n" +
        '  new Request("https://victim.com/.well-known/webauthn", {\n' +
        '    headers: { host: "victim.com" },\n' +
        "  }),\n" +
        ");",
      exercising: true,
    },
    {
      why: "live tests/passkeys_test.ts:196 dispatches webauthn via attacker-evil.com Request URL",
      paths: ["/.well-known/webauthn"],
      isLogin: false,
      source: "const res2 = await fetch(\n" +
        '  new Request("https://attacker-evil.com/.well-known/webauthn", {\n' +
        '    headers: { host: "attacker-evil.com" },\n' +
        "  }),\n" +
        ");",
      exercising: true,
    },
    {
      why: "dispatches a route whose host and path share a URL literal",
      // The live passkeys shape: `app.fetch(new Request("https://victim.com/.well-known/webauthn"))`
      // (tests/passkeys_test.ts:188, :196). Classified separately from /login because that row's
      // path test is the login-specific regex.
      paths: ["/.well-known/webauthn"],
      isLogin: false,
      source: 'const res = await fetch(new Request("https://victim.com/.well-known/webauthn", {\n' +
        '  headers: { host: "victim.com" },\n' +
        "}));",
      exercising: true,
    },
    {
      why: "mixes a URL literal with a route path after it and an escaped quote inside a string",
      source: 'const banner = "see \\"https://example.com\\" before login";\n' +
        'await fetch(new Request("https://audio.example.com/login"));',
      exercising: true,
    },
    {
      why: "only names the route in a comment that follows a protocol URL",
      // audio-feed-anqjk, the other direction: a quote-aware strip must not turn a commented-out
      // dispatch into an exerciser, and the `//` in the URL must not licence reading past it.
      source: '// await fetch(new Request("https://audio.example.com/login"));',
      exercising: false,
    },
    {
      why: "only names the route in an unrelated string",
      source: 'const note = "navigate to /login to sign in";',
      exercising: false,
    },
    {
      why: "only names the route in an unrelated string mixing a URL literal and an escaped quote",
      source: 'const doc = "see \\"https://example.com\\" before /login is accessed";',
      exercising: false,
    },
    {
      why: "hands the app's fetch to a local helper",
      source: "const get = (fetch, p) => fetch(new Request(p));\n" +
        'const res = await get(fetch, "/login");',
      exercising: true,
    },
    {
      why: "calls a local helper whose body dispatches",
      source: "const post = (p) => fetch(new Request(p));\n" +
        'const res = await t.post("/login", {});',
      exercising: true,
    },
    {
      why: "names a helper this file never defines",
      source: 'const res = await call("/login");',
      exercising: false,
    },
    {
      why: "calls a local helper that never fetches",
      source: "function call(p) { return JSON.stringify(p); }\n" +
        'const res = await call("/login");',
      exercising: false,
    },
    {
      why: "only names the route in a test title",
      source: 'Deno.test("login page renders", () => {});',
      exercising: false,
    },
    {
      why: "only names the route in a comment",
      source: "// GET /login returns the page",
      exercising: false,
    },
    {
      why: "only names the route in a log field",
      source: 'record({ route: "/login", id: 1 });',
      exercising: false,
    },
  ];
  for (const row of CLASSIFIER_ROWS) {
    assertEquals(
      exercisesRoute(
        "tests/synthetic.ts",
        row.source,
        row.paths ?? ["/login"],
        row.isLogin ?? true,
      ),
      row.exercising,
      `classifier row must be ${row.exercising ? "exercising" : "mention-only"}: ${row.why}`,
    );
  }

  const DISPATCH_ROWS: { why: string; source: string; passes: boolean }[] = [
    { why: "bare fetch with Request", source: 'await fetch(new Request("/login"));', passes: true },
    { why: "helper fetch", source: "await t.fetch(req);", passes: true },
    { why: "app fetch", source: "await app.fetch(req);", passes: true },
    {
      why: "incidental fetch in line comment",
      source: '// await fetch(new Request("/login"));\nconst req = new Request("/login");',
      passes: false,
    },
    {
      why: "incidental fetch in block comment",
      source: '/* fetch(new Request("/login")) */\nconst req = new Request("/login");',
      passes: false,
    },
    {
      why: "incidental fetch in double-quoted string",
      source: 'const msg = "fetch(url)";\nconst req = new Request("/login");',
      passes: false,
    },
    {
      why: "incidental fetch in single-quoted string",
      source: "const msg = 'fetch(url)';\nconst req = new Request('/login');",
      passes: false,
    },
    {
      why: "incidental fetch in template string",
      source: 'const msg = `fetch(url)`;\nconst req = new Request("/login");',
      passes: false,
    },
    {
      why: "prefetch identifier",
      source: 'prefetch("/login");\nconst req = new Request("/login");',
      passes: false,
    },
    {
      why: "dispatch that follows a template containing //",
      // audio-feed-v527x, the union-gate case in miniature: tests/source_error_disclosure_test.ts
      // builds its RSS fixture at :39-41 with `<link>https://example.com/p1</link>`. Stripping
      // comments first deleted that line from the `//` on, INCLUDING the template's closing
      // backtick, so the template masker paired that backtick with one 40 lines later and the file
      // measured 4 raw `fetch(` sites and 0 after masking.
      source: 'const RSS = `<?xml version="1.0"?>\n<link>https://example.com/p1</link>`;\n' +
        "await fetch(new Request(`${BASE}/api/sources`));",
      passes: true,
    },
    {
      why: "commented-out fetch that follows a template containing //",
      // The other direction, and the dangerous one: a `//` in a template must not licence
      // counting a fetch( a human commented out, nor reach back into that template's backtick.
      source: "const RSS = `https://example.com/p1`;\n" +
        "// await fetch(new Request(`${BASE}/api/sources`));\n" +
        'const req = new Request("/login");',
      passes: false,
    },
    {
      why: "real dispatch after an apostrophe in a line comment",
      // Both strips are mutually dependent, so the fix cannot be "mask first, then strip": the
      // apostrophe in that comment is not a string start, and a masker that believes it is would
      // swallow the dispatch below it.
      source: '// don\'t dispatch yet\nawait fetch(new Request("/login"));',
      passes: true,
    },
  ];
  for (const row of DISPATCH_ROWS) {
    assertEquals(
      hasDispatch(row.source),
      row.passes,
      `dispatch rule must ${row.passes ? "pass" : "reject"}: ${row.why}`,
    );
  }

  const spec = [
    {
      file: "src/routes/account_api.ts",
      paths: accountRoutes.map((path) =>
        path.includes(":") ? path.slice(0, path.indexOf(":")) : path
      ),
      mentions: (source: string) =>
        accountRoutes.some((path) =>
          source.includes(path.includes(":") ? path.slice(0, path.indexOf(":")) : path)
        ),
    },
    {
      file: "src/routes/login.ts",
      paths: ["/login"],
      mentions: (source: string) => /(?<!\/api\/auth)\/login(?=[/?#"'`])/.test(source),
    },
    {
      file: "src/routes/admin_telemetry.ts",
      paths: ["/admin/observability/telemetry"],
      mentions: (source: string) => source.includes("/admin/observability/telemetry"),
    },
    {
      file: "src/routes/webauthn.ts",
      paths: ["/.well-known/webauthn"],
      mentions: (source: string) => source.includes("/.well-known/webauthn"),
    },
    {
      file: "src/routes/reports.ts",
      paths: ["/api/reports/csp"],
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
      [...sources.entries()].some(([f, source]) => exercisesRoute(f, source, [stem])),
      `${population}: new account route ${path} has NO test candidate; do not narrow until one exercises it`,
    );
  }
  // The tripwire the deleted hand lists used to be (audio-feed-jmq5b): when a suite's
  // classification CHANGES, a human is asked to audit the route's real handler before the gate
  // narrows. It is a SNAPSHOT of a static heuristic, not a proof of execution - a suite pinned
  // as exercising can still stop executing on its own. New suites are deliberately ABSENT, so
  // adding a legitimate suite is admitted without a red and does not ambush an unrelated
  // landing; only a flip for an already-pinned suite trips it.
  const ABH1_PINNED_CLASSIFICATION: Record<
    string,
    { exercises: string[]; mentionsOnly: string[] }
  > = {
    "src/routes/account_api.ts": {
      exercises: [
        "tests/account_regenerate_test.ts",
        "tests/admin_throttle_test.ts",
        "tests/auth_body_cap_test.ts",
        "tests/auth_login_options_limit_test.ts",
        "tests/auth_routes_test.ts",
        "tests/feed_discovery_test.ts",
        // audio-feed-4laa9: direct-gate suite; its compare spy proves lockout skips comparison.
        // Keep pinned here so a known classification flip reds; do not exempt new suites.
        "tests/lockout_order_test.ts",
        "tests/sources_body_cap_test.ts",
        "tests/webmcp_admin_forms_test.ts",
      ],
      mentionsOnly: ["tests/listen_test.ts"],
    },
    "src/routes/login.ts": {
      exercises: [
        "tests/account_pages_test.ts",
        // audio-feed-anqjk: the suite whose `app.fetch(new Request("https://…/login"))` at :269 the
        // old quote-free comment strip truncated to `new Request("https:`. Pinned as EXERCISING so
        // that strip cannot come back unnoticed.
        "tests/login_conditional_mediation_test.ts",
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
    },
    "src/routes/admin_telemetry.ts": {
      exercises: ["tests/admin_subpages_test.ts"],
      mentionsOnly: [],
    },
    "src/routes/webauthn.ts": {
      exercises: ["tests/passkeys_test.ts"],
      mentionsOnly: [],
    },
    "src/routes/reports.ts": {
      exercises: ["tests/csp_reporting_test.ts"],
      mentionsOnly: [
        "tests/admin_subpages_test.ts",
        "tests/origin_test.ts",
        "tests/router_csp_report_url_test.ts",
      ],
    },
  };
  assertEquals(
    Object.keys(ABH1_PINNED_CLASSIFICATION).sort(),
    spec.map((route) => route.file).sort(),
    `${population}: every audited route needs a pinned classification`,
  );
  const derived = new Map<string, { exercises: string[]; mentionsOnly: string[] }>();
  for (const route of spec) {
    const candidates = [...sources].filter(([, source]) => route.mentions(source))
      .map(([file]) => file).sort();
    const isLogin = route.file === "src/routes/login.ts";
    const exercises = candidates.filter((file) =>
      exercisesRoute(file, sources.get(file)!, route.paths, isLogin)
    );
    const mentionsOnly = candidates.filter((file) => !exercises.includes(file));
    derived.set(route.file, { exercises, mentionsOnly });
    assert(
      exercises.length > 0,
      `${population}: ${route.file} has no exercising candidate suite; do not narrow`,
    );
    // An exerciser must dispatch through fetch. The sole named exception tests the gate
    // directly by design: its compare spy asserts the comparison was NOT called at lockout.
    // Keep it pinned as EXERCISING so a classification flip reds below; new suites get no
    // exception and must fetch even if they pass a Request to a handler.
    for (const file of exercises) {
      const directGateException = route.file === "src/routes/account_api.ts" &&
        file === "tests/lockout_order_test.ts";
      if (directGateException) {
        assert(
          ABH1_PINNED_CLASSIFICATION["src/routes/account_api.ts"]!.exercises.includes(file),
          `${population}: direct-gate exception must remain pinned as exercising: ${file}`,
        );
        // audio-feed-62lgx: pin the exception's justification - the direct-gate suite must
        // actually invoke the route handler and assert its compare spy on the success path.
        const source = sources.get(file)!;
        assert(
          /\bhandlers\.bootstrap\s*\(/.test(source),
          `${population}: direct-gate exception ${file} must invoke handlers.bootstrap() directly`,
        );
        assert(
          (/compareCalls\s*,\s*4/.test(source) || /compareCalls\s*>\s*0/.test(source)) &&
            /compareCalls\s*,\s*3/.test(source),
          `${population}: direct-gate exception ${file} must assert compareCalls on success and lockout`,
        );
        // audio-feed-dzrx2 / audio-feed-v46l5: everything above is SHAPE, and shape is satisfied
        // by code that never runs - `if (false) { await handlers.bootstrap(...); assertEquals(compareCalls, 4, ...) }`
        // passes all of it. So the exception is also pinned to an observed run: the suite must
        // print the earned proof line its success path emits, validated by directGateProof.
        const proof = await directGateProof();
        assert(
          proof.ok,
          `${population}: direct-gate exception ${file} must PROVE its success path by EXECUTING - ` +
            `expected the suite to print valid earned proof line. Source patterns alone are ` +
            `satisfied by dead code; this check is not. Got: ${proof.detail}`,
        );
      }
      assert(
        directGateException || hasDispatch(sources.get(file)!),
        `${population}: ${file} is classified as exercising ${route.file} but never calls fetch( — a constructed Request that is never dispatched exercises nothing`,
      );
    }
    const named = await nameMatchedTests([route.file]);
    assertEquals(
      (named.get(route.file) ?? []).sort(),
      candidates,
      `${population}: ${route.file} must select the entire URL candidate UNION, including mention-only suites that could grow real handler tests`,
    );
  }
  const drift = Object.entries(ABH1_PINNED_CLASSIFICATION).flatMap(([file, pinned]) => {
    const now = derived.get(file)!;
    return [
      ...pinned.exercises.filter((suite) => !now.exercises.includes(suite))
        .map((suite) => `${file}: ${suite} was EXERCISING, is now mention-only or gone`),
      ...pinned.mentionsOnly.filter((suite) => !now.mentionsOnly.includes(suite))
        .map((suite) => `${file}: ${suite} was MENTION-ONLY, is now exercising or gone`),
    ];
  });
  assertEquals(
    drift,
    [],
    `${population}: classification changed for an already-pinned suite — audit the route's real handler, then update ABH1_PINNED_CLASSIFICATION deliberately. This pin is a snapshot of a static heuristic, not a proof of execution.\n${
      drift.join("\n")
    }`,
  );
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

Deno.test("planTests: deno.json, an UNOBSERVED core file, an UNOBSERVED test helper, and a non-ts asset all fall back", () => {
  // The tests/fixtures.ts row is a helper NO channel observes in this synthetic setup (no importer in
  // GRAPH, no relation entry): the fail-closed fallback for that shape is unchanged (audio-feed-3e4s0).
  // An OBSERVED helper selects its observers instead - pinned in the 3e4s0 test below. The src/router.ts
  // and src/compose/access.ts rows are core files NOTHING reaches in GRAPH: fail-closed to FULL is the
  // zyrug rule for exactly that case (an OBSERVED core file selects its closure - the zyrug test below).
  for (
    const changed of [
      ["deno.json"],
      ["deno.lock"],
      ["src/router.ts"],
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

Deno.test("planTests: an OBSERVED core/hub file selects its closure, crossing hubs (audio-feed-zyrug)", () => {
  // src/app.ts is a hub; GRAPH has tests/app_test.ts importing it directly. The old rule ran FULL by list
  // membership; the zyrug rule selects the observers the walk reaches, crossing hubs because the changed
  // file IS the hub.
  assertEquals(planTests(["src/app.ts"], GRAPH, NO_NAMED).testFiles, ["tests/app_test.ts"]);

  // Transitively: a core file imported by a route reaches the route's own test AND the app-booting test
  // through the hub - every one of them exercises the core file on every request.
  const graph = new Map<string, string[]>([
    ["src/http.ts", ["src/routes/home.ts"]],
    ["src/routes/home.ts", ["src/app.ts", "tests/home_test.ts"]],
    ["src/app.ts", ["tests/app_test.ts"]],
  ]);
  assertEquals(
    planTests(["src/http.ts"], graph, NO_NAMED).testFiles,
    ["tests/app_test.ts", "tests/home_test.ts"],
  );

  // Fail CLOSED, never to nothing: a core file NOTHING reaches still runs the FULL suite, by name.
  const orphan = planTests(["src/config.ts"], graph, NO_NAMED);
  assertEquals(orphan.testFiles, null);
  assert(orphan.reason.includes("no test reaches"), orphan.reason);

  // And a resolver-proven data read covers a core file the graph cannot see (the relation outranks the
  // uncovered fallback): no import edge, one relation entry, that suite selected.
  const withRelation = new Map([["src/config.ts", ["tests/config_reader_test.ts"]]]);
  assertEquals(
    planTests(["src/config.ts"], new Map(), NO_NAMED, withRelation).testFiles,
    ["tests/config_reader_test.ts"],
  );
});

Deno.test("planTests: a whole-tree scan SELECTS the scanner under its tree, and COVERS none of them (sru1b + ngrm6)", () => {
  // sru1b's hole: once a core file had ANY graph observer the scanner's narrow selection went quiet, so a
  // suite that scans all of src/ as TEXT (security_audit's CSP scan) silently dropped out of selection.
  // A directory relation key - bare ("src") or trailing-slash ("src/") - therefore SELECTS the scanner
  // for any change under its tree (the scriptPlan row below). ngrm6's review finding splits the other
  // half of what this row USED to pin: the directory key must not also answer the COVERAGE question -
  // a text scan of a tree proves no suite tests one file in it, so an unreached source file still fails
  // closed to the FULL suite (which runs the scanner anyway: selection was never what the fallback put
  // at stake). audio-feed-a5n0q drew the matching line for data: non-TypeScript files keep scanner
  // coverage, code does not.
  const relations = new Map([
    ["src/", ["tests/tree_scan_test.ts"]],
    ["scripts", ["tests/scripts_scan_test.ts"]],
  ]);
  const orphan = planTests(["src/config.ts"], new Map(), NO_NAMED, relations);
  assertEquals(
    orphan.testFiles,
    null,
    "a directory key must not COVER an unreached source file - the fallback must fire",
  );
  assert(orphan.reason.includes("no test reaches: src/config.ts"), orphan.reason);
  const scriptPlan = planTests(["scripts/tool.ts"], GRAPH, NO_NAMED, relations);
  assertEquals(
    scriptPlan.testFiles,
    ["tests/scripts_scan_test.ts", "tests/tool_test.ts"],
    "a bare directory key still SELECTS the scanner alongside the graph observers",
  );
  // The slash anchor: a bare "src" key must never claim a path outside the tree it scans.
  assertEquals(
    planTests(["src2/config.ts"], new Map(), NO_NAMED, relations).testFiles,
    null,
    "a directory key must not prefix-match a sibling tree (src vs src2)",
  );
});

Deno.test("planTests: the scanned-tree asymmetry - unreached .ts fails closed, scanned .json selects the scanner (audio-feed-ngrm6 + a5n0q, coord ruling)", () => {
  // The review repro, verbatim shape: a whole-src/ scanner relation exists and the changed file is
  // reached by nothing - no import edge, no name match, no exact relation. The old coverage filter
  // asked the prefix-matching suitesObserving(), so the scanner's directory key covered EVERY file
  // under the tree and the fallback never fired: the plan came back [security_audit_test, ...] - a
  // false green on untested code. The fallback must fire and NAME the file.
  const relations = new Map([["src/", ["tests/security_audit_test.ts"]]]);
  const plan = planTests(["src/untested_orphan.ts"], new Map(), NO_NAMED, relations);
  assertEquals(plan.testFiles, null, "an unreached source file must fail closed");
  assert(plan.reason.includes("no test reaches: src/untested_orphan.ts"), plan.reason);

  // THE OTHER HALF OF THE SAME RULING (audio-feed-a5n0q, coord): a .json under the scanned tree is
  // WHOLLY observed by the scanner that text-reads all of src/, so the narrow selection is right -
  // not a missing fallback. Pinned beside half one so neither side can silently flip: code fails
  // closed, data keeps scanner coverage.
  assertEquals(
    planTests(["src/unread_schema.json"], new Map(), NO_NAMED, relations).testFiles,
    ["tests/security_audit_test.ts"],
    "a .json under a scanned tree selects the scanner that text-reads it (genuine content observation)",
  );

  // The seam, on the .ts side: an EXACT relation (a resolver-proven read/execute of the file ITSELF)
  // is coverage, so the plan stays narrow - the scanner (prefix selection) plus the exact observer.
  // This is the seam the fix draws: prefix selects, exact covers.
  const both = new Map([
    ["src/", ["tests/security_audit_test.ts"]],
    ["src/untested_orphan.ts", ["tests/orphan_reader_test.ts"]],
  ]);
  assertEquals(
    planTests(["src/untested_orphan.ts"], new Map(), NO_NAMED, both).testFiles,
    ["tests/orphan_reader_test.ts", "tests/security_audit_test.ts"],
    "an exact relation covers the file and the plan stays narrow",
  );
});

Deno.test("planTests: a tests/ helper selects its OBSERVERS, not the FULL suite (audio-feed-3e4s0)", () => {
  // The bead's repro: tests/fixtures/invocation_death_child.ts is observed by exactly ONE suite and paid
  // the full 159-suite gate under the old blanket "shared test helper" rule.
  // Channel 1 - the import graph: an IMPORTED helper selects the suites that import it, transitively
  // through other helpers.
  const graph = new Map<string, string[]>([
    ["tests/helpers/util.ts", ["tests/helpers/more.ts"]],
    ["tests/helpers/more.ts", ["tests/one_test.ts"]],
  ]);
  const imported = planTests(["tests/helpers/util.ts"], graph, NO_NAMED);
  assertEquals(imported.testFiles, ["tests/fast_gate_subset_test.ts", "tests/one_test.ts"]);

  // Channel 2 - the derived relation: a helper a suite EXECUTES as a child process has no import edge
  // for the graph to walk, so the relation is the only channel that can see it.
  const relations = new Map([["tests/fixtures/child.ts", ["tests/spawner_test.ts"]]]);
  const spawned = planTests(["tests/fixtures/child.ts"], new Map(), NO_NAMED, relations);
  assertEquals(spawned.testFiles, ["tests/fast_gate_subset_test.ts", "tests/spawner_test.ts"]);

  // Neither channel: fail CLOSED - a helper nothing is seen to import, read or execute still runs the
  // full suite, named as uncovered rather than as a class.
  const unobserved = planTests(["tests/helpers/orphan.ts"], new Map(), NO_NAMED);
  assertEquals(unobserved.testFiles, null);
  assert(unobserved.reason.includes("no test reaches"), unobserved.reason);
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

Deno.test("the coverage marker that names nothing is never emitted (p14sc)", () => {
  // PROBLEM: an empty `unmapped:` marker is a WARNING-SHAPED line that makes no claim. The fleet's banner
  // says "COVERAGE WARNING: 0 unmapped changed file(s):" whenever a candidate suite was omitted
  // (bin/fleet-check: `num_unmapped -gt 0 || num_omitted -gt 0`), so a marker this gate emitted with an
  // empty list reads as a coverage warning about nothing - and the channel people need for a genuinely
  // uncovered change is the one that gets ignored.
  assertEquals(unmappedMarker([]), null, "an empty list must produce NO line at all");

  // The non-empty case is unchanged: the host parses it token by token
  // (remote/check-coverage.py: `m_unm.group(1).split()` into `explicit_unmapped`).
  const reporter = /(?:fast-gate:.*?)?unmapped:\s*(.*)/;
  const line = unmappedMarker(["README.md"]);
  assert(line !== null, "a non-empty list must still be marked");
  const match = reporter.exec(line);
  assert(match !== null, line);
  assertEquals(match[1]!.split(/\s+/), ["README.md"]);

  // SOURCE-LEVEL, deliberately (same reason as the `passed:`/`ran:` emission tests): the guard bites only
  // if it is on the emission, so an inline `console.log(suiteMarker("unmapped", ...))` coming back reds.
  const src = Deno.readTextFileSync(new URL("../scripts/fast-check.ts", import.meta.url));
  assertEquals(
    (src.match(/console\.log\(suiteMarker\("unmapped"/g) ?? []).length,
    0,
    "the emission must go through unmappedMarker, which emits nothing for an empty list",
  );
  assert(
    src.includes("unmappedMarker(changed ?? [])"),
    "and the empty-selection path is the caller",
  );
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
    "fast-gate: failed: tests/account_test.ts",
    "fast-gate: failing-test: tests/account_test.ts: account deletion fails",
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
    "fast-gate: failed: tests/corrupt_test.ts",
    "fast-gate: failing-test: tests/corrupt_test.ts: (uncaught error)",
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
    "fast-gate: failed: tests/interrupted_test.ts",
    "fast-gate: failing-test: tests/interrupted_test.ts: interrupted test case",
  ]);
});

Deno.test("failureMarkers emits unextracted diagnostic without fragile heuristics (pkv1)", () => {
  // Single suite known
  assertEquals(
    failureMarkers("", ["tests/single_test.ts"]),
    [
      "fast-gate: failed: tests/single_test.ts",
      "fast-gate: failing-test: tests/single_test.ts: unextracted test",
    ],
  );

  // Multiple suites (cannot guess)
  assertEquals(
    failureMarkers("", ["tests/a_test.ts", "tests/b_test.ts"]),
    ["fast-gate: failing-test: unknown: unextracted test"],
  );
});

Deno.test("audio-feed-2h5f: production fmt covers deno.json's configured include scope", async () => {
  // Read the configured scope at the use site: neither directories nor line width belong
  // in this assertion. Bare `deno fmt --check` delegates both to deno.json.
  const jsonc = await Deno.readTextFile(new URL("../deno.json", import.meta.url));
  const config = JSON.parse(
    jsonc.split("\n").filter((line) => !/^\s*[/][/]/.test(line)).join("\n"),
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

Deno.test("audio-feed-pnw73: the gate type-checks the tree once per run, never twice", async () => {
  // Two facts have to hold together, and either one alone would be a silent loss of coverage:
  //   (1) the gate's test step carries --no-check, i.e. the duplicate type-check is gone;
  //   (2) the step IMMEDIATELY BEFORE it is the whole-tree `deno check`, so nothing is unverified.
  // The bare `test` task is asserted the other way round: it runs no check first, so a --no-check
  // added there would type-check nothing at all. Measured on deno 2.9.7, 2267 tests: removing the
  // duplicate took 201.4s/259.8s down to 191.6s/187.5s with an identical result.
  const jsonc = await Deno.readTextFile(new URL("../deno.json", import.meta.url));
  const config = JSON.parse(
    jsonc.split("\n").filter((line) => !/^\s*[/][/]/.test(line)).join("\n"),
  ) as { tasks?: Record<string, string> };
  const tasks = config.tasks ?? {};
  const gateTask = tasks.gate ?? "";
  assert(gateTask.length > 0, "deno.json must define the gate task");

  const gate = gateTask.split(/\s*&&\s*/);
  const testStep = gate.findIndex((step) => step.startsWith("deno test"));
  assert(testStep > 0, "the gate must still run a test step, after its cheap steps");
  const testStepText = gate[testStep] ?? "";
  assert(
    testStepText.includes("--no-check"),
    `the gate's test step must not repeat the whole-tree type check: ${testStepText}`,
  );
  assertEquals(
    gate[testStep - 1],
    tasks.check ?? "",
    "--no-check is sound only directly after the whole-tree deno check that covers the same roots",
  );
  assert(
    !(tasks.test ?? "").includes("--no-check"),
    "the bare `test` task runs no deno check first, so it must keep type-checking",
  );

  // The fast tier takes the same shortcut for the same reason, and its cheap steps are unconditional
  // (the loop over `[fmtStep, lint, check]` above every TEST_FLAGS call site) - assert both halves.
  const src = await Deno.readTextFile(new URL("../scripts/fast-check.ts", import.meta.url));
  const flags = src.match(/const TEST_FLAGS = \[([^\]]*)\]/)?.[1] ?? "";
  assert(flags.length > 0, "TEST_FLAGS must be a literal array in scripts/fast-check.ts");
  assert(
    flags.includes('"--no-check"'),
    "the fast tier must not repeat the type check its cheap steps already ran",
  );
  assertMatch(
    src,
    /for \(const step of \[fmtStep, \["deno", "lint"\], \["deno", "task", "check"\]\]\)/,
    "the cheap steps must stay unconditional: --no-check is only sound while they always run",
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
    "fast-gate: failed: tests/b_test.ts",
    "fast-gate: failing-test: tests/b_test.ts: some assertion",
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
    "fast-gate: FAILED: lint",
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
        
        // audio-feed-lnnjd audit: these Deno.env.set calls are SOURCE TEXT for the
        // deno-eval child process, not mutations of this test process — nothing
        // concurrently running in this worker can observe them.
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
  let cloneReady = false;
  try {
    const clone = await new Deno.Command("git", {
      args: ["clone", "--shared", "-q", ".", tmpDir],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(clone.code, 0, new TextDecoder().decode(clone.stderr));
    cloneReady = true;
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
          assertEquals(
            await git("ls-files", "-v", path),
            "H " + path,
            "child finally must leave the clone's tracked file with neither index flag",
          );
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
    try {
      if (cloneReady) {
        // Defence if the child exits before its finally; verify the CLONE, never the lane checkout.
        for (const flag of ["--no-assume-unchanged", "--no-skip-worktree"]) {
          await new Deno.Command("git", {
            args: ["update-index", flag, path],
            cwd: tmpDir,
            stdout: "null",
            stderr: "null",
          }).output().catch(() => {});
        }
        const index = await new Deno.Command("git", {
          args: ["ls-files", "-v", path],
          cwd: tmpDir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        assertEquals(index.code, 0, new TextDecoder().decode(index.stderr));
        assertEquals(
          new TextDecoder().decode(index.stdout).trim(),
          `H ${path}`,
          "parent finally must leave the disposable clone with neither index flag",
        );
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
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
      stderr.includes("fast-gate: FAILED: synthetic selection refused"),
      `stderr must report refusal: ${stderr}`,
    );
    assert(
      !stdout.includes("fast-check: ok in"),
      `stdout must NOT contain passing verdict: ${stdout}`,
    );
  },
);

Deno.test(
  "audio-feed-efgpr: --skip-type-check without --fmt-fixture fails closed with exit code 2",
  async () => {
    // The flag exists for the gate-in-gate fixture mode only; on a bare invocation it is a
    // synthetic gate, and synthetic gates refuse at entry with exit 2 (audio-feed-8rz5's contract),
    // so fleet-check (rc=0 = PASS) can never cache a run that skipped the type-check.
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-run=git,deno",
        "--allow-env",
        "scripts/fast-check.ts",
        "--skip-type-check",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);

    assertEquals(
      out.code,
      2,
      `--skip-type-check without --fmt-fixture must exit 2, got ${out.code}: ${stderr}`,
    );
    assert(
      stderr.includes("--skip-type-check refused without --fmt-fixture"),
      `stderr must name the refusal: ${stderr}`,
    );
    assert(
      !stdout.includes("fast-check: ok in"),
      `stdout must NOT contain a passing verdict: ${stdout}`,
    );
  },
);

Deno.test(
  "audio-feed-i8e0z: a --fmt-fixture flag with no usable VALUE is not fixture mode for --skip-type-check",
  async () => {
    // The guard used to read argv PRESENCE: `--fmt-fixture --skip-type-check` passed it while the
    // value resolver swallowed the flag as the fixture path, so fmt failed on a bogus path AND the
    // type-check was skipped. Both orderings must refuse with exit 2.
    for (
      const args of [
        ["--fmt-fixture", "--skip-type-check"],
        ["--skip-type-check", "--fmt-fixture"],
      ]
    ) {
      const out = await new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-run=git,deno",
          "--allow-env",
          "scripts/fast-check.ts",
          ...args,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(
        out.code,
        2,
        `${args.join(" ")} must exit 2 (no usable fixture value): ${stderr}`,
      );
      assert(
        stderr.includes("--skip-type-check refused without --fmt-fixture <path>"),
        `stderr must name the refusal: ${stderr}`,
      );
    }
  },
);

Deno.test("audio-feed-vdys: changedFiles API cannot be short-circuited programmatically", () => {
  // audio-feed-vdys: changedFiles accepts 0 arguments; untrackedOnly option is eliminated
  // entirely from the API so synthetic selection cannot be requested programmatically.
  assertEquals(changedFiles.length, 0, "changedFiles must accept zero arguments");
});

Deno.test("audio-feed-m4vi: a failing test name containing 'passed:' never pollutes the coverage note", () => {
  const log = [
    "fast-gate: ran: tests/a_test.ts tests/b_test.ts",
    "fast-gate: failed: tests/b_test.ts",
    "fast-gate: failing-test: tests/b_test.ts: some assertion with passed: words and spaces",
    "fast-gate: FAILED: lint",
    "fast-gate: coverage: ran 2 suite(s): tests/a_test.ts tests/b_test.ts",
  ].join("\n");

  // The other half of this bead's expectation - "the failing test's name is never scraped as a suite name" -
  // belonged to a local parser of the gate log. That parser is gone: the HOST owns coverage classification
  // (hub ruling, 2026-10-15; deleted with audio-feed-toxg). What stays is the half this repo still owns: the
  // log WE emit has to render one clean note, with no word of a test name in it.
  assertEquals(
    coverageNoteFromLog(log),
    "2 suite(s) ran: tests/a_test.ts tests/b_test.ts",
    "a failing test name containing 'passed:' must not pollute the coverage note",
  );
});

/**
 * The HOST's suite reader (`remote/check-coverage.py`), reproduced only to pin OUR OWN output against it.
 *
 * This is not a coverage classifier and must not become one (hub ruling, 2026-10-15 - the repo's
 * classifier was deleted with audio-feed-toxg): it extracts nothing, it asserts what the gate writes.
 * The rule is: a marker line whose keyword is in this set carries a SUITE LIST, split on whitespace, and
 * each token has quotes/brackets stripped before it is recorded.
 */
const HOST_SUITE_MARKER = /^fast-gate:\s*(?:running|ran|passed|completed|failed):\s*(.*)$/;

function suiteTokensTheHostWouldRecord(log: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const line of log) {
    const m = HOST_SUITE_MARKER.exec(line);
    if (!m) continue;
    for (const raw of m[1]!.split(" ")) {
      const item = raw.replace(/^["',;()[\]{}]+/, "").replace(/["',;()[\]{}]+$/, "");
      if (item && !item.startsWith("-")) tokens.push(item);
    }
  }
  return tokens;
}

Deno.test("garbagenames: a failing run's marker lines hand the host only real suite paths (fleet-zq9cc)", async () => {
  // The EXACT tail of the gate run at .fleet/checks/bc781c0386696d6b4e99d08cd26129515a1b35cf (tree
  // 706d9b87): two suites selected, one red row whose TITLE is prose. Its recorded coverage list was
  // `audio-feed-zy3j: bound budget completion delay exceeds fires invocation mirror terminal when` PLUS
  // the real files - the title's own words, harvested as eleven suites.
  const redRun = [
    "fast-gate: ran: tests/bare_name_relation_test.ts tests/synthesis_claim_lifecycle_test.ts",
    ...failureMarkers(
      `\nrunning 1 test from ./tests/synthesis_claim_lifecycle_test.ts
` +
        `audio-feed-zy3j: terminal completion invocation bound fires when delay exceeds budget (mirror) ... FAILED (45s)

 FAILURES 

` +
        `audio-feed-zy3j: terminal completion invocation bound fires when delay exceeds budget (mirror) => ./tests/synthesis_claim_lifecycle_test.ts:2181:6

FAILED | 367 passed | 1 failed (520s)
`,
      ["tests/bare_name_relation_test.ts", "tests/synthesis_claim_lifecycle_test.ts"],
    ),
    "fast-gate: coverage: ran 2 suite(s): tests/bare_name_relation_test.ts tests/synthesis_claim_lifecycle_test.ts",
  ];

  const recorded = suiteTokensTheHostWouldRecord(redRun);

  // Every token the host would record must BE a suite: a real file in this repo, nothing else.
  for (const suite of recorded) {
    const stat = await Deno.stat(new URL(`../${suite}`, import.meta.url)).catch(() => null);
    assert(
      stat?.isFile === true,
      `'${suite}' was recorded as a suite name but is not a file in the repo - the gate emitted prose on a suite marker line`,
    );
  }

  // The fail-closed tier is NOT narrowed to make that true: the whole selected set is still named,
  // including the suite that failed (audio-feed-bko2q - under-selection is worse than slowness).
  assertEquals(recorded, [
    "tests/bare_name_relation_test.ts",
    "tests/synthesis_claim_lifecycle_test.ts",
    "tests/synthesis_claim_lifecycle_test.ts",
  ]);
  assertEquals(
    redRun.some((l) => l.includes("audio-feed-zy3j:")),
    true,
    "the failing test's NAME must still be in the log - it is moved, not dropped",
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

Deno.test("splitProcessGlobalSuites: carves process-global suites into sequential batch", () => {
  const carvedA = PROCESS_GLOBAL_SUITES[0];
  const carvedB = PROCESS_GLOBAL_SUITES[1];
  assert(carvedA !== undefined && carvedB !== undefined);
  const ordinary1 = "tests/app_test.ts";
  const ordinary2 = "tests/listen_test.ts";
  const ordinary = [ordinary1, ordinary2];

  // (i) a selection containing both carved suites
  const both = splitProcessGlobalSuites([carvedA, ordinary1, carvedB, ordinary2]);
  assertEquals(both.parallelFiles, ordinary);
  assertEquals(both.sequentialFiles, [carvedA, carvedB]);

  // (ii) containing neither
  const neither = splitProcessGlobalSuites(ordinary);
  assertEquals(neither.parallelFiles, ordinary);
  assertEquals(neither.sequentialFiles, []);

  // (iii) containing only one
  for (const carved of PROCESS_GLOBAL_SUITES) {
    const onlyOne = splitProcessGlobalSuites([ordinary1, carved, ordinary2]);
    assertEquals(onlyOne.parallelFiles, ordinary);
    assertEquals(onlyOne.sequentialFiles, [carved]);
  }
});

Deno.test("splitProcessGlobalSuites: every carved suite exists in the fast-gate universe", async () => {
  // (iv) an assertion that every path in PROCESS_GLOBAL_SUITES exists in the fast-gate universe
  // (so a rename reds instead of silently un-carving).
  assert(
    PROCESS_GLOBAL_SUITES.length >= 2,
    "PROCESS_GLOBAL_SUITES must define the expected process-global suites",
  );
  const fastUniverse = new Set(await allTestFiles());
  for (const suite of PROCESS_GLOBAL_SUITES) {
    assert(
      fastUniverse.has(suite),
      `Carved suite '${suite}' must exist in the fast-gate universe (allTestFiles); a rename without updating PROCESS_GLOBAL_SUITES would silently drop the carve-out`,
    );
  }
});

Deno.test("audio-feed-v46l5: (a) direct-gate spawn is bounded and kills a hung child", async () => {
  const start = performance.now();
  // Pass a tight 200ms bound to prove the abort signal kills the process and reports the bound.
  const result = await directGateProof(200, [
    "eval",
    "await new Promise((r) => setTimeout(r, 60_000));",
  ]);
  const elapsed = performance.now() - start;
  assert(!result.ok, "hung child must not succeed");
  assert(
    result.detail.includes("killed by 200ms bound"),
    `detail must report child was killed by bound, got: ${result.detail}`,
  );
  assert(elapsed < 2000, `bound must abort promptly, took ${elapsed}ms`);
});

Deno.test("audio-feed-v46l5: (b) old constants without a nonce red", async () => {
  const result = await directGateProof(DIRECT_GATE_SPAWN_BOUND_MS, [
    "eval",
    'console.log("lockout-order-proof row2: bootstrap status=200 delta=1 total=4 remaining=0");',
  ]);
  assert(!result.ok, "hardcoded values without a nonce must not pass");
  assert(result.detail.includes("unearned or malformed proof line"), result.detail);
});

Deno.test("audio-feed-v46l5: wrong nonce cannot forge a proof", async () => {
  const result = await directGateProof(DIRECT_GATE_SPAWN_BOUND_MS, [
    "eval",
    'console.log("lockout-order-proof row2: bootstrap status=200 delta=1 total=4 remaining=0 nonce=00000000-0000-4000-8000-000000000000");',
  ]);
  assert(!result.ok, "a nonce from another run must not pass");
  assert(result.detail.includes("unearned proof nonce"), result.detail);
});

Deno.test("audio-feed-v46l5: (c) importing the old checksum still cannot forge a proof", async () => {
  const result = await directGateProof(DIRECT_GATE_SPAWN_BOUND_MS, [
    "eval",
    'import { computeProofChecksum } from "./tests/lockout_order_test.ts"; console.log(`lockout-order-proof row2: bootstrap status=200 delta=1 total=4 remaining=0 checksum=${computeProofChecksum(200, 1, 4, 0)}`);',
  ]);
  assert(!result.ok, "old-format checksum line without a nonce must not pass");
  assert(result.detail.includes("unearned or malformed proof line"), result.detail);
});

Deno.test("audio-feed-v46l5: (d) real child echoes this audit's nonce after row 2", async () => {
  const result = await directGateProof();
  assert(result.ok, result.detail);
  assertMatch(result.detail, /nonce=[0-9a-f-]+$/);
});
