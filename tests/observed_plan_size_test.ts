/**
 * audio-feed-8905 ROW 2 - the FALLBACK contract of observedPlanSize, as a UNIT row.
 *
 * The narration yield label must report the plan size the client actually observed, but
 * only once a progress event has published one. Before that - or if the attached value is
 * somehow not a number - the caller must fall back to the constant ceiling rather than
 * print undefined or a nonsense count.
 *
 * The write sites for `totalTurns` show why a unit row is the honest place for this:
 * there are FIVE of them across three stages (narration budget options, dialogue budget
 * options, and the terminal-persistence stage where `totalTurns: 1` is fixed and
 * correct). A value measured at one site says nothing about the path it was read on, so
 * this row pins the reader's own contract rather than asserting a number that some other
 * stage happens to produce.
 */
import { assert, assertEquals } from "@std/assert";
import { observedPlanSize } from "../src/worker/synthesis.ts";

Deno.test("audio-feed-8905: observedPlanSize returns the observed count when one was attached", () => {
  assertEquals(observedPlanSize({ observedTotalTurns: 3 }), 3);
  assertEquals(observedPlanSize({ observedTotalTurns: 0 }), 0);
});

Deno.test("audio-feed-8905: observedPlanSize returns undefined when nothing was attached", () => {
  // A failure BEFORE the first progress event: the error carries no observed count, so
  // the caller must fall back to the constant ceiling.
  assertEquals(observedPlanSize(new Error("budget aborted")), undefined);
  assertEquals(observedPlanSize({}), undefined);
  assertEquals(observedPlanSize(undefined), undefined);
  assertEquals(observedPlanSize(null), undefined);
});

Deno.test("audio-feed-8905: observedPlanSize refuses a non-number rather than trusting the shape", () => {
  // The typeof check is the guarantee: a renamed or repurposed property must degrade to
  // the fallback instead of being printed as a plan size.
  assertEquals(observedPlanSize({ observedTotalTurns: "3" }), undefined);
  assertEquals(observedPlanSize({ observedTotalTurns: Number.NaN }), undefined);
  assertEquals(observedPlanSize({ observedTotalTurns: null }), undefined);
  assertEquals(observedPlanSize({ observedTotalTurns: {} }), undefined);
});

Deno.test("audio-feed-8905: the reader prefers the observed count over what the wrapper carries", () => {
  // This is the substitution the three read sites perform. `totalTurns` on the error is
  // the constant the narration budget options pass; the observed count wins when present.
  const constant = 24;
  const withProgress = { observedTotalTurns: 6, totalTurns: constant };
  assert(
    (observedPlanSize(withProgress) ?? withProgress.totalTurns) === 6,
    "an observed plan size must win over the constant",
  );
  const withoutProgress = { totalTurns: constant };
  assert(
    (observedPlanSize(withoutProgress) ?? withoutProgress.totalTurns) === constant,
    "with no observation the constant is the documented fallback",
  );
});
