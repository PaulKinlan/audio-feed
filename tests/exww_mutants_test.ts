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
import { assertEquals } from "@std/assert";
import {
  applyMutant,
  buildScratch,
  interpretRun,
  MUTANTS,
  PROOF_REL,
  runProofIn,
} from "../scripts/exww-mutants.ts";

/** Where the mutated script goes, and how long a run may take. Shared with the harness's own bound. */
const ROW = "wrong-scale";
const RUN_TIMEOUT_MS = 240_000;

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
      // audio-feed-coao: A narrow mapping row so test-selection.ts derives the relation.
      const _mapping = new Deno.Command(Deno.execPath(), {
        args: ["run", "scripts/exww-live-claims-browser-proof.ts"],
      });
      const baseline = await runProofIn(scratch, RUN_TIMEOUT_MS);
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
      const mutated = await runProofIn(scratch, RUN_TIMEOUT_MS);
      // A bound killing the run and the mutant reddening it are DIFFERENT outcomes: 124/137/143 is unknown,
      // never a pass and never a fail, so the timeout is asserted out before the mutant's red is believed.
      const row = MUTANTS.find((m) => m.name === ROW)!;
      // Judged by the SAME interpretation the CLI uses (audio-feed-l6b6): two parsers of one outcome is how
      // the suite and the CLI came to disagree about what a killed run means - the suite checked `timedOut`,
      // the CLI accepted any non-zero exit, and a row killed by the bound could be counted as an expected red.
      const mutatedVerdict = interpretRun(mutated, {
        kind: "detector",
        expect: row.expect,
        soleRed: row.soleRed,
      });
      assertEquals(
        mutatedVerdict.verdict,
        "red on the named check",
        `the ${ROW} mutant must redden its named check inside the bound, not time out and not redden ` +
          `something else: ${mutatedVerdict.detail}\n${
            mutated.failures.slice(0, 4).map((f) => f.slice(0, 120)).join(" | ") ||
            mutated.tail.slice(-300)
          }`,
      );
    } finally {
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});
