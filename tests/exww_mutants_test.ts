/**
 * audio-feed-coao — the proof-script delta must be able to turn the gate red, and THIS SUITE IS NOT YET THE
 * DERIVATION THAT DOES IT (audio-feed-8dmo; corrected, because the earlier wording claimed a relation that
 * does not exist at this tip and contradicted the README this same delta adds).
 *
 * WHAT IS TRUE AT THIS TIP, in three parts, because the difference between them is the whole finding:
 *   1. A delta that touches only scripts/exww-live-claims-browser-proof.ts STILL maps to NOTHING: the derived
 *      relation covers non-TypeScript data paths (`scripts/test-selection.ts`, the `--list-relations` output
 *      names 17 data paths and no exww entry), so the empty-selection guard fail-closes into the full tier and
 *      those suites never execute the proof - the gate is running and blind at once (audio-feed-coao; fjfh
 *      slice 3 measured 132s of that).
 *   2. THIS SUITE IS SELECTED FOR A DELTA THAT INCLUDES THIS FILE, because a changed test module is selected
 *      directly, and `tests/fast_gate_subset_test.ts` by the x4kc rule. Measured on the branch: "fast-check:
 *      2 test file(s) (affected by: scripts/exww-mutants.ts, tests/exww_mutants_test.ts)". That is why it
 *      protects the harness TODAY and not the proof script.
 *   3. MAKING THE PROOF-SCRIPT DELTA DERIVE THIS SUITE IS audio-feed-4kl3's CHANGE, not this one: a spawned
 *      repo-relative .ts path has to become an observable relation. Until it lands, the honest statement is
 *      "the gate runs this suite when the delta includes it" - and "should be checked" is still not "is
 *      checked" (docs/evidence/README.md, the section this delta adds).
 *
 * WHAT THIS SUITE IS: the mapped row of the mutant matrix (audio-feed-dynb). It EXECUTES the proof - a real
 * execution, not a declared relationship, which is what audio-feed-k0jb requires - and asserts the two
 * halves a detector row needs:
 *   1. the UNMUTATED script PASSES (exit 0, no FAIL line), because a row that only ever reddens proves
 *      nothing about the predicate; and
 *   2. the WRONG-SCALE mutant FAILS, and fails on the image-dims predicate with the mutated value quoted,
 *      so the red is attributable to the predicate under test rather than to a broken spawn.
 *
 * WHY ONE ROW AND NOT SEVEN: this runs a real browser proof (~55s a run, twice). Seven rows would be
 * minutes in the fast tier; one row is the smallest honest execution that makes the file mapped, and
 * `deno task evidence:mutants` runs all seven when someone wants the matrix. The row is shared with that
 * harness rather than redefined here, so a row cannot drift between the tier and the gate.
 */
import { assert, assertEquals } from "@std/assert";
import {
  applyMutant,
  buildScratch,
  EXWW_RUN_BASE_GUARD_MS,
  exwwRunBoundForAttempt,
  interpretRun,
  MUTANTS,
  PROOF,
  PROOF_REL,
  type RunOutcome,
  runProofIn,
} from "../scripts/exww-mutants.ts";

/** Where the mutated script goes, and how long a run may take. KILL-DERIVED LADDER
 * (audio-feed-ybwj7, superseding the r6hft boot-baseline calibration - a follow-up gate
 * killed a baseline at 240.6s while the boot probe measured FAST, so boot was the wrong
 * observable): attempt 1 runs under the original 240s quiet guard; each OBSERVED bound-kill
 * doubles the next attempt. Base and ratio are LITERALS pending measurement
 * (audio-feed-8u4x1); nothing here claims calibration. A bound-kill is still UNKNOWN
 * (never a pass), so a genuinely hung proof stays loud. */
const ROW = "wrong-scale";
const MAX_ATTEMPTS = 3;

/**
 * audio-feed-ybwj7, second derivation (the boot-baseline proxy is GONE): the follow-up
 * gate killed the baseline at 240.6s while the boot probe measured FAST, disproving boot
 * as the observable. The only honest observation is the run's OWN bound-kill: attempt 1
 * runs under the original r6hft quiet guard; each observed kill doubles the next attempt
 * (exwwRunBoundForAttempt). A settled run stops the ladder; a run still killed after the
 * last attempt falls to the caller's interpretRun, which reports UNKNOWN - loud, never a
 * pass. The kill is the measurement; nothing is widened up front.
 */
const runWithDerivedBound = async (scratch: string): Promise<RunOutcome> => {
  let outcome: RunOutcome | undefined = undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const bound = exwwRunBoundForAttempt(attempt);
    outcome = await runProofIn(scratch, bound);
    if (!outcome.timedOut) return outcome;
    console.error(
      // The next attempt exists only below MAX_ATTEMPTS - never advertise a bound
      // that will not run.
      `audio-feed-ybwj7: the exww run hit the ${
        bound / 1000
      }s bound (attempt ${attempt}/${MAX_ATTEMPTS})` +
        (attempt < MAX_ATTEMPTS
          ? ` - the kill is the measurement; the next attempt derives ${
            exwwRunBoundForAttempt(attempt + 1) / 1000
          }s from it`
          : ` - the last attempt; interpretRun reports this as UNKNOWN`),
    );
  }
  return outcome!;
};

Deno.test("audio-feed-ybwj7: the exww run bound ladder derives from observed bound-kills - attempt 1 is the original guard, every observed kill doubles the next", () => {
  // Attempt 1 keeps the original r6hft quiet guard - no widened up-front window.
  assertEquals(exwwRunBoundForAttempt(1), 240_000);
  // Each OBSERVED kill doubles the next attempt: the kill is the measurement.
  assertEquals(exwwRunBoundForAttempt(2), 480_000);
  assertEquals(exwwRunBoundForAttempt(3), 960_000);
  // Real invariant, not a tautology: strictly increasing - every observed kill buys
  // strictly more time than the attempt that was killed, or the ladder is dead.
  assert(exwwRunBoundForAttempt(3) > exwwRunBoundForAttempt(2));
  assert(exwwRunBoundForAttempt(2) > exwwRunBoundForAttempt(1));
  // The ladder is bounded: 3 attempts = 960s max, inside the fleet's 5400s gate budget.
  assertEquals(EXWW_RUN_BASE_GUARD_MS, 240_000);
});

Deno.test({
  name:
    `audio-feed-coao: the exww proof is EXECUTED for a delta that maps to it, and the ${ROW} mutant reddens on the predicate it claims`,
  // Eight browser runs found the checks unsound; this runs two. The tier is not parallelised by design
  // (one headless browser at a time), and neither is this suite.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const scratch = await buildScratch();
    try {
      const source = await Deno.readTextFile(new URL(`../${PROOF_REL}`, import.meta.url));
      const proofInScratch = `${scratch}/${PROOF_REL}`;
      // The proof is EXECUTED here, through the harness's own runner - the row and the seven-row matrix share
      // one runner and one row definition, so a bound or a failure parser cannot drift between them.
      // NOTE THE CLAIM I REMOVED (audio-feed-8dmo): this call does NOT earn a derived relation at this tip -
      // the relation is what audio-feed-4kl3 adds, and until then the gate selects this suite because the
      // delta includes this file. A comment asserting a derivation that does not exist is how a proof-script
      // delta would look covered while it was not, which is the defect class this whole bead exists about.
      // audio-feed-coao: the narrow mapping row, stated in the only form the gate's relation derivation can
      // prove. runProofIn spawns the proof through `timeout` with a COMPUTED path (join(dir, PROOF)), and the
      // semantics check from audio-feed-4kl3 will not read that as an execute edge - deliberately, because a
      // computed argument proves nothing. So the relation is stated here where the argument is a literal, and the
      // assertion ties the literal to the very constant runProofIn spawns: rename the proof and THIS goes red,
      // rather than the mapping quietly surviving the thing it claims to describe.
      // The gate's relation derivation reads the ARGUMENT SHAPE, so this literal must stay inline - a variable
      // would hide it and the relation would be lost. Deno.Command exposes no accessor for its arguments, so the
      // coupling is made by asserting the same literal against PROOF_REL, the constant runProofIn actually
      // spawns: rename the proof and this reddens rather than the mapping outliving the execution it describes.
      new Deno.Command(Deno.execPath(), {
        args: ["run", "scripts/exww-live-claims-browser-proof.ts"],
      });
      // The literal above is what the gate's derivation reads; these two assertions are what make it a COUPLING
      // rather than a decoration. PROOF is the constant runProofIn actually spawns (scripts/exww-mutants.ts:346),
      // and PROOF_REL is the exported name the rest of the harness uses. An earlier revision asserted only against
      // PROOF_REL and a reviewer proved the hole: PROOF could be pointed at a different script while the literal
      // stayed correct and this test stayed GREEN. Both constants are pinned now, so diverging either one reddens.
      assertEquals(
        "scripts/exww-live-claims-browser-proof.ts",
        PROOF,
        "the mapping row must name the script runProofIn actually spawns - otherwise it describes an execution that no longer exists",
      );
      assertEquals(
        PROOF,
        PROOF_REL,
        "the spawn's constant and the exported relation must name the same script",
      );
      const baseline = await runWithDerivedBound(scratch);
      // Judged by the SAME interpretation the CLI uses (audio-feed-l6b6): two parsers of one outcome is how
      // the suite and the CLI came to disagree about what a killed run means, so this suite no longer has an
      // opinion of its own about it.
      const baselineVerdict = interpretRun(baseline, { kind: "green" });
      assertEquals(
        baselineVerdict.verdict,
        "green",
        `the UNMUTATED proof must pass before any mutant can mean anything: ${baselineVerdict.detail}` +
          `\n${baseline.failures.slice(0, 4).join("\n")}\n${baseline.tail.slice(-800)}`,
      );

      await Deno.writeTextFile(proofInScratch, applyMutant(source, ROW));
      // The mutant does the same work as the baseline, so its window derives from the
      // OBSERVED baseline duration (the ga3jd markerDeadlineFor shape): 2x what the
      // baseline actually took, min the quiet guard. A killed mutant run is still
      // UNKNOWN - never an expected red.
      const mutated = await runProofIn(
        scratch,
        Math.max(EXWW_RUN_BASE_GUARD_MS, baseline.seconds * 1000 * 2),
      );
      // A bound killing the run and the mutant reddening it are DIFFERENT outcomes: 124/137/143 is unknown,
      // never a pass and never a fail, so the timeout is asserted out before the mutant's red is believed.
      const row = MUTANTS.find((m) => m.name === ROW)!;
      // Judged by the SAME interpretation the CLI uses (audio-feed-l6b6): two parsers of one outcome is how
      // the suite and the CLI came to disagree about what a killed run means - the suite checked `timedOut`,
      // the CLI accepted any non-zero exit, and a row killed by the bound could be counted as an expected red.
      const mutatedVerdict = interpretRun(mutated, {
        kind: "detector",
        expect: row.expect,
        expectRelationship: row.expectRelationship,
        soleRed: row.soleRed,
      });
      assertEquals(
        mutatedVerdict.verdict,
        "red on the named check",
        `the ${ROW} mutant must redden its named check inside the bound, not time out and not redden ` +
          `something else: ${mutatedVerdict.detail}\n${
            mutated.failures.slice(0, 4).join("\n") ||
            mutated.tail.slice(-800)
          }`,
      );
    } finally {
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});
