/**
 * audio-feed-dynb — the exww capture-identity mutant matrix, as a harness rather than a transcript.
 *
 * The seven mutants that prove the exww proof's capture checks CAN fail were applied by hand, over CDP,
 * every time a predicate changed. That makes the evidence that the checks are load-bearing live in a
 * transcript instead of in the tree: a refactor of the predicates can ship with the matrix quietly no
 * longer applying, and nobody would see it. This harness is the sibling of `deno task evidence`
 * (audio-feed-lyt1) and reuses its shape deliberately - structured records rather than parsed text, one
 * named invokable command, `--only <mutant>` for a single row, a demonstrated red per row, and a bound
 * on every run.
 *
 *     deno task evidence:mutants                 run the baseline and the whole matrix
 *     deno task evidence:mutants --list          print the matrix, run nothing, launch no browser
 *     deno task evidence:mutants --dry-run       apply every mutation and report how each one applied
 *     deno task evidence:mutants --only x-shift  one row
 *     deno task evidence:mutants --timeout 300   per-run bound (default 240)
 *
 * WHERE IT RUNS, AND WHY THAT IS THE DESIGN RATHER THAN AN IMPLEMENTATION DETAIL: the proof boots its own
 * in-process server (`Deno.serve` + `appFetch`) and resolves its output from its own URL
 * (`OUT = new URL("../docs/evidence/audio-feed-exww/", import.meta.url)`), so a scratch copy of
 * scripts/, src/, deno.json and docs/evidence/audio-feed-exww/ is enough to run it and every write lands
 * in the copy. THE WORKTREE THIS IS INVOKED FROM IS NEVER DIRTIED. The hand matrix did the opposite: it
 * rewrote the committed PNGs in place on every row, which is exactly the tree-pollution that
 * audio-feed-simp is about.
 *
 * HOW EACH ROW SHOWS IT APPLIED - the standard this fleet now holds, and it has two halves, both here:
 *   1. the substitution asserts its anchor appears EXACTLY ONCE, so a moved anchor is INAPPLICABLE
 *      rather than silently not applied (a mutant that did not apply looks exactly like a check that
 *      does not work); and
 *   2. the expected FAIL message must itself QUOTE the mutated value - "clip was x=1000..1280" for the
 *      x-shift, "image is 640x473" for the wrong scale. Asserting that the text changed is necessary and
 *      not sufficient; the message proves the mutated value reached the assertion.
 * The md5 of every mutated file is printed as the third, independent record of what ran.
 *
 * ROWS THAT CANNOT GO RED ARE DECLARED, NOT COUNTED (NOT_DETECTORS below, printed on every run): the
 * geometry branches that REFUSE to measure when the section or the claim box is not inside the clip are
 * reachable only from a page state no single-text mutation produces, so they are named as non-detectors
 * in this matrix rather than left to look covered.
 *
 * WHAT IT DOES NOT DO: it is not wired into the fast gate, and it does not map the proof script to a
 * suite - audio-feed-k0jb forbids a relation that looks like coverage, and eight browser runs cannot go
 * in a tier budgeted so that a docs-only change selects no suites. audio-feed-coao (the proof script
 * being unmapped) is the bead that decides WHO invokes this; this file only makes invoking it possible.
 */
import { join, resolve } from "@std/path";

export interface Mutant {
  /** Row name, as `--only` spells it. */
  name: string;
  /** The finding that produced this row. */
  bead: string;
  /** What the row proves about the predicates, in one line. */
  why: string;
  /** The exact-text substitution; throws when the anchor is not there exactly once. */
  apply: (source: string) => string;
  /** Substrings that MUST appear among the FAIL lines (mutated values included, deliberately). */
  expect: string[];
  /** When set, these are the ONLY failures allowed: the separation is enforced, not commented. */
  soleRed?: string[];
}

/** The application record for a mutation: what actually ran, not what we meant to run. */
async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(
    0,
    16,
  );
}

export interface Options {
  list: boolean;
  dryRun: boolean;
  only?: string;
  timeoutMs: number;
  keep?: string;
}

const REPO = resolve(new URL("../", import.meta.url).pathname);
export const PROOF_REL = "scripts/exww-live-claims-browser-proof.ts";
const PROOF = PROOF_REL;
/** Where the mutant matrix gets its results from; the tier's own contract (`scripts/proof-helper.ts`). */
const FAIL_PREFIX = "FAIL";

/**
 * One anchor, one substitution, and an assertion that it applied exactly once. `label` is what the
 * failure message names when an anchor has moved, so an INAPPLICABLE row says which row and which text
 * rather than "mutant failed".
 */
export function substitute(source: string, from: string, to: string, label: string): string {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `anchor appears ${occurrences} time(s), expected exactly 1, so the mutation DID NOT APPLY as ` +
        `written: ${label}`,
    );
  }
  return source.replace(from, to);
}

/** Inject a statement into the proof's failure-section probe, the seam every hiding mutant uses. */
function injectBeforeProbe(source: string, statement: string, label: string): string {
  return substitute(
    source,
    "      const failuresText = await failuresSectionText();",
    `      await js(\`(() => { const sec = document.querySelector('[aria-labelledby="failures-h"]'); ` +
      `const wants = 'provider status 500'; const els = [...sec.querySelectorAll('*')]` +
      `.filter((e) => (e.textContent ?? '').includes(wants)); ` +
      `const el = els.find((e) => ![...e.children].some((c) => (c.textContent ?? '').includes(wants))) ` +
      `?? els[els.length - 1]; ${statement}; return el.tagName; })()\`);\n` +
      "      const failuresText = await failuresSectionText();",
    label,
  );
}

export const MUTANTS: Mutant[] = [
  {
    name: "x-shift",
    bead: "audio-feed-9zgi / audio-feed-ehcu",
    why: "a capture of the section's own ROWS but another COLUMN must not pass",
    apply: (s) =>
      substitute(
        s,
        "          x: Math.max(0, Math.floor(bounds.left) - 8),",
        '          x: name.startsWith("04-") ? 1000 : Math.max(0, Math.floor(bounds.left) - 8),',
        "04 clip x -> 1000",
      ),
    expect: [
      "captured the section's own box, not another region of the page",
      "clip was x=1000..1280",
    ],
  },
  {
    name: "y-shift",
    bead: "audio-feed-g86r",
    why: "a capture that starts at the top of the page must not pass",
    apply: (s) =>
      substitute(
        s,
        "          y: Math.max(0, Math.floor(bounds.top) - 8),",
        '          y: name.startsWith("04-") ? 0 : Math.max(0, Math.floor(bounds.top) - 8),',
        "04 clip y -> 0",
      ),
    expect: ["captured the section's own box, not another region of the page"],
  },
  {
    name: "section-opacity-0",
    bead: "audio-feed-7yom",
    why:
      "hiding the section leaves textContent and layout intact while the image records background",
    apply: (s) =>
      injectBeforeProbe(
        s,
        "el.closest('[aria-labelledby=\"failures-h\"]').style.opacity = '0'",
        "failures section opacity:0",
      ),
    expect: [
      "is a capture of rendered content, not a flat single-colour clip",
      "actually rendered, not just present in the DOM",
    ],
  },
  {
    name: "card-opacity-0",
    bead: "audio-feed-7yom",
    why:
      "hiding the CARD alone is a different red from hiding the section, which is why both rows exist",
    apply: (s) => injectBeforeProbe(s, "el.style.opacity = '0'", "failure card opacity:0"),
    expect: ["actually rendered, not just present in the DOM"],
  },
  {
    name: "wrong-scale",
    bead: "audio-feed-9zgi",
    why: "a right-box, wrong-scale capture must fail on the image's own dimensions",
    apply: (s) =>
      substitute(
        s,
        "          scale: EVIDENCE_SCALE,",
        '          scale: name.startsWith("04-") ? 0.5 : EVIDENCE_SCALE,',
        "04 clip scale -> 0.5",
      ),
    expect: ["image is 640x473 for a clip of 1280x946"],
  },
  {
    name: "background-coloured-claim",
    bead: "audio-feed-9zgi",
    why:
      "the axis a computed-style check structurally cannot see: 'visible' to the style check, blank in " +
      "the image - this row must fail the INK check ALONE",
    apply: (s) =>
      injectBeforeProbe(
        s,
        "el.style.color = 'rgb(247, 247, 247)'",
        "claim painted in the page background",
      ),
    expect: ['shows ink where "provider status 500" is painted'],
    soleRed: ['shows ink where "provider status 500" is painted'],
  },
  {
    name: "different-text",
    bead: "audio-feed-9zgi",
    why: "the section must show the text the README's claim names, not merely something",
    apply: (s) =>
      substitute(
        s,
        "      const failuresText = await failuresSectionText();",
        "      await js(`(() => { const sec = document.querySelector('[aria-labelledby=\"failures-h\"]'); sec.innerHTML = sec.innerHTML.split('provider status 500').join('provider status 404'); return true; })()`);\n" +
          "      const failuresText = await failuresSectionText();",
        "failures section paints 'provider status 404'",
      ),
    expect: ['has "provider status 500" inside the captured pixels'],
  },
];

/**
 * Named so nobody counts them as coverage: these rows exist in the predicates and no single-text
 * mutation in this matrix reddens them. If a future mutation can reach one, move it up into MUTANTS.
 */
export const NOT_DETECTORS: Array<{ row: string; why: string }> = [
  {
    row:
      "the refuse-to-measure branches (section or claim box not inside the clip -> NaN, so the check fails)",
    why:
      "reachable only from a page state no single-text mutation produces: they are the guard against " +
      "reporting someone else's pixels as this section's content, and their reddening would need a " +
      "capture-time geometry change, not a source edit",
  },
  {
    row: "the faded-rendering band between flat (~1e-8) and the measured claim boxes (0.235-0.353)",
    why:
      "audio-feed-l11d's finding; a contrast floor is being designed on that bead, and this matrix " +
      "should carry the row only once the floor's threshold exists to assert against",
  },
];

function parseOptions(args: string[]): Options {
  const options: Options = { list: false, dryRun: false, timeoutMs: 240_000 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    if (arg === "--list") options.list = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--only" && value) {
      options.only = value;
      i++;
    } else if (arg === "--timeout" && value) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`--timeout needs positive seconds, got ${JSON.stringify(value)}`);
      }
      options.timeoutMs = Math.round(seconds * 1000);
      i++;
    } else if (arg === "--keep" && value) {
      options.keep = value;
      i++;
    } else {
      throw new Error(
        `unrecognised argument ${JSON.stringify(arg)}\n` +
          "usage: deno task evidence:mutants [--list] [--dry-run] [--only <name>] [--timeout <s>] [--keep <dir>]",
      );
    }
  }
  if (options.only && !MUTANTS.some((m) => m.name === options.only)) {
    throw new Error(
      `--only ${options.only} matches no row; known rows: ${MUTANTS.map((m) => m.name).join(", ")}`,
    );
  }
  return options;
}

function printMatrix(): void {
  console.log(`[mutants] ${MUTANTS.length} row(s) against ${PROOF}`);
  for (const mutant of MUTANTS) {
    console.log(`  ${mutant.name.padEnd(26)} ${mutant.bead}`);
    console.log(`      proves: ${mutant.why}`);
    console.log(`      expects the run to redden: ${mutant.expect.join(" | ")}`);
    if (mutant.soleRed) {
      console.log(
        `      and NOTHING else may fail (separation enforced): ${mutant.soleRed.join(" | ")}`,
      );
    }
  }
  console.log(
    `[mutants] ${NOT_DETECTORS.length} DECLARED NON-DETECTOR(s) - rows this matrix does not redden:`,
  );
  for (const row of NOT_DETECTORS) console.log(`  NOT A DETECTOR: ${row.row}\n      ${row.why}`);
}

/** The scratch tree: only what the proof imports and writes, so the invoking worktree stays clean. */
export async function buildScratch(options: Pick<Options, "keep"> = {}): Promise<string> {
  const dir = options.keep
    ? resolve(options.keep)
    : await Deno.makeTempDir({ prefix: "exww-mutants-" });
  // COPY WHAT THE TREE CARRIES RATHER THAN AN ENUMERATED LIST, because the enumeration went stale the moment a
  // proof imported something outside it: the exww proof imports ../tests/fixtures.ts, so every run in a scratch
  // that carried only scripts/src/deno.json died with "Module not found" in 0.1s - the baseline was never green
  // and every row's "red" was a red for the wrong reason. A scratch that cannot run the unmutated proof makes
  // the whole matrix meaningless, so this is a correctness fix.
  // Excluded on purpose: .git and .beads (a scratch has no business copying a git dir or a possibly-locked Dolt
  // DB), node_modules (installs are not inputs to a Deno proof), and .fleet (per-VM state).
  for await (const entry of Deno.readDir(REPO)) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const src = join(REPO, entry.name);
    const dst = join(dir, entry.name);
    if (entry.isDirectory) await copyTree(src, dst);
    else if (entry.isFile) await Deno.copyFile(src, dst);
  }
  return dir;
}

const SKIP_ENTRIES = new Set([".git", ".beads", ".fleet", "node_modules"]);

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory) await copyTree(src, dst);
    else if (entry.isFile) await Deno.copyFile(src, dst);
  }
}

export interface RunOutcome {
  code: number;
  seconds: number;
  timedOut: boolean;
  failures: string[];
  passCount: number;
  tail: string;
}

export async function runProofIn(
  dir: string,
  timeoutMs = 240_000,
): Promise<RunOutcome> {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const started = performance.now();
  const child = new Deno.Command("timeout", {
    args: [
      "-k",
      "5",
      `${seconds}`,
      Deno.execPath(),
      "run",
      "--allow-all",
      "--unstable-kv",
      join(dir, PROOF),
    ],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = await child.output();
  const text = `${new TextDecoder().decode(output.stdout)}\n${
    new TextDecoder().decode(output.stderr)
  }`;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const failures = lines.filter((line) => line.startsWith(`${FAIL_PREFIX} `)).map((line) =>
    line.slice(5)
  );
  return {
    code: output.code,
    seconds: (performance.now() - started) / 1000,
    timedOut: isUnknownExit(output.code),
    failures,
    passCount: lines.filter((line) => line.startsWith("PASS ")).length,
    tail: lines.slice(-6).join("\n  "),
  };
}

/**
 * THE FLEET'S DEFINITION OF UNKNOWN, IN ONE PLACE (audio-feed-l6b6): 124 is the bound, 137 is SIGKILL and 143
 * is SIGTERM. A run killed by a bound is UNKNOWN - never a pass and never a fail - and the CLI used to omit
 * 143, so a `timeout` that escalated would have read as an ordinary non-zero exit.
 */
export const UNKNOWN_EXIT_CODES: readonly number[] = [124, 137, 143];

export function isUnknownExit(code: number): boolean {
  return UNKNOWN_EXIT_CODES.includes(code);
}

/** What a run can mean. `unknown` is its own outcome, not a flavour of pass or fail. */
export type Verdict = "green" | "red on the named check" | "unknown" | "unexpected";

/** A row's recorded outcome: the interpretation's verdicts plus the two states that are not run outcomes. */
export type RowResultVerdict = Verdict | "inapplicable" | "failed to run";

/**
 * The display form, derived in ONE place from the same enum the summary counts. The CLI's counts and its
 * printout were briefly off by a representation (a `green` baseline counted as `unexpected`) because two
 * strings described one verdict - so the enum is the record and this is the only place it becomes prose.
 */
export function describeVerdict(verdict: RowResultVerdict): string {
  switch (verdict) {
    case "green":
      return "as expected (green)";
    case "red on the named check":
      return "as expected (red on the named check)";
    case "unknown":
      return "UNKNOWN (a bound killed it: not a pass, not a fail)";
    case "inapplicable":
      return "INAPPLICABLE (the row's anchor is gone)";
    case "failed to run":
      return "FAILED TO RUN";
    default:
      return "UNEXPECTED";
  }
}

/** The three-way count the CLI reports. Extracted because a CLERICAL bug lived here: a `green` baseline was
 *  counted as unexpected when the record held the enum and the counter compared display strings, and the run
 *  went RED with every row correct. A count is not a presentation, so it is its own function with its own test. */
export interface Summary {
  expected: number;
  unknown: number;
  unexpected: number;
}

export function summarise(results: readonly { verdict: RowResultVerdict }[]): Summary {
  const summary: Summary = { expected: 0, unknown: 0, unexpected: 0 };
  for (const { verdict } of results) {
    if (verdict === "green" || verdict === "red on the named check") summary.expected++;
    else if (verdict === "unknown") summary.unknown++;
    else summary.unexpected++;
  }
  return summary;
}

/** What a caller expects of a run: the BASELINE must be green, a detector row must redden its named check. */
export type Expectation =
  | { kind: "green" }
  | { kind: "detector"; expect: string[]; soleRed?: string[] };

export interface Interpretation {
  verdict: Verdict;
  detail: string;
}

/**
 * ONE INTERPRETATION FOR EVERY CALLER - the CLI's summary and the mapped suite - because two parsers of the
 * same outcome is how the CLI and the suite came to disagree (audio-feed-l6b6: the suite checked `timedOut`
 * and the CLI accepted any non-zero exit, so a run the bound killed could be counted as an expected detector
 * red). The unknown check comes FIRST and returns regardless of what the run printed before it died: a named
 * FAIL emitted before the bound hit does NOT make a killed run a red, because the row's whole point is that a
 * bound is unknown. That false green - "as expected" produced by a killed run - is the exact defect the row
 * exists to prevent, arriving through the harness's own CLI.
 */
export function interpretRun(outcome: RunOutcome, expectation: Expectation): Interpretation {
  if (outcome.timedOut || isUnknownExit(outcome.code)) {
    return {
      verdict: "unknown",
      detail: `killed by the bound (exit ${outcome.code}) after ${outcome.seconds.toFixed(1)}s: ` +
        `a bound is UNKNOWN, never a pass and never a fail, whatever the run printed first`,
    };
  }
  if (expectation.kind === "green") {
    return outcome.code === 0 && outcome.failures.length === 0
      ? { verdict: "green", detail: `${outcome.passCount} check(s) passed` }
      : {
        verdict: "unexpected",
        detail: `expected a green run: exit ${outcome.code}, ${outcome.failures.length} failed`,
      };
  }
  if (outcome.code === 0) {
    return {
      verdict: "unexpected",
      detail: "the mutant did not redden the proof: exit 0, so the check did not react",
    };
  }
  const expectedSeen = expectation.expect.every((needle) =>
    outcome.failures.some((f) => f.includes(needle))
  );
  const soleRedOk = !expectation.soleRed ||
    (outcome.failures.length === expectation.soleRed.length &&
      outcome.failures.every((f) => expectation.soleRed!.some((needle) => f.includes(needle))));
  if (!expectedSeen) {
    return {
      verdict: "unexpected",
      detail:
        `MISSING the expected red: ${
          expectation.expect.join(" | ")
        } - the mutant applied and the ` +
        `check did not react, which is the state this harness exists to make loud`,
    };
  }
  if (!soleRedOk) {
    return {
      verdict: "unexpected",
      detail: `SOLE-RED violated: expected only ${expectation.soleRed?.join(" | ")}`,
    };
  }
  return {
    verdict: "red on the named check",
    detail: `exit ${outcome.code}, ${outcome.failures.length} check(s) red`,
  };
}

/** Apply one named row to the proof's source. Shared by the matrix and the mapped test, so a row cannot
 *  drift between the tier that runs all of them and the suite that runs one of them. */
export function applyMutant(source: string, name: string): string {
  const mutant = MUTANTS.find((m) => m.name === name);
  if (!mutant) {
    throw new Error(`no such row: ${name}; known: ${MUTANTS.map((m) => m.name).join(", ")}`);
  }
  return mutant.apply(source);
}

// THE MATRIX RUNS ONLY AS A SCRIPT (audio-feed-coao, found by the gate): this module is IMPORTED by
// tests/exww_mutants_test.ts for its rows and its runner, and without this guard the import executed all
// seven rows and called Deno.exit(1) from outside any test, which terminated the test isolate and turned a
// mapped suite into "error: Test failed" before a single assertion ran. A module the gate imports must not
// have side effects at import time; the CLI behaviour is unchanged under `deno task evidence:mutants`.
if (import.meta.main) {
  const options = parseOptions(Deno.args);
  if (options.list) {
    printMatrix();
    Deno.exit(0);
  }

  const source = await Deno.readTextFile(join(REPO, PROOF));
  const rows = options.only ? MUTANTS.filter((m) => m.name === options.only) : MUTANTS;

  if (options.dryRun) {
    let inapplicable = 0;
    for (const mutant of rows) {
      try {
        const mutated = mutant.apply(source);
        const digest = await sha256(mutated);
        // NET LINE DELTA, not a positional comparison: an INSERTED line shifts every later line, so a
        // positional diff reports the whole tail as touched - it printed "312 lines" for a one-line
        // injection until I checked it. The application record is the anchor assertion plus the sha256;
        // this number is only here to say whether the edit inserted anything.
        const changed = mutated.split("\n").length - source.split("\n").length;
        console.log(
          `[mutants] APPLIES  ${mutant.name.padEnd(26)} sha256 ${digest} anchor x1, net ${
            changed >= 0 ? "+" : ""
          }${changed} line(s)`,
        );
      } catch (err) {
        inapplicable++;
        console.log(`[mutants] INAPPLICABLE ${mutant.name}: ${(err as Error).message}`);
      }
    }
    console.log(
      `[mutants] --dry-run: ${
        rows.length - inapplicable
      } of ${rows.length} row(s) apply to the proof as it ` +
        `stands; ${inapplicable} INAPPLICABLE (a moved anchor is a row that no longer tests anything)`,
    );
    Deno.exit(inapplicable > 0 ? 1 : 0);
  }

  const scratch = await buildScratch(options);
  console.log(`[mutants] scratch tree ${scratch} (the invoking worktree is not written to)`);
  const results: Array<{ row: string; verdict: RowResultVerdict; detail: string }> = [];

  try {
    // The BASELINE is not decoration: without it, a harness that reddens everything would look correct.
    const baseline = await runProofIn(scratch, options.timeoutMs);
    const baselineVerdict = interpretRun(baseline, { kind: "green" });
    const baselineOk = baselineVerdict.verdict === "green";
    console.log(
      `[mutants] BASELINE ${
        baselineVerdict.verdict === "green"
          ? "ok  "
          : baselineVerdict.verdict === "unknown"
          ? "UNKNOWN"
          : "FAIL"
      } exit ${baseline.code}, ${baseline.seconds.toFixed(1)}s, ` +
        `${baseline.passCount} check(s) passed, ${baseline.failures.length} failed`,
    );
    if (!baselineOk) console.log(`  ${baselineVerdict.detail}`);
    results.push({
      row: "BASELINE (unmutated)",
      verdict: baselineVerdict.verdict,
      detail: baselineVerdict.detail,
    });
  } catch (err) {
    console.log(`[mutants] BASELINE could not run: ${(err as Error).message}`);
    results.push({
      row: "BASELINE (unmutated)",
      verdict: "failed to run",
      detail: (err as Error).message,
    });
  }

  for (const mutant of rows) {
    let mutated: string;
    try {
      mutated = mutant.apply(source);
    } catch (err) {
      console.log(`[mutants] INAPPLICABLE ${mutant.name}: ${(err as Error).message}`);
      results.push({ row: mutant.name, verdict: "inapplicable", detail: (err as Error).message });
      continue;
    }
    const digest = await sha256(mutated);
    await Deno.writeTextFile(join(scratch, PROOF), mutated);
    const outcome = await runProofIn(scratch, options.timeoutMs);
    const judged = interpretRun(outcome, {
      kind: "detector",
      expect: mutant.expect,
      soleRed: mutant.soleRed,
    });
    const asExpected = judged.verdict === "red on the named check";
    console.log(
      `[mutants] ${asExpected ? "ok  " : judged.verdict === "unknown" ? "UNKNOWN" : "UNEXPECTED"} ${
        mutant.name.padEnd(26)
      } modified-sha ${digest} ` + judged.detail,
    );
    if (!asExpected) {
      for (const failure of outcome.failures) console.log(`      red: ${failure.slice(0, 130)}`);
      console.log(`      ${judged.detail}`);
    }
    results.push({
      row: mutant.name,
      verdict: judged.verdict,
      detail: asExpected
        ? `${outcome.failures.length} check(s) red, sha256 ${digest}`
        : `exit ${outcome.code}, ${outcome.failures.length} red`,
    });
    // Restore for the next row: every mutant starts from the pristine proof.
    await Deno.writeTextFile(join(scratch, PROOF), source);
  }

  printMatrix();
  // UNKNOWN IS ITS OWN ROW IN THE SUMMARY, not a flavour of unexpected (audio-feed-l6b6): a bound that killed
  // a row means that row was NOT TESTED, which is a different statement from a row that behaved wrongly - and
  // the difference is the whole reason 124/137/143 are called unknown in this fleet.
  // THE COUNT IS ITS OWN FUNCTION (summarise), so the clerical bug this fix hit - a `green` baseline counted
  // as unexpected because the counter compared display strings - is testable without a browser and cannot come
  // back silently.
  const counts = summarise(results);
  const unknown = results.filter((r) => r.verdict === "unknown");
  const unexpected = results.filter((r) =>
    r.verdict !== "green" && r.verdict !== "red on the named check" && r.verdict !== "unknown"
  );
  console.log(
    `[mutants] ${counts.expected} row(s) as expected, ${counts.unknown} UNKNOWN ` +
      `(a bound killed it: not a pass, not a fail, the row was not tested), ${counts.unexpected} unexpected`,
  );
  if (!options.keep) {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  } else {
    console.log(`[mutants] scratch kept at ${scratch} (--keep)`);
  }
  if (unknown.length > 0) {
    console.log("[mutants] UNKNOWN rows: a bound killed the run, so the row proved nothing");
    for (const row of unknown) console.log(`  ${row.row}: ${row.detail}`);
  }
  if (unexpected.length > 0) {
    console.log("[mutants] RED: a row did not behave as the matrix claims");
    for (const row of unexpected) {
      console.log(`  ${row.row}: ${describeVerdict(row.verdict)} - ${row.detail}`);
    }
  }
  if (counts.unexpected > 0 || counts.unknown > 0) Deno.exit(1);
  console.log(
    "[mutants] every row behaved as the matrix claims, and the declared non-detectors are listed above",
  );
}
