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
        "The fast gate's selection must be a SUBSET of the full gate's, and these modules fall outside it,",
        "so a fast-gate PASS would say nothing about them. Fix it in scripts/test-selection.ts, one of two ways:",
        "  (a) widen isFastGateSelectable() so the fast gate can select them, or",
        "  (b) add each one to FAST_GATE_EXCLUSIONS with a reason saying where it IS run instead.",
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
 * A non-TypeScript path whose change can change a suite's result, and the suites that observe it.
 * `readBy: []` is a POSITIVE claim that nothing reads it — which is why every entry carries a reason.
 */
export interface DataLedgerEntry {
  /** Repo-relative prefix (directory, ending in `/`) or exact path. */
  pattern: string;
  /** Suites the full gate runs that observe this path. Empty means "verified nobody does". */
  readBy: string[];
  reason: string;
}

/**
 * The ledger for non-TypeScript changes OUTSIDE src/ and tests/.
 *
 * The rule this replaces was "not a .ts file, so no test can care" — which is how a 200KB
 * docs/evidence/*.png came to select ZERO suites while tests/evidence_size_test.ts asserts the PNG byte
 * budgets, so the fast gate passed and the full gate failed on the same tree (reproduced 2026-10-11).
 * Anything not covered here and not documentation is now an UNCLASSIFIED full-suite fallback that names the
 * file, so the ledger is what keeps a lane fast without letting a suite fall out of the selection.
 *
 * Every `readBy` entry is checked twice by tests/fast_gate_subset_test.ts: it must name a suite that exists
 * and that the fast gate can select, and (for the evidence tree) the suite must really read the pattern.
 */
export const DATA_LEDGER: DataLedgerEntry[] = [
  {
    pattern: "docs/evidence/",
    readBy: ["tests/evidence_size_test.ts"],
    reason:
      "evidencePngs() walks this tree and the suite asserts the per-file (150KB) and aggregate (8MB) PNG byte budgets (audio-feed-39k1), so a changed screenshot changes its result. Selecting that one suite beats both the old behaviour (nothing ran, so a fast PASS hid a full FAIL) and a blanket full-suite fallback for every screenshot a lane adds.",
  },
  {
    pattern: "scripts/observability-agent-run.sh",
    readBy: ["tests/observability_agent_poll_test.ts"],
    reason:
      "the suite EXECUTES this runner (`sh scripts/observability-agent-run.sh --interval-seconds 0`) and asserts its exit code and stderr text, so the runner is test-observable content that happens not to be TypeScript. Before audio-feed-es8y a change to it selected zero suites.",
  },
  {
    pattern: ".beads/",
    readBy: [],
    reason:
      "beads export and hooks: task state, not test input. Verified no suite reads it (no readTextFile/readDir/stat under tests/ names .beads), so a beads-only commit correctly stays a fast no-test change rather than a full-suite run on every lane.",
  },
  {
    pattern: ".github/",
    readBy: [],
    reason: "CI workflow config; no suite reads it (checked).",
  },
  {
    pattern: ".gitignore",
    readBy: [],
    reason: "VCS ignore list; no suite reads it (checked).",
  },
  {
    pattern: ".codex/",
    readBy: [],
    reason: "agent tool config committed to the repo; no suite reads it (checked).",
  },
  {
    pattern: ".agents/",
    readBy: [],
    reason: "agent skills/instructions committed to the repo; no suite reads it (checked).",
  },
  {
    pattern: ".claude/",
    readBy: [],
    reason: "agent tool config committed to the repo; no suite reads it (checked).",
  },
];

/** `.md` anywhere: prose. No suite in this repo reads markdown content (checked 2026-10-11: every test's
 * readTextFile/readDir/stat target is code, JSON, HTML or a picture; the docs paths that appear in tests
 * are inside failure MESSAGES telling a human where to look). */
export function isDocumentation(relPath: string): boolean {
  return relPath.endsWith(".md");
}

/** The ledger entry a repo-relative path belongs to: exact match, or directory prefix. */
export function ledgerEntryFor(
  relPath: string,
  ledger: readonly DataLedgerEntry[] = DATA_LEDGER,
): DataLedgerEntry | undefined {
  return ledger.find((entry) =>
    entry.pattern.endsWith("/") ? relPath.startsWith(entry.pattern) : relPath === entry.pattern
  );
}

export interface NonTsClassification {
  /** Markdown: no suite reads it, so no selection consequence. */
  documentation: string[];
  /** Suites that must run because a change touches data they observe. */
  suites: string[];
  /** Not .ts, not markdown, not in the ledger: the caller must fall back to the FULL suite and say so. */
  unclassified: string[];
}

/**
 * Classify the non-TypeScript half of a change set. Callers handle non-.ts files under src/ and tests/
 * themselves (those are already a full-suite fallback: assets, fixtures) and reach this for everything else.
 */
export function classifyNonTsChanges(
  changed: readonly string[],
  ledger: readonly DataLedgerEntry[] = DATA_LEDGER,
): NonTsClassification {
  const classification: NonTsClassification = {
    documentation: [],
    suites: [],
    unclassified: [],
  };
  const suites = new Set<string>();

  for (const file of changed) {
    if (file.endsWith(".ts")) continue;
    if (isDocumentation(file)) {
      classification.documentation.push(file);
      continue;
    }
    const entry = ledgerEntryFor(file, ledger);
    if (!entry) {
      classification.unclassified.push(file);
      continue;
    }
    for (const suite of entry.readBy) suites.add(suite);
  }

  classification.suites = [...suites].sort();
  return classification;
}

/**
 * Ledger self-checks that do not need the fast gate's graph: every suite named by the ledger exists and is
 * selectable, every entry explains itself, and every pattern is a path that exists in the tree (so a typo
 * like `docs/evidence` without its slash cannot silently stop matching).
 */
export async function auditDataLedger(
  root: string = ROOT,
  ledger: readonly DataLedgerEntry[] = DATA_LEDGER,
  fullGateTestFiles: string[] = [],
): Promise<string[]> {
  const problems: string[] = [];
  const known = new Set(fullGateTestFiles);
  for (const entry of ledger) {
    if (!entry.pattern.trim()) problems.push("a DATA_LEDGER entry has no pattern");
    if (!entry.reason.trim()) problems.push(`${entry.pattern} has no reason`);
    for (const suite of entry.readBy) {
      if (!known.has(suite)) {
        problems.push(`${entry.pattern} names ${suite}, which is not a full-gate module`);
      } else if (!isFastGateSelectable(suite)) {
        problems.push(`${entry.pattern} names ${suite}, which the fast gate cannot select`);
      }
    }
    const path = entry.pattern.endsWith("/") ? entry.pattern.slice(0, -1) : entry.pattern;
    const stat = await Deno.stat(`${root}${path}`).catch(() => null);
    if (stat === null) problems.push(`${entry.pattern} does not exist in the tree`);
  }
  return problems;
}

if (import.meta.main) {
  const full = await discoverFullGateTestFiles();
  const audit = auditSelection(full);
  const ledgerProblems = await auditDataLedger(ROOT, DATA_LEDGER, full);

  console.log(
    `test-selection: the full gate runs ${full.length} test module(s); the fast gate can select ${audit.fastGateUniverse.length}.`,
  );
  if (!audit.ok) {
    console.error(audit.message);
    Deno.exit(1);
  }
  if (ledgerProblems.length) {
    console.error(
      `fast-gate: DATA_LEDGER problem(s) (audio-feed-es8y):\n  ${ledgerProblems.join("\n  ")}`,
    );
    Deno.exit(1);
  }
  console.log("test-selection: ok");
}
