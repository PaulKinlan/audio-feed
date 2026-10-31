/**
 * audio-feed-lyt1 — NOTHING RAN THE PROOFS.
 *
 * The repo's founding evidence rule is "no evidence without a check that can fail, and no README
 * claiming more than the check covers". Every evidence README already names the script that produces
 * it, in a `- Script: <path>` line, and the debt list tracks which directories declare nothing. What
 * was missing was that NOTHING EVER EXECUTED THE THING DECLARED: a proof could be unable to pass for
 * days while its README and screenshots sat committed, and an app change could invalidate several
 * proofs without any gate going red. Three examples in one night (audio-feed-8fc, 0cmu, and the
 * migration that ran them by accident) — each found only because something happened to run the proof.
 *
 * This adds a NEW, EXPLICITLY-INVOKED TIER rather than widening an existing one:
 *
 *     deno task evidence                 run every declared proof, sequentially
 *     deno task evidence --list          the inventory only: no browsers, no servers
 *     deno task evidence --only <dir>    one evidence directory (its directory NAME)
 *     deno task evidence --timeout <s>   per-proof bound (default 300)
 *     deno task evidence --root <dir>    resolve declarations under another root (used to prove the
 *                                        tier can go red, against a scratch evidence tree)
 *
 * EXIT CODES, because a silent non-zero is as useless as a silent skip:
 *     0  every declared proof passed, and every evidence directory declares something;
 *     1  at least one declared proof FAILED, a declared script is not a file (UNRESOLVED),
 *        or the evidence tree is REFUSED (nested evidence or a symlink); debt is still reported;
 *     2  every declared proof passed, but the tree carries DECLARATION DEBT - a directory that
 *        declares nothing or has no README. Debt is not a proof failure and is not a pass either:
 *        a skip that is not printed is a test that stopped testing, so it is named and it is non-zero.
 *
 * WHY A NEW TIER AND NOT A MAPPING INTO fast-check: a mapping buys speed with a new suppression
 * surface — a mapping that names the wrong suite suppresses a slice's gate while looking green
 * (audio-feed-nxnf states exactly this risk) — and a browser proof cannot run inside the fast gate
 * anyway without breaking its budget, which requires that a docs-only change still select no suites.
 * scripts/fast-check.ts and scripts/test-selection.ts are not touched by this change.
 *
 * WHERE TO RUN IT, which is not obvious and has already bitten this repo once: the proofs REWRITE
 * their own committed artefacts under docs/evidence, so the tier is a WRITER and must not share a
 * worktree with anything else that writes - a gate run in the same tree while a proof rewrites its
 * PNGs fails for reasons that have nothing to do with the diff. Run it in its own worktree (or one no
 * gate is using) and restore the artefacts afterwards. It is also bounded twice over, per proof and in
 * total, which is what lets it run in the fleet's single heavy slot: `--timeout <s>` bounds each proof
 * and the invocation itself is wrapped in a total bound.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, so nobody reads more into a green run than it says:
 * - it does not check that a proof asserts what its README CLAIMS (that is the declaration and
 *   evidence-size work);
 * - it does not run proofs whose README declares `- Executed by: <suite>` with an existing suite
 *   that references the proof (audio-feed-zmwa1: a suite that never names the proof is not its
 *   owner, and the tier refuses the run rather than trusting the name). That declaration
 *   (audio-feed-4oe2) means the SUITE owns the proof's execution — the gate even
 *   selects the suite from it (scripts/fast-check.ts, audio-feed-ruqh) — so executing it here as
 *   well would run a proof under a bound the suite never chose: audio-feed-8u4x1's campaign runs
 *   12 attempts under a 600s per-attempt bound and a 4800s deadline, and the tier's 300s default
 *   SIGKILLed it before it could write its record, every time, while --list correctly labelled it
 *   `[executed by: ...]`. Such proofs are SKIPped BY NAME in a run (a skip that is not printed is
 *   a test that stopped testing) and stay in the inventory.
 * - it does not run directories that declare nothing. It COUNTS them, because "there is no proof
 *   here" is a different fact from "the proof here passes", and printing the count keeps the debt
 *   visible instead of letting it read as coverage;
 * - a declared script that is not a file is an UNRESOLVED FAILURE, never a skip: a tier that skips
 *   quietly is satisfied by construction, which is the defect class this fleet has been closing all
 *   evening.
 *
 * audio-feed-h22ml — EVERY CLAIMED RUN LEAVES A CHECKABLE RECORD. The tier wrote NOTHING: no log, no
 * digest, no state, so "declared" was mistaken for "green" all night - a proof that could never
 * complete went unnoticed for weeks, and a suite-owned proof was SIGKILLed at the 300s default bound
 * every run while the tier printed "every declared proof passed". After each proof run the tier now
 * writes `docs/evidence/<id>/run.json` (the committed per-dir file is the SAME churn class the proofs
 * already own - they rewrite repro.json and PNGs today):
 *
 *     { "script": "scripts/...", "sha": "<40-hex HEAD of the run>",
 *       "bound": { "ms": 300000, "provenance": "flag" | "declared" | "default" },
 *       "startedAt": "<ISO>", "endedAt": "<ISO>", "exit": 0, "marker": true,
 *       "artefacts": { "<file>": "sha256:..." } }   // every file in the dir except README.md and run.json
 *
 * The bound comes from resolveBound() - reused, never recomputed. Staleness is GIT, not arithmetic:
 * `git merge-base --is-ancestor <record.sha> HEAD`; a sha that is not an ancestor is visibly stale
 * and never silently believed. On the RUN path these are incidents that make the invocation exit
 * non-zero while the proof still runs (running is how a stale or failed record is refreshed): no
 * run.json (when armed, see below); sha not in history or unverifiable; endedAt older than 30 days;
 * exit !== 0 or marker === false (124 and 137 stay distinct from a clean exit in the record and in
 * the incident text); any artefact hash mismatch, missing artefact, or unrecorded file. A proof the
 * tier RAN must leave a parseable record afterward - if the writer is broken the tier names "the tier
 * ran <dir> and wrote no record" and goes red (that guarantee is NEVER gated: it is the detector for
 * the exact "ran and wrote nothing" silence this bead exists to close).
 *
 * AMENDMENT 1 (Paul): the "no run.json => exit 1" rule must NOT be armed until the records exist.
 * It lives behind the single constant EVIDENCE_RECORDS_ENFORCED below. While it is false the run path
 * quietly seeds a record for any dir that lacks one ("a red wall nobody reads is how a rule gets
 * disabled" - 41 dirs have no record at 23ed894e); arming is the one-line commit that flips it to
 * true AFTER the full-tree seed lands, and the checklist sits beside the constant itself. The other
 * rules need an existing record to fire at all, so they self-gate and arm with this commit. Suite-owned proofs (skipped by name, executed by their suite)
 * and UNRESOLVED declarations never run here, so they are EXEMPT from the record rules rather than
 * permanently red; their record is the owning suite's gate.
 *
 * AMENDMENT 2 (Paul): --list MUST NOT exit non-zero for staleness/freshness - it annotates
 * ("[stale: sha not in history]", "[no record]") and exits 0. --list is used by other lanes and by
 * the census; making a diagnostic fail on age would turn it into an outage. Only the RUN path may
 * exit non-zero for these states.
 */
import { fromFileUrl, join, relative, resolve } from "@std/path";
import { stripComments } from "./test-selection.ts";

export interface Declaration {
  /** `docs/evidence/<dir>` relative to the root. */
  dir: string;
  /** The path as written in the README. */
  declared: string;
  /** Whether that path is a file under the root. */
  exists: boolean;
  /** Whether the README explicitly admits no assertions (- Capture: no assertions). */
  isCapture: boolean;
  /** Asserts line if present in README. */
  asserts: string | null;
  /** The test suite that executes this proof script, if declared. */
  executedBy: string | null;
  /** Whether the executedBy file exists under root, if declared. */
  executorExists?: boolean;
  /** Whether every declared executor suite names the proof PATH in code (audio-feed-zmwa1, audio-feed-377of). */
  executorReferencesProof?: boolean;
  /** Declared per-proof timeout in milliseconds, if present in README. */
  timeoutMs?: number;
  /** Raw timeout string as declared in README. */
  rawTimeout?: string | null;
  /** Whether the declared timeout was malformed. */
  timeoutMalformed?: boolean;
}

export interface Options {
  list: boolean;
  only?: string;
  timeoutMs: number;
  root: string;
  explicitTimeout: boolean;
}

/** The per-dir record every executed proof leaves behind (audio-feed-h22ml). */
export const RECORD_FILE = "run.json";
/** A record older than this is stale: proofs must actually re-run at least this often. */
export const RECORD_MAX_AGE_DAYS = 30;

/**
 * AMENDMENT 1 (audio-feed-h22ml). FALSE while the seed is out: the run path then quietly seeds a
 * record wherever one is missing, and --list annotates `[no record]` without failing. Arming is the
 * one-line follow-up commit that flips this to true AFTER the full-tree seed (run.json for every
 * runnable declared dir) has landed; from that commit on, a MISSING record is a named run-path
 * incident that exits non-zero (the run still executes and seeds the record, so arming can never
 * deadlock a new or deleted record). Nothing else is gated on this constant.
 *
 * ARMING CHECKLIST - the one place to read before flipping this to true:
 *
 * 1. SEED RUN. `deno task evidence` over the whole tree (no `--only`, real bounds) writes a
 *    run.json per runnable declared dir. As of 23ed894e, 0 of 41 such dirs have one, so arming
 *    now would red the tier on 41 seeded-in-the-same-run dirs and prove nothing.
 * 2. JUDGE THE SEED BY READING THE RECORDS, not by the tier's exit code. `deno task evidence`
 *    exits non-zero on any red proof, and at least one is red for environmental reasons: on Deno
 *    2.9.7 a `deno eval` child that owns an aborted `AbortSignal.any` composite does not exit on
 *    its own, so docs/evidence/audio-feed-0cmu records exit 1 / marker false from its mechanism
 *    probe. Its seed record must therefore say so honestly; fixing that proof is a separate bead
 *    from arming this constant.
 * 3. COMMIT THE SEED ON ITS OWN, then flip this constant in a SEPARATE commit whose body names
 *    that commit as the arming commit. The same commit arms the census row in
 *    tests/evidence_run_test.ts (it is otherwise gated on this constant) and turns the
 *    missing-record incident on in the run path.
 * 4. NOTHING ELSE IS GATED on this constant: the post-run "the tier ran <dir> and wrote no
 *    record" guarantee is always on, because it is the detector for the silence this bead closes.
 */
export const EVIDENCE_RECORDS_ENFORCED = false;

/** The record itself, written after every proof run (audio-feed-h22ml). */
export interface RunRecord {
  /** The declared script path, as in the README's `- Script:` line. */
  script: string;
  /** 40-hex HEAD of the tree the proof ran in; "" when the root is not a git work tree. */
  sha: string;
  /** The bound the proof ran under, reused from resolveBound(), never recomputed. */
  bound: { ms: number; provenance: BoundProvenance };
  startedAt: string;
  endedAt: string;
  /** The proof process's raw exit code; 124 and 137 stay distinct from a clean exit. */
  exit: number;
  /** Whether stdout carried a PASS or OK assertion line. */
  marker: boolean;
  /** sha256 of every file in the evidence dir except README.md and run.json. */
  artefacts: Record<string, string>;
}

export type RunRecordRead =
  | { state: "missing" }
  | { state: "unparseable"; error: string }
  | { state: "ok"; record: RunRecord };

export function runRecordPath(root: string, dir: string): string {
  return join(root, dir, RECORD_FILE);
}

export async function readRunRecord(dirAbs: string): Promise<RunRecordRead> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(dirAbs, RECORD_FILE));
  } catch {
    return { state: "missing" };
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("record is not a JSON object");
    }
    return { state: "ok", record: parsed as RunRecord };
  } catch (err) {
    return { state: "unparseable", error: (err as Error).message };
  }
}

const USAGE =
  `usage: deno task evidence [--list] [--only <evidence-dir>] [--timeout <seconds>] [--root <dir>]`;

export function parseOptions(args: string[]): Options {
  const root = resolve(fromFileUrl(new URL("../", import.meta.url)));
  const options: Options = { list: false, timeoutMs: 300_000, root, explicitTimeout: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    if (arg === "--list") options.list = true;
    else if (arg === "--only" && value) {
      options.only = value;
      i++;
    } else if (arg === "--timeout" && value) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 1) {
        throw new Error(
          `--timeout needs a positive number of seconds (>= 1), got ${JSON.stringify(value)}`,
        );
      }
      options.timeoutMs = Math.round(seconds * 1000);
      options.explicitTimeout = true;
      i++;
    } else if (arg === "--root" && value) {
      options.root = resolve(value);
      i++;
    } else {
      throw new Error(`unrecognised argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  return options;
}

export interface DeclarationInfo {
  declared: string | null;
  isCapture: boolean;
  asserts: string | null;
  executedBy: string | null;
  timeoutSec: number | null;
  rawTimeout: string | null;
  timeoutMalformed: boolean;
}

/**
 * The declaration the READMEs already carry, rather than a new one: a `- Script:` line naming the
 * proof that produces the directory's evidence. Backticks and quotes are stripped because the line
 * is prose as often as it is a path.
 *
 * Also checks whether the directory admits no assertions (- Capture: no assertions) or carries
 * an explicit - Asserts: line (audio-feed-c0ft), and parses - Executed by: line naming the test suite
 * that executes the proof script (audio-feed-4oe2).
 *
 * Parses optional per-proof bound (- Timeout: <seconds>) beside the - Script: line (audio-feed-kphw).
 */
export function readDeclaration(readme: string): DeclarationInfo {
  let declared: string | null = null;
  let isCapture = false;
  let asserts: string | null = null;
  let executedBy: string | null = null;
  let timeoutSec: number | null = null;
  let rawTimeout: string | null = null;
  let timeoutMalformed = false;
  let inFence = false;
  for (const line of readme.split("\n")) {
    if (/^\s*(?:```+|~~~+)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const scriptMatch = /^\s*-\s*Script:\s*(.+?)\s*$/.exec(line);
    if (scriptMatch) declared = scriptMatch[1]!.replace(/[`"']/g, "").trim();
    if (/^\s*-\s*Capture:\s*no assertions\b/.test(line)) isCapture = true;
    const assertsMatch = /^\s*-\s*Asserts:\s*(.+)$/.exec(line);
    if (assertsMatch) asserts = assertsMatch[1]!.trim();
    const executedByMatch = /^\s*-\s*Executed by:\s*(.+?)\s*$/.exec(line);
    if (executedByMatch) executedBy = executedByMatch[1]!.replace(/[`"']/g, "").trim();
    const timeoutMatch = /^\s*-\s*Timeout:(.*)$/.exec(line);
    if (timeoutMatch) {
      rawTimeout = timeoutMatch[1]!.replace(/[`"']/g, "").trim();
      const numMatch = /^([0-9]+(?:\.[0-9]+)?)\s*(?:s(?:ecs?|econds?)?)?$/i.exec(rawTimeout);
      if (numMatch) {
        const sec = Number(numMatch[1]);
        if (Number.isFinite(sec) && sec >= 1) {
          timeoutSec = sec;
        } else {
          timeoutMalformed = true;
        }
      } else {
        timeoutMalformed = true;
      }
    }
  }
  return { declared, isCapture, asserts, executedBy, timeoutSec, rawTimeout, timeoutMalformed };
}

/**
 * audio-feed-c0ft: Walk docs/evidence recursively to detect any nested evidence directories.
 * Evidence directories must be flat directly under docs/evidence/ (depth 1).
 * Any nested subdirectory (depth >= 2) carrying a README.md (declared or undeclared) is refused.
 * Also return every symlink at any depth: following one can escape this tree or cycle, while
 * skipping it can hide evidence. The caller reports these as symlink refusals, not nested folders.
 */
export async function findNestedEvidence(evidenceRoot: string): Promise<string[]> {
  const nested: string[] = [];
  async function walk(dir: string, depth: number) {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const entry of entries) {
      const sub = join(dir, entry.name);
      if (entry.isSymlink) {
        nested.push(sub);
      } else if (entry.isDirectory) {
        if (depth >= 1) {
          // Inside docs/evidence/<top>/...
          // If this nested directory has a README.md (declared or undeclared), it is a nested evidence directory.
          try {
            await Deno.stat(join(sub, "README.md"));
            nested.push(sub);
          } catch {
            // Check deeper subdirectories
          }
        }
        await walk(sub, depth + 1);
      }
    }
  }
  await walk(evidenceRoot, 0);
  return nested;
}

export interface MalformedTimeout {
  dir: string;
  rawTimeout: string | null;
}

export type BoundProvenance = "flag" | "declared" | "default";

export interface ResolvedBound {
  timeoutMs: number;
  boundSec: number;
  provenance: BoundProvenance;
}

export function resolveBound(
  options: Options,
  declaration: Declaration,
): ResolvedBound {
  let timeoutMs: number;
  let provenance: BoundProvenance;
  if (options.explicitTimeout) {
    timeoutMs = options.timeoutMs;
    provenance = "flag";
  } else if (declaration.timeoutMs !== undefined) {
    timeoutMs = declaration.timeoutMs;
    provenance = "declared";
  } else {
    timeoutMs = options.timeoutMs;
    provenance = "default";
  }
  const boundSec = timeoutMs / 1000;
  return { timeoutMs, boundSec, provenance };
}

/**
 * Run git and NEVER throw: a git that cannot be spawned (no binary on PATH) is reported as code -1,
 * which shaIsAncestor turns into `unverifiable` (fail closed) and --list turns into an annotation.
 * Throwing here would make --list exit non-zero for a record state, which amendment 2 forbids
 * (audio-feed-h22ml).
 */
async function gitCapture(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let output: Deno.CommandOutput;
  try {
    const command = new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "piped" });
    output = await command.output();
  } catch (err) {
    return { code: -1, stdout: "", stderr: `git could not be run: ${(err as Error).message}` };
  }
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

/** 40-hex HEAD of `root`, or null when it is not a git work tree with a commit (audio-feed-h22ml). */
export async function gitHeadSha(root: string): Promise<string | null> {
  const res = await gitCapture(root, ["rev-parse", "HEAD"]);
  return res.code === 0 && /^[0-9a-f]{40}$/.test(res.stdout) ? res.stdout : null;
}

export type ShaHistoryState =
  | { state: "ancestor" }
  | { state: "foreign" }
  | { state: "unverifiable"; detail: string };

/**
 * Staleness IS GIT, not arithmetic (audio-feed-h22ml): a record's sha counts as in-history only when
 * `git merge-base --is-ancestor` accepts it. git exit 1 is the DEFINITE not-an-ancestor; any other
 * failure (bad sha, no repo) is UNVERIFIABLE and fails closed - a record that cannot be checked is
 * never silently believed.
 */
export async function shaIsAncestor(root: string, sha: string): Promise<ShaHistoryState> {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return { state: "unverifiable", detail: `sha is not 40-hex: ${JSON.stringify(sha)}` };
  }
  const res = await gitCapture(root, ["merge-base", "--is-ancestor", sha, "HEAD"]);
  if (res.code === 0) return { state: "ancestor" };
  if (res.code === 1) return { state: "foreign" };
  return { state: "unverifiable", detail: res.stderr || `git exit ${res.code}` };
}

const RECORD_EXCLUDED = new Set(["README.md", RECORD_FILE]);

/**
 * sha256 of every file under the evidence dir, except README.md and run.json (audio-feed-h22ml).
 * Keys are dir-relative paths with a stable sort so records diff cleanly. Symlinks are skipped here
 * (the tree walk refuses them outright); nested directories are walked because a declared dir may
 * carry README-less asset subdirectories.
 */
export async function hashEvidenceDir(dirAbs: string): Promise<Record<string, string>> {
  const artefacts: Record<string, string> = {};
  async function walk(rel: string): Promise<void> {
    const abs = rel === "" ? dirAbs : join(dirAbs, rel);
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(abs)) entries.push(entry);
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.isSymlink) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(childRel);
        continue;
      }
      if (rel === "" && RECORD_EXCLUDED.has(entry.name)) continue;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await Deno.readFile(join(dirAbs, childRel)),
      );
      artefacts[childRel] = `sha256:${
        [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
      }`;
    }
  }
  await walk("");
  return artefacts;
}

export interface RecordValidationContext {
  root: string;
  /** `docs/evidence/<dir>`, as in Declaration.dir. */
  dir: string;
  /** Whether a MISSING record is itself an incident (EVIDENCE_RECORDS_ENFORCED - amendment 1). */
  recordsEnforced: boolean;
  /**
   * Whether the ROOT has a git HEAD at all. Without one there is no history to be an ancestor of,
   * so the sha staleness rule is undefined rather than failed - the sha check is skipped and the
   * caller says so ("records are written but not history-checked"). Every OTHER rule (exit, marker,
   * age, artefact hashes) is git-independent and still applies. A repo whose git ERRORS is a
   * different case: shaIsAncestor then reports unverifiable, which is an incident (fail closed).
   */
  historyCheckable: boolean;
}

/**
 * The failure rules of the record tier (audio-feed-h22ml), each naming its own incident: no record
 * (only when recordsEnforced); unparseable record; sha not an ancestor of HEAD; endedAt older than
 * 30 days; exit !== 0; marker === false; any artefact hash mismatch, missing artefact, or file
 * present but unrecorded. An empty list means the record can be believed.
 */
export async function validateRunRecord(
  read: RunRecordRead,
  ctx: RecordValidationContext,
): Promise<string[]> {
  const incidents: string[] = [];
  if (read.state === "missing") {
    if (ctx.recordsEnforced) {
      incidents.push(
        `RECORD MISSING: no ${RECORD_FILE} in ${ctx.dir} - a claimed run must leave a checkable record ` +
          `(the proof runs anyway; it seeds a fresh one)`,
      );
    }
    return incidents;
  }
  if (read.state === "unparseable") {
    incidents.push(
      `RECORD UNPARSEABLE: ${ctx.dir}/${RECORD_FILE} does not parse (${read.error}) - ` +
        `a record that cannot be read cannot be believed`,
    );
    return incidents;
  }
  const record = read.record;

  if (ctx.historyCheckable) {
    const shaState = await shaIsAncestor(ctx.root, record.sha ?? "");
    if (shaState.state === "foreign") {
      incidents.push(
        `RECORD STALE: ${ctx.dir} ${RECORD_FILE} sha ${record.sha} is not in HEAD's history (sha not in history)`,
      );
    } else if (shaState.state === "unverifiable") {
      incidents.push(
        `RECORD UNVERIFIABLE: ${ctx.dir} ${RECORD_FILE} sha could not be checked against history (${shaState.detail})`,
      );
    }
  }

  const ended = Date.parse(record.endedAt ?? "");
  if (Number.isNaN(ended)) {
    incidents.push(
      `RECORD UNDATED: ${ctx.dir} ${RECORD_FILE} endedAt ${
        JSON.stringify(record.endedAt ?? null)
      } is not an ISO timestamp`,
    );
  } else {
    const ageDays = Math.floor((Date.now() - ended) / 86_400_000);
    if (ageDays > RECORD_MAX_AGE_DAYS) {
      incidents.push(
        `RECORD STALE: ${ctx.dir} ${RECORD_FILE} endedAt ${record.endedAt} is ${ageDays} days old ` +
          `(bound: ${RECORD_MAX_AGE_DAYS} days)`,
      );
    }
  }

  if (typeof record.exit !== "number") {
    incidents.push(`RECORD INCOMPLETE: ${ctx.dir} ${RECORD_FILE} has no numeric exit`);
  } else if (record.exit !== 0) {
    incidents.push(
      `RECORD FAILED: ${ctx.dir} ${RECORD_FILE} records exit ${record.exit} ` +
        `(not a clean exit; 124 and 137 mean the bound killed the recorded run)`,
    );
  }
  if (typeof record.marker !== "boolean") {
    incidents.push(`RECORD INCOMPLETE: ${ctx.dir} ${RECORD_FILE} has no boolean marker`);
  } else if (record.marker === false) {
    incidents.push(
      `RECORD UNASSERTED: ${ctx.dir} ${RECORD_FILE} records marker false (the recorded run produced no PASS or OK line)`,
    );
  }

  const recorded = record.artefacts ?? {};
  if (typeof recorded !== "object" || Array.isArray(recorded)) {
    incidents.push(`RECORD INCOMPLETE: ${ctx.dir} ${RECORD_FILE} has no artefact map`);
  } else {
    const actual = await hashEvidenceDir(join(ctx.root, ctx.dir));
    const names = new Set([...Object.keys(recorded), ...Object.keys(actual)]);
    for (const name of [...names].sort()) {
      const expected = recorded[name];
      const got = actual[name];
      if (typeof expected !== "string") {
        incidents.push(
          `RECORD GAP: ${ctx.dir} artefact ${name} is present on disk but not in ${RECORD_FILE}`,
        );
      } else if (got === undefined) {
        incidents.push(
          `RECORD GAP: ${ctx.dir} artefact ${name} is in ${RECORD_FILE} but missing on disk`,
        );
      } else if (expected !== got) {
        incidents.push(
          `RECORD TAMPERED: ${ctx.dir} artefact ${name} hash mismatch (recorded ${expected}, on disk ${got})`,
        );
      }
    }
  }
  return incidents;
}

/**
 * Write `<evidence dir>/run.json` after a proof run (audio-feed-h22ml): the record of what ran,
 * under which bound, from which commit, with what outcome, and the sha256 of every artefact on disk
 * at write time. Called on EVERY outcome - a failed proof's record (exit 3, marker false) is exactly
 * the evidence that it failed.
 */
export async function writeRunRecord(
  root: string,
  declaration: Declaration,
  bound: ResolvedBound,
  startedAt: string,
  result: RunResult,
): Promise<void> {
  const sha = await gitHeadSha(root);
  const artefacts = await hashEvidenceDir(join(root, declaration.dir));
  const record: RunRecord = {
    script: declaration.declared,
    sha: sha ?? "",
    bound: { ms: bound.timeoutMs, provenance: bound.provenance },
    startedAt,
    endedAt: result.endedAt,
    exit: result.code,
    marker: result.hasAssertionSignal,
    artefacts,
  };
  await Deno.writeTextFile(
    runRecordPath(root, declaration.dir),
    JSON.stringify(record, null, 2) + "\n",
  );
}

/**
 * The --list annotation for one dir's record (audio-feed-h22ml, amendment 2): ANNOTATION ONLY, never
 * a failure - --list is a diagnostic used by other lanes and the census, so it exits 0 no matter how
 * stale the records are. Suite-owned and UNRESOLVED declarations get no annotation (they never run
 * here, so they are exempt from the record rules rather than permanently red).
 */
export async function recordAnnotation(
  root: string,
  dir: string,
  historyCheckable: boolean,
): Promise<string> {
  const read = await readRunRecord(join(root, dir));
  if (read.state === "missing") return ` [no record]`;
  if (read.state === "unparseable") return ` [UNPARSEABLE RECORD: ${read.error}]`;
  const record = read.record;
  const parts: string[] = [];
  if (historyCheckable) {
    const shaState = await shaIsAncestor(root, record.sha ?? "");
    if (shaState.state === "foreign") parts.push("stale: sha not in history");
    else if (shaState.state === "unverifiable") parts.push("stale: sha unverifiable");
  }
  const ended = Date.parse(record.endedAt ?? "");
  if (Number.isNaN(ended)) parts.push("undated record");
  else {
    const ageDays = Math.floor((Date.now() - ended) / 86_400_000);
    if (ageDays > RECORD_MAX_AGE_DAYS) parts.push(`stale: ${ageDays}d old`);
  }
  if (typeof record.exit === "number" && record.exit !== 0) parts.push(`last exit: ${record.exit}`);
  if (record.marker === false) parts.push("marker: false");
  return parts.length > 0 ? ` [${parts.join("; ")}]` : "";
}

export async function collect(options: Options): Promise<{
  declarations: Declaration[];
  undeclared: string[];
  withoutReadme: string[];
  refused: string[];
  symlinks: string[];
  malformedTimeouts: MalformedTimeout[];
}> {
  const evidenceRoot = join(options.root, "docs", "evidence");
  const declarations: Declaration[] = [];
  const undeclared: string[] = [];
  const withoutReadme: string[] = [];
  const refused: string[] = [];
  const symlinks: string[] = [];
  const malformedTimeouts: MalformedTimeout[] = [];
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(evidenceRoot)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (err) {
    // A missing tree is an unreadable run, not an empty one: reporting "nothing to run" as a pass is
    // the same defect class as a check satisfied by construction. State it, and stay red.
    console.error(
      `[evidence] no readable docs/evidence under ${options.root} (${(err as Error).name}): ` +
        `nothing was verified`,
    );
    Deno.exit(1);
  }

  // Refuse nested evidence and any symlink within the evidence tree. A symlink must not
  // disappear from the top-level inventory or bypass the nested walk.
  const nested = await findNestedEvidence(evidenceRoot);
  for (const n of nested) {
    const rel = relative(options.root, n);
    if ((await Deno.lstat(n)).isSymlink) symlinks.push(rel);
    else refused.push(rel);
  }

  // Stable order so two runs of the inventory are comparable line by line.
  names.sort();
  for (const name of names) {
    if (options.only && options.only !== name) continue;
    const dir = `docs/evidence/${name}`;
    let readme: string;
    try {
      readme = await Deno.readTextFile(join(options.root, dir, "README.md"));
    } catch {
      withoutReadme.push(dir);
      continue;
    }
    const info = readDeclaration(readme);
    if (info.timeoutMalformed) {
      malformedTimeouts.push({ dir, rawTimeout: info.rawTimeout });
    }
    if (!info.declared) {
      undeclared.push(dir);
      continue;
    }
    let exists = false;
    try {
      exists = (await Deno.stat(join(options.root, info.declared))).isFile;
    } catch {
      exists = false;
    }
    let executorExists: boolean | undefined = undefined;
    let executorReferencesProof: boolean | undefined = undefined;
    if (info.executedBy) {
      const targets = info.executedBy.split(",").map((s) => s.trim()).filter(Boolean);
      let allExist = targets.length > 0;
      let allLinked = targets.length > 0;
      for (const target of targets) {
        const targetRel = target.startsWith("tests/") ? target : `tests/${target}`;
        try {
          const targetPath = join(options.root, targetRel);
          if (!(await Deno.stat(targetPath)).isFile) {
            allExist = false;
            allLinked = false;
            break;
          }
          // LINKAGE (audio-feed-zmwa1, tightened by audio-feed-377of): existence alone let any file
          // named as `- Executed by:` silence a broken proof, so the suite must NAME the proof. The
          // first version accepted that name anywhere in the text, and review found two ways for a
          // cosmetic mention to buy silence: a COMMENT naming the proof executes nothing, and a bare
          // basename matched an unrelated file. The mention must now be the proof PATH, inside a
          // quoted code context, with comments stripped first.
          const suiteText = await Deno.readTextFile(targetPath);
          if (!referencesProofInCode(suiteText, info.declared)) {
            allLinked = false;
          }
        } catch {
          allExist = false;
          allLinked = false;
          break;
        }
      }
      executorExists = allExist;
      executorReferencesProof = allLinked;
    }
    declarations.push({
      dir,
      declared: info.declared,
      exists,
      isCapture: info.isCapture,
      asserts: info.asserts,
      executedBy: info.executedBy,
      executorExists,
      executorReferencesProof,
      timeoutMs: info.timeoutSec !== null ? Math.round(info.timeoutSec * 1000) : undefined,
      rawTimeout: info.rawTimeout,
      timeoutMalformed: info.timeoutMalformed,
    });
  }
  return { declarations, undeclared, withoutReadme, refused, symlinks, malformedTimeouts };
}

/**
 * Whether `suiteText` names the proof `declared` in a CODE context (audio-feed-377of).
 *
 * THE RULE: comments are stripped, and the proof must then appear as its PATH - `scripts/<name>.ts`
 * or with a relative prefix like `../scripts/<name>.ts` - between quotes, i.e. an import specifier
 * or a string literal. A comment naming the proof is stripped away, so a cosmetic mention cannot
 * silence the tier; a bare basename is not the declared path, so it no longer matches an unrelated
 * file.
 *
 * WHY STRIPPING AND A QUOTE BOTH, rather than either alone: stripping alone still accepts a path
 * that merely sits in code position (a regex literal, an identifier fragment), and a quoted-specifier
 * check alone still accepts a path inside a comment that happens to quote it. The pair is narrow in
 * the direction that matters here - a false LINK is a false SKIP, which is a test that stopped
 * testing.
 *
 * THE STRIPPER IS THE REPO'S OWN (scripts/test-selection.ts stripComments, audio-feed-ywjz/dmrw),
 * NOT scripts/source-mask.ts maskNonCode: the masker blanks the INTERIOR of string and template
 * literals, which is exactly where an import specifier lives, so it would refuse every honest suite.
 *
 * DECLARED HOLE, INHERITED AND NOT FIXED HERE: stripComments deliberately KEEPS the tail of an
 * UNTERMINATED block comment as code (tests/strip_comments_unterminated_test.ts explains why - a
 * hidden import narrows the selector, and narrowing is the dangerous direction there). In an
 * ILL-FORMED suite, a quoted path after a never-closed `/*` therefore still links. It is stated
 * rather than assumed away, and it requires BOTH an unbalanced comment AND a quoted path inside it.
 * Also not treated as linkage: a path assembled from fragments (`"../scripts/" + "proof.ts"`).
 *
 * DECLARED HOLE, RULED RATHER THAN CLOSED: an UNUSED quoted literal still buys ownership -
 * `const unused = "scripts/outbox-proof.ts";` links. Accepted because this rule strictly dominates
 * mention-anywhere (faking now needs CODE-SHAPED text instead of a passive comment), an unused const
 * also trips deno lint no-unused-vars, and closing it properly needs import/AST parsing, which is
 * disproportionate for a text tier. So this RAISES THE COST OF FAKING; it does not close the class -
 * do not read it as a guarantee that a linked suite actually runs the proof.
 */
export function referencesProofInCode(suiteText: string, declared: string): boolean {
  const { stripped } = stripComments(suiteText);
  const path = declared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Quotes on BOTH sides make the path a complete literal, and a relative prefix of `./`/`../`
  // segments is allowed so a suite in tests/ can write `../scripts/<name>.ts`.
  return new RegExp(`["'\`](?:\\.\\.?/)*${path}["'\`]`).test(stripped);
}

export function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface RunResult {
  code: number;
  seconds: number;
  timedOut: boolean;
  tail: string;
  outputEmpty: boolean;
  hasAssertionSignal: boolean;
  passed: boolean;
  failureReason?: string;
  /** Wall-clock bounds of the run, recorded verbatim in run.json (audio-feed-h22ml). */
  startedAt: string;
  endedAt: string;
}

/**
 * One proof, SEQUENTIALLY and under a hard bound.
 *
 * Never in parallel: these proofs drive a browser, and the fleet runs one headless browser at a time.
 *
 * The bound is GNU `timeout`, not a JavaScript timer, because `timeout` without `--foreground` puts
 * the command in its own process group and signals the GROUP: that reaches the dev server and the
 * browser the proof started, which a single-process kill leaves behind. (Measured while building
 * this: Deno.kill(-pid) on a group is NotCapable under a least-privilege runner, setsid's fork
 * behaviour depends on whether the child is already a group leader, and a failed group kill that is
 * swallowed by a `catch {}` turns the bound into no bound at all - the first version of this file
 * did exactly that and wedged, which row 3b caught. `timeout` is the mechanism the fleet already
 * prescribes, and it has the exit code convention this tier reports: 124 means the bound was hit.)
 *
 * The JavaScript backstop at bound + 15s is for the one case `timeout` cannot cover: a proof that
 * escapes its process group and keeps the output pipes open, which would otherwise leave the tier
 * blocked in `output()` forever. It kills the direct child, which is always permitted to this
 * process.
 */
export async function runProof(
  options: Options,
  declaration: Declaration,
  onChild: (pid: number | null) => void,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const { timeoutMs: effectiveTimeoutMs, boundSec } = resolveBound(options, declaration);
  const command = new Deno.Command("timeout", {
    args: [
      "-k",
      "5",
      `${boundSec}`,
      Deno.execPath(),
      "run",
      "--allow-all",
      "--unstable-kv",
      declaration.declared,
    ],
    cwd: options.root,
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  onChild(child.pid);
  const backstop = setTimeout(() => {
    console.log(
      `[evidence] ${declaration.dir} exceeded its bound by 15s and ignored it: killing pid ${child.pid}`,
    );
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, effectiveTimeoutMs + 15_000);
  // `output()` drains both pipes while it waits; not draining them is how a chatty proof deadlocks.
  const output = await child.output();
  clearTimeout(backstop);
  onChild(null);
  const rawText = `${new TextDecoder().decode(output.stdout)}\n${
    new TextDecoder().decode(output.stderr)
  }`;
  const text = stripAnsi(rawText);
  const outputEmpty = text.trim().length === 0;
  const hasAssertionSignal = /\b(PASS|OK)\b/.test(text);
  const tail = rawText.split("\n").filter((line) => line.trim() !== "").slice(-6).join("\n  ");

  let passed = output.code === 0;
  const endedAt = new Date().toISOString();
  let failureReason: string | undefined;
  if (output.code === 0) {
    if (outputEmpty) {
      passed = false;
      failureReason =
        "EMPTY OUTPUT: script exited 0 without asserting anything or producing output";
    } else if (declaration.asserts !== null && !declaration.isCapture && !hasAssertionSignal) {
      passed = false;
      failureReason = "ZERO ASSERTIONS: declared Asserts requires a PASS or OK assertion marker";
    }
  }

  return {
    code: output.code,
    seconds: (performance.now() - started) / 1000,
    // GNU timeout reports 124 when the bound was hit, and 137 when the KILL grace expired.
    timedOut: output.code === 124 || output.code === 137,
    tail,
    outputEmpty,
    hasAssertionSignal,
    passed,
    failureReason,
    startedAt,
    endedAt,
  };
}

export async function main(args: string[] = Deno.args): Promise<void> {
  const options = parseOptions(args);
  // audio-feed-h22ml: history checks need a git HEAD. A root without one (a scratch fixture) gets
  // records WRITTEN and the git-independent rules applied, but the sha rule is skipped and the skip
  // is named here once. A root whose git ERRORS still fails closed inside shaIsAncestor.
  const historyCheckable = (await gitHeadSha(options.root)) !== null;
  if (!historyCheckable) {
    console.log(
      `[evidence] note: records are written but not history-checked under ${options.root} (no git HEAD)`,
    );
  }
  const { declarations, undeclared, withoutReadme, refused, symlinks, malformedTimeouts } =
    await collect(options);
  const unresolved = declarations.filter((declaration) => !declaration.exists);
  const unresolvedExecutors = declarations.filter(
    (declaration) => declaration.executedBy !== null && declaration.executorExists === false,
  );
  // An executor that EXISTS but never references the proof is not an owner (audio-feed-zmwa1):
  // trusting the name alone let `- Executed by: tests/anything` silence a broken proof. Gated on
  // executorExists so a nonexistent suite reports only as UNRESOLVED, never twice.
  const unlinkedExecutors = declarations.filter(
    (declaration) =>
      declaration.executedBy !== null &&
      declaration.executorExists === true &&
      declaration.executorReferencesProof === false,
  );

  /**
   * A DECLARATION OUTCOME IS PRINTED, NEVER IMPLIED. Three facts are debt rather than failure - a
   * directory that declares nothing, a directory with no README, and one script declared by two
   * directories - and every one of them is a skip in disguise if it is silent: a skip that is not
   * printed is a test that stopped testing. They are named here, counted in the summary, and they make
   * the tier exit 2 (no proof failed, but the evidence tree is not fully declared).
   *
   * Measured before deciding how to treat the duplicate: scripts/bookmarklet-browser-proof.ts is
   * declared by audio-feed-6hw and audio-feed-ep1, and that is legitimate - one proof produces two
   * evidence sets with different artefacts and different assertion lists. So a duplicate is reported
   * rather than failed, because failing it would be a red that is not a defect.
   */
  const byScript = new Map<string, string[]>();
  for (const declaration of declarations) {
    const dirs = byScript.get(declaration.declared) ?? [];
    dirs.push(declaration.dir);
    byScript.set(declaration.declared, dirs);
  }
  const duplicates = [...byScript.entries()].filter(([, dirs]) => dirs.length > 1).sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  );

  function printDebt(): number {
    for (const dir of undeclared) {
      console.log(`[evidence] debt: ${dir} declares no proof (no '- Script:' line in its README)`);
    }
    for (const dir of withoutReadme) {
      console.log(
        `[evidence] debt: ${dir} has no README, so nothing is declared or asserted there`,
      );
    }
    for (const [script, dirs] of duplicates) {
      console.log(
        `[evidence] note: ${script} is declared by ${dirs.length} directories (${
          dirs.join(", ")
        }) - ` +
          `one proof producing more than one evidence set; it will be run once per declaring directory`,
      );
    }
    return undeclared.length + withoutReadme.length;
  }

  if (options.list) {
    for (const dir of refused) {
      console.log(`REFUSED    ${dir} (nested evidence directory)`);
    }
    for (const dir of symlinks) {
      console.log(`REFUSED    ${dir} (symlinked evidence path)`);
    }
    for (const declaration of declarations) {
      const execSuffix = declaration.executedBy
        ? declaration.executorExists === false
          ? ` [UNRESOLVED EXECUTOR: ${declaration.executedBy}]`
          : declaration.executorReferencesProof === false
          ? ` [UNLINKED EXECUTOR: ${declaration.executedBy}]`
          : ` [executed by: ${declaration.executedBy}]`
        : "";
      const timeoutSuffix = declaration.timeoutMalformed
        ? ` [MALFORMED TIMEOUT: ${declaration.rawTimeout}]`
        : declaration.timeoutMs !== undefined
        ? ` [timeout: ${declaration.timeoutMs / 1000}s]`
        : "";
      // audio-feed-h22ml (AMENDMENT 2): the record state is an ANNOTATION here, never a failure -
      // --list is a diagnostic used by other lanes and by the census, and exits 0 regardless of how
      // stale or missing the records are. Only the RUN path may exit non-zero for these states.
      const recordSuffix = declaration.executedBy === null && declaration.exists
        ? await recordAnnotation(options.root, declaration.dir, historyCheckable)
        : "";
      console.log(
        `${
          declaration.exists ? "declared  " : "UNRESOLVED"
        } ${declaration.dir} -> ${declaration.declared}${execSuffix}${timeoutSuffix}${recordSuffix}`,
      );
    }
    const unresolvedExecNote = (unresolvedExecutors.length > 0
      ? `, ${unresolvedExecutors.length} unresolved executor(s)`
      : "") +
      (unlinkedExecutors.length > 0 ? `, ${unlinkedExecutors.length} unlinked executor(s)` : "");
    console.log(
      `[evidence] inventory: ${declarations.length} declared proof(s), ${unresolved.length} unresolved, ` +
        `${undeclared.length} directory(ies) declare nothing, ${withoutReadme.length} have no README` +
        unresolvedExecNote +
        (refused.length + symlinks.length > 0
          ? `, ${refused.length} refused (nested), ${symlinks.length} refused (symlink)`
          : "") +
        (options.only ? ` (filtered to --only ${options.only})` : ""),
    );
    printDebt();
    console.log("[evidence] --list is an inventory, not a verdict: it exits 0 and runs nothing");
    Deno.exit(0);
  }

  // Refusal takes precedence over debt: exit 2 means every declared proof passed, but a
  // refused tree has not been verified. Still print declaration debt before exiting.
  if (refused.length > 0 || symlinks.length > 0) {
    printDebt();
    for (const dir of refused) {
      console.error(
        `[evidence] FAIL: nested evidence directory is forbidden: ${dir} ` +
          `(evidence directories must be flat directly under docs/evidence/)`,
      );
    }
    for (const dir of symlinks) {
      console.error(
        `[evidence] FAIL: symlinked evidence path is forbidden: ${dir} ` +
          `(evidence paths under docs/evidence/ must not be symlinks)`,
      );
    }
    console.error(
      `[evidence] RED: ${refused.length} nested evidence directory(ies), ` +
        `${symlinks.length} symlink(s) detected; refusing run - ` +
        `unexamined evidence cannot be credited as green`,
    );
    Deno.exit(1);
  }

  // A declared executor that is not a file is an UNRESOLVED failure.
  if (unresolvedExecutors.length > 0) {
    printDebt();
    for (const declaration of unresolvedExecutors) {
      console.error(
        `[evidence] FAIL ${declaration.dir} -> executor ${declaration.executedBy} (UNRESOLVED EXECUTOR: not a file)`,
      );
    }
    console.error(
      `[evidence] RED: ${unresolvedExecutors.length} declared executor(s) do not exist; refusing run - ` +
        `stale executor declarations must be fixed`,
    );
    Deno.exit(1);
  }

  // A declared executor that exists but does not reference the proof is UNLINKED (audio-feed-zmwa1):
  // the tier must neither silently skip (the suite may never run it) nor silently execute (the
  // declaration says the suite owns it). It refuses, naming declaration, suite, and the gap.
  if (unlinkedExecutors.length > 0) {
    printDebt();
    for (const declaration of unlinkedExecutors) {
      console.error(
        `[evidence] FAIL ${declaration.dir} -> ${declaration.declared} ` +
          `(UNLINKED EXECUTOR: ${declaration.executedBy} has no code reference to ${declaration.declared} - ` +
          `the suite must name the proof path in an import or string literal, not in a comment or a bare basename)`,
      );
    }
    console.error(
      `[evidence] RED: ${unlinkedExecutors.length} declared executor(s) never reference the proof they are declared to own; refusing run - ` +
        `suite ownership must be visible in the suite's own code, not in a comment`,
    );
    Deno.exit(1);
  }

  // A declared timeout that is malformed is an UNRESOLVED failure.
  if (malformedTimeouts.length > 0) {
    printDebt();
    for (const declaration of malformedTimeouts) {
      console.error(
        `[evidence] FAIL ${declaration.dir} -> timeout '${declaration.rawTimeout}' (UNRESOLVED TIMEOUT: expected positive number of seconds)`,
      );
    }
    console.error(
      `[evidence] RED: ${malformedTimeouts.length} declared timeout(s) are malformed; refusing run - ` +
        `malformed timeout declarations must be fixed`,
    );
    Deno.exit(1);
  }

  console.log(
    `[evidence] running ${declarations.length} declared proof(s) sequentially, ${
      options.timeoutMs / 1000
    }s ` +
      `bound each, from ${options.root}`,
  );
  // A run that exercised nothing is RED. Measured before a reviewer saw it: `--only` with a name that
  // matched nothing printed "every declared proof passed on this tree" and exited 0, so a typo in a
  // filter read as a clean bill of health.
  if (declarations.length === 0) {
    console.error(
      options.only
        ? `[evidence] --only ${options.only} matched no evidence directory that declares a proof ` +
          `(${undeclared.length} declare nothing, ${withoutReadme.length} have no README): ` +
          `nothing was verified`
        : `[evidence] no evidence directory declares a proof under ${options.root}: nothing was verified`,
    );
    Deno.exit(1);
  }
  const debt = printDebt();
  const results: Array<{ declaration: Declaration; result?: RunResult }> = [];
  const suiteOwned: Declaration[] = [];
  // audio-feed-h22ml: every claimed run leaves a checkable record. Incidents accumulate here and
  // redden the invocation; seeding during the unarmed phase is a NOTE, never an incident.
  const recordIncidents: string[] = [];
  let seededRecords = 0;
  let running: number | null = null;
  try {
    for (const declaration of declarations) {
      if (!declaration.exists) {
        console.log(
          `[evidence] FAIL ${declaration.dir} -> ${declaration.declared} (UNRESOLVED: not a file)`,
        );
        results.push({ declaration });
        continue;
      }
      // Suite-owned (audio-feed-opqvh, audio-feed-zmwa1): the refusals above guarantee every
      // declared executor EXISTS and REFERENCES the proof, so reaching here with an executor means
      // ownership is demonstrated in the suite's own text and the tier must not also run it.
      // SKIP by name; the summary counts it.
      if (declaration.executedBy !== null) {
        console.log(
          `[evidence] SKIP ${declaration.dir} -> ${declaration.declared} ` +
            `(suite-owned: executed by ${declaration.executedBy}; not run directly)`,
        );
        suiteOwned.push(declaration);
        continue;
      }
      // audio-feed-h22ml: pre-flight the EXISTING record (named incidents, seeded quietly while
      // unarmed), run the proof, write the fresh record, then require the record to exist - the
      // post-run guarantee is what catches a broken writer even during the seed phase.
      const bound = resolveBound(options, declaration);
      const dirAbs = join(options.root, declaration.dir);
      const pre = await readRunRecord(dirAbs);
      if (pre.state === "missing" && !EVIDENCE_RECORDS_ENFORCED) {
        console.log(
          `[evidence] note: ${declaration.dir} has no ${RECORD_FILE} yet (seed phase: writing one this run)`,
        );
        seededRecords++;
      } else {
        for (
          const incident of await validateRunRecord(pre, {
            root: options.root,
            dir: declaration.dir,
            recordsEnforced: EVIDENCE_RECORDS_ENFORCED,
            historyCheckable,
          })
        ) {
          console.log(
            `[evidence] FAIL ${declaration.dir} -> ${declaration.declared} (${incident})`,
          );
          recordIncidents.push(`${declaration.dir}: ${incident}`);
        }
      }
      const result = await runProof(options, declaration, (pid) => running = pid);
      await writeRunRecord(options.root, declaration, bound, result.startedAt, result);
      const post = await readRunRecord(dirAbs);
      if (post.state !== "ok") {
        const reason = post.state === "missing"
          ? `RECORD NOT WRITTEN: the tier ran ${declaration.dir} and wrote no ${RECORD_FILE} - the record writer is broken`
          : `RECORD NOT WRITTEN: the tier ran ${declaration.dir} but ${RECORD_FILE} does not parse (${post.error})`;
        console.log(`[evidence] FAIL ${declaration.dir} -> ${declaration.declared} (${reason})`);
        recordIncidents.push(reason);
      }
      results.push({ declaration, result });
      // A proof that exceeded the BOUND is UNKNOWN, not failed: 124/137/143 mean the bound killed it,
      // which is the fleet's own rule and the same distinction the gate draws. It is still non-zero,
      // because an unknown is not a pass - but calling it a failure would be this tier overclaiming.
      const verdict = result.passed ? "ok  " : result.timedOut ? "TIMEOUT" : "FAIL";
      const reasonNote = result.failureReason ? ` (${result.failureReason})` : "";
      const note = result.timedOut
        ? ` UNKNOWN (exceeded the ${bound.boundSec}s bound [${bound.provenance}]; raise --timeout to decide it)`
        : reasonNote;
      console.log(
        `[evidence] ${verdict} ${declaration.dir} -> ${declaration.declared} ` +
          `(exit ${result.code}, ${result.seconds.toFixed(1)}s)${note}`,
      );
      if (!result.passed && result.tail) console.log(`  ${result.tail}`);
    }
  } finally {
    // Never leave a proof's server or browser running after the tier returns.
    if (running) {
      try {
        Deno.kill(-running, "SIGKILL");
      } catch { /* already gone */ }
    }
  }

  const passed = results.filter((entry) => entry.result?.passed === true).length;
  const unknown =
    results.filter((entry) => entry.result !== undefined && entry.result.timedOut).length;
  const failed = results.length - passed - unknown;
  const seconds = results.reduce((total, entry) => total + (entry.result?.seconds ?? 0), 0);
  console.log(
    `[evidence] ${passed} passed, ${failed} failed, ${unknown} unknown (exceeded the bound) of ` +
      `${declarations.length} declared ` +
      `(${unresolved.length} unresolved, ${suiteOwned.length} suite-owned not run directly, ` +
      `${undeclared.length} declare nothing, ` +
      `${withoutReadme.length} without a README) in ${seconds.toFixed(1)}s of proof time` +
      (seededRecords > 0 ? `, ${seededRecords} record(s) seeded` : ""),
  );
  for (const incident of recordIncidents) {
    console.log(`[evidence] record incident: ${incident}`);
  }
  if (failed > 0 || unknown > 0 || recordIncidents.length > 0) {
    console.log(
      `[evidence] RED: ${failed} declared proof(s) failed or asserted nothing` +
        (unknown > 0 ? ` and ${unknown} stayed UNKNOWN inside the bound` : "") +
        (recordIncidents.length > 0
          ? `; ${recordIncidents.length} record incident(s) - every claimed run must leave a checkable record`
          : "") +
        " - an unknown is not a pass",
    );
    Deno.exit(1);
  }
  if (debt > 0) {
    console.log(
      `[evidence] RED (declaration debt): every declared proof passed, but ${debt} directory(ies) ` +
        `declare nothing and were therefore not run - the list is above, by name`,
    );
    Deno.exit(2);
  }
  const suiteNote = suiteOwned.length > 0
    ? `, ${suiteOwned.length} suite-owned not run directly`
    : "";
  console.log(
    `[evidence] every declared proof passed on this tree (${passed} proof(s)${suiteNote})`,
  );
}

if (import.meta.main) {
  await main();
}
