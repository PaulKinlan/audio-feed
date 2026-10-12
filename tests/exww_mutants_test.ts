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
      // The proof is EXECUTED here, through this path: the read/execute relation the fast gate derives for
      // scripts/exww-live-claims-browser-proof.ts is earned by this call rather than declared beside it.
      const child = new Deno.Command("timeout", {
        args: [
          "-k",
          "5",
          `${RUN_TIMEOUT_MS / 1000}`,
          Deno.execPath(),
          "run",
          "--allow-all",
          "--unstable-kv",
          proofInScratch,
        ],
        cwd: scratch,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const baselineOutput = await child.output();
      const baseline = `${new TextDecoder().decode(baselineOutput.stdout)}\n${
        new TextDecoder().decode(baselineOutput.stderr)
      }`;
      const baselineFailures = baseline.split("\n").filter((line) => line.startsWith("FAIL "));
      assertEquals(
        baselineOutput.code,
        0,
        `the UNMUTATED proof must pass before any mutant can mean anything: exit ${baselineOutput.code}\n` +
          baselineFailures.slice(0, 4).join("\n"),
      );
      assertEquals(baselineFailures, [], "the unmutated proof must report no FAIL line");

      await Deno.writeTextFile(proofInScratch, applyMutant(source, ROW));
      const mutatedChild = new Deno.Command("timeout", {
        args: [
          "-k",
          "5",
          `${RUN_TIMEOUT_MS / 1000}`,
          Deno.execPath(),
          "run",
          "--allow-all",
          "--unstable-kv",
          proofInScratch,
        ],
        cwd: scratch,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const mutatedOutput = await mutatedChild.output();
      const mutated = `${new TextDecoder().decode(mutatedOutput.stdout)}\n${
        new TextDecoder().decode(mutatedOutput.stderr)
      }`;
      const mutatedFailures = mutated.split("\n").filter((line) => line.startsWith("FAIL "));
      assert(
        mutatedOutput.code !== 0,
        `the ${ROW} mutant must fail the proof run (exit ${mutatedOutput.code})`,
      );
      // The mutated value must appear in the red, so the failure is attributable to the predicate: a spawn
      // error, a missing browser or a crash would produce no such line.
      assertStringIncludes(
        mutatedFailures.join("\n"),
        "image is 640x473 for a clip of 1280x946",
        `the ${ROW} mutant reddened something else: ${
          mutatedFailures.slice(0, 4).map((f) => f.slice(0, 120)).join(" | ")
        }`,
      );
    } finally {
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});
