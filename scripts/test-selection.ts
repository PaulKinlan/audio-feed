/**
 * audio-feed-es8y — ONE source of truth for "which test modules exist", so the fast gate's selection is a
 * PROVEN SUBSET of the full gate's instead of a second, hand-maintained list that can drift from it.
 *
 * THE FINDING THIS EXISTS FOR (mirrored from the fleet audit fleet-1ojy.9). The full gate
 * (`deno task gate`) ends in `deno test` with NO file arguments, so Deno DISCOVERS test modules by name
 * pattern anywhere in the repo. The fast gate (scripts/fast-check.ts) runs an explicit file list built from
 * its own `tests/**` walk. Two independent definitions of the same set is how a suite comes to exist that
 * only one of the two gates ever runs, and the gap is silent in both directions:
 *
 *   - a `tests/foo.test.ts`, a `tests/foo_test.mts`, or a `src/foo_test.ts` is RUN by the full gate and is
 *     invisible to the fast gate. An implementer iterates green on a suite that never runs for them, and
 *     the failure surfaces on the merged union — the most expensive place to find it;
 *   - conversely, a change the fast gate cannot see at all (measured: a 200KB `docs/evidence/*.png` selected
 *     ZERO suites while tests/evidence_size_test.ts asserts those PNG byte budgets) gives a fast-gate PASS
 *     with a full-gate FAIL, reproduced end to end on 2026-10-11.
 *
 * DENO'S DISCOVERY RULE, verified empirically on Deno 2.9.7 in an isolated directory rather than taken on
 * trust: `a_test.ts`, `b.test.ts`, `c_test.mts`, `d_test.js`, `tests/t_test.ts`, `tests/sub/deep_test.ts`
 * and `tests/sub/deep.test.ts` all ran; `helper.ts` and `tests/helper_in_tests.ts` did not. The rule is a
 * BASENAME pattern — `{*_,*.,}test.{ts,tsx,js,jsx,mjs,mts}` — applied anywhere in the tree, with no
 * directory rule (a file merely being inside tests/ is not enough, which is why the helper files are safe).
 *
 * WHAT THIS MODULE GUARANTEES. Both properties are asserted by tests/fast_gate_subset_test.ts, and the
 * second one also FAILS THE GATE at the start (`deno task gate`, and every `test:fast` run) so that drift is
 * loud rather than discovered by a merger:
 *
 *   1. every module the fast gate can select is a module the full gate runs — because the fast universe is
 *      DERIVED by filtering the discovered universe, not walked separately;
 *   2. every module the full gate runs is either selectable by the fast gate or listed in
 *      FAST_GATE_EXCLUSIONS with a reason. A new `.test.ts` file is a NAMED gate failure that says exactly
 *      what to do, not a suite that quietly never runs again.
 *
 * The same drift exists for non-TypeScript files a suite READS (the docs/evidence case above), so
 * DATA_LEDGER declares them: a changed non-.ts file is either documentation (no suite reads `.md`), a
 * declared data file naming the suites that observe it, or an "unclassified" full-suite fallback that names
 * the file. Silence is not an option in any of the three.
 */

/** `<repo>/scripts/` by definition; the tests pass an explicit root for fixture trees. */
export const ROOT = import.meta.dirname!.replace(/\/scripts$/, "") + "/";

/** Extensions Deno's `{*_,*.,}test.<ext>` discovery rule covers. */
const TEST_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "mts"];

/**
 * Deno's test-module rule, as a pure predicate so it can be unit-tested: basename matching
 * `{*_,*.,}test.<ext>` — i.e. `foo_test.ts`, `foo.test.ts`, or `test.ts`.
 */
export function isTestModule(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? "";
  for (const ext of TEST_EXTENSIONS) {
    if (base.endsWith(`_test.${ext}`) || base.endsWith(`.test.${ext}`) || base === `test.${ext}`) {
      return true;
    }
  }
  return false;
}

/**
 * Directories neither gate walks: deno.json's `exclude` (`[".beads/", "var/"]`) plus the VCS and dependency
 * trees. That this covers the configured excludes is asserted by tests/fast_gate_subset_test.ts, so adding
 * an exclude to deno.json without teaching the walk about it is a test failure rather than a silent extra
 * module in the universe.
 */
export const NEVER_WALKED: string[] = [".git", "node_modules", ".beads", "var"];

/**
 * Every test module `deno task gate`'s `deno test` (no file arguments) will run, as repo-relative POSIX
 * paths, sorted. This is the FULL gate's universe — the one thing the fast gate is allowed to narrow.
 */
export async function discoverFullGateTestFiles(root: string = ROOT): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const dir = relative ? `${root}${relative}` : root;
    for await (const entry of Deno.readDir(dir)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (NEVER_WALKED.includes(entry.name)) continue;
        await walk(path);
      } else if (isTestModule(path)) {
        out.push(path);
      }
    }
  };
  await walk("");
  return out.sort();
}

/**
 * The fast gate's narrowing: suites under `tests/` named `*_test.ts`. Deliberately narrower than the full
 * gate's rule (no `.test.ts`, no `.mts`, no test modules outside tests/) — the narrowing is legal ONLY
 * because auditSelection() proves nothing falls outside it, which is the whole point of this module.
 */
export function isFastGateSelectable(relPath: string): boolean {
  return relPath.startsWith("tests/") && relPath.endsWith("_test.ts");
}

export interface FullGateExclusion {
  /** A test module the full gate runs. */
  path: string;
  /** Where it IS run instead, and why it is not selectable here. Never optional. */
  reason: string;
}

/**
 * Full-gate modules the fast gate deliberately does not select. Empty, and that is the point: today every
 * module the full gate runs is one the fast gate can select. An entry here is a promise that the module runs
 * somewhere else instead (the nightly factory line, CI, a hand-run), and auditSelection() rejects an entry
 * that has no reason or that names something which is not actually a full-gate module.
 */
export const FAST_GATE_EXCLUSIONS: FullGateExclusion[] = [];

export interface SelectionAudit {
  fullGateTestFiles: string[];
  fastGateUniverse: string[];
  /** Full-gate modules the fast gate can never select and no exclusion justifies. */
  unaccounted: string[];
  /** Malformed exclusion entries: not a full-gate module, or no reason given. */
  badExclusions: string[];
  ok: boolean;
  /** The NAMED failure text, empty when `ok`. */
  message: string;
}

/**
 * The gate-time audit must not be defeatable by the thing it audits: the universe the RUN selects from and
 * the universe the exported builder produces have to be the same set. They were two walks of the same rule
 * - equal, but equal by agreement rather than by construction, and a builder reverted to a narrower walk
 * would have been invisible. This turns that into a NAMED failure.
 */
export function universeDrift(run: readonly string[], built: readonly string[]): string | null {
  const sort = (paths: readonly string[]) => [...new Set(paths)].sort();
  const left = sort(run);
  const right = sort(built);
  if (left.join("\n") === right.join("\n")) return null;
  const inRun = new Set(left);
  const inBuilt = new Set(right);
  const onlyRun = left.filter((f) => !inBuilt.has(f));
  const onlyBuilt = right.filter((f) => !inRun.has(f));
  const show = (paths: string[]) =>
    paths.length === 0
      ? "none"
      : `${paths.length}: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}`;
  return [
    "fast-gate: SELECTION DRIFT (audio-feed-es8y): the universe this run selects from is NOT the universe",
    "allTestFiles() produces, so the audit would be describing a different selection than the one that runs.",
    `  only in the run's universe: ${show(onlyRun)}`,
    `  only in allTestFiles(): ${show(onlyBuilt)}`,
    "Both must come from the same walk (scripts/test-selection.ts); fix the builder rather than the message.",
  ].join("\n");
}

/**
 * Property 2 of audio-feed-es8y: the fast gate's selection is a subset, and anything it cannot select is
 * accounted for. Pure over its inputs so a test can prove it bites (a `.test.ts` module must come back as a
 * named failure, not a pass).
 */
export function auditSelection(
  fullGateTestFiles: string[],
  exclusions: FullGateExclusion[] = FAST_GATE_EXCLUSIONS,
): SelectionAudit {
  const isFullGateModule = new Set(fullGateTestFiles);
  const excluded = new Set<string>();
  const badExclusions: string[] = [];

  for (const exclusion of exclusions) {
    if (!isFullGateModule.has(exclusion.path)) {
      badExclusions.push(`${exclusion.path} (the full gate does not run this module)`);
    } else if (!exclusion.reason.trim()) {
      badExclusions.push(`${exclusion.path} (no reason given)`);
    } else {
      excluded.add(exclusion.path);
    }
  }

  const fastGateUniverse = fullGateTestFiles.filter(isFastGateSelectable);
  const unaccounted = fullGateTestFiles.filter((f) => !isFastGateSelectable(f) && !excluded.has(f));
  const ok = unaccounted.length === 0 && badExclusions.length === 0;

  let message = "";
  if (!ok) {
    const lines = ["fast-gate: SELECTION GAP (audio-feed-es8y)"];
    if (unaccounted.length) {
      lines.push(
        `${unaccounted.length} test module(s) the full gate runs can never be selected by the fast gate:`,
      );
      for (const file of unaccounted) lines.push(`  ${file}`);
      lines.push(
        "A fast-gate PASS would say nothing about them, so the gate refuses to run rather than report on part",
        "of the suite. Usually the module is simply NAMED or PLACED outside the convention the fast gate",
        "selects (`tests/*_test.ts`; a `src/*_test.ts` module belongs under tests/) and fixing that is the",
        "whole fix. If it must stay where it is, change scripts/test-selection.ts instead, one of two ways:",
        "  (a) widen isFastGateSelectable() so the fast gate can select a module shaped like it, or",
        "  (b) add it to FAST_GATE_EXCLUSIONS with a reason saying where it IS run instead.",
      );
    }
    if (badExclusions.length) {
      lines.push("FAST_GATE_EXCLUSIONS entries that do not justify themselves:");
      for (const entry of badExclusions) lines.push(`  ${entry}`);
      lines.push(
        "Every exclusion must name a module the full gate runs and say where it is run instead.",
      );
    }
    message = lines.join("\n");
  }

  return { fullGateTestFiles, fastGateUniverse, unaccounted, badExclusions, ok, message };
}

/**
 * A path DECLARED to be read by no suite. This is the only part of the data story that cannot be derived:
 * "no read detected" is checkable, not derivable, and a declaration is what keeps a beads commit or an
 * `.md` edit from running the whole suite. Every declaration is reconciled against the DERIVED read relation
 * (see deriveDataReadRelations): a detectable read that contradicts one is a NAMED gate failure.
 */
export interface UnreadDeclaration {
  /** Repo-relative prefix (directory, ending in `/`) or exact path. */
  pattern: string;
  reason: string;
}

/**
 * Declarations for non-TypeScript paths OUTSIDE src/ and tests/ that nothing observes.
 *
 * Why this list exists at all: the alternative for an undeclared path is the FULL suite (safe, slow), and a
 * beads export or an agent-config tweak is not a reason to run 103 modules. What is deliberately NOT here is
 * any statement about who READS a file — that relation is derived from the suites themselves
 * (deriveDataReadRelations), so a suite that starts reading a new data file is covered without anyone
 * editing this list, which was the flaw in the first version of this fix (audio-feed-es8y condition 1: the
 * relation must come from the suites, not from a list maintained beside them).
 */
export const UNREAD_DECLARATIONS: UnreadDeclaration[] = [
  {
    pattern: ".beads/",
    reason:
      "beads export and hooks: task state, not test input, so a beads-only commit stays a fast no-test change rather than a full-suite run on every lane. Reconciled: no derived read relation names this path, and no suite source contains a read/exec call mentioning it.",
  },
  {
    pattern: ".github/",
    reason: "CI workflow config; no suite reads it (reconciled against the derived relation).",
  },
  {
    pattern: ".gitignore",
    reason: "VCS ignore list; no suite reads it (reconciled).",
  },
  {
    pattern: ".codex/",
    reason: "agent tool config committed to the repo; no suite reads it (reconciled).",
  },
  {
    pattern: ".agents/",
    reason: "agent skills/instructions committed to the repo; no suite reads it (reconciled).",
  },
  {
    pattern: ".claude/",
    reason: "agent tool config committed to the repo; no suite reads it (reconciled).",
  },
];

/** `.md` anywhere: prose, so a markdown change is inert - UNLESS a suite is DERIVED to read it, which is
 * checked first in classifyNonTsChanges (audio-feed-38sn: an earlier version asked this function before the
 * relation, so a test asserting README contents would have been an empty pass). The hand-check that used to
 * stand here ("no suite reads markdown, checked 2026-10-11") is now a derived fact that can only over-select. */
export function isDocumentation(relPath: string): boolean {
  return relPath.endsWith(".md");
}

/**
 * The DERIVED read relation: which non-TypeScript paths a suite can read or execute, and by which suite.
 * Keys are repo-relative exact paths or directory prefixes ending in `/`.
 */
export type DataReadRelations = Map<string, string[]>;

/** Call sites whose arguments are filesystem/process paths a suite depends on. */
const READ_CALLS = [
  "readTextFile",
  "readTextFileSync",
  "readFile",
  "readFileSync",
  "readDir",
  "readDirSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "realPath",
  "open",
  "openSync",
  "Deno.Command",
  "Command",
];

/**
 * Strip comments before scanning: the detector reads raw text, and this file's own documentation contains
 * example lines like `const EVIDENCE_DIR = ...docs/evidence` which would otherwise be read as a real path
 * constant (found by exactly that false positive on the first run). The line-comment rule leaves `https://`
 * alone because a colon or quote precedes the slashes there.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1");
}

/** Static path hints found inside one call expression. */
function staticPathHints(call: string, moduleDir: string, root: string): string[] {
  const hints: string[] = [];
  const literals = [...call.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)];
  for (const match of literals) {
    let text = match[1] ?? match[2] ?? match[3] ?? "";
    if (!text) continue;
    const templated = match[3] !== undefined;
    if (templated) {
      // `${import.meta.dirname}` and `${import.meta.url}` are the repo-idiomatic ways to reach a file, and
      // both resolve statically. Anything else interpolated stays useful: the text is split on whitespace
      // and path-shaped tokens are kept, with a token that is cut by another interpolation kept as its
      // directory prefix (a suite reading `./fixtures/${name}.html` observes the whole fixtures directory).
      const dir = `${root}${moduleDir}`.replace(/\/$/, "");
      text = text
        .replace(/\$\{import\.meta\.dirname\}/g, dir)
        .replace(/\$\{import\.meta\.url\}/g, `${dir}/index.ts`);
      for (const token of text.split(/[\s"']+/).filter(Boolean)) {
        const wildcard = token.search(/\$\{/);
        if (wildcard < 0) {
          hints.push(token);
          continue;
        }
        const head = token.slice(0, wildcard);
        if (head.includes("/")) hints.push(head.slice(0, head.lastIndexOf("/") + 1));
      }
      continue;
    }
    hints.push(text);
  }
  return hints;
}

/**
 * Path constants defined in a module (`const EVIDENCE_DIR = `${import.meta.dirname}/../docs/evidence``),
 * so a read call that passes an IDENTIFIER (`Deno.readDir(dir)` with `dir = EVIDENCE_DIR`) still resolves.
 * That indirection is how docs/evidence is read: the suite calls evidencePngs(), which walks EVIDENCE_DIR.
 * A resolved constant with no file extension is recorded as a directory prefix, which over-selects rather
 * than under-selects - the trade this whole bead is about.
 */
function pathConstants(source: string, moduleDir: string, root: string): Map<string, string> {
  const constants = new Map<string, string>();
  const declare = (name: string, resolved: string) => {
    const isDirectory = !/[^/]+\.[A-Za-z0-9]{1,5}$/.test(resolved);
    constants.set(name, isDirectory ? `${resolved.replace(/\/$/, "")}/` : resolved);
  };
  const resolve = (expr: string): string | null => {
    const hints = staticPathHints(expr, moduleDir, root);
    if (hints.length !== 1) return null;
    return toRepoPath(hints[0]!, moduleDir, root);
  };

  const lines = source.split("\n").map((line) => line.trim());
  for (const line of lines) {
    const match = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const resolved = resolve(match[2]) ?? constants.get(match[2].replace(/;$/, "").trim());
    if (resolved) declare(match[1], resolved);
  }
  // Default parameter values: `evidencePngs(dir = EVIDENCE_DIR)` reads through `dir`, so the name that
  // appears at the read call site is the PARAMETER, not the constant.
  for (const line of lines) {
    for (
      const match of line.matchAll(
        /[([,]\s*([A-Za-z_$][\w$]*)\s*(?::\s*[^=,)]+)?=\s*([A-Za-z_$][\w$]*)\s*[,)]/g,
      )
    ) {
      const [, name, referenced] = match;
      if (!name || !referenced) continue;
      const resolved = constants.get(referenced);
      if (resolved) declare(name, resolved);
    }
  }
  return constants;
}

/** Turn a hint into a repo-relative path or directory prefix, or null when it points outside the repo. */
function toRepoPath(hint: string, moduleDir: string, root: string): string | null {
  let path = hint.trim();
  if (!path) return null;
  // Only path-shaped hints count. A `Deno.Command` call is full of literals that are not files: CLI flags
  // (`--allow-all`, `-c`), numbers, and punctuation from an args array. Keeping them out is what makes the
  // relation readable and keeps a change from matching junk.
  if (!/^[\w@./-]+$/.test(path)) return null;
  if (path.startsWith("-")) return null;
  if (!path.includes("/") && !/\.[A-Za-z0-9]{1,5}$/.test(path)) return null;
  if (/^[a-z]+:/i.test(path) && !/^file:/i.test(path)) return null; // http(s):, jsr:, node:, data:
  path = path.replace(/^file:\/\//, "/");
  if (path.startsWith(root)) return normalisePath(path.slice(root.length));
  if (path.startsWith("./") || path.startsWith("../")) {
    return normalisePath(`${moduleDir ? `${moduleDir}/` : ""}${path}`);
  }
  if (path.startsWith("/")) return null; // absolute outside the repo
  // A bare relative path is resolved by Deno against the PROCESS CWD, which is the repo root for both gates
  // (`sh scripts/x.sh` in a Command call, `Deno.readTextFile("deno.json")`), so it stays repo-relative.
  return normalisePath(path);
}

/** Collapse `.` and `..` segments; null when the path escapes the repo root. */
function normalisePath(path: string): string | null {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}

/** True when the call text at `index` is a read/exec call site we care about. */
function readCallAt(source: string, index: number): boolean {
  const before = source.slice(Math.max(0, index - 12), index);
  return !/(?:import|export|from|require)\s*$/.test(before);
}

/**
 * audio-feed-es8y condition 1: DERIVE "who reads this" from the suites, instead of maintaining it beside them.
 *
 * For each suite the walk collects the suite's own source plus the repo modules it imports (a small number of
 * hops, because the path literal often lives in the module that does the reading — `evidencePngs()` is called
 * by the suite and points EVIDENCE_DIR at docs/evidence inside scripts/evidence-compress.ts), then scans read
 * and exec call sites for statically resolvable paths: string literals, `new URL("<literal>", import.meta.url)`,
 * and templates built from `${import.meta.dirname}`.
 *
 * It is deliberately an OVER-approximation: a hint that resolves to a directory becomes that whole prefix, so
 * a suite that reads one fixture selects every change under the directory it is built from. Over-selecting
 * costs seconds; under-selecting is the bug this bead is about.
 *
 * What it cannot see is a path assembled at runtime from variables — that residual is why an undeclared file
 * OUTSIDE src/ and tests/ still falls back to the full suite, and it is stated rather than papered over.
 */
export async function deriveDataReadRelations(
  root: string = ROOT,
  suiteFiles?: readonly string[],
): Promise<DataReadRelations> {
  const suites = suiteFiles ?? (await discoverFullGateTestFiles(root)).filter(isFastGateSelectable);
  const sources = new Map<string, string>();
  const read = async (relPath: string): Promise<string | null> => {
    const cached = sources.get(relPath);
    if (cached !== undefined) return cached;
    const text = await Deno.readTextFile(`${root}${relPath}`).catch(() => null);
    sources.set(relPath, text ?? "");
    return text;
  };

  const relations: DataReadRelations = new Map();
  const add = (path: string, suite: string) => {
    // TypeScript is covered by the import graph, and non-.ts files under src/ and tests/ keep the
    // conservative full-suite fallback - so a relation to either is recorded nowhere: it would never be
    // consulted and it would bury the data paths that matter (audio-feed-es8y scope note).
    if (path.endsWith(".ts")) return;
    if (
      path === "src" || path === "tests" || path.startsWith("src/") || path.startsWith("tests/")
    ) {
      return;
    }
    const list = relations.get(path) ?? [];
    if (!list.includes(suite)) list.push(suite);
    relations.set(path, list);
  };

  for (const suite of suites) {
    const moduleDir = suite.split("/").slice(0, -1).join("/");
    const queue: { relPath: string; dir: string; depth: number }[] = [
      { relPath: suite, dir: moduleDir, depth: 0 },
    ];
    const seen = new Set<string>();
    const constants = new Map<string, string>();
    while (queue.length) {
      const { relPath, dir, depth } = queue.pop()!;
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      const source = stripComments(await read(relPath) ?? "");
      if (source === null) continue;

      for (const [name, path] of pathConstants(source, dir, root)) {
        if (!constants.has(name)) constants.set(name, path);
      }

      for (const call of READ_CALLS) {
        for (const match of source.matchAll(new RegExp(`${call}\\s*\\(`, "g"))) {
          const at = match.index ?? 0;
          if (!readCallAt(source, at)) continue;
          // Scan to the matching close paren so the literals belong to this call.
          let depthParen = 0;
          let end = at + match[0].length - 1;
          for (let i = end; i < source.length; i++) {
            const ch = source[i];
            if (ch === "(") depthParen++;
            else if (ch === ")") {
              depthParen--;
              if (depthParen === 0) {
                end = i;
                break;
              }
            }
          }
          const callText = source.slice(at, end + 1);
          for (const hint of staticPathHints(callText, dir, root)) {
            const path = toRepoPath(hint, dir, root);
            if (path) add(path, suite);
          }
          // An argument passed by NAME still resolves through the constants collected above.
          for (const identifier of callText.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)/g)) {
            const path = constants.get(identifier[1]!);
            if (path) add(path, suite);
          }
        }
      }

      // One hop (two levels) into the modules this file imports, for path constants like EVIDENCE_DIR.
      if (depth < 2) {
        for (const spec of source.matchAll(/from\s*["'](\.[^"']+)["']/g)) {
          const imported = normalisePath(`${dir}/${spec[1]}`);
          if (!imported || seen.has(imported)) continue;
          const importedDir = imported.split("/").slice(0, -1).join("/");
          queue.push({ relPath: imported, dir: importedDir, depth: depth + 1 });
        }
      }
    }
  }

  for (const list of relations.values()) list.sort();
  // Keep only paths that exist in the tree: a key derived from a mis-parsed template can never match a
  // changed file, and dropping it keeps the audit output readable.
  const existing: DataReadRelations = new Map();
  for (const [path, observers] of relations) {
    const stat = await Deno.stat(`${root}${path.replace(/\/$/, "")}`).catch(() => null);
    if (stat) existing.set(path, observers);
  }
  return existing;
}

/** The suites the derived relation says observe a changed path (exact match or directory prefix). */
export function suitesObserving(
  relPath: string,
  relations: DataReadRelations,
): string[] {
  const suites = new Set<string>();
  for (const [pattern, observed] of relations) {
    if (pattern.endsWith("/") ? relPath.startsWith(pattern) : relPath === pattern) {
      for (const suite of observed) suites.add(suite);
    }
  }
  return [...suites].sort();
}

/** The unread declaration a repo-relative path matches, if any. */
export function declarationFor(
  relPath: string,
  declarations: readonly UnreadDeclaration[] = UNREAD_DECLARATIONS,
): UnreadDeclaration | undefined {
  return declarations.find((entry) =>
    entry.pattern.endsWith("/") ? relPath.startsWith(entry.pattern) : relPath === entry.pattern
  );
}

export interface NonTsClassification {
  /** Markdown: no suite reads it, so no selection consequence. */
  documentation: string[];
  /** Suites that must run because the DERIVED relation says they read the changed data. */
  suites: string[];
  /** Declared unread: inert, with a stated reason, reconciled against the derived relation. */
  inert: string[];
  /** Not .ts, not markdown, not read by anything detectable and not declared: full suite, by name. */
  unclassified: string[];
}

/**
 * Classify the non-TypeScript half of a change set against the DERIVED read relation. Callers handle non-.ts
 * files under src/ and tests/ themselves (those keep the conservative full-suite fallback: assets, fixtures)
 * and reach this for everything else.
 */
export function classifyNonTsChanges(
  changed: readonly string[],
  relations: DataReadRelations,
  declarations: readonly UnreadDeclaration[] = UNREAD_DECLARATIONS,
): NonTsClassification {
  const classification: NonTsClassification = {
    documentation: [],
    suites: [],
    inert: [],
    unclassified: [],
  };
  const suites = new Set<string>();

  for (const file of changed) {
    if (file.endsWith(".ts")) continue;
    // THE DERIVED RELATION IS CHECKED FIRST (audio-feed-38sn, found in review of this delta): a markdown
    // file a suite READS is a real input, so classifying it as inert documentation before looking at the
    // relation turned a real input into an empty pass - the exact hole this bead exists to close, and the
    // one place where a hand-checked "no suite reads .md" claim still outranked the derived fact. Read by a
    // suite -> select it; not read by anything -> documentation (loud inert state).
    const observers = suitesObserving(file, relations);
    if (observers.length) {
      for (const suite of observers) suites.add(suite);
      continue;
    }
    if (isDocumentation(file)) {
      classification.documentation.push(file);
      continue;
    }
    if (declarationFor(file, declarations)) {
      classification.inert.push(file);
      continue;
    }
    classification.unclassified.push(file);
  }

  classification.suites = [...suites].sort();
  return classification;
}

/**
 * Can an EMPTY selection be trusted for this change set?
 *
 * Only when every changed file is declared inert — markdown documentation, or an UNREAD_DECLARATIONS entry
 * with a reason. This is audio-feed-es8y condition 2: a gate that ran no suite must never read like a gate
 * that ran suites and passed. Anything not proven inert (a standalone script nothing imports, an undeclared
 * file) gets the FULL suite instead.
 */
export function isProvablyInert(
  changed: readonly string[],
  classification: NonTsClassification,
): boolean {
  if (!changed.length) return false;
  const inert = new Set([...classification.documentation, ...classification.inert]);
  return changed.every((file) => inert.has(file));
}

/**
 * Reconciliation for the only hand-written part of the data story: a declaration that nothing reads a path is
 * a CLAIM, so it is checked against the derived relation and against any read/exec call in a suite that names
 * the path. A contradiction is a NAMED failure — the declaration is either wrong or the read is a new input
 * relation the selection must know about (audio-feed-es8y conditions 1 and 2).
 */
export async function auditUnreadDeclarations(
  root: string = ROOT,
  declarations: readonly UnreadDeclaration[] = UNREAD_DECLARATIONS,
  relations?: DataReadRelations,
  suiteFiles?: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  const derived = relations ?? await deriveDataReadRelations(root, suiteFiles);
  const suites = suiteFiles ?? (await discoverFullGateTestFiles(root)).filter(isFastGateSelectable);

  for (const declaration of declarations) {
    if (!declaration.pattern.trim()) problems.push("an UNREAD_DECLARATIONS entry has no pattern");
    if (!declaration.reason.trim()) problems.push(`${declaration.pattern} has no reason`);

    for (const [path, observers] of derived) {
      const overlaps = declaration.pattern.endsWith("/")
        ? path.startsWith(declaration.pattern) || declaration.pattern.startsWith(`${path}/`)
        : path === declaration.pattern || path.startsWith(`${declaration.pattern}/`);
      if (overlaps) {
        problems.push(
          `${declaration.pattern} is declared read by nobody, but the derived relation says ${
            observers.join(", ")
          } reads ${path}`,
        );
      }
    }

    const bare = declaration.pattern.replace(/\/$/, "");
    for (const suite of suites) {
      const source = stripComments(await Deno.readTextFile(`${root}${suite}`).catch(() => ""));
      for (const call of READ_CALLS) {
        const lines = source.split("\n").filter((line) => line.includes(call));
        if (lines.some((line) => line.includes(bare))) {
          problems.push(
            `${declaration.pattern} is declared read by nobody, but ${suite} has a ${call} call mentioning it`,
          );
          break;
        }
      }
    }

    const path = declaration.pattern.endsWith("/")
      ? declaration.pattern.slice(0, -1)
      : declaration.pattern;
    const stat = await Deno.stat(`${root}${path}`).catch(() => null);
    if (stat === null) problems.push(`${declaration.pattern} does not exist in the tree`);
  }
  return problems;
}

/**
 * The fixture corpus the discovery proof is run over: every pattern Deno's rule covers, planted in isolated
 * directories, plus the look-alikes that must NOT be discovered and the trees the walk skips.
 */
const PROOF_CORPUS: Record<string, string> = {
  "a_test.ts": 'Deno.test("a", () => {});\n',
  "b.test.ts": 'Deno.test("b", () => {});\n',
  "c_test.mts": 'Deno.test("c", () => {});\n',
  "d_test.js": 'Deno.test("d", () => {});\n',
  "test.ts": 'Deno.test("root test module", () => {});\n',
  "helper.ts": "export const x = 1;\n",
  "tests/t_test.ts": 'Deno.test("t", () => {});\n',
  "tests/helper_in_tests.ts": "export const y = 2;\n",
  "tests/sub/deep.test.ts": 'Deno.test("deep", () => {});\n',
  "tests/sub/deep_test.ts": 'Deno.test("deep2", () => {});\n',
  "nested/deeper/inner_test.ts": 'Deno.test("inner", () => {});\n',
  "src/inline.test.ts": 'Deno.test("inline", () => {});\n',
  "node_modules/dep/x_test.ts": 'Deno.test("dep", () => {});\n',
  ".beads/export_test.ts": 'Deno.test("beads", () => {});\n',
  "var/scratch_test.ts": 'Deno.test("scratch", () => {});\n',
};

export interface DiscoveryProof {
  ok: boolean;
  ours: string[];
  deno: string[];
  detail: string;
}

/**
 * audio-feed-es8y condition 4: prove the universe EQUALS what Deno discovers, instead of asserting the
 * pattern list is right. Plants the corpus in a temp tree and compares our walk with the module list
 * `deno test --no-run` reports there (a fresh DENO_DIR per run, because a warm cache prints no Check lines).
 *
 * Needs `--allow-run=deno`: the full gate task grants it, and the test in
 * tests/fast_gate_subset_test.ts is skipped where it is not granted (in the gate it always runs).
 */
export async function proveDiscoveryMatchesDeno(): Promise<DiscoveryProof> {
  const dir = await Deno.makeTempDir({ prefix: "af-discovery-proof-" });
  const denoDir = await Deno.makeTempDir({ prefix: "af-discovery-denodir-" });
  try {
    // The fixture carries the REPO's real `exclude` list, because the excludes are part of discovery: with
    // no config, `deno test` happily scans .beads/ and var/, and the comparison would be measuring the
    // fixture's missing config rather than our walk. Reading the live list also means a configured exclude
    // the walk does not know about shows up here as a mismatch.
    const repoConfig = JSON.parse(
      (await Deno.readTextFile(`${ROOT}deno.json`))
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n"),
    ) as { exclude?: string[] };
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ exclude: repoConfig.exclude ?? [] }, null, 2),
    );

    for (const [path, body] of Object.entries(PROOF_CORPUS)) {
      const full = `${dir}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, body);
    }

    const ours = await discoverFullGateTestFiles(`${dir}/`);
    const output = await new Deno.Command("deno", {
      args: ["test", "--no-run"],
      cwd: dir,
      env: { ...Deno.env.toObject(), DENO_DIR: denoDir, NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
    const deno = [...text.matchAll(/^Check\s+(.+)$/gm)]
      .map((m) => (m[1] ?? "").trim())
      .map((path) => path.replace(/^file:\/\//, ""))
      .map((path) => path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path)
      .sort();

    const ok = deno.length > 0 && JSON.stringify(ours) === JSON.stringify(deno);
    return {
      ok,
      ours,
      deno,
      detail: ok ? "" : `our walk: ${ours.join(", ")}\ndeno test --no-run: ${deno.join(", ")}`,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(denoDir, { recursive: true });
  }
}

if (import.meta.main) {
  const full = await discoverFullGateTestFiles();
  const audit = auditSelection(full);
  const fastUniverse = full.filter(isFastGateSelectable);
  const relations = await deriveDataReadRelations(ROOT, fastUniverse);
  const declarationProblems = await auditUnreadDeclarations(
    ROOT,
    UNREAD_DECLARATIONS,
    relations,
    fastUniverse,
  );

  console.log(
    `test-selection: the full gate runs ${full.length} test module(s); the fast gate can select ${audit.fastGateUniverse.length}.`,
  );
  console.log(
    `test-selection: the derived read relation covers ${relations.size} data path(s) across ${UNREAD_DECLARATIONS.length} unread declaration(s).`,
  );
  if (Deno.args.includes("--list-relations")) {
    for (const [path, observers] of [...relations].sort()) {
      console.log(`  ${path} <- ${observers.join(", ")}`);
    }
  }
  if (!audit.ok) {
    console.error(audit.message);
    Deno.exit(1);
  }
  if (declarationProblems.length) {
    console.error(
      `fast-gate: UNREAD DECLARATION contradiction(s) (audio-feed-es8y):\n  ${
        declarationProblems.join("\n  ")
      }\nThe relation is DERIVED from the suites, so a declaration a suite contradicts is simply wrong: delete it\n(the derived relation already selects that suite) or fix the read that made it wrong - and do not answer it\nby adding the path to a second list.`,
    );
    Deno.exit(1);
  }

  if (Deno.args.includes("--prove-discovery")) {
    const proof = await proveDiscoveryMatchesDeno().catch((error) => ({
      ok: false,
      ours: [],
      deno: [],
      detail: `could not run \`deno test --no-run\` (does this task grant --allow-run=deno?): ${
        error instanceof Error ? error.message : String(error)
      }`,
    }));
    if (!proof.ok) {
      console.error(
        `fast-gate: DISCOVERY MISMATCH (audio-feed-es8y): our test universe is not what Deno runs.\n${proof.detail}\nNeither gate may proceed on a universe it cannot prove.`,
      );
      Deno.exit(1);
    }
    console.log(
      `test-selection: discovery proof ok against \`deno test --no-run\` (${proof.deno.length} planted module(s)).`,
    );
  }
  console.log("test-selection: ok");
}
