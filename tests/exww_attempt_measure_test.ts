/**
 * audio-feed-8u4x1 — the attempt-measurement harness's DERIVATION MATH, unit-tested.
 *
 * The campaign itself is a browser measurement run by hand (scripts/exww-attempt-measure.ts, one
 * bounded run, evidence into docs/evidence/audio-feed-8u4x1/) — it is evidence, not a suite. But
 * the rules that turn its samples into the ladder's constants are code, and wrong math here would
 * quietly re-derive the bound from nothing. So the math is pure, exported, and pinned here:
 * percentile rank, the ratio rule and its floor, the base rule and its floor, the censoring
 * refusal, and the gate-budget check. The pin that ties the SHIPPED constants to the COMMITTED
 * evidence lives in tests/exww_mutants_test.ts, next to the ladder it guards.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  BASE_FLOOR_MS,
  deriveLadderConstants,
  GATE_BUDGET_MS,
  LADDER_RATIO_FLOOR,
  MAX_CENSORED_SHARE,
  nearestRankPercentile,
  parseMeasureOptions,
} from "../scripts/exww-attempt-measure.ts";

Deno.test("audio-feed-8u4x1: nearest-rank percentile is the rank the README can recompute by hand", () => {
  // n=4: rank(50) = ceil(0.5*4) = 2 → the 2nd of the sorted values.
  assertEquals(nearestRankPercentile([4, 1, 3, 2], 50), 2);
  // n=4: rank(100) = 4 → the maximum; the input order must not matter.
  assertEquals(nearestRankPercentile([9, 1, 5, 3], 100), 9);
  // n=12 (the campaign's shape): rank(99) = ceil(11.88) = 12 → p99 IS the worst observed attempt.
  const twelve = [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 240];
  assertEquals(nearestRankPercentile(twelve, 99), 240);
  assertEquals(nearestRankPercentile(twelve, 50), 60);
  // Monotone in p: a higher percentile never returns a smaller value.
  const samples = [30, 22, 91, 45, 67, 12, 88, 5];
  for (let p = 1; p <= 100; p++) {
    assert(
      nearestRankPercentile(samples, p) >= nearestRankPercentile(samples, Math.max(1, p - 1)),
      `percentile ${p} must not dip below ${p - 1}`,
    );
  }
  assertThrows(() => nearestRankPercentile([], 50), Error, "empty sample set");
});

Deno.test("audio-feed-8u4x1: the ratio rule is ceil(p99/p50), floored at the ladder's strictly-increasing invariant", () => {
  // A wide tail, built explicitly so the reader can verify by hand: eleven 60s and one 240
  // → p50 = 60, p99 = 240 → ratio ceil(4) = 4 (data raised it above the floor).
  const samples = [...Array(11).fill(60), 240];
  assertEquals(nearestRankPercentile(samples, 50), 60);
  assertEquals(nearestRankPercentile(samples, 99), 240);
  const derived = deriveLadderConstants(samples, 0);
  assertEquals(derived.ratio, 4);
  assertEquals(derived.p50S, 60);
  assertEquals(derived.p99S, 240);

  // A tight tail: p99 == p50 → the raw quotient is 1, but the floor holds the ladder increasing.
  const tight = [55, 55, 55, 55, 55];
  assertEquals(deriveLadderConstants(tight, 0).ratio, LADDER_RATIO_FLOOR);
  assertEquals(LADDER_RATIO_FLOOR, 2);
});

Deno.test("audio-feed-8u4x1: the base rule keeps the r6hft floor and rounds the tail up to the minute", () => {
  // p99 under the floor: the base stays at the original quiet guard — measurement never narrows it.
  const under = [...Array(11).fill(60), 180]; // p99 = 180s < 240s
  const derivedUnder = deriveLadderConstants(under, 0);
  assertEquals(derivedUnder.baseMs, BASE_FLOOR_MS);
  assertEquals(derivedUnder.baseMs, 240_000);

  // p99 over the floor: the base rounds UP to the next minute above the tail. Fixture shape:
  // eleven 150s and one 375s → p50 = 150, p99 = 375 → ratio ceil(2.5) = 3, so the derived ladder
  // (420 × 3² = 3780s) still fits the gate budget and the base rule is what the test isolates.
  const over = [...Array(11).fill(150), 375];
  assertEquals(deriveLadderConstants(over, 0).baseMs, 420_000);
});

Deno.test("audio-feed-8u4x1: censoring is reported, excluded from the percentiles, and refused when it eats the tail", () => {
  const uncensored = [...Array(11).fill(60), 240];
  const derived = deriveLadderConstants(uncensored, 1);
  assertEquals(derived.censoredCount, 1);
  assertEquals(derived.attemptCount, 13);
  // The percentiles come from the UNCENSORED samples only: a censored 600s would have dragged p99 to the bound.
  assertEquals(derived.p99S, 240);

  // One fifth censored is the line the README states; one nanosecond past it is inconclusive.
  const twelve = [...Array(11).fill(60), 240];
  const threeCensoredOfTwentySeven = deriveLadderConstants([...uncensored, ...twelve], 3);
  assertEquals(threeCensoredOfTwentySeven.censoredCount, 3);
  assertEquals(threeCensoredOfTwentySeven.attemptCount, 27);
  assert(
    threeCensoredOfTwentySeven.censoredCount / threeCensoredOfTwentySeven.attemptCount <=
      MAX_CENSORED_SHARE,
    "3 of 27 sits inside the stated line and must derive",
  );
  assertThrows(
    () => deriveLadderConstants([...Array(6).fill(60)], 2),
    Error,
    "INCONCLUSIVE",
  );
  assertThrows(() => deriveLadderConstants([], 12), Error, "measured nothing");
});

Deno.test("audio-feed-8u4x1: a ladder the gate budget cannot run fails the derivation instead of shipping", () => {
  // p99 = 1200s from 60 uncensored samples → base = 1200s; with a ratio forced to 5 by a p50 of 240s,
  // the ladder top 1200 × 5² = 30000s dwarfs the 5400s budget — the derivation must refuse.
  const samples = [...Array(30).fill(240), ...Array(30).fill(1200)];
  assertEquals(nearestRankPercentile(samples, 50), 240);
  assertEquals(nearestRankPercentile(samples, 99), 1200);
  assertThrows(
    () => deriveLadderConstants(samples, 0),
    Error,
    "gate budget",
  );
  // And the shipped ladder, at its WORST derived shape, fits: 240 × 2² = 960s « 5400s.
  const shipped = deriveLadderConstants([...Array(11).fill(60), 240], 0);
  assert(
    shipped.baseMs * shipped.ratio ** 2 <= GATE_BUDGET_MS,
    "the derived ladder top must stay inside the fleet's gate budget",
  );
});

Deno.test("audio-feed-8u4x1: the CLI options bound the campaign before it burns a heavy slot", () => {
  const defaults = parseMeasureOptions([]);
  assertEquals(defaults.attempts, 12);
  assertEquals(defaults.boundMs, 600_000);
  assertEquals(defaults.deadlineMs, 4_800_000);
  assertEquals(defaults.outDir, "docs/evidence/audio-feed-8u4x1");

  const parsed = parseMeasureOptions([
    "--attempts",
    "8",
    "--bound-s",
    "300",
    "--deadline-s",
    "2400",
    "--out",
    "/tmp/x",
  ]);
  assertEquals(parsed.attempts, 8);
  assertEquals(parsed.boundMs, 300_000);
  assertEquals(parsed.deadlineMs, 2_400_000);
  assertEquals(parsed.outDir, "/tmp/x");

  // A deadline inside one attempt's bound can never finish: refused before any browser starts.
  assertThrows(
    () => parseMeasureOptions(["--bound-s", "600", "--deadline-s", "300"]),
    Error,
    "deadline",
  );
  assertThrows(() => parseMeasureOptions(["--attempts", "0"]), Error, "positive");
  assertThrows(() => parseMeasureOptions(["--nonsense"]), Error, "unrecognised argument");
});
