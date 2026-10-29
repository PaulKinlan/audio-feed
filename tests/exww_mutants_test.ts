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
import { deriveLadderConstants } from "../scripts/exww-attempt-measure.ts";
import {
  applyMutant,
  buildScratch,
  EXWW_RUN_BASE_GUARD_MS,
  EXWW_RUN_LADDER_RATIO,
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
 * doubles the next attempt. Base and ratio are MEASURED now (audio-feed-8u4x1,
 * docs/evidence/audio-feed-8u4x1/): a conditioned 12-attempt campaign (load1 recorded per
 * attempt) supersedes the unconditioned 238.7/221.4/221.0s figure - the pin below recomputes
 * the derivation from the committed attempts.json and fails the suite if the constants drift
 * from the data, or if the evidence record itself is tampered with. A bound-kill is still
 * UNKNOWN (never a pass), so a genuinely hung proof stays loud. */
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
  // MEASURED BASIS (audio-feed-8u4x1): the same unmutated proof ran 238.7s, 221.4s and 221.0s on
  // three consecutive attempts under identical 240s guards - a FLAT cost per attempt (0.93x, then
  // 1.00x), so the doubling below is load margin and the attempt-1 guard sits 0.5% above measured cost.
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

Deno.test("audio-feed-8u4x1: the shipped ladder constants are the derivation of the COMMITTED measurement - recompute the evidence, compare the code", async () => {
  // The pin coord asked for: not a reword, the number. attempts.json is the campaign record
  // (12 uncensored attempts of the unmutated coao proof, per-attempt wall seconds + the load
  // regime); the same pure rules the campaign ran turn its samples into constants, and those
  // constants must BE the ones this tree ships. Re-measure different data, and this row goes
  // red until the constants move with it - the drift the 'literals pending measurement' era
  // could never see.
  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL("../docs/evidence/audio-feed-8u4x1/attempts.json", import.meta.url),
    ),
  );
  const samples = raw.attempts
    .filter((a: { timedOut: boolean }) => !a.timedOut)
    .map((a: { seconds: number }) => a.seconds);
  const derivation = deriveLadderConstants(samples, raw.attempts.length - samples.length);
  // TAMPER-EVIDENCE, named (coord's falsifiability list): the record must be internally
  // consistent before the derivation over it means anything.
  // (a) sample count: dropping attempts changes n and must red, not silently re-derive.
  assertEquals(
    raw.attempts.length,
    12,
    "the committed campaign is 12 attempts; an edited sample size must re-run, not re-derive",
  );
  // (b) timestamps: every attempt carries its startedAt, they are ordered, and the record's
  // measuredAt closes the campaign - a stale or back-dated record reds here.
  const started = raw.attempts.map((a: { startedAt: string }) => Date.parse(a.startedAt));
  assert(
    started.every((t: number) => Number.isFinite(t)),
    "every attempt must carry a parseable startedAt",
  );
  assert(
    started.every((t: number, i: number) => i === 0 || t > started[i - 1]!),
    "attempt timestamps must be strictly ascending",
  );
  assert(
    Date.parse(raw.measuredAt) >= started[started.length - 1]!,
    "measuredAt must close the campaign it claims to summarise",
  );
  // (c) variance: the committed derivation block must be the derivation of THESE samples -
  // editing the percentiles/summary without the attempts reds, and vice versa.
  assertEquals(derivation.p50S, raw.derivation.p50S);
  assertEquals(derivation.p90S, raw.derivation.p90S);
  assertEquals(derivation.p99S, raw.derivation.p99S);
  assertEquals(
    derivation.baseMs,
    EXWW_RUN_BASE_GUARD_MS,
    `the committed evidence derives base ${derivation.baseMs}ms but the code ships ${EXWW_RUN_BASE_GUARD_MS}ms - re-measured data and the shipped ladder have drifted`,
  );
  assertEquals(
    derivation.ratio,
    EXWW_RUN_LADDER_RATIO,
    `the committed evidence derives ratio ${derivation.ratio} but the code ships ${EXWW_RUN_LADDER_RATIO}`,
  );
  // The gate-budget rule the derivation enforces, restated against the SHIPPED ladder.
  assert(
    EXWW_RUN_BASE_GUARD_MS * EXWW_RUN_LADDER_RATIO ** (MAX_ATTEMPTS - 1) <= 5_400_000,
    "the shipped ladder top must stay inside the fleet's 5400s gate budget",
  );
  // And the base's binding term is named in the data, not just the prose: with p99 88.0s,
  // ceil-to-60s gives 120s, so the 240s that ships is the r6hft FLOOR - the measurement holds
  // the floor honest (p99 over 240s moves the base); it does not set today's number.
  assertEquals(
    derivation.baseMs,
    Math.max(derivation.baseMs, Math.ceil((derivation.p99S * 1000) / 60_000) * 60_000),
  );
  assert(
    Math.ceil((derivation.p99S * 1000) / 60_000) * 60_000 < derivation.baseMs,
    "this campaign's p99 is UNDER the base floor: the floor binds, and the prose says so",
  );
});

Deno.test("audio-feed-8u4x1: a campaign whose bound censors more than 20% of attempts is INCONCLUSIVE, never a derivation", () => {
  // The tail is exactly what a too-small bound hides: with a quarter of attempts killed by the
  // bound, p99 is unknowable, so the rules refuse to derive rather than ship a number.
  let message = "";
  try {
    deriveLadderConstants([67, 70, 88], 1); // 1 censored of 4 = 25% > MAX_CENSORED_SHARE (20%)
  } catch (e) {
    message = (e as Error).message;
  }
  assert(message.includes("INCONCLUSIVE"), `expected INCONCLUSIVE, got: ${message}`);
  // And the boundary is inclusive on the allowed side: 20% exactly still derives.
  const atLimit = deriveLadderConstants([67, 88, 80, 90], 1); // 1 of 5 = 20%, not over
  assertEquals(atLimit.attemptCount, 5);
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
      // OBSERVED baseline duration (the ga3jd markerDeadlineFor shape): the measured ladder
      // ratio applied to what the baseline actually took, min the quiet guard. A killed
      // mutant run is still UNKNOWN - never an expected red.
      const mutated = await runProofIn(
        scratch,
        Math.max(EXWW_RUN_BASE_GUARD_MS, baseline.seconds * 1000 * EXWW_RUN_LADDER_RATIO),
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
