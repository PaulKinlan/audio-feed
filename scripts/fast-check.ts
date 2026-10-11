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
 *     server/origin) runs the FULL suite — every test exercises it;
 *   - deno.json/deno.lock changed, or a src/ file no test reaches, also runs
 *     the FULL suite. Safe beats fast.
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

const TEST_FLAGS = [
  "--allow-net",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--unstable-kv",
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

/** Committed diff vs origin/main plus anything uncommitted or untracked. null = unknown. */
async function changedFiles(): Promise<string[] | null> {
  const files = new Set<string>();
  const committed = await git("diff", "--name-only", "origin/main...HEAD");
  if (committed === null) return null;
  for (const f of committed.split("\n")) f.trim() && files.add(f.trim());
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
async function reverseGraph(): Promise<Map<string, string[]>> {
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
 * The walk does not cross a hub: app.ts/compose.ts import every route, so
 * crossing them selects every app-booting test for any route change. A test
 * that only reaches the changed file THROUGH the hub boots the whole app but
 * does not exercise that route's behaviour; the changed file's direct tests
 * are the ones that do. scripts/ modules are walked like anything else — a
 * tested script (fast-check.ts itself) must select its test; only a script
 * NOTHING imports is exempt (audio-feed-bqd4).
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
    if (!/^(src\/|scripts\/|main\.ts$)/.test(start)) continue; // docs, assets: no tests

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
        if (importer !== start && isHub(importer)) continue; // do not cross hubs
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
 * The name-convention complement to the graph: src/routes/listen.ts is covered
 * by tests/listen_test.ts and tests/listen_*_test.ts; src/auth/passkeys.ts
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

  for await (const f of tsFiles(testsDir)) {
    const rel = f.slice(testsDir.length - "tests".length); // tests/...
    if (!rel.endsWith("_test.ts") && !rel.endsWith("-test.ts")) continue;
    const base = rel.split("/").pop()!;
    const testStem = base.replace(/(_test|\.test|\.spec|-test)\.ts$/, "");
    for (const { file, stem, subdir } of stems) {
      const normStem = stem.replace(/[-_]/g, "_");
      const normTestStem = testStem.replace(/[-_]/g, "_");
      const hit = normTestStem === normStem ||
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
 */
export function suiteMarker(kind: "passed" | "ran", files: string[]): string {
  return `fast-gate: ${kind}: ${files.join(" ")}`;
}

/** Every test file, in the rel paths the reporter expects (tests/...). */
export async function allTestFiles(): Promise<string[]> {
  const testsDir = `${ROOT}tests`;
  const out: string[] = [];
  for await (const f of tsFiles(testsDir)) {
    const rel = f.slice(testsDir.length - "tests".length); // tests/...
    if (rel.endsWith("_test.ts")) out.push(rel);
  }
  return out.sort();
}

async function run(args: string[]): Promise<number> {
  console.log(`$ ${args.join(" ")}`);
  const out = await new Deno.Command(args[0]!, { args: args.slice(1), cwd: ROOT }).output();
  if (!out.success) {
    console.error(new TextDecoder().decode(out.stderr));
  }
  return out.code;
}

/**
 * The whole selection decision, pure so the tests can pin every fallback:
 * `testFiles: null` means "run the FULL suite".
 */
export function planTests(
  changed: string[],
  reverse: Map<string, string[]>,
  named: Map<string, string[]>,
): { testFiles: string[] | null; reason: string } {
  if (changed.some((f) => f === "deno.json" || f === "deno.lock")) {
    return { testFiles: null, reason: "deno.json/deno.lock changed — import graph may have moved" };
  }

  const codeChanged = changed.filter((f) => f.endsWith(".ts"));

  // Non-TypeScript under src/ or tests/ is still test-asserted content —
  // src/assets/*.js|css have tests pinning their bytes, tests/fixtures/*.html
  // feed parsers — and the import graph cannot see any of it.
  const nonTsCode = changed.filter((f) => !f.endsWith(".ts") && /^(src|tests)\//.test(f));
  if (nonTsCode.length) {
    return {
      testFiles: null,
      reason: `non-TypeScript code/fixture(s) changed: ${nonTsCode.join(", ")}`,
    };
  }

  const coreChanged = codeChanged.filter((f) => CORE.has(f) || isHub(f));
  if (coreChanged.length) {
    return { testFiles: null, reason: `cross-cutting file(s) changed: ${coreChanged.join(", ")}` };
  }

  // A changed tests/ helper (fixtures.ts, listen_client.ts, ...) fans out to
  // dozens of suites; selecting its importers IS most of the suite anyway.
  const helpers = codeChanged.filter((f) => f.startsWith("tests/") && !f.endsWith("_test.ts"));
  if (helpers.length) {
    return { testFiles: null, reason: `shared test helper(s) changed: ${helpers.join(", ")}` };
  }

  if (!codeChanged.length) return { testFiles: [], reason: "no testable change" };

  const { tests, uncovered } = reachableTests(reverse, codeChanged);
  for (const list of named.values()) for (const f of list) tests.add(f);
  // A file with name-matched tests is covered even when the graph cannot
  // see it (the route tests boot the app through the hub).
  const stillUncovered = uncovered.filter((f) => !named.get(f)?.length);
  if (stillUncovered.length) {
    return { testFiles: null, reason: `no test reaches: ${stillUncovered.join(", ")}` };
  }
  return { testFiles: [...tests].sort(), reason: `affected by: ${codeChanged.join(", ")}` };
}

if (import.meta.main) {
  const forceAll = Deno.args.includes("--all");
  const started = performance.now();

  // The cheap whole-repo steps always run: together ~10s, and a type error in
  // an UNTOUCHED importer of a changed file is exactly what skipping them
  // would miss.
  for (const step of [["deno", "fmt", "--check"], ["deno", "lint"], ["deno", "task", "check"]]) {
    if (await run(step) !== 0) Deno.exit(1);
  }

  const changed = await changedFiles();
  let plan: { testFiles: string[] | null; reason: string };
  if (forceAll) {
    plan = { testFiles: null, reason: "--all given" };
  } else if (changed === null) {
    // Never silently green: an unknown change set gets the full suite.
    plan = { testFiles: null, reason: "git diff failed (stale or missing origin/main?)" };
  } else {
    const reverse = await reverseGraph();
    const named = await nameMatchedTests(changed);
    plan = planTests(changed, reverse, named);
  }
  const { testFiles, reason } = plan;

  if (testFiles === null) {
    console.log(`fast-check: FULL suite (${reason})`);
    const wholeSuite = await allTestFiles();
    if (await run(["deno", "test", ...TEST_FLAGS]) !== 0) {
      console.log(suiteMarker("ran", wholeSuite));
      Deno.exit(1);
    }
    console.log(suiteMarker("passed", wholeSuite));
  } else if (testFiles.length === 0) {
    console.log(`fast-check: no tests to run (${reason})`);
  } else {
    console.log(`fast-check: ${testFiles.length} test file(s) (${reason})`);
    for (const f of testFiles) console.log(`  ${f}`);
    if (await run(["deno", "test", ...TEST_FLAGS, ...testFiles]) !== 0) {
      console.log(suiteMarker("ran", testFiles));
      Deno.exit(1);
    }
    console.log(suiteMarker("passed", testFiles));
  }

  console.log(`fast-check: ok in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}
