/**
 * The Core Web Vitals arithmetic, tested directly (audio-feed-i7vi / d55l + dzgj).
 *
 * This evaluates `src/assets/cwv-stats.js` rather than a copy of the maths, so the browser and the
 * test cannot drift: the file is a classic script for the page, and it is read here as source.
 *
 * Both of these bugs were arithmetic the browser collector got wrong while the server-side contract
 * around it was correct and tested — which is why the collector's maths needed a test of its own and
 * the CDP run needed to be a proof of wiring rather than of arithmetic.
 */

import { assert, assertEquals } from "@std/assert";

const source = await Deno.readTextFile("src/assets/cwv-stats.js");
const {
  p98,
  largestSessionWindow,
  interactionLatencies,
  interactionP98,
} = new Function(
  `${source}\nreturn { p98, largestSessionWindow, interactionLatencies, interactionP98 };`,
)() as {
  inpFromObserved: (observed: number[], interactions: number) => number;
  p98: (values: number[]) => number;
  interactionLatencies: (
    entries: { interactionId: number; duration: number }[],
  ) => number[];
  interactionP98: (entries: { interactionId: number; duration: number }[]) => number;
  largestSessionWindow: (
    entries: { startTime: number; value: number; hadRecentInput?: boolean }[],
  ) => { value: number; observed: boolean };
};

const shift = (startTime: number, value: number, hadRecentInput = false) => ({
  startTime,
  value,
  hadRecentInput,
});

Deno.test("INP is the 98th percentile, which is not the maximum (audio-feed-dzgj)", () => {
  // One unlucky interaction among a hundred: max would report that unlucky one as the page's INP.
  const values = [80, 90, 95, 100, ...[110].concat(Array.from({ length: 95 }, (_, i) => 120 + i))];
  const worst = Math.max(...values);
  const p = p98(values);
  assert(p < worst, `p98 (${p}) must be below the maximum (${worst})`);
  // 101 values, so the nearest rank is ceil(0.98 * 101) = 99 — the 99th smallest, which is 212.
  // I first wrote 230 here from a miscount of my own fixture; the test caught it, which is the point.
  assertEquals(p, 212, "nearest rank of 101 values is the 99th smallest");

  // A single interaction is its own percentile, and an empty set is zero rather than undefined.
  assertEquals(p98([250]), 250);
  assertEquals(p98([]), 0);
  // Nearest rank never interpolates, so the answer is always a value that was actually observed.
  assert(values.includes(p98(values)), "no interpolated value is ever reported");
});

Deno.test("CLS is the largest session window, not a running sum (audio-feed-d55l)", () => {
  // Four shifts spread far apart: each opens its own window, and the metric is the largest one — a
  // sum would report 0.4 here, which is a score no window ever had.
  const spread = [shift(100, 0.1), shift(3000, 0.1), shift(6000, 0.1), shift(9000, 0.1)];
  assertEquals(largestSessionWindow(spread).value, 0.1);

  // A burst inside one second is one window and sums.
  const burst = [shift(100, 0.1), shift(200, 0.05), shift(300, 0.05)];
  assertEquals(largestSessionWindow(burst).value, 0.2);

  // The window closes after 5s even with no gap, so a long dribble cannot accumulate for ever.
  const long = [
    shift(0, 0.1),
    shift(900, 0.1),
    shift(1800, 0.1),
    shift(2700, 0.1),
    shift(3600, 0.1),
    shift(4500, 0.1),
    shift(5400, 0.1),
  ];
  const total = long.reduce((sum, entry) => sum + entry.value, 0);
  const largest = largestSessionWindow(long);
  assert(
    largest.value < total,
    `the largest window (${largest.value}) must be less than the total (${total})`,
  );
  assert(largest.value >= 0.6, "the first window holds the shifts within 5s of its start");

  // Shifts caused by user input are not CLS at all.
  assertEquals(largestSessionWindow([shift(100, 0.9, true)]).value, 0);
  assertEquals(largestSessionWindow([shift(100, 0.9, true)]).observed, false);
});

Deno.test("a zero CLS from a page that shifted is observed, not silence (audio-feed-d55l)", () => {
  // The distinction the collector needs: a page with a shift entry scoring zero HAS a measurement
  // (a good one), while a page with no shift entries has none. Collapsing both into 0 made a
  // well-built page report nothing at all.
  const zeroScore = largestSessionWindow([shift(100, 0)]);
  assertEquals(zeroScore.value, 0);
  assertEquals(zeroScore.observed, true, "a shift was observed, so a score of 0 is a measurement");

  const neverShifted = largestSessionWindow([]);
  assertEquals(neverShifted.value, 0);
  assertEquals(
    neverShifted.observed,
    false,
    "no shift was observed, so there is nothing to report",
  );
});

Deno.test("INP groups entries by interactionId before taking the percentile (audio-feed-dzgj)", () => {
  const event = (interactionId: number, duration: number) => ({ interactionId, duration });

  // The reviewer's reproduction: 59 interactions at 80ms and ONE interaction at 1000ms which emitted
  // TWO entries. Percentile-over-entries counts that slow interaction twice, so its entries alone
  // occupy the top of an otherwise fast distribution and the shipped INP was 1000ms.
  const entries = [
    ...Array.from({ length: 59 }, (_, i) => event(i + 1, 80)),
    event(60, 1000),
    event(60, 1000),
  ];
  assertEquals(entries.length, 61, "61 entries");
  assertEquals(interactionLatencies(entries).length, 60, "but 60 distinct interactions");
  assertEquals(
    p98(interactionLatencies(entries)),
    80,
    "nearest rank over 60 interactions: the 59th smallest, so the one slow interaction is above it",
  );
  assertEquals(interactionP98(entries), 80, "and that is the reported INP, not 1000");
  // Stated as the property, so a revert to percentile-over-entries fails here rather than on a count.
  assert(
    interactionP98(entries) < 1000,
    "one slow interaction cannot define the page's INP by itself",
  );

  // One interaction contributes ONE latency: the longest of its entries.
  assertEquals(interactionLatencies([event(1, 40), event(1, 120), event(1, 90)]), [120]);

  // Entries with no interactionId are not interactions (a scroll or a hover), so they are excluded
  // rather than becoming a phantom interaction with id 0.
  assertEquals(interactionLatencies([event(0, 500), event(1, 30)]), [30]);
  assertEquals(interactionP98([event(0, 500)]), 0, "no interaction means nothing to report");
});

Deno.test("INP is reported as an upper bound, because the interaction count cannot be derived (audio-feed-dzgj)", () => {
  const event = (interactionId: number, duration: number) => ({ interactionId, duration });

  // MEASURED, not assumed: the ids are not a per-document count. In a real headless browser the
  // highest id seen was 3892 in one run and 7381 in another, so a scheme that used max(interactionId)
  // as the interaction count would place the nearest rank deep inside the suppressed range for any
  // realistic page and collapse INP to the threshold — reporting every page as fast. That is the
  // dangerous direction, so the correction is withdrawn.
  //
  // What ships instead: the percentile over the reported interactions. A page whose observed
  // interaction is poor is reported as poor even when its fast interactions were suppressed (the
  // upper-bound direction, which is safe); the cost is that a page with many suppressed fast
  // interactions is over-reported rather than under-reported.
  const observed = [1000];
  assertEquals(p98(observed), 1000, "an observed poor interaction is reported as poor");
  const mixed = [80, 80, 1000];
  assertEquals(p98(mixed), 1000);
  assert(p98(mixed) >= 80, "never below the observed distribution");

  // Grouping and the zero-id exclusion still hold: they are what the observer's entries mean.
  assertEquals(
    interactionLatencies([event(1, 40), event(1, 120)]),
    [120],
    "one interaction, one latency",
  );
  assertEquals(interactionLatencies([event(0, 900)]).length, 0, "a scroll is not an interaction");
});
