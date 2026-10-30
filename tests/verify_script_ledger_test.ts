/**
 * A checked-in script whose name says "verify" is cited by future readers as evidence of current
 * behaviour - but unless a suite actually executes or reads it, nothing keeps it true
 * (audio-feed-byh4j: verify_i7vi_events.ts asserted severity bands that a later landing had moved;
 * the whole-tree scanners "observe" every script only by TEXT-READING the directory, which selects
 * them for changes but proves nothing about the script's claims - the ngrm6 selection/coverage
 * distinction again).
 *
 * audio-feed-q6ecj: A SOURCE-TEXT READ IS NOT AN EXEMPTION, IT IS A LABEL. The relation map merged two
 * different edges, so a suite that read a script's SOURCE satisfied the ledger while proving nothing about
 * that script's own assertions - the vacuous check this file exists to prevent, one level up. For
 * scripts/verify_s3uk_real_browser.ts that reader was the temp-profile call-site audit, a real check of a
 * different property. The ledger now asks the execute class first:
 *   1. EXECUTED - a suite SPAWNS the script; the suite runs its assertions and reds when they break. The only
 *      form accepted as live evidence.
 *   2. HISTORICAL banner on line 1 - the script says of itself that it is not evidence.
 *   3. SOURCE_TEXT_AUDITS - a read-only entry that must STATE, per script, why execution is not what this
 *      script gets and what is checked instead. Silent exemptions are the defect; a labelled one is honest.
 * Anything else, including a read-only relation with no label, is a named failure.
 */

import { assert, assertEquals } from "@std/assert";
import { deriveReadRelationReport, ROOT, suitesObservingExact } from "../scripts/test-selection.ts";

const BANNER_MARKER = "audio-feed-byh4j: HISTORICAL";

/**
 * Deriving the relation is a whole-tree scan (~45s here), and the three rows below ask the SAME report the
 * same questions. Memoised per process so the ledger costs one derivation, not three.
 */
let reportOnce: Promise<ReturnType<typeof deriveReadRelationReport>> | undefined;
const ledgerReport = () => (reportOnce ??= deriveReadRelationReport(ROOT));

/**
 * Scripts a suite only reads, with what that read DOES prove. Every entry is a claim about coverage that
 * would otherwise be invisible; the rows below keep the table honest (no stale key, no entry that in fact
 * gets executed, no entry that nothing reads).
 */
const SOURCE_TEXT_AUDITS: Readonly<Record<string, string>> = {
  "scripts/verify_c0gj_scanner_divergence.ts":
    "read as data by the two c0gj suites that pin its scanner's linear-complexity property; the script's own end-to-end scan of the real tree is not run by any suite",
  "scripts/verify_live_tts.ts":
    "its evidence-dir resolution helpers are imported and asserted by tests/verify_live_e2e_tts_output_test.ts; the live TTS run itself needs GEMINI_API_KEY and is not executed",
  "scripts/verify_live_e2e_tts.ts":
    "its evidence-dir resolution helpers are imported and asserted by tests/verify_live_e2e_tts_output_test.ts; the live end-to-end run needs GEMINI_API_KEY and is not executed",
  "scripts/verify_main_l7m1_e2e.ts":
    "run only as a MUTATED COPY written to a temp path (tests/l7m1_proof_test.ts builds it from this source and asserts the copy's exit codes); the repo path itself is never spawned, so no execute relation can name it",
};

/** Scripts that must be EXECUTED: a read-only relation here is the exact defect this ledger is about. */
const EXECUTION_REQUIRED: Readonly<Record<string, string>> = {
  "scripts/verify_s3uk_real_browser.ts":
    "the INP/interaction assertions are the evidence (audio-feed-s3uk); reading the source proves the source says something, not that it passes",
};

Deno.test("every scripts/verify_*.ts is EXECUTED, labelled source-text, or bannerred as historical (audio-feed-byh4j, audio-feed-q6ecj)", async () => {
  const report = await ledgerReport();
  const names = [...Deno.readDirSync(`${ROOT}scripts`)]
    .map((e) => e.name)
    .filter((n) => /^verify_.*\.ts$/.test(n))
    .sort();

  assert(
    names.length > 0,
    "the verify_* family must still exist for this invariant to mean anything",
  );

  const violators: string[] = [];
  for (const name of names) {
    const relPath = `scripts/${name}`;
    if (suitesObservingExact(relPath, report.executedRelations).length > 0) continue;
    const first = (await Deno.readTextFile(`${ROOT}${relPath}`)).split("\n")[0] ?? "";
    if (first.includes(BANNER_MARKER)) continue;
    if (relPath in SOURCE_TEXT_AUDITS) continue;
    const readers = suitesObservingExact(relPath, report.relations);
    violators.push(
      `${relPath}: no suite EXECUTES it and the HISTORICAL banner ("${BANNER_MARKER}") is missing from line 1` +
        (readers.length > 0
          ? ` - ${
            readers.join(", ")
          } only READ its source, which selects the suite but does not prove the script's assertions still hold; a read-only entry needs a SOURCE_TEXT_AUDITS line saying what it does prove`
          : ""),
    );
  }

  assert(
    violators.length === 0,
    `ungated verify script(s) presented as live evidence - either wire the script into a suite that EXECUTES it, label a source-text audit, or banner line 1 as historical:\n${
      violators.join("\n")
    }`,
  );
});

Deno.test("audio-feed-q6ecj: the s3uk interaction script is EXECUTED, not exempted by a source read", async () => {
  const report = await ledgerReport();
  for (const relPath of Object.keys(EXECUTION_REQUIRED)) {
    const executors = suitesObservingExact(relPath, report.executedRelations);
    assert(
      executors.length > 0,
      `${relPath} must be SPAWNED by a suite (${
        EXECUTION_REQUIRED[relPath]
      }): a source-text read is not ` +
        `evidence its assertions hold, and this row exists so reverting to one cannot pass`,
    );
    assert(
      !(relPath in SOURCE_TEXT_AUDITS),
      `${relPath} is executed, so a source-text label for it would be stale - delete the label rather than ` +
        `letting two answers to the same question disagree`,
    );
  }
});

Deno.test("audio-feed-q6ecj: every source-text label is stale-proof and names a real reader", async () => {
  const report = await ledgerReport();
  for (const [relPath, reason] of Object.entries(SOURCE_TEXT_AUDITS)) {
    const stat = await Deno.stat(`${ROOT}${relPath}`).catch(() => null);
    assert(stat?.isFile, `${relPath} is labelled but no longer exists - delete the label`);
    assert(
      !(relPath in EXECUTION_REQUIRED),
      `${relPath} cannot be both execution-required and source-text labelled`,
    );
    assertEquals(
      suitesObservingExact(relPath, report.executedRelations),
      [],
      `${relPath} is labelled source-text-only but a suite now EXECUTES it - delete the label, the execute ` +
        `relation is the stronger evidence`,
    );
    assert(
      suitesObservingExact(relPath, report.relations).length > 0,
      `${relPath} is labelled source-text-only but no suite is derived to read it - a label with no reader ` +
        `is the silent exemption this table exists to end`,
    );
    assert(reason.trim().length > 0, `${relPath} must say what its source read does prove`);
  }
});
