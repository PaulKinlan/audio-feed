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
 * The same drift exists for non-TypeScript files a suite READS (the docs/evidence case above), so the read
 * relation is DERIVED from the suites' own code and a `.md` a suite reads is a real input like any other.
 * A changed non-.ts file is then either documentation (no suite is derived to read it), a data file whose
 * observers are selected, or "unclassified" - which runs the FULL suite and names the file. NOTHING is
 * DECLARED: a hand-written "nothing reads this" is a standing assertion that a later suite can contradict
 * silently, and the measured cost of not having one is a full suite on the rare change to tooling config
 * (those paths change 15 times in 652 commits, which is why audio-feed-r9fe deleted the list). Silence is
 * not an option in any of the three outcomes.
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

/** `.md` anywhere: prose, so a markdown change is inert - UNLESS a suite is DERIVED to read it, which is
 * checked first in classifyNonTsChanges (audio-feed-38sn: an earlier version asked this function before the
 * relation, so a test asserting README contents would have been an empty pass). The hand-check that used to
 * stand here ("no suite reads markdown, checked 2026-10-11") is now a derived fact that can only over-select. */
export function isDocumentation(relPath: string): boolean {
  return relPath.endsWith(".md");
}

/**
 * THE ORDERING RULE, as a check rather than a comment (coord, after rev-13 found the 38sn hole in review):
 * the DERIVED read relation outranks every category heuristic. A path the relation names a reader for is a
 * real input whatever it looks like, so if a path is ever treated as inert documentation WHILE a derived
 * reader exists, that is not an empty selection - it is an ORDERING BUG, and the gate must name it and run
 * the full suite instead. This is the check that would have caught 38sn, and the one that catches the next
 * path-shaped heuristic added above the relation.
 */
export function inertContradictions(
  inertPaths: readonly string[],
  relations: DataReadRelations,
): string[] {
  // NOTE THE PARAMETER (audio-feed-t0sp): this takes the CLASSIFIER'S INERT BUCKET, not the change set, and it
  // deliberately does NOT re-test any predicate of its own. A guard that asked `isDocumentation(file)` was
  // only as broad as the category that existed when it was written, so a second inert category - a `.csv`
  // pushed into the bucket by someone who never read this file - would have gone straight past it and
  // produced the 38sn empty pass again.
  return inertPaths.filter((path) => suitesObserving(path, relations).length > 0);
}

/**
 * Files whose change can move what EVERY suite resolves. A NET, not the safety mechanism: the protection is
 * the unclassified default in classifyNonTsChanges()/planTests(), where any file that is not documentation
 * and has no derived reader runs the FULL suite. auditResolverConfigs() keeps this list honest against the
 * config files Deno's resolver ACTUALLY reads, so it is a claim that is checked rather than a guess.
 */
export const GRAPH_CONFIG_FILES =
  /^(deno\.json|deno\.jsonc|deno\.lock|import_map\.json|tsconfig\.json)$/;

/**
 * The config files Deno's module resolver actually reads for this repo, DERIVED from the config rather than
 * enumerated: the config present in the tree, anything it `extends` (recursively, bounded), and the lockfile
 * it names - or the default `deno.lock` when one exists. A config shape nobody thought of is still found,
 * which is the point: the family list above is reviewed against THIS, not against memory.
 */
export async function resolverConfigInputs(root: string = ROOT): Promise<string[]> {
  const inputs = new Set<string>();
  const readConfig = async (rel: string, depth: number): Promise<void> => {
    if (depth > 4 || inputs.has(rel)) return;
    const text = await Deno.readTextFile(`${root}${rel}`).catch(() => null);
    if (text === null) return;
    inputs.add(rel);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const config = parsed as Record<string, unknown>;
    const lock = config.lock;
    if (lock === true) inputs.add("deno.lock");
    else if (typeof lock === "string") await readConfig(lock.replace(/^\.\//, ""), depth + 1);
    const extended = config.extends;
    for (
      const entry of Array.isArray(extended)
        ? extended
        : typeof extended === "string"
        ? [extended]
        : []
    ) {
      if (typeof entry === "string") await readConfig(entry.replace(/^\.\//, ""), depth + 1);
    }
  };
  await readConfig("deno.json", 0);
  await readConfig("deno.jsonc", 0);
  if (await Deno.stat(`${root}deno.lock`).then(() => true).catch(() => false)) {
    inputs.add("deno.lock");
  }
  return [...inputs].sort();
}

/** A config the resolver reads that the family does not match is a NAMED failure: either widen the family or
 * accept that the unclassified default covers it, but do not leave a list quietly failing to describe the
 * config graph it claims to describe. */
export function auditResolverConfigs(inputs: readonly string[]): string[] {
  return inputs.filter((path) => !GRAPH_CONFIG_FILES.test(path)).map((path) =>
    `${path} is read by the module resolver but does not match GRAPH_CONFIG_FILES - widen the family (the unclassified default already sends it to the full suite, so this is about the list telling the truth)`
  );
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

/**
 * Spans of `source` that are STRING CONTENT rather than code (audio-feed-lm4d).
 *
 * The scan is textual, so a read call that exists only inside a string literal looks exactly like a read
 * site. It cannot be one - string content is data - and counting it as one put five paths into the
 * unresolved list that no suite can ever read, because `tests/fast_gate_subset_test.ts` carries synthetic
 * module sources as fixtures and those fixtures read things (`data/table.csv`, `fixtures.html`,
 * `docs/absent.html`, `docs/present.md`). Under audio-feed-q0ky's rule those five are enough on their own to
 * keep the inert class disabled for EVERY change, so a documentation-only edit paid the full suite.
 *
 * A template INTERPOLATION is code, not string content, so a read inside `${...}` is still a read: that is
 * the boundary, and it is asserted in tests/read_relation_hints_test.ts.
 */
function stringContentSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const scan = (from: number, to: number): void => {
    let i = from;
    while (i < to) {
      const ch = source[i]!;
      if (ch === "/" && source[i + 1] === "/") {
        while (i < to && source[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < to && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const start = i++;
        while (i < to && source[i] !== ch) {
          if (source[i] === "\\") i++;
          i++;
        }
        i++;
        spans.push([start, Math.min(i, to)]);
        continue;
      }
      if (ch === "`") {
        i++;
        let chunk = i;
        while (i < to) {
          const c = source[i]!;
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === "`") {
            i++;
            break;
          }
          if (c === "$" && source[i + 1] === "{") {
            spans.push([chunk, i]);
            i += 2;
            const codeStart = i;
            let depth = 1;
            while (i < to && depth > 0) {
              const d = source[i]!;
              if (d === "{") {
                depth++;
              } else if (d === "}") {
                depth--;
                if (depth === 0) break;
              } else if (d === '"' || d === "'" || d === "`") {
                i++;
                while (i < to && source[i] !== d) {
                  if (source[i] === "\\") i++;
                  i++;
                }
              }
              i++;
            }
            scan(codeStart, i);
            i++;
            chunk = i;
            continue;
          }
          i++;
        }
        spans.push([chunk, i]);
        continue;
      }
      i++;
    }
  };
  scan(0, source.length);
  return spans;
}

/** Whether an index falls inside string content rather than code. */
function insideSpans(spans: ReadonlyArray<[number, number]>, index: number): boolean {
  for (const [start, end] of spans) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/**
 * Names bound to a path rooted OUTSIDE the repository (audio-feed-lm4d): an OS temp directory or `$HOME`.
 *
 * `${dir}/state.json` with `dir = await Deno.makeTempDir()` was offered as the repo-relative path
 * `state.json`, and `const root = chromeCacheRoot ?? `${home}/.cache/puppeteer/chrome`` with
 * `home = Deno.env.get("HOME")` as `.cache/puppeteer/chrome`. Neither can ever name a file a CHANGE can
 * touch - the tree is the repository - so offering them as repo hints made the completeness check fire
 * forever on reads of files that live outside it, which is what kept the inert class unreachable.
 */
function outOfRepoNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
    const name = match[1];
    const rhs = match[2] ?? "";
    if (name && /Deno\.makeTemp(?:Dir|File)\s*\(/.test(rhs)) names.add(name);
    else if (name && /Deno\.env\.get\(\s*["'](?:HOME|TMPDIR|TEMP|TMP)["']/.test(rhs)) {
      names.add(name);
    } else if (name && /(?:os|platform)\.(?:homedir|tmpdir)\s*\(/.test(rhs)) names.add(name);
  }
  return names;
}

/** The last identifier of an interpolation, so `${stateDir}` and `${config.dir}` both yield a name. */
function interpolationBaseName(token: string): string {
  const open = token.lastIndexOf("${");
  if (open < 0) return "";
  const expr = token.slice(open + 2, token.lastIndexOf("}"));
  return /([A-Za-z_$][\w$]*)\s*$/.exec(expr)?.[1] ?? "";
}

/** Static path hints found inside one call expression. * Hints are returned in two lists, because they are not the same kind of evidence (audio-feed-lm4d):
 * `paths` are path-shaped things an author wrote (a literal, or a directory prefix before an interpolation);
 * `tailCandidates` are the SUFFIXES after an interpolation, offered so that a resolvable one over-selects.
 * A suffix is not the path the author wrote, so a miss from one is not evidence of a read that could not be
 * resolved - see the `unattributed` bucket on ReadRelationReport.
 */
function staticPathHints(
  call: string,
  moduleDir: string,
  root: string,
  outOfRepo: ReadonlySet<string> = new Set(),
  suppressed: Set<string> = new Set(),
): { paths: string[]; tailCandidates: string[] } {
  const hints: string[] = [];
  const tailCandidates: string[] = [];
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
      //
      // THE DOCUMENTED BOUNDARY (audio-feed-lkvz): a template with NO statically-known path fragment at all
      // (`Deno.readDir(`${dir}`)`) deliberately yields no hint. There is nothing to check against the tree, so
      // it cannot become an unresolved PATH hint; treating every such read as an incompleteness signal would
      // widen on the temp-directory reads every suite performs, and the honest statement is that this class is
      // OUT OF SCOPE for a path-RELATION detector rather than silently handled. The next reader should see that
      // as a decision with a reason, not as an oversight: the interpolated-TAIL case above is the one that was
      // blindness, and it is fixed.
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
        // audio-feed-lkvz: an interpolation can also PRECEDE the path, and the old code threw the whole token
        // away when it did - which made the detector BLIND to every runtime-assembled read (`${dir}/data/x.csv`
        // produced no hint at all, measured). The tail after the last interpolation is statically known, so it
        // is offered as a path candidate: if it names a real file, the relation over-selects that suite (the
        // safe direction), and if it names nothing it becomes an UNRESOLVED hint, which under audio-feed-q0ky's
        // rule makes the inert class unreachable and widens the run rather than selecting nothing.
        //
        // audio-feed-lm4d: that widening is only meaningful when the base COULD be a repository path. When
        // the base is bound outside the repo (outOfRepoNames above), the tail can never name a file a change
        // touches, so it is reported as out-of-repo instead of being offered and then found missing forever.
        const tail = token.slice(token.lastIndexOf("}") + 1);
        if (/\/[^/]/.test(tail)) {
          const base = interpolationBaseName(token);
          if (base && outOfRepo.has(base)) suppressed.add(tail.replace(/^\/+/, ""));
          else tailCandidates.push(tail.replace(/^\/+/, ""));
        }
      }
      continue;
    }
    hints.push(text);
  }
  return { paths: hints, tailCandidates };
}

/**
 * Path constants defined in a module (`const EVIDENCE_DIR = `${import.meta.dirname}/../docs/evidence``),
 * so a read call that passes an IDENTIFIER (`Deno.readDir(dir)` with `dir = EVIDENCE_DIR`) still resolves.
 * That indirection is how docs/evidence is read: the suite calls evidencePngs(), which walks EVIDENCE_DIR.
 * A resolved constant with no file extension is recorded as a directory prefix, which over-selects rather
 * than under-selects - the trade this whole bead is about.
 */
function pathConstants(
  source: string,
  moduleDir: string,
  root: string,
  outOfRepo: ReadonlySet<string> = new Set(),
  suppressed: Set<string> = new Set(),
): Map<string, string> {
  const constants = new Map<string, string>();
  const declare = (name: string, resolved: string) => {
    const isDirectory = !/[^/]+\.[A-Za-z0-9]{1,5}$/.test(resolved);
    constants.set(name, isDirectory ? `${resolved.replace(/\/$/, "")}/` : resolved);
  };
  const resolve = (expr: string): string | null => {
    const { paths, tailCandidates } = staticPathHints(expr, moduleDir, root, outOfRepo, suppressed);
    // A constant can be built from a suffix: `const readme = `${dir}/README.md`` is how tests/evidence_size_test
    // reaches the root README, and dropping the tail here (audio-feed-lm4d, first attempt) DROPPED that
    // relation - the under-selection direction. The tail is accepted as the constant's value; if the constant
    // is then used at a read site and the path names nothing, it is reported as an unresolved hint, which is
    // the conservative side of the fragment/vs-authored distinction.
    if (paths.length === 1) return toRepoPath(paths[0]!, moduleDir, root);
    if (paths.length === 0 && tailCandidates.length === 1) {
      return toRepoPath(tailCandidates[0]!, moduleDir, root);
    }
    return null;
  };

  const lines = source.split("\n").map((line) => line.trim());
  for (const line of lines) {
    const match = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    // audio-feed-lm4d: `const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" })` used to register
    // the file SUFFIX as this constant's path, so every `readTextFile(tempHtmlFile)` contributed `.html/` to
    // the relation. A name bound outside the repo is not a repo path and is not a constant to resolve.
    if (outOfRepo.has(match[1])) continue;
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
 * What it cannot see is a path assembled at runtime from variables — that residual is why an undeclared
 * non-TS file still falls back to the full suite, and it is stated rather than papered over (audio-feed-40ch
 * extended the relation to assets and fixtures inside src/ and tests/; the fallback covers them unchanged).
 */
/**
 * The relation PLUS what the detector could not resolve (audio-feed-q0ky, coord's decision (b)).
 *
 * `unresolved` lists path HINTS the scan produced that do not name anything in the tree. Such a hint is the
 * detector saying "some suite reads something here and I could not confirm what": it is dropped from the
 * relation (a key derived from a mis-parsed template can never match a changed file), and dropping it
 * SILENTLY is what let the gate describe an unreadable universe as inert. The caller must not classify any
 * file inert while this list is non-empty - see planTests - because "no derived reader" and "I could not
 * resolve a read of it" are different facts, and only one of them may select nothing.
 */
export interface ReadRelationReport {
  relations: DataReadRelations;
  /** Hints that did not resolve to an existing path, sorted for a stable reason string. */
  unresolved: string[];
  /**
   * SUFFIXES of a runtime-assembled path (the text after an interpolation) that did not resolve
   * (audio-feed-lm4d), sorted for a stable reason string.
   *
   * A suffix is not the path an author wrote: it is a candidate offered so that a resolvable one over-selects
   * the suite. When it names nothing, the honest statement is "this fragment names no file in the tree", not
   * "a suite reads something here and I could not resolve it" - and the difference decides whether the inert
   * class is disabled for EVERY change. Reported, never silent (audio-feed-q0ky).
   */
  unattributed: string[];
  /**
   * Hints whose base is bound OUTSIDE the repository (audio-feed-lm4d), sorted for a stable reason string.
   *
   * They are not repo-path evidence and so they neither enter the relation nor the completeness signal -
   * but they are REPORTED, because the q0ky lesson is that dropping a hint SILENTLY is what let an
   * unreadable universe be described as inert. This bucket is the reason the `unresolved` list can be empty
   * on this tree at all.
   */
  outOfRepo: string[];
}

/** The relation alone, for callers that do not need the incompleteness signal. */
export async function deriveDataReadRelations(
  root: string = ROOT,
  suiteFiles?: readonly string[],
): Promise<DataReadRelations> {
  return (await deriveReadRelationReport(root, suiteFiles)).relations;
}

export async function deriveReadRelationReport(
  root: string = ROOT,
  suiteFiles?: readonly string[],
): Promise<ReadRelationReport> {
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
  const outOfRepoHints = new Set<string>();
  const authoredPaths = new Set<string>();
  const tailPaths = new Set<string>();
  const add = (path: string, suite: string) => {
    // TypeScript is covered by the import graph, so a relation to a .ts path is recorded nowhere: it could
    // never be consulted, and it would bury the non-TS paths that matter.
    if (path.endsWith(".ts")) return;
    // audio-feed-40ch: assets and fixtures INSIDE src/ and tests/ are now in the relation too. They used to
    // be excluded here (audio-feed-es8y's scope note) on the argument that they keep the conservative
    // full-suite fallback - which was true, and cost every one of them the whole gate: a one-line change to
    // src/assets/home.css could not select the suite that reads it. Measured before this change, that file
    // and four others like it were UNCLASSIFIED and ran all 108 suites. The fallback is still what protects
    // them when the relation names no reader (classifyNonTsChanges pushes them to `unclassified`, never to
    // `inert` - only markdown is inert), so extending the relation cannot make such a change silent: it can
    // only turn "everything" into "the suites that read it".
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
      // Two classes of hint that are not repo-path evidence, computed once per scanned file (audio-feed-lm4d):
      // the file's string CONTENT (fixture code-as-data) and its names bound outside the repository.
      const spans = stringContentSpans(source);
      const outOfRepo = outOfRepoNames(source);

      for (const [name, path] of pathConstants(source, dir, root, outOfRepo, outOfRepoHints)) {
        if (!constants.has(name)) constants.set(name, path);
      }
      // A NAME CAN BE BOTH, and the repo-attributable binding wins (audio-feed-lm4d):
      // tests/evidence_size_test.ts has a temp-dir local `dir` in one test and a `dir` parameter whose
      // default is the repo's evidence directory in another. Reading the name only as out-of-repo dropped a
      // REAL relation (`README.md <- tests/evidence_size_test.ts`, measured) - the under-selection direction,
      // which is the one that must never happen. So a name the constant pass resolved stays a repo candidate:
      // if its candidate resolves it over-selects (safe), and if it names nothing it is a reported fragment.
      const outOfRepoEffective = new Set([...outOfRepo].filter((name) => !constants.has(name)));

      for (const call of READ_CALLS) {
        for (const match of source.matchAll(new RegExp(`${call}\\s*\\(`, "g"))) {
          const at = match.index ?? 0;
          // A read that exists only inside a string is data, not a read site: the suite that carries the
          // detector's own fixtures was contributing ITS fixtures' reads as if they were its own.
          if (insideSpans(spans, at)) continue;
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
          const { paths, tailCandidates } = staticPathHints(
            callText,
            dir,
            root,
            outOfRepoEffective,
            outOfRepoHints,
          );
          for (const hint of paths) {
            const path = toRepoPath(hint, dir, root);
            if (path) {
              authoredPaths.add(path);
              add(path, suite);
            }
          }
          // The suffix after an interpolation is a CANDIDATE: it resolves into the relation when it names a
          // real file, and when it names nothing it is reported without being mistaken for a read we could
          // not resolve (audio-feed-lm4d). `authoredPaths` wins on a path offered both ways.
          for (const hint of tailCandidates) {
            const path = toRepoPath(hint, dir, root);
            if (path) {
              tailPaths.add(path);
              add(path, suite);
            }
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
  const unresolved: string[] = [];
  const unattributed: string[] = [];
  for (const [path, observers] of relations) {
    const stat = await Deno.stat(`${root}${path.replace(/\/$/, "")}`).catch(() => null);
    if (stat) existing.set(path, observers);
    else if (!authoredPaths.has(path) && tailPaths.has(path)) unattributed.push(path);
    else unresolved.push(path);
  }
  unresolved.sort();
  unattributed.sort();
  return { relations: existing, unresolved, unattributed, outOfRepo: [...outOfRepoHints].sort() };
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

export interface NonTsClassification {
  /**
   * THE INERT BUCKET: files whose change may legally select NOTHING. Markdown that no suite is derived to
   * read is the only member today, and it is deliberately a BUCKET rather than a predicate - any future
   * inert category appends HERE, and both the empty-selection decision (isProvablyInert) and the ordering
   * guard (inertContradictions) read THIS LIST. That is audio-feed-t0sp: a guard written against
   * `isDocumentation(file)` covered only the one predicate that existed when it was written, so a second
   * inert category would have reintroduced the 38sn empty pass - a real input the relation names a reader
   * for, silently selecting nothing.
   */
  inert: string[];
  /** Suites that must run because the DERIVED relation says they read the changed data. */
  suites: string[];
  /** Not .ts, not markdown, not read by anything detectable and not declared: full suite, by name. */
  unclassified: string[];
}

/**
 * Classify every non-TypeScript path in a change set against the DERIVED read relation (audio-feed-40ch,
 * audio-feed-q0kq).
 *
 * All non-.ts files (including assets and fixtures under src/ and tests/) are classified here:
 * 1. Paths a suite is observed to read map to those suites (data, narrow selection).
 * 2. Paths that are documentation (markdown) and not read by any suite are classified as inert.
 * 3. Any path with no derived reader falls through to `unclassified`, causing planTests() to run
 *    the conservative full-suite fallback.
 */
export function classifyNonTsChanges(
  changed: readonly string[],
  relations: DataReadRelations,
): NonTsClassification {
  const classification: NonTsClassification = {
    inert: [],
    suites: [],
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
 * Only when every changed file is documentation that NO suite is derived to read (audio-feed-r9fe: the
 * declarations are gone, so markdown is the only inert class left). This is audio-feed-es8y condition 2: a
 * gate that ran no suite must never read like a gate that ran suites and passed. Anything else - a standalone
 * script nothing imports, a config path, a file with no derived reader - gets the FULL suite instead.
 */
export function isProvablyInert(
  changed: readonly string[],
  classification: NonTsClassification,
): boolean {
  if (!changed.length) return false;
  const inert = new Set(classification.inert);
  return changed.every((file) => inert.has(file));
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

  console.log(
    `test-selection: the full gate runs ${full.length} test module(s); the fast gate can select ${audit.fastGateUniverse.length}.`,
  );
  console.log(
    `test-selection: the derived read relation covers ${relations.size} data path(s); nothing is declared unread, so an unread path runs the FULL suite and names itself.`,
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
