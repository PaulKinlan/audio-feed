/**
 * audio-feed-pubd — the fast tier of the test gate.
 *
 * `deno task gate` runs the full suite: ~108s on a fleet VM, of which ~90s is
 * the tests. A one-file change pays for all of it. This script runs the cheap
 * whole-repo checks (fmt, lint, type-check — ~10s together, and type errors
 * propagate transitively so checking only changed files would miss breakage
 * in their importers) plus the tests selected for a change:
 *
 *   - a changed tests/foo_test.ts runs directly;
 *   - a changed src/ file runs every test that reaches it through the repo's
 *     static import graph WITHOUT crossing a hub (src/app.ts, src/compose.ts,
 *     src/compose/*), plus the name-matched tests: the route tests boot the
 *     whole app through the hub (createApp + createHandlers), so the graph
 *     alone cannot see that listen_test.ts is ABOUT listen.ts — the
 *     `<stem>_test.ts` / `<stem>_*_test.ts` / mirrored-subdirectory
 *     convention is what knows. Uncut, the hubs connect every route to every
 *     app-booting test — measured: a listen.ts change selected 58 of 80 files
 *     and saved nothing. Cut + name-matched, the same change selects ~10.
 *   - a changed HUB or cross-cutting file (app/compose/router/http/config/
 *     server/origin) selects the suites that actually reach it: the walk is
 *     allowed to CROSS hubs when the changed file IS the hub (the hub cut
 *     exists to keep ROUTE changes narrow - a test that reaches a route only
 *     through the hub boots the app without exercising that route; a test
 *     that reaches http.ts through the hub exercises http.ts on every
 *     request). Only a core file NOTHING reaches widens to the FULL suite
 *     (audio-feed-zyrug: the hardcoded list cost a 90min bound-killed gate
 *     for a change whose honest observer set is 90 of 159 suites);
 *   - a non-TypeScript file outside src/ and tests/ (a docs/evidence PNG, a shell runner) selects the
 *     suites the DERIVED read relation says read or execute it - the relation is scanned out of the
 *     suites' own code in scripts/test-selection.ts, not listed beside them - and anything the derivation
 *     cannot see runs the FULL suite and names itself (audio-feed-es8y: "not
 *     a .ts file" used to mean "no test can care", which gave a fast PASS on a tree where the full gate
 *     failed);
 *   - a changed tests/ helper selects the suites observed to depend on it - the importers the reverse
 *     graph walks, plus the suites the derived relation names as reading or EXECUTING it (a spawned
 *     fixture has no import edge) - and only a helper NEITHER channel connects to any suite runs the
 *     FULL suite (audio-feed-3e4s0: the old blanket rule cost a one-file fixture the whole gate);
 *   - deno.json/deno.lock changed, or a src/ file no test reaches, also runs
 *     the FULL suite. Safe beats fast.
 *
 * The selection is a PROVEN SUBSET of the full gate's (audio-feed-es8y): the test-file list is derived
 * from scripts/test-selection.ts, which discovers what `deno test` (no file arguments, the tail of
 * `deno task gate`) actually runs, and every run opens with an audit that fails BY NAME when a module the
 * full gate runs can never be selected here. `deno task gate` runs the same audit as its first step, so
 * the drift cannot survive in either direction.
 *
 * This tier is an ITERATION aid for implementer lanes: the merger still runs
 * the full `deno task gate` on the merged union before anything lands, so a
 * selection miss here is caught there, not shipped.
 *
 * Usage:
 *   deno task test:fast          # affected tests for changes vs origin/main + uncommitted
 *   deno task test:fast --all    # force the full suite
 *
 * Exit code is non-zero when any step fails. Wired as CHECK_FAST_CMD in
 * ~/.fleet/check.conf on the fleet VM (VM-local; the durable copy is this
 * script plus the AGENTS.md note).
 */

import {
  auditResolverConfigs,
  auditSelection,
  classifyNonTsChanges,
  type DataReadRelations,
  deriveReadRelationReport,
  discoverFullGateTestFiles,
  GRAPH_CONFIG_FILES,
  inertContradictions,
  isDocumentation,
  isFastGateSelectable,
  isProvablyInert,
  isTestModule,
  type ReadRelationReport,
  resolverConfigInputs,
  suitesObserving,
  universeDrift,
} from "./test-selection.ts";
import { evidenceReadmesAmong, findUnselectedExecutors } from "./evidence-selection.ts";
import { guardNotArmedMessage, prepushGuardStatus } from "./hooks/guard-status.ts";

// The script lives in <repo>/scripts/ by definition; strip that segment.
// (normalise() below is for repo-RELATIVE paths and drops the leading slash.)
const ROOT = import.meta.dirname!.replace(/\/scripts$/, "") + "/";
const CODE_DIRS = ["src", "tests", "scripts"];
/** Walking OUT of these into their importers connects everything to everything. */
const HUBS = new Set(["src/app.ts", "src/compose.ts"]);
const HUB_DIRS = ["src/compose/"];
/** Changing one of these can break any app-booting test: always full suite. */
const CORE = new Set([
  "src/app.ts",
  "src/compose.ts",
  "src/router.ts",
  "src/http.ts",
  "src/config.ts",
  "src/server.ts",
  "src/origin.ts",
]);

// These HTTP route tests boot the app through a hub, so the graph's hub
// cut cannot attribute their handler coverage. These are verified minimum
// readers, supplemented by URL candidates below; unknown routes and routes
// with no present reader still widen to FULL.
// The host reporter's "unmapped" warning is NOT the selector's distinct
// "fast-check: FULL suite (no test reaches: ...)" fallback: observability.ts
// and log.ts were already selected by direct importers without this table.
const BEHAVIOUR_SUITES: ReadonlyMap<string, readonly string[]> = new Map([
  ["src/routes/admin_issues.ts", [
    "tests/admin_subpages_test.ts",
    "tests/webmcp_admin_forms_test.ts",
  ]],
  ["src/routes/admin_subscribers.ts", [
    "tests/admin_subpages_test.ts",
    "tests/webmcp_admin_forms_test.ts",
  ]],
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
]);

// The five hub-cut routes have URL candidates outside their verified HTTP suites.
// Conservatively select EVERY candidate: if a formerly mention-only test starts
// calling the handler, the selector already includes it without a table edit.
const CANDIDATE_ROUTES = new Set([
  "src/routes/admin_telemetry.ts",
  "src/routes/login.ts",
  "src/routes/account_api.ts",
  "src/routes/webauthn.ts",
  "src/routes/reports.ts",
]);

function accountRoutePaths(app: string): string[] {
  const paths = [...app.matchAll(/router\.(?:get|post|delete)\("([^"]+)", account\("[^"]+"\)\);/g)]
    .map((match) => match[1]!);
  if (!paths.length) throw new Error("account() route registration discovery is empty");
  return paths;
}

/** Redact fixture literals, not the selector-test module: new real HTTP tests there remain candidates. */
export function withoutRouteAuditFixture(file: string, source: string): string {
  if (file !== "tests/fast_check_test.ts") return source;
  const marker = 'Deno.test("' +
    "abh1: route registrations discover the complete HTTP test set before narrowing" +
    '", async () => {';
  const start = source.indexOf(marker);
  const end = source.indexOf("\n});", start);
  if (start < 0 || end <= start || source.indexOf(marker, start + marker.length) !== -1) {
    throw new Error("route-reference audit fixture block missing or duplicated");
  }
  return source.slice(0, start) + source.slice(end + 4);
}

function mentionsRouteUrl(file: string, source: string, accountPaths: readonly string[]): boolean {
  switch (file) {
    case "src/routes/account_api.ts":
      return accountPaths.some((path) =>
        source.includes(path.includes(":") ? path.slice(0, path.indexOf(":")) : path)
      );
    case "src/routes/login.ts":
      return /(?<!\/api\/auth)\/login(?=[/?#"'`])/.test(source);
    case "src/routes/admin_telemetry.ts":
      return source.includes("/admin/observability/telemetry");
    case "src/routes/webauthn.ts":
      return source.includes("/.well-known/webauthn");
    case "src/routes/reports.ts":
      return source.includes("/api/reports/csp");
    default:
      return false;
  }
}

const TEST_FLAGS = [
  "--allow-net",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--unstable-kv",
  // audio-feed-pnw73: `deno check main.ts src tests scripts` runs as an unconditional cheap step
  // ABOVE every call site of TEST_FLAGS in this file, so the type-check `deno test` would repeat
  // inside each module is the same one, over the same tree. Measured on deno 2.9.7 with 2267
  // tests: 201.4s / 259.8s with the duplicate, 191.6s / 187.5s without it, same result. This is
  // only sound while the check step stays unconditional - tests/fast_check_test.ts pins that.
  "--no-check",
];

/**
 * Repo paths are always relative POSIX strings, so the tiny bit of joining and
 * normalising this script needs is done by hand: importing @std/path would
 * rewrite deno.lock on FIRST RUN on any lane (the lock did not carry it),
 * and a dirty deno.lock both pollutes the lane's diff and trips this script's
 * own config-changed fallback into the full suite.
 */
function normalise(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Resolve a relative import specifier against the importing file, repo-relative. */
function resolveImport(importer: string, spec: string): string {
  const dir = importer.split("/").slice(0, -1).join("/");
  return normalise(`${dir}/${spec}`);
}

async function git(...args: string[]): Promise<string | null> {
  const out = await new Deno.Command("git", { args, cwd: ROOT, stdout: "piped", stderr: "null" })
    .output();
  // A failed git call must never read as "no changes": that turns a missing
  // or stale origin/main (a fresh lane worktree is exactly that) into a green
  // run that tested nothing.
  if (!out.success) return null;
  return new TextDecoder().decode(out.stdout);
}

/**
 * Fast-check exit-code contract (audio-feed-8rz5):
 * - 0 = REAL selection ran and passed (all selected test suites passed, cheap steps passed).
 * - 1 = REAL selection ran and FAILED (a test suite assertion failed, or a cheap step like fmt/lint failed; fix the code).
 * - 1 also covers the gate REFUSING to run because this clone's pre-push guard is not armed
 *       (audio-feed-p2la): that is a failure of the tree the gate is asked to vouch for, not an
 *       unhonourable invocation, so it is 1 and not 2.
 * - 2 = REFUSED / SYNTHETIC / UNKNOWN (selection issue: committed changes exist in git when --untracked-only was requested,
 *       or synthetic selection active; not a test failure; fix the invocation).
 *       2 also covers --skip-type-check WITHOUT --fmt-fixture (audio-feed-efgpr): that flag exists for the
 *       integration-test fixture mode only, so a bare-gate invocation carrying it is a synthetic gate and
 *       fails closed like any other.
 *       Exiting 2 fails closed so fleet-check (which treats rc=0 as PASS) can NEVER record or cache a synthetic run as PASS.
 *       DO NOT turn 2 into 0.
 * - Note: The script's own tests (tests/fast_check_test.ts) are the ONLY place --untracked-only is passed;
 *   it is an internal test assertion flag, not a supported user invocation. Ambient environment variable
 *   names (IN_FAST_GATE_INTEGRATION_TEST, FAST_GATE_FMT_FIXTURE) are completely absent from executable code.
 */

/** Committed diff vs origin/main plus anything uncommitted or untracked. null = unknown. */
export async function changedFiles(): Promise<string[] | null> {
  // audio-feed-hkco: assume-unchanged and skip-worktree can conceal a tracked mutation from
  // git diff/status. A flagged path is UNKNOWN, not an empty change set, so planTests widens to FULL.
  // -z preserves filenames containing newlines; a failed index query also cannot prove cleanliness.
  const index = await git("ls-files", "-v", "-z");
  if (index === null) {
    console.log(
      "fast-check: change set UNKNOWN (git ls-files -v -z failed); widening to FULL suite",
    );
    return null;
  }
  const hidden = findHiddenTrackedMutations(index);
  if (hidden.length) {
    // The detector existed (audio-feed-tyt5), but was not on the path that decides selection.
    // Print a bounded, escaped sample so a slow full-suite run names its cause without log injection.
    const sample = hidden.slice(0, 3).map((path) => JSON.stringify(path)).join(", ");
    console.log(
      `fast-check: change set UNKNOWN (${hidden.length} tracked index flag(s) may hide mutations: ${sample}${
        hidden.length > 3 ? ", ..." : ""
      }); widening to FULL suite`,
    );
    return null;
  }
  // audio-feed-8rz5 / audio-feed-vdys: Ambient environment variables and programmatic options
  // CANNOT short-circuit changedFiles. All changes (committed, uncommitted, untracked) are always included.
  const committed = await git("diff", "--name-only", "origin/main...HEAD");
  if (committed === null) return null;
  const files = new Set<string>(
    committed.split("\n").map((f) => f.trim()).filter(Boolean),
  );
  const uncommitted = await git("diff", "--name-only", "HEAD");
  if (uncommitted === null) return null;
  for (const f of uncommitted.split("\n")) f.trim() && files.add(f.trim());
  const untracked = await git("ls-files", "--others", "--exclude-standard");
  if (untracked === null) return null;
  for (const f of untracked.split("\n")) f.trim() && files.add(f.trim());
  return [...files];
}

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* tsFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** Static relative imports of one file, resolved to repo-relative paths. */
async function importsOf(path: string): Promise<string[]> {
  const text = await Deno.readTextFile(path);
  const out: string[] = [];
  for (
    const m of text.matchAll(
      /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g,
    )
  ) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec?.startsWith(".")) continue; // only repo-internal edges
    out.push(resolveImport(path, spec));
  }
  return out;
}

/** Reverse import graph over the repo: importer -> imported is inverted. */
export async function reverseGraph(): Promise<Map<string, string[]>> {
  const reverse = new Map<string, string[]>();
  const add = (imported: string, importer: string) => {
    const list = reverse.get(imported) ?? [];
    list.push(importer);
    reverse.set(imported, list);
  };
  for (const dir of CODE_DIRS) {
    for await (const f of tsFiles(`${ROOT}${dir}`)) {
      const rel = f.slice(ROOT.length);
      for (const dep of await importsOf(rel)) add(dep, rel);
    }
  }
  for (const dep of await importsOf("main.ts")) add(dep, "main.ts");
  return reverse;
}

function isHub(file: string): boolean {
  return HUBS.has(file) || HUB_DIRS.some((d) => file.startsWith(d));
}

/**
 * Every test file that can observe one of the changed files.
 *
 * Coverage is judged per CHANGED file, not per node reached mid-walk: the
 * reverse graph from src/routes/listen.ts legitimately passes through app.ts
 * and server.ts into scripts/* (dev tools no test imports), and those interior
 * nodes say nothing about whether the CHANGE is covered.
 *
 * The walk does not cross a hub FOR A NON-HUB START: app.ts/compose.ts
 * import every route, so crossing them selects every app-booting test for
 * any route change, and a test that only reaches the changed file THROUGH
 * the hub boots the whole app but does not exercise that route's behaviour.
 * When the changed file IS a hub or core file the rule inverts (audio-feed-
 * zyrug): a suite that boots through http.ts exercises http.ts on every
 * request, so the walk crosses hubs and the closure is the observer set.
 * scripts/ modules are walked like anything else — a
 * tested script (fast-check.ts itself) must select its test; only a script
 * NOTHING imports is exempt (audio-feed-bqd4). tests/ helpers (fixtures.ts,
 * tests/fixtures/*) are walked too (audio-feed-3e4s0): a helper selects the
 * suites that import it, transitively through other helpers, and one NO test
 * imports is uncovered rather than silently skipped.
 */
export function reachableTests(reverse: Map<string, string[]>, changed: string[]): {
  tests: Set<string>;
  uncovered: string[];
} {
  const tests = new Set<string>();
  const uncovered: string[] = [];

  for (const start of changed) {
    if (/_test\.ts$/.test(start)) {
      tests.add(start);
      continue;
    }
    if (!/^(src\/|scripts\/|tests\/|main\.ts$)/.test(start)) continue; // docs, assets: no tests

    // audio-feed-zyrug: the hub cut below keeps a ROUTE change narrow (a test that reaches the route only
    // through app.ts boots the app without exercising that route's behaviour). When the changed file IS a
    // hub or core file the rule inverts: every suite that boots through it DOES exercise it on every
    // request, so the walk crosses hubs and the closure is the honest observer set (measured on this tree:
    // src/http.ts -> 90 suites, where the hardcoded list ran all 159).
    const crossHubs = isHub(start) || CORE.has(start);

    let covered = false;
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (/_test\.ts$/.test(file)) {
        tests.add(file);
        covered = true;
        continue; // a test file's own importers are not evidence of anything
      }
      for (const importer of reverse.get(file) ?? []) {
        if (!crossHubs && importer !== start && isHub(importer)) continue; // do not cross hubs
        queue.push(importer);
      }
    }
    // Uncovered means "changed code no test can observe":
    // - src/ and main.ts always need coverage;
    // - a scripts/ module with importers but no reachable test cannot be
    //   scoped safely -> full suite;
    // - a scripts/ module NOTHING imports is a standalone dev tool: the
    //   always-run type-check is its gate, zero tests is correct.
    if (!covered && (!start.startsWith("scripts/") || reverse.has(start))) {
      uncovered.push(start);
    }
  }
  return { tests, uncovered };
}

/**
 * Complements the graph with filename conventions, verified handler bindings,
 * and conservative URL candidates for five hub-cut routes. src/routes/listen.ts
 * is covered by tests/listen_test.ts and tests/listen_*_test.ts; src/auth/passkeys.ts
 * additionally by everything in the mirrored tests/auth/ directory.
 */
export async function nameMatchedTests(
  changed: string[],
  testsDir: string = `${ROOT}tests`,
): Promise<Map<string, string[]>> {
  const matched = new Map<string, string[]>();
  const stems: { file: string; stem: string; subdir: string | null }[] = [];
  for (const file of changed) {
    if (!/^(src|scripts)\//.test(file) || !file.endsWith(".ts")) continue;
    const parts = file.split("/");
    stems.push({
      file,
      stem: parts[parts.length - 1]!.replace(/\.ts$/, ""),
      subdir: parts.length > 2 && parts[0] === "src" ? parts.slice(1, -1).join("/") : null,
    });
  }
  if (!stems.length) return matched;

  const candidateFiles = stems.map(({ file }) => file).filter((file) => CANDIDATE_ROUTES.has(file));
  const accountPaths = candidateFiles.includes("src/routes/account_api.ts")
    ? accountRoutePaths(await Deno.readTextFile(`${ROOT}src/app.ts`))
    : [];
  for await (const f of tsFiles(testsDir)) {
    const rel = f.slice(testsDir.length - "tests".length); // tests/...
    if (!rel.endsWith("_test.ts") && !rel.endsWith("-test.ts")) continue;
    const base = rel.split("/").pop()!;
    const testStem = base.replace(/(_test|\.test|\.spec|-test)\.ts$/, "");
    const source = candidateFiles.length
      ? withoutRouteAuditFixture(rel, await Deno.readTextFile(f))
      : "";
    for (const { file, stem, subdir } of stems) {
      const normStem = stem.replace(/[-_]/g, "_");
      const normTestStem = testStem.replace(/[-_]/g, "_");
      const hit = BEHAVIOUR_SUITES.get(file)?.includes(rel) ||
        (CANDIDATE_ROUTES.has(file) && mentionsRouteUrl(file, source, accountPaths)) ||
        normTestStem === normStem ||
        normTestStem.startsWith(`${normStem}_`) ||
        (subdir !== null && rel.startsWith(`tests/${subdir}/`));
      if (hit) matched.set(file, [...matched.get(file) ?? [], rel]);
    }
  }
  return matched;
}

/**
 * The suite marker the fleet's coverage reporter parses.
 *
 * This is not decoration. remote/check-coverage.py in the fleet derives which suites EXECUTED by matching
 * this log, and this script captures the runner's stdout, so on success the log used to say nothing about
 * which suites ran. The reporter then reported every changed file as "unmapped" - a false positive on
 * every lane's gate, which trains people to ignore the warning that exists to catch a genuinely uncovered
 * change (audio-feed-dywc, same class as audio-feed-7jsl).
 *
 * "passed" is emitted only after a run that actually passed; a failing run emits "ran", so the log still
 * says which suites were attempted without ever claiming a pass.
 *
 * The HOST owns coverage classification (hub ruling, 2026-10-15): `bin/fleet-check` computes the
 * authoritative headline verdict, and a repository must NOT keep a diverging classifier or a second parser
 * of this log. The local parser that used to live below this block was deleted with audio-feed-toxg for
 * exactly that reason - do not re-add one. If the host's parse of this log is wrong, that is a host defect
 * to report (audio-feed-toxg filed fleet-zq9cc for one: the `failed:` line's parenthesised test name leaks
 * its words into the recorded suite list).
 */
export function suiteMarker(kind: "passed" | "ran" | "unmapped", files: string[]): string {
  return `fast-gate: ${kind}: ${files.join(" ")}`;
}

/**
 * The suites the gate EXECUTED, in the vocabulary the fleet runner already uses. The runner prints
 * `coverage: ran N suite(s): <files>` for a finished run, so this reuses that wording rather than inventing
 * a second dialect for one concept (coord's guidance on audio-feed-psjb): a reader who has seen the
 * runner's line must not have to learn a second phrasing for the same fact.
 */
export function coverageRan(files: readonly string[]): string {
  return `ran ${files.length} suite(s)${files.length ? `: ${files.join(" ")}` : ""}`;
}

/**
 * The UNIFORM coverage marker (audio-feed-psjb). `passed:` and `ran:` stay exactly as they are - they are a
 * consumed contract, and breaking them to make parsing easier would fix one reader by breaking others - but
 * they mean DIFFERENT things depending on how the run ended, so a reporter that only knows the passing one
 * cannot tell "the gate ran these suites and something failed" from "the gate never got that far". This
 * marker means the same thing on every path: `ran N suite(s)` when the harness executed suites, an explicit
 * `ran 0 suite(s)` when it executed none and that is a FACT (the inert case), and an explicit UNKNOWN when
 * the gate stopped before the harness. A report must never render an inability to know as a zero - a lint
 * failure means the coverage note has NO INFORMATION, not that coverage was empty.
 */
export function coverageMarker(payload: string): string {
  return `fast-gate: coverage: ${payload}`;
}

/**
 * Every test file the fast gate can run, in the rel paths the reporter expects (tests/...).
 *
 * DERIVED from the full gate's universe (audio-feed-es8y) by filtering it, rather than walked
 * independently: two definitions of the same set is how a suite comes to exist that only one gate ever
 * runs. `deno test` with no file arguments (what `deno task gate` ends in) discovers test modules by
 * basename pattern anywhere in the tree, which is a strictly larger rule than this narrowing - so the
 * narrowing is legal only because auditSelection() proves nothing falls outside it, and the gate refuses
 * to start otherwise.
 */
export async function allTestFiles(): Promise<string[]> {
  return (await discoverFullGateTestFiles(ROOT)).filter(isFastGateSelectable);
}

function normaliseTestPath(filePath: string): string {
  let p = filePath.trim();
  if (p.startsWith("file://")) {
    p = p.slice("file://".length);
  }
  if (p.startsWith(ROOT)) {
    p = p.slice(ROOT.length);
  }
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  return p;
}

export interface FailingTest {
  name: string;
  file?: string;
}

/**
 * Extract failing test names and suite paths from test runner output.
 *
 * Deno test formats failures in a summary `FAILURES` section with lines of
 * `<test name> => <file>:<line>:<col>` or `<file> (uncaught error)`.
 * If runner output cannot be parsed cleanly (e.g. killed before formatting),
 * returns empty array rather than inventing fragile heuristics.
 */
export function extractFailingTests(output: string): FailingTest[] {
  // deno-lint-ignore no-control-regex
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const failures: FailingTest[] = [];

  const failuresBlock = clean.match(
    /(?:^|\n)\s*FAILURES\s*\n([\s\S]*?)(?:\n\s*(?:FAILED\b|\n\n)|$)/,
  );
  if (failuresBlock && failuresBlock[1]) {
    for (const line of failuresBlock[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const arrowMatch = trimmed.match(/^(.*)\s+=>\s+([^:]+):(\d+):(\d+)$/);
      if (arrowMatch && arrowMatch[1] && arrowMatch[2]) {
        failures.push({
          name: arrowMatch[1].trim(),
          file: normaliseTestPath(arrowMatch[2]),
        });
        continue;
      }
      const uncaughtMatch = trimmed.match(/^(.*?)\s*\(uncaught error\)$/);
      if (uncaughtMatch && uncaughtMatch[1]) {
        failures.push({
          name: "(uncaught error)",
          file: normaliseTestPath(uncaughtMatch[1]),
        });
        continue;
      }
    }
  }

  // Fallback: match inline "<test name> ... FAILED" if summary block was missing
  if (failures.length === 0) {
    for (const m of clean.matchAll(/(?:^|\n)\s*(.*?)\s+\.\.\.\s+FAILED\b/g)) {
      const name = m[1]?.trim();
      if (name && !name.startsWith("running ")) {
        failures.push({ name });
      }
    }
  }

  return failures;
}

/**
 * Machine-readable failure marker naming the failing suite and test.
 * Structured so log parsers / coverage tools can extract the failing suite
 * while keeping the failing test name prominent in the gate's tail.
 */
export function failureMarker(file: string, testName: string): string {
  return `fast-gate: failed: ${file} (${testName})`;
}

/**
 * Machine-readable STALE marker emitted when the worktree or HEAD changes
 * underneath a running gate (audio-feed-bycd). Prefixes the verdict unmistakably
 * so a superseded run is never mistaken for a test failure.
 */
export function staleMarker(reason: string): string {
  return `fast-gate: STALE: ${reason}, verdict not evaluated`;
}

export interface WorktreeSnapshot {
  headSha: string | null;
  headTree: string | null;
  status: string | null;
}

export async function captureWorktreeSnapshot(): Promise<WorktreeSnapshot> {
  const [headSha, headTree, status] = await Promise.all([
    git("rev-parse", "--short", "HEAD"),
    git("rev-parse", "HEAD^{tree}"),
    git("status", "--porcelain"),
  ]);
  return {
    headSha: headSha?.trim() || null,
    headTree: headTree?.trim() || null,
    status: status !== null ? status : null,
  };
}

/**
 * Detect whether the repository HEAD, tree, or worktree status changed while the
 * gate was executing (audio-feed-bycd).
 */
export function detectStaleRun(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
): string | null {
  if (before.headSha && after.headSha && before.headSha !== after.headSha) {
    return `superseded by ${after.headSha} (started on ${before.headSha})`;
  }
  if (before.headTree && after.headTree && before.headTree !== after.headTree) {
    return `tree changed to ${after.headTree.slice(0, 7)} (started on ${
      before.headTree.slice(0, 7)
    })`;
  }
  if (before.status !== null && after.status !== null && before.status !== after.status) {
    return "worktree modified during gate run";
  }
  return null;
}

/**
 * Detect tracked files with non-standard index flags: 'S' is skip-worktree and any
 * lowercase tag indicates assume-unchanged (including 'h' and combined 's').
 * Accept NUL-separated `git ls-files -v -z` without splitting filenames on newlines;
 * newline-separated input remains supported for the original audio-feed-tyt5 fixture.
 */
export function findHiddenTrackedMutations(lsFilesVOutput: string): string[] {
  const hidden: string[] = [];
  for (const entry of lsFilesVOutput.split(lsFilesVOutput.includes("\0") ? "\0" : "\n")) {
    const m = /^[a-zS] (.+)$/s.exec(entry);
    if (m) hidden.push(m[1]!);
  }
  return hidden.sort();
}

/**
 * Emit failure markers for all failing tests identified in stdout.
 * If no specific failing test could be parsed reliably, emit a diagnostic
 * marker without guessing. If `staleReason` is provided (audio-feed-bycd),
 * emit the STALE marker instead of a false failure line.
 */
export function failureMarkers(
  stdout: string,
  fallbackFiles?: string[],
  staleReason?: string | null,
): string[] {
  if (staleReason) {
    return [staleMarker(staleReason)];
  }
  const failures = extractFailingTests(stdout);
  if (failures.length > 0) {
    return failures.map((f) => {
      const file = f.file ??
        (fallbackFiles && fallbackFiles.length === 1 ? fallbackFiles[0]! : "unknown");
      return failureMarker(file, f.name);
    });
  }
  // When runner stdout could not be parsed for specific test failures (e.g. killed
  // or aborted before formatting failures), do not guess with fragile heuristics:
  // state that it was unextracted.
  if (fallbackFiles && fallbackFiles.length === 1) {
    return [`fast-gate: failed: ${fallbackFiles[0]} (unextracted test)`];
  }
  return ["fast-gate: failed: (unextracted test)"];
}

/**
 * Format command failure output, ensuring BOTH stdout and stderr are preserved,
 * with stdout first (where test runners emit failure details and stack traces)
 * followed by stderr (where runner errors and diagnostic notes land).
 */
export function formatFailureOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  const trimmedStdout = stdout.trimEnd();
  if (trimmedStdout.length > 0) {
    parts.push(trimmedStdout);
  }
  const trimmedStderr = stderr.trimEnd();
  if (trimmedStderr.length > 0) {
    parts.push(trimmedStderr);
  }
  return parts.join("\n");
}

/**
 * Strip ANSI escape sequences, carriage-return progress prefixes, and inner
 * per-test captured stdout blocks (`------- output ------- ... ----- output end -----`)
 * so inner test evaluations (like `$ deno eval ...` inside `fast_check_test.ts`)
 * never leak into outer runner summaries (audio-feed-97m0).
 */
export function stripCapturedTestOutput(stdout: string): string {
  // deno-lint-ignore no-control-regex
  const noAnsi = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const out: string[] = [];
  let inCapturedBlock = false;
  for (const rawLine of noAnsi.split("\n")) {
    const line = rawLine.replace(/^.*\r/, "");
    if (/^\s*-{5,}\s*output\s*-{5,}\s*$/.test(line)) {
      inCapturedBlock = true;
      continue;
    }
    if (/^\s*-{5,}\s*output end\s*-{5,}\s*$/.test(line)) {
      inCapturedBlock = false;
      continue;
    }
    if (!inCapturedBlock) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * The summary line(s) Deno prints when it SKIPS tests rather than running them:
 *
 *     ok | 0 passed | 0 failed | 2 ignored (6ms)
 *
 * (audio-feed-48b7). On a successful run the fast gate prints only its own
 * markers, so this line - the only evidence that a suite ran NOTHING - was
 * invisible in the gate log. That is how the fast gate's own recursion-guard
 * suite came to report "ok" while executing zero assertions.
 *
 * DELIBERATELY BOUNDED to the summary line(s) that carry the ignored count, never
 * the whole stdout. The first version of this passthrough printed `stdout.trim()`
 * WHOLE, which dumps every per-test line for a large successful suite that
 * happens to contain one ignored test (audio-feed-48b7 review: "preserve bounded
 * output where possible"). `[1-9]` and not `\d`: a run with zero ignored tests is
 * an ordinary quiet pass and must stay quiet.
 * Anchored to `^\s*ok\s*\|` outside captured test output blocks so an echoed
 * `$ deno eval ...` command line is never matched as a test summary (audio-feed-97m0).
 */
export function ignoredSummary(stdout: string): string {
  const ignored = /^\s*ok\s*\|.*\|\s*[1-9]\d*\s+ignored\b/;
  return stripCapturedTestOutput(stdout)
    .split("\n")
    .filter((line) => ignored.test(line))
    .join("\n")
    .trim();
}

/**
 * Bounded per-suite test output for a clean `deno test` pass (audio-feed-97m0).
 *
 * Surfaces each suite's `running N test(s) from ...` header line and the final
 * `ok | ...` summary line (while stripping inner `------- output -------` blocks
 * and individual passing test lines). For non-test commands (where no `running N
 * test(s) from ...` header exists), falls back to `ignoredSummary(stdout)` so
 * ordinary non-test commands remain completely quiet on success (pkv1, 48b7).
 */
export function testSuiteSummary(stdout: string): string {
  const cleaned = stripCapturedTestOutput(stdout);
  const suiteLines: string[] = [];
  const summaryLines: string[] = [];
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (/^running\s+\d+\s+tests?\s+from\s+\S+/.test(trimmed)) {
      suiteLines.push(trimmed);
    } else if (/^ok\s*\|/.test(trimmed)) {
      summaryLines.push(trimmed);
    }
  }
  if (suiteLines.length > 0) {
    return [...suiteLines, ...summaryLines].join("\n").trim();
  }
  return ignoredSummary(stdout);
}

/**
 * audio-feed-dp30: Check whether `testFile` has a real static or dynamic relative
 * import/export reference to `targetFile`, resolving specifiers to normalized
 * repo-relative paths rather than matching bare stems against directory segments.
 */
export function hasImportReference(
  testFile: string,
  testSource: string,
  targetFile: string,
): boolean {
  const normTest = normalise(testFile);
  const normTarget = normalise(targetFile);
  const code = testSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  for (
    const m of code.matchAll(
      /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g,
    )
  ) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec?.startsWith(".")) continue;
    if (resolveImport(normTest, spec) === normTarget) {
      return true;
    }
  }
  return false;
}

/**
 * audio-feed-dp30: Check whether `testFile` genuinely executes or reads `targetFile`
 * by path (or via derived `readRelations`), rather than matching a bare stem inside
 * an arbitrary function call such as `run({ id: "s1", kind: "synthesis" })`.
 */
export function hasExecReference(
  testFile: string,
  testSource: string,
  targetFile: string,
  readRelations: DataReadRelations = new Map(),
): boolean {
  const normTest = normalise(testFile);
  const normTarget = normalise(targetFile);
  if (readRelations.get(normTarget)?.includes(normTest)) {
    return true;
  }
  const code = testSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  // Match explicit URL or file-read/Command string literals that resolve to normTarget
  for (
    const m of code.matchAll(
      /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)|(?:Deno\.(?:Command|readTextFile|readTextFileSync|readFile|readFileSync|stat|statSync)|run)\s*\(\s*(?:\[\s*)?["']([^"']+)["']/g,
    )
  ) {
    const rawPath = m[1] ?? m[2];
    if (!rawPath) continue;
    const resolved = rawPath.startsWith(".")
      ? resolveImport(normTest, rawPath)
      : normalise(rawPath);
    if (resolved === normTarget) {
      return true;
    }
  }
  // Also check explicit repo-relative path literal (with at least one slash and extension)
  // passed inside a Deno.Command args array or script constant when targetFile is in scripts/
  if (
    normTarget.includes("/") && (normTarget.startsWith("scripts/") || !normTarget.endsWith(".ts"))
  ) {
    const escaped = normTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const repoPathRegex = new RegExp(`["'\`/]${escaped}["'\`]`);
    if (repoPathRegex.test(code)) {
      return true;
    }
  }
  return false;
}

export interface CandidateSearchOptions {
  reverse?: Map<string, string[]>;
  named?: Map<string, string[]>;
  readRelations?: DataReadRelations;
}

/**
 * audio-feed-dp30: Find candidate test suites for `targetFile` without false positives
 * from directory path segments (`../src/synthesis/limits.ts`) or string literal values
 * (`run({ kind: "synthesis" })`).
 */
export function findCandidateTestsForFile(
  targetFile: string,
  testSources: ReadonlyMap<string, string>,
  options: CandidateSearchOptions = {},
): string[] {
  const normTarget = normalise(targetFile);
  const candidates = new Set<string>();

  if (isTestModule(normTarget) && testSources.has(normTarget)) {
    candidates.add(normTarget);
  }
  if (options.reverse) {
    const { tests } = reachableTests(options.reverse, [normTarget]);
    for (const t of tests) {
      if (testSources.has(t)) candidates.add(t);
    }
  }
  for (const t of options.named?.get(normTarget) ?? []) {
    if (testSources.has(t)) candidates.add(t);
  }
  for (const t of options.readRelations ? suitesObserving(normTarget, options.readRelations) : []) {
    if (testSources.has(t)) candidates.add(t);
  }

  for (const [suite, source] of testSources.entries()) {
    const normSuite = normalise(suite);
    if (hasImportReference(normSuite, source, normTarget)) {
      candidates.add(normSuite);
      continue;
    }
    if (hasExecReference(normSuite, source, normTarget, options.readRelations)) {
      candidates.add(normSuite);
    }
  }

  return [...candidates].sort();
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  onOutput?: (msg: string) => void;
}

export async function run(
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  console.log(`$ ${args.join(" ")}`);
  const cwd = options.cwd ?? ROOT;
  const out = await new Deno.Command(args[0]!, { args: args.slice(1), cwd }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success) {
    const formatted = formatFailureOutput(stdout, stderr);
    if (formatted.length > 0) {
      if (options.onOutput) {
        options.onOutput(formatted);
      } else {
        console.error(formatted);
      }
    }
  } else {
    // audio-feed-48b7 / audio-feed-97m0: surface bounded per-suite test output
    // (`running N tests from ...` + `ok | ...`) for test runs, and ignored-count
    // summary lines otherwise, while keeping non-test commands quiet on success.
    const summary = testSuiteSummary(stdout);
    if (summary.length > 0) {
      if (options.onOutput) {
        options.onOutput(summary);
      } else {
        console.log(summary);
      }
    }
  }
  return { code: out.code, stdout, stderr };
}

/**
 * The whole selection decision, pure so the tests can pin every fallback:
 * `testFiles: null` means "run the FULL suite".
 */
/**
 * FAIL-SAFE DIRECTION (coord's condition on the detector, audio-feed-es8y): a derivation engine inside the
 * gate may not fail OPEN. If it cannot run - an argument it cannot resolve, a call site it does not model,
 * an internal error - the gate must WIDEN to the full suite rather than select from a relation it could not
 * compute, because a detector that fails open puts the silent-green hole back inside the component added to
 * close it. So this never throws: it returns the reason, and main() turns that into the full suite. It is
 * EXTRACTED rather than inlined so a test can pass a throwing function and pin the failure mode, which a
 * transcript from a mutated run cannot do.
 */
export async function deriveOrWiden(
  derive: () => Promise<DataReadRelations>,
): Promise<{ relations: DataReadRelations; failure: string | null }> {
  try {
    return { relations: await derive(), failure: null };
  } catch (error) {
    return {
      relations: new Map(),
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether one unresolved hint could hide a read of an INERT-ELIGIBLE file (audio-feed-lm4d).
 *
 * The guard this feeds exists to protect the inert class, and the inert class is markdown (isDocumentation).
 * A fragment (the suffix after an interpolation, ReadRelationReport.unattributed) that names nothing and has
 * some other extension cannot hide an inert-eligible read: a change to a `.json`, `.kv` or `.html` file is
 * never inert, it is `unclassified` and runs the full suite anyway. A fragment with NO extension is a possible
 * directory prefix, which can contain markdown, so it still blocks - and a markdown fragment still blocks.
 * The safe direction is kept exactly where it can still buy something.
 */
export function couldHideInertRead(hint: string): boolean {
  return hint.endsWith("/") || isDocumentation(hint);
}

/**
 * Whether a fragment could BE the file being changed - the only way a fragment can make the inert class
 * unsafe (audio-feed-7l9m).
 *
 * A fragment is the suffix after an interpolation: a path the detector could not resolve, `state.json` or
 * `digest.md`. The question the guard asks is "could a change I am being told to classify as inert be the
 * thing this read consumes?", and a change can only touch a file in the tree - so a markdown fragment blocks
 * only when the change HAS that basename. A directory-shaped fragment (`docs/`) still blocks, because any
 * file under it could be the change.
 *
 * This pairing is what keeps the correction from the other side honest. `digest.md` is a temp-directory read
 * whose base is an arrow-callback PARAMETER (`withTempDir(async (dir) => ...)`), so the detector cannot prove
 * it is out-of-repo and must not suppress it - and it must not pay the full suite for it either, because a
 * change to `docs/ingest.md` cannot be that file.
 */
export function couldBeTheChangedFile(hint: string, changed: ReadonlyArray<string>): boolean {
  if (hint.endsWith("/")) return true;
  return changed.some((file) => file === hint || file.endsWith(`/${hint}`));
}

/** The same fail-safe for the REPORTING derivation, which carries the incompleteness signal with it. */
export async function deriveOrWidenReport(
  derive: () => Promise<ReadRelationReport>,
): Promise<{ report: ReadRelationReport; failure: string | null }> {
  try {
    return { report: await derive(), failure: null };
  } catch (error) {
    return {
      report: {
        relations: new Map(),
        unresolved: [],
        unattributed: [],
        outOfRepo: [],
        unclassified: [],
        computedImportSuites: [],
      },
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The plan a failed derivation forces: everything, with the failure itself as the reason. */
export function planForFailedRelation(failure: string): { testFiles: null; reason: string } {
  return { testFiles: null, reason: `the data read relation could not be derived (${failure})` };
}

export function planTests(
  changed: string[],
  reverse: Map<string, string[]>,
  named: Map<string, string[]>,
  readRelations: DataReadRelations = new Map(),
  configPaths: readonly string[] = [],
  unresolvedReads: readonly string[] = [],
  computedImportSuites: readonly string[] = [],
): { testFiles: string[] | null; reason: string } {
  // The family list is a NET; the DERIVED set of config files the resolver actually reads (configPaths) is
  // what keeps it honest - a resolver input the family does not name still forces the full suite.
  const graphConfig = changed.filter((f) => configPaths.includes(f) || GRAPH_CONFIG_FILES.test(f));
  if (graphConfig.length) {
    return {
      testFiles: null,
      reason: `module-graph config changed: ${
        graphConfig.join(", ")
      } (any suite's resolution may have moved)`,
    };
  }

  const codeChanged = changed.filter((f) => f.endsWith(".ts"));

  // audio-feed-40ch FOUND THIS BY MEASURING THE PLANNER RATHER THAN THE RELATION: a guard here used to return
  // the FULL suite for every non-.ts file under src/ or tests/ BEFORE the relation below was consulted, which
  // made the relation's entries for exactly those paths unreachable - a change to src/assets/admin.css ran all
  // 108 suites even after the relation named the one suite that reads it. That contradicts the ordering rule
  // this function is built on ("the derived relation is consulted FIRST and outranks every category
  // heuristic"), so the guard is gone: non-.ts content is classified below, where a path a suite is DERIVED to
  // read selects that suite, and a path nothing is derived to read lands in `unclassified` and still runs the
  // full suite with its own name in the reason. The import graph cannot see any of it either way, which is
  // why the relation - not the graph - is what decides.
  // Non-TypeScript OUTSIDE src/ and tests/ (docs, evidence, tooling, generated exports) is the case that
  // produced a fast-gate PASS with a full-gate FAIL on the same tree (audio-feed-es8y): a 200KB
  // docs/evidence/*.png selected ZERO suites while tests/evidence_size_test.ts asserted its byte budget.
  // The relation is DERIVED from the suites (scripts/test-selection.ts) rather than listed here, so a suite
  // that starts reading a new data file is covered without anyone editing a selection table. Anything the
  // derivation cannot see runs the FULL suite and names itself. THE ORDERING RULE: the derived relation is
  // consulted FIRST and outranks every category heuristic - a path a suite is seen to read is a real input
  // whatever it looks like (audio-feed-38sn), and inertContradictions() below makes an inversion of that
  // order a NAMED failure instead of a silent empty selection.
  const data = classifyNonTsChanges(changed, readRelations);
  if (data.unclassified.length) {
    return {
      testFiles: null,
      reason:
        `non-TypeScript file(s) with no derived reader (nothing is declared unread, so an unread path always runs the FULL suite): ${
          data.unclassified.join(", ")
        }`,
    };
  }

  // audio-feed-zyrug: a core/hub file (app/compose/router/http/config/server/origin) used to widen EVERY
  // change to the FULL suite by list membership. The list's intent - a hub change can break any suite that
  // boots through it - is answered precisely by the graph: the suites that boot through it ARE the closure,
  // and reachableTests crosses hubs for exactly these starts (the hub cut stays for route changes, where
  // booting through the hub exercises the app but not the route). What still widens is a core file NOTHING
  // reaches (stillUncovered below), plus the named-convention and proven data-read suites merged below.
  // (audio-feed-3e4s0 took the same step for tests/ helpers: observed through the graph walk - which walks
  // tests/ starts transitively through other helpers - and the relation, never widened by class.)

  if (!codeChanged.length) {
    if (data.suites.length) {
      const selected = new Set(data.suites);
      if (changed.some((f) => f.startsWith("tests/"))) {
        selected.add("tests/fast_gate_subset_test.ts");
      }
      return {
        testFiles: [...selected].sort(),
        reason: `data file(s) observed by: ${[...selected].join(", ")}`,
      };
    }
    // audio-feed-es8y condition 2: an empty selection must never read like a pass. It is only allowed when
    // EVERY changed file is documentation that NO suite is derived to read (audio-feed-r9fe removed the
    // declarations, so markdown is the only inert class left). Anything else gets the full suite and names
    // itself.
    // Defence in depth for the ordering rule (audio-feed-38sn): classifyNonTsChanges() asks the relation
    // first, so this cannot be reached today - and if a future change inverts that order, the answer must
    // still not be an empty pass. It becomes the FULL suite, with the contradiction named.
    // The guard reads the CLASSIFIER'S INERT BUCKET, not a predicate of its own (audio-feed-t0sp).
    const inertWithReaders = inertContradictions(data.inert, readRelations);
    if (inertWithReaders.length) {
      return {
        testFiles: null,
        reason:
          `ORDERING BUG: path(s) treated as inert documentation while the derived relation names a reader: ${
            inertWithReaders.join(", ")
          } (the derived relation outranks the documentation heuristic)`,
      };
    }
    // THE INERT CLASS IS UNREACHABLE WHILE THE RELATION IS INCOMPLETE (audio-feed-q0ky, coord's decision
    // (b)). The rule this branch applied - "markdown that no suite is DERIVED to read selects nothing" -
    // treats an INCOMPLETENESS as a NEGATIVE: it cannot tell "nothing reads this file" from "some suite reads
    // something here and I could not confirm what", and it published the second as the first. That is the same
    // defect as the reporter printing `unmapped` for a run that executed every suite, and the same as the
    // blank admin cell: a report must not render an inability to know as a fact. So while the detector has
    // unresolved hints, NO file may be classified inert and the run widens to the full suite - NAMED, so a
    // slower gate is explainable rather than mysterious.
    if (unresolvedReads.length && data.inert.length && !data.unclassified.length) {
      return {
        testFiles: null,
        reason:
          `the read relation is INCOMPLETE (${unresolvedReads.length} unresolved read path hint(s): ${
            unresolvedReads.slice(0, 3).join(", ")
          }${unresolvedReads.length > 3 ? ", ..." : ""}), so no file may be called inert: ${
            changed.join(", ")
          }`,
      };
    }
    if (isProvablyInert(changed, data)) {
      return {
        testFiles: [],
        reason: `no test-observable change (inert, no suite is derived to read it: ${
          data.inert.join(", ")
        })`,
      };
    }
    return {
      testFiles: null,
      reason:
        `nothing selected and the change is not inert documentation, so nothing can be claimed about it: ${
          changed.join(", ")
        }`,
    };
  }

  const { tests, uncovered } = reachableTests(reverse, codeChanged);
  for (const list of named.values()) for (const f of list) tests.add(f);
  // A data change (a screenshot, a document the app serves) rides alongside the code change.
  for (const suite of data.suites) tests.add(suite);
  // The second observation channel (audio-feed-3e4s0 for tests/ helpers, extended to every code change
  // by audio-feed-zyrug): a suite that READS a changed file as data or EXECUTES it as a child process has
  // no import edge for the graph to walk, but the derived relation names it when the read is resolver-
  // proven (tests/fixtures/invocation_death_child.ts -> the suite that spawns it; a source-scanner suite
  // reading a src/*.ts as text -> that suite).
  for (const file of codeChanged) {
    for (const suite of suitesObserving(file, readRelations)) tests.add(suite);
  }

  // audio-feed-x4kc: Any change under tests/ can alter what a suite reads (or change test assertions/invariants
  // that relation-policing suites depend on) without touching scripts/test-selection.ts.
  // Rule (a): When any file under tests/ changes, always select tests/fast_gate_subset_test.ts so that
  // changes to test read relations or test-suite discovery immediately verify the relation invariants.
  if (changed.some((f) => f.startsWith("tests/"))) {
    tests.add("tests/fast_gate_subset_test.ts");
  }

  // audio-feed-8kiar: a suite holding a COMPUTED dynamic import (the specifier resolves at runtime) is a
  // reader nothing can attribute - the old hardcoded FULL fallback used to cover exactly this shape, and
  // zyrug's removal of it means a name-matched observer now silently hides the drop. Fail closed per
  // suite, which is the narrowest loud answer: the suite declares nothing about what it reads, so the
  // only sound claim is that it may read ANYTHING code-shaped. A docs-only change still selects nothing
  // (codeChanged is empty), and the escape is in the suite author's hands: a literal specifier turns this
  // back into an ordinary edge (followed by both graphs), or a whole-tree scan declares its scope
  // (audio-feed-sru1b's directory relation).
  const computedImportNote = codeChanged.length && computedImportSuites.length
    ? ` + computed-import (selected for every code change): ${computedImportSuites.join(", ")}`
    : "";
  if (codeChanged.length) {
    for (const suite of computedImportSuites) tests.add(suite);
  }

  // Property 1 in the narrow case (audio-feed-es8y): a selected module that is NOT in the full gate's
  // universe would make the fast gate run something the full gate never runs - `tests/foo-test.ts` is the
  // name-matching convention but not a Deno discovery pattern, so selecting it would be the mirror image of
  // the gap this bead is about. Unknown coverage runs everything.
  const outsideUniverse = [...tests].filter((f) => !isFastGateSelectable(f));
  if (outsideUniverse.length) {
    return {
      testFiles: null,
      reason: `test module(s) outside the fast gate's selectable universe: ${
        outsideUniverse.join(", ")
      }`,
    };
  }
  // A file with name-matched tests is covered even when the graph cannot
  // see it (the route tests boot the app through the hub). Any file is
  // covered the same way when the derived relation names a suite that reads or
  // executes it (audio-feed-3e4s0 for helpers, audio-feed-zyrug for src) -
  // the graph cannot see a spawn or a resolver-proven data read.
  const stillUncovered = uncovered.filter((f) =>
    !named.get(f)?.length && !suitesObserving(f, readRelations).length
  );
  if (stillUncovered.length) {
    return { testFiles: null, reason: `no test reaches: ${stillUncovered.join(", ")}` };
  }
  const dataNote = data.suites.length ? ` + data: ${data.suites.join(", ")}` : "";

  // Condition 2 again, for the case that reaches here: a changed .ts file the graph cannot connect to any
  // suite (a standalone scripts/ module nothing imports) selects nothing. The old carve-out treated that
  // as "the type-check is its gate" and returned a silent empty pass, which is indistinguishable from
  // "something ran and passed" (audio-feed-es8y; measured: scripts/smoke.ts -> 0 suites). A .ts change is
  // never inert by declaration, so it gets the full suite.
  if (!tests.size) {
    return {
      testFiles: null,
      reason: `no suite is mapped to ${
        codeChanged.join(", ")
      } and a TypeScript change is not inert by declaration`,
    };
  }
  return {
    testFiles: [...tests].sort(),
    reason: `affected by: ${codeChanged.join(", ")}${dataNote}${computedImportNote}`,
  };
}

/** The fixture is the only positional fmt path; production delegates scope to deno.json fmt.include. */
export function formatCheckStep(fmtFixture?: string | null): string[] {
  return ["deno", "fmt", "--check", ...(fmtFixture ? [fmtFixture] : [])];
}

if (import.meta.main) {
  // audio-feed-p2la: the guard is armed and verified by the FIRST steps of both gate tasks
  // (`deno task hooks:install && deno task hooks:verify`). Assert it here as well — a gate that goes
  // green while the guard is absent is the exact defect this check closes — because THIS is the call
  // site that covers a bare `deno run scripts/fast-check.ts` and a gate task whose verify step has
  // been deleted, both of which the task-level step cannot speak for. (The block that used to sit
  // here launched the installer behind a permission test:fast never grants and discarded the child's
  // exit status, so nothing was ever installed and nothing was ever said about it.)
  const prepushGuard = await prepushGuardStatus(ROOT);
  if (prepushGuard.state === "not-armed") {
    console.error(`fast-gate: failed: ${guardNotArmedMessage(prepushGuard)}`);
    Deno.exit(1);
  }
  if (prepushGuard.state === "not-a-worktree") {
    console.error(
      "fast-gate: pre-push guard NOT armed (audio-feed-p2la): not a git worktree, so this tree cannot push and there is nothing to guard; continuing.",
    );
  }

  const forceAll = Deno.args.includes("--all");
  const started = performance.now();

  if (Deno.args.includes("--untracked-only")) {
    // audio-feed-8rz5: Any synthetic selection must fail closed immediately with exit code 2
    // so no automated gate or reader (e.g. fleet-check:430) can ever record or cache it as PASS.
    console.error(
      "fast-gate: failed: synthetic selection refused — --untracked-only is not a supported gate mode (audio-feed-8rz5)",
    );
    Deno.exit(2);
  }

  // audio-feed-efgpr: --skip-type-check is an EXPLICIT argv opt-out (never an environment variable,
  // per audio-feed-8rz5) that exists for ONE caller: the gate-in-gate integration suite
  // (tests/fast_gate_fmt_test.ts), whose disposable clone holds a tree byte-identical to the one the
  // outer gate already type-checked, so the in-clone `deno task check` is ~4 minutes of cold-cache
  // duplicate work per row. It is honoured ONLY together with --fmt-fixture, the flag that already
  // marks an integration-test invocation; any other invocation carrying it is a synthetic gate and
  // fails closed with exit 2, here at entry, before any work. No task (gate, test:fast) passes either
  // flag, so a production run can never skip the check, and when it IS honoured the run says so in
  // plain text (below) rather than passing quietly.
  //
  // audio-feed-i8e0z: "fixture mode" means a usable fixture VALUE, not the flag's presence -
  // `--fmt-fixture --skip-type-check` used to pass this guard (presence) while the value resolver
  // below swallowed the flag as the fixture path, so fmt failed on a bogus path AND the skip was
  // honoured. Resolve the value FIRST, here at entry, and let the guard judge that. A value that is
  // itself a flag (`--...`) is not a value.
  const fmtFixtureIdx = Deno.args.indexOf("--fmt-fixture");
  const fmtFixture = fmtFixtureIdx !== -1 && fmtFixtureIdx + 1 < Deno.args.length &&
      !Deno.args[fmtFixtureIdx + 1]!.startsWith("--")
    ? Deno.args[fmtFixtureIdx + 1]
    : null;
  const skipTypeCheck = Deno.args.includes("--skip-type-check");
  if (skipTypeCheck && !fmtFixture) {
    console.error(
      "fast-gate: failed: --skip-type-check refused without --fmt-fixture <path> — skipping the type-check is honoured only for the integration-test fixture mode (audio-feed-efgpr, audio-feed-i8e0z)",
    );
    Deno.exit(2);
  }

  // audio-feed-es8y property 2, checked BEFORE anything else so a selection gap is a NAMED failure at the
  // start of the run rather than a suite that quietly never runs again. The full gate runs this audit too
  // (first step of `deno task gate`), so drift cannot survive in either direction.
  const fullGateTestFiles = await discoverFullGateTestFiles(ROOT);
  // ONE walk, and everything below derives from this value: the audit, the read relation, the selection and
  // the full-suite fallback all describe the same universe. The cross-check against allTestFiles() is what
  // keeps that true if the exported builder is ever changed to walk differently (audio-feed-es8y).
  const fastUniverse = fullGateTestFiles.filter(isFastGateSelectable);
  const selectionAudit = auditSelection(fullGateTestFiles);
  if (!selectionAudit.ok) {
    console.error(selectionAudit.message);
    console.log(
      coverageMarker("UNKNOWN - the gate stopped before the test harness: selection audit failed"),
    );
    Deno.exit(1);
  }
  const drift = await (async () => {
    try {
      return universeDrift(fastUniverse, await allTestFiles());
    } catch (error) {
      // The cross-check itself failing is not "unknown" - it is "we could not verify", so it stops the run.
      return `fast-gate: SELECTION CROSS-CHECK FAILED (audio-feed-es8y): ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  })();
  if (drift) {
    console.error(drift);
    console.log(
      coverageMarker("UNKNOWN - the gate stopped before the test harness: universe drift"),
    );
    Deno.exit(1);
  }
  // The audit line's two numbers are CHECKED, not merely printed (coord: "a printed-but-unchecked number is
  // a comment with extra steps"). They are equal by construction today - same walk, same predicate - which is
  // exactly the kind of promise this bead replaces with a refusal.
  const auditUniverseDrift = universeDrift(fastUniverse, selectionAudit.fastGateUniverse);
  if (auditUniverseDrift) {
    console.error(`fast-gate: AUDIT/RUN UNIVERSE MISMATCH (audio-feed-es8y):
${auditUniverseDrift}`);
    console.log(
      coverageMarker("UNKNOWN - the gate stopped before the test harness: audit mismatch"),
    );
    Deno.exit(1);
  }
  // The read relation is derived once per run: which data files the suites read or execute. A detector that
  // cannot run widens (see deriveOrWiden) rather than answering "no read found".
  const { report: relationReport, failure: relationFailure } = await deriveOrWidenReport(() =>
    deriveReadRelationReport(ROOT, fastUniverse)
  );
  const readRelations = relationReport.relations;
  const unresolvedReads = relationReport.unresolved;
  // The change set is resolved HERE, because what a fragment can hide depends on it (audio-feed-7l9m).
  const changed = await changedFiles();
  // What disables the inert class for this run: authored-path misses (ALL of them) plus the fragments that
  // could still hide an inert-eligible read (couldHideInertRead above) AND could be the file being changed
  // (couldBeTheChangedFile). Fragments that cannot are PRINTED below - dropping a hint silently is what let an
  // unreadable universe be described as inert (audio-feed-q0ky) - but they do not widen every later change,
  // which is what made a docs-only edit pay the full suite.
  const inertBlockingReads = [
    ...unresolvedReads,
    ...relationReport.unattributed.filter((hint) =>
      couldHideInertRead(hint) && couldBeTheChangedFile(hint, changed ?? [])
    ),
  ];
  const inertNeutralFragments = relationReport.unattributed.filter((hint) =>
    !inertBlockingReads.includes(hint)
  );
  if (inertBlockingReads.length) {
    // SAID OUT LOUD, because this is what disables the inert class for this run: a reader who sees a FULL
    // suite on a docs-only change must be able to see WHY rather than infer it (audio-feed-q0ky).
    console.log(
      `fast-gate: read relation INCOMPLETE: ${inertBlockingReads.length} read path hint(s) do not name anything in the tree (${
        inertBlockingReads.slice(0, 3).join(", ")
      }${
        inertBlockingReads.length > 3 ? ", ..." : ""
      }) - no file may be classified inert, so a change otherwise treated as inert widens to the FULL suite`,
    );
  }
  // Reported for the same reason the INCOMPLETE line is (audio-feed-lm4d): these hints were dropped as
  // out-of-repo, and a dropped hint that says nothing is how an unreadable universe got described as inert.
  // They do NOT block the inert class - a hint based outside the repository cannot name a file a change
  // touches - which is why this line is informational and the one above is not.
  if (relationReport.outOfRepo.length) {
    console.log(
      `fast-gate: read relation: ${relationReport.outOfRepo.length} read path hint(s) sit outside the repository (OS temp or $HOME base) and are not repo paths: ${
        relationReport.outOfRepo.slice(0, 3).join(", ")
      }${relationReport.outOfRepo.length > 3 ? ", ..." : ""}`,
    );
  }
  if (inertNeutralFragments.length) {
    console.log(
      `fast-gate: read relation: ${inertNeutralFragments.length} path FRAGMENT(s) after an interpolation name nothing in the tree and do not widen (not markdown, or not the file being changed): ${
        inertNeutralFragments.slice(0, 3).join(", ")
      }${inertNeutralFragments.length > 3 ? ", ..." : ""}`,
    );
  }
  // The third bucket (audio-feed-snww, audio-feed-3ttu): runtime-assembled read suffixes that NO OTHER BUCKET
  // accounts for - not a repo path, not a fragment, not out-of-repo. It is defined by "unaccounted for" rather
  // than by a shape, because a shape test always has a silent complement (`notes+draft`, `draft#1` and `déjà` were
  // each in NO bucket at all). It neither enters the relation nor blocks the inert class - a member cannot be the
  // markdown file a change touches - so this line is informational and the INCOMPLETE line above is not.
  if (relationReport.unclassified.length) {
    console.log(
      `fast-gate: read relation: ${relationReport.unclassified.length} runtime-assembled read hint(s) are UNCLASSIFIED (not a repo path, not a fragment, not out-of-repo) and are reported rather than dropped in silence: ${
        relationReport.unclassified.slice(0, 3).join(", ")
      }${relationReport.unclassified.length > 3 ? ", ..." : ""}`,
    );
  }
  if (relationReport.computedImportSuites.length) {
    console.log(
      `fast-gate: read relation: ${relationReport.computedImportSuites.length} suite(s) hold COMPUTED IMPORT sites (the specifier resolves at runtime, so nothing can prove what they read - they are selected for every code change until a specifier is a literal): ${
        relationReport.computedImportSuites.slice(0, 3).join(", ")
      }${relationReport.computedImportSuites.length > 3 ? ", ..." : ""}`,
    );
  }
  console.log(
    `fast-gate: selection audit ok: ${fullGateTestFiles.length} full-gate module(s), ${selectionAudit.fastGateUniverse.length} fast-selectable, ${readRelations.size} derived data relation(s)`,
  );
  // The cheap whole-repo steps always run: together ~10s, and a type error in
  // an UNTOUCHED importer of a changed file is exactly what skipping them
  // would miss.
  let cheapStepsFailed = false;
  // The integration test checks an OS-temp fixture explicitly, so SIGKILL cannot leave an
  // untracked, unformatted test file behind to fail the next gate in this worktree.
  // audio-feed-8rz5: explicit --fmt-fixture on argv is the ONLY way to pass an external fixture;
  // ambient environment variables are completely removed so they have zero effect.
  // (The value itself is resolved at entry, next to the --skip-type-check guard - audio-feed-i8e0z.)
  const fmtStep = formatCheckStep(fmtFixture);
  for (const step of [fmtStep, ["deno", "lint"], ["deno", "task", "check"]]) {
    // audio-feed-efgpr: the opt-out honoured above. The loop and its steps stay unconditional for
    // every real invocation (audio-feed-pnw73's pin stands); the skip exists only inside
    // fixture-mode runs, and even there it is SAID, not silent - a log reading "ok" while the
    // type-check never ran is exactly the report-must-not-lie defect this fleet keeps fixing.
    if (skipTypeCheck && step[1] === "task" && step[2] === "check") {
      console.log(
        "fast-check: type-check SKIPPED (--skip-type-check, honoured only with --fmt-fixture): this verdict says nothing about types",
      );
      continue;
    }
    const res = await run(step);
    if (res.code !== 0) {
      console.log(`fast-gate: failed: ${step.slice(1).join(" ")}`);
      cheapStepsFailed = true;
    }
  }

  // The config files the resolver actually reads, DERIVED from the config itself: the family list above is a
  // net, and this is the check that keeps it honest - a resolver input the family does not name is a NAMED
  // failure rather than a list that quietly stopped describing the config graph (audio-feed-es8y).
  const resolverInputs = await resolverConfigInputs(ROOT);
  const configProblems = auditResolverConfigs(resolverInputs);
  if (configProblems.length) {
    console.error(
      `fast-gate: MODULE-GRAPH CONFIG NOT COVERED (audio-feed-es8y):\n  ${
        configProblems.join("\n  ")
      }`,
    );
    console.log(
      coverageMarker("UNKNOWN - the gate stopped before the test harness: config problems"),
    );
    Deno.exit(1);
  }

  let plan: { testFiles: string[] | null; reason: string };
  if (forceAll) {
    plan = { testFiles: null, reason: "--all given" };
  } else if (relationFailure !== null) {
    // The detector could not run: widen, and name the failure as the reason.
    plan = planForFailedRelation(relationFailure);
  } else if (changed === null) {
    // Never silently green: an unknown change set gets the full suite.
    plan = {
      testFiles: null,
      reason: "change set UNKNOWN (git query failed or tracked index flags may hide mutations)",
    };
  } else {
    const reverse = await reverseGraph();
    const named = await nameMatchedTests(changed);
    plan = planTests(
      changed,
      reverse,
      named,
      readRelations,
      resolverInputs,
      inertBlockingReads,
      relationReport.computedImportSuites,
    );
  }
  const { testFiles, reason } = plan;

  // audio-feed-ruqh: A CHANGED PROOF THAT DECLARES ITS EXECUTOR MUST HAVE THAT SUITE SELECTED. The
  // declaration existed (`scripts/evidence-run.ts`, audio-feed-4oe2) and nothing consumed it, so a proof
  // could declare `- Executed by: tests/x_test.ts` while the gate selected some other suite, or none, and
  // still report itself covered. Shape B: a README that declares NOTHING is left exactly as it was, since
  // failing all 33 undeclared sites would be a tree-wide policy change rather than a selection fix.
  // FREE ON THE COMMON PATH: `evidenceReadmesAmong` returns nothing unless a changed file is an evidence
  // README, so a normal tip does no reads here at all. Placed before the run because the failure names the
  // fix (select the suite, or declare the one that really runs it) and running suites first would only
  // delay that.
  const declaredProofs = evidenceReadmesAmong(changed ?? []);
  if (declaredProofs.length) {
    const selected = testFiles ?? fastUniverse;
    const violations = findUnselectedExecutors(declaredProofs, selected, (path) => {
      try {
        return Deno.readTextFileSync(path);
      } catch {
        return null;
      }
    });
    if (violations.length) {
      console.log(
        `fast-check: DECLARED EXECUTOR NOT SELECTED - ${violations.length} changed proof(s) declare a suite this plan does not run.`,
      );
      for (const v of violations) {
        console.log(
          `  ${v.readme} declares \`- Executed by: ${v.executedBy}\`, which is not selected.`,
        );
      }
      console.log(
        "  This is a SELECTION failure, not a test result: no suite in this plan executes the proof",
      );
      console.log(
        "  that this README says produces its evidence. Either select that suite, or correct the",
      );
      console.log(
        "  declaration so it names the suite that really runs the proof (audio-feed-ruqh).",
      );
      Deno.exit(1);
    }
  }

  const snapshotBefore = await captureWorktreeSnapshot();
  if (testFiles === null) {
    console.log(`fast-check: FULL suite (${reason})`);
    const wholeSuite = fastUniverse;
    const res = await run(["deno", "test", ...TEST_FLAGS]);
    const staleReason = detectStaleRun(snapshotBefore, await captureWorktreeSnapshot());
    if (res.code !== 0 || staleReason !== null) {
      if (!staleReason) console.log(suiteMarker("ran", wholeSuite));
      console.log(
        coverageMarker(
          staleReason
            ? `UNKNOWN - run was invalidated while tests were executing (${staleReason})`
            : coverageRan(wholeSuite),
        ),
      );
      for (const m of failureMarkers(res.stdout, wholeSuite, staleReason)) {
        console.log(m);
      }
      Deno.exit(1);
    }
    console.log(suiteMarker("passed", wholeSuite));
    console.log(coverageMarker(coverageRan(wholeSuite)));
  } else if (testFiles.length === 0) {
    // audio-feed-es8y condition 2: a gate that ran NOTHING must not read like a gate that ran suites and
    // passed. The state is distinct and loud, and it is reflected in the fleet's coverage line by the
    // `unmapped:` marker the reporter already parses (it turns a non-empty list into a COVERAGE WARNING).
    // Only reachable when every changed file is inert documentation that NO suite is derived to read -
    // anything else fell back to the full suite.
    console.log(
      `fast-check: NO SUITES SELECTED — 0 of ${fastUniverse.length} test module(s) ran. ${reason}`,
    );
    console.log(
      "  This is a statement about the changed files, NOT a test result: no suite in this repo observes",
    );
    console.log("  them (documentation and declared-inert files only).");
    console.log(suiteMarker("unmapped", changed ?? []));
    console.log(coverageMarker(`${coverageRan([])} - no suite observes the changed files`));
  } else {
    console.log(`fast-check: ${testFiles.length} test file(s) (${reason})`);
    for (const f of testFiles) console.log(`  ${f}`);
    const res = await run(["deno", "test", ...TEST_FLAGS, ...testFiles]);
    const staleReason = detectStaleRun(snapshotBefore, await captureWorktreeSnapshot());
    if (res.code !== 0 || staleReason !== null) {
      if (!staleReason) console.log(suiteMarker("ran", testFiles));
      console.log(
        coverageMarker(
          staleReason
            ? `UNKNOWN - run was invalidated while tests were executing (${staleReason})`
            : coverageRan(testFiles),
        ),
      );
      for (const m of failureMarkers(res.stdout, testFiles, staleReason)) {
        console.log(m);
      }
      Deno.exit(1);
    }
    console.log(suiteMarker("passed", testFiles));
    console.log(coverageMarker(coverageRan(testFiles)));
  }

  if (cheapStepsFailed) {
    Deno.exit(1);
  }
  console.log(`fast-check: ok in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}
