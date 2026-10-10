/**
 * audio-feed-pubd — the fast tier of the test gate.
 *
 * `deno task gate` runs the full suite: ~108s on a fleet VM, of which ~90s is
 * the tests. A one-file change pays for all of it. This script runs the cheap
 * whole-repo checks (fmt, lint, type-check — ~10s together, and type errors
 * propagate transitively so checking only changed files would miss breakage
 * in their importers) plus ONLY the tests that can observe a changed file:
 *
 *   - a changed tests/foo_test.ts runs directly;
 *   - a changed src/ or scripts/ file runs every test that can reach it
 *     through the repo's static import graph (reverse reachability);
 *   - anything the graph cannot account for — deno.json/deno.lock, a changed
 *     code file NO test reaches, an unparseable import — falls back to the
 *     FULL suite. Safe beats fast: a fast tier that can silently skip a
 *     relevant test is worse than no fast tier.
 *
 * Usage:
 *   deno task test:fast            # affected tests for changes vs origin/main + uncommitted
 *   deno task test:fast -- --all   # force the full suite (what the merger runs anyway)
 *
 * Exit code is non-zero when any step fails. Wired as CHECK_FAST_CMD in
 * ~/.fleet/check.conf on the fleet VM (VM-local; the durable copy is this
 * script plus the AGENTS.md note).
 */

import { join, relative, resolve } from "@std/path";

const ROOT = new URL("..", import.meta.url).pathname;
const CODE_DIRS = ["src", "tests", "scripts"];
const TEST_FLAGS = [
  "--allow-net",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--unstable-kv",
];

async function git(...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, cwd: ROOT, stdout: "piped", stderr: "null" })
    .output();
  return new TextDecoder().decode(out.stdout);
}

/** Committed diff vs origin/main plus anything uncommitted or untracked. */
async function changedFiles(): Promise<string[]> {
  const files = new Set<string>();
  const committed = await git("diff", "--name-only", "origin/main...HEAD");
  for (const f of committed.split("\n")) f.trim() && files.add(f.trim());
  const uncommitted = await git("diff", "--name-only", "HEAD");
  for (const f of uncommitted.split("\n")) f.trim() && files.add(f.trim());
  const untracked = await git("ls-files", "--others", "--exclude-standard");
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
      /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g,
    )
  ) {
    const spec = m[1] ?? m[2];
    if (!spec?.startsWith(".")) continue; // only repo-internal edges
    out.push(relative(ROOT, resolve(join(ROOT, path, ".."), spec)));
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
    for await (const f of tsFiles(join(ROOT, dir))) {
      const rel = relative(ROOT, f);
      for (const dep of await importsOf(rel)) add(dep, rel);
    }
  }
  for (const dep of await importsOf("main.ts")) add(dep, "main.ts");
  return reverse;
}

/** Every test file that can observe one of the changed files. */
function reachableTests(reverse: Map<string, string[]>, changed: string[]): {
  tests: Set<string>;
  uncovered: string[];
} {
  const tests = new Set<string>();
  const uncovered: string[] = [];
  const queue = [...changed];
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (/_test\.ts$/.test(file)) tests.add(file);
    const importers = reverse.get(file);
    if (!importers?.length && /^(src|scripts)\//.test(file) && !/_test\.ts$/.test(file)) {
      uncovered.push(file);
    }
    for (const importer of importers ?? []) queue.push(importer);
  }
  return { tests, uncovered };
}

async function run(args: string[]): Promise<number> {
  console.log(`$ ${args.join(" ")}`);
  const out = await new Deno.Command(args[0]!, { args: args.slice(1), cwd: ROOT }).output();
  if (!out.success) {
    console.error(new TextDecoder().decode(out.stderr));
  }
  return out.code;
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
  const codeChanged = changed.filter((f) => /\.ts$/.test(f));
  const configChanged = changed.some((f) => f === "deno.json" || f === "deno.lock");

  let testFiles: string[] | null = null; // null = full suite
  let reason = "";
  if (forceAll) {
    reason = "--all given";
  } else if (configChanged) {
    reason = "deno.json/deno.lock changed — import graph may have moved";
  } else if (codeChanged.length === 0) {
    testFiles = [];
    reason = "no .ts changed";
  } else {
    const { tests, uncovered } = reachableTests(await reverseGraph(), codeChanged);
    if (uncovered.length) {
      reason = `no test reaches: ${uncovered.join(", ")}`;
    } else {
      testFiles = [...tests].sort();
      reason = `affected by: ${codeChanged.join(", ")}`;
    }
  }

  if (testFiles === null) {
    console.log(`fast-check: FULL suite (${reason})`);
    if (await run(["deno", "test", ...TEST_FLAGS]) !== 0) Deno.exit(1);
  } else if (testFiles.length === 0) {
    console.log(`fast-check: no tests to run (${reason})`);
  } else {
    console.log(`fast-check: ${testFiles.length} test file(s) (${reason})`);
    for (const f of testFiles) console.log(`  ${f}`);
    if (await run(["deno", "test", ...TEST_FLAGS, ...testFiles]) !== 0) Deno.exit(1);
  }

  console.log(`fast-check: ok in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}
