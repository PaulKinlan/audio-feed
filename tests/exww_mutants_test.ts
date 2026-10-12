/**
 * audio-feed-coao — a proof script the gate maps to NOTHING must still be able to turn the gate red.
 *
 * THE PROBLEM THIS CLOSES, measured: for a delta that touches only scripts/exww-live-claims-browser-proof.ts,
 * nothing in the repo reads or executes that file, so the fast gate's derivation sees no relation, the
 * empty-selection guard fail-closes into the FULL 115-suite tier, and those suites do not exercise the
 * file: the gate is red-hot AND blind at the same time (audio-feed-coao; fjfh slice 3 measured 132s).
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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { applyMutant, buildScratch, PROOF_REL, runProofIn } from "../scripts/exww-mutants.ts";

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
      // The proof is EXECUTED here, through the harness's own runner: the read/execute relation the fast
      // gate derives for scripts/exww-live-claims-browser-proof.ts is earned by this call - and the row and
      // the seven-row matrix share one runner as well as one row definition, so a bound or a failure parser
      // cannot drift between them either.
      const baseline = await runProofIn(scratch, RUN_TIMEOUT_MS);
      assertEquals(
        baseline.code,
        0,
        `the UNMUTATED proof must pass before any mutant can mean anything: exit ${baseline.code}${
          baseline.timedOut ? " (TIMED OUT - a bound, not a proof failure)" : ""
        }\n${baseline.failures.slice(0, 4).join("\n")}`,
      );
      assertEquals(baseline.failures, [], "the unmutated proof must report no FAIL line");

      await Deno.writeTextFile(proofInScratch, applyMutant(source, ROW));
      const mutated = await runProofIn(scratch, RUN_TIMEOUT_MS);
      // A bound killing the run and the mutant reddening it are DIFFERENT outcomes: 124/137/143 is unknown,
      // never a pass and never a fail, so the timeout is asserted out before the mutant's red is believed.
      assert(
        mutated.code !== 0 && !mutated.timedOut,
        `the ${ROW} mutant must fail the proof run, not time out (exit ${mutated.code}, timedOut=${mutated.timedOut})`,
      );
      // The mutated value must appear in the red, so the failure is attributable to the predicate: a spawn
      // error, a missing browser or a crash would produce no such line.
      assertStringIncludes(
        mutated.failures.join("\n"),
        "image is 640x473 for a clip of 1280x946",
        `the ${ROW} mutant reddened something else: ${
          mutated.failures.slice(0, 4).map((f) => f.slice(0, 120)).join(" | ") ||
          mutated.tail.slice(-300)
        }`,
      );
    } finally {
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});
