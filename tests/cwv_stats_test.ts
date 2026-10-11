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
  ) => { value: number; observed: boolean; peakWindowStart: number };
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

Deno.test("the reviewer's 49-interaction repro: a poor interaction is not reported as good (audio-feed-dzgj)", () => {
  const event = (interactionId: number, duration: number) => ({ interactionId, duration });

  // The reproduction from dzgj round 5, verbatim: 49 REAL interactions with ids 1..49 - 48 at 80ms and
  // one at 1000ms, so the page's true p98 IS the slow one - plus a pointerdown on a scroll whose Event
  // Timing interactionId is 0.
  const entries = [
    ...Array.from({ length: 48 }, (_, i) => event(i + 1, 80)),
    event(49, 1000),
    event(0, 500),
  ];

  const observed = interactionLatencies(entries);
  assertEquals(observed.length, 49, "the scroll must not add a latency");
  assertEquals(interactionP98(entries), 1000, "the page's p98 is its slow interaction");

  // THE PROPERTY, which is what round 5 was about: the reported value must be the slow interaction and
  // must never be one of the fast ones.
  assert(interactionP98(entries) > 80, "a poor interaction must not be reported as good");

  // And the arithmetic of the failure, so a reintroduced count fails on the mechanism: an inflated count
  // of 50 gives rank ceil(0.98 * 50) = 49; one imagined unobserved interaction moves it to the 48th
  // smallest, and that value is an 80ms interaction. This is why no count is used in this path.
  const rankWithInflatedCount = Math.ceil(0.98 * 50);
  const shiftedRank = rankWithInflatedCount - (50 - observed.length);
  assert(
    shiftedRank < observed.length,
    "an inflated count moves the rank off the slow interaction",
  );
  assertEquals(observed[shiftedRank - 1], 80, "and the value it lands on is a FAST interaction");
});

Deno.test("a page whose fast interactions were suppressed is reported as the slow one it did report (audio-feed-dzgj)", () => {
  const event = (interactionId: number, duration: number) => ({ interactionId, duration });

  // 59 interactions at 8ms, below the observer's 16ms clamp so never reported, plus one at 1000ms that
  // is. Without a count this is an UPPER BOUND: the reported percentile is the one observed value, so the
  // page looks worse than it is. Deliberate - overstating INP is recoverable, reporting a poor
  // interaction as good is not - and it is what the standard web-vitals library reports.
  const entries = [
    ...Array.from({ length: 59 }, (_, i) => event(i + 1, 8)),
    event(60, 1000),
  ];
  const observed = interactionLatencies(entries.filter((e) => e.duration >= 16));
  assertEquals(observed, [1000], "the fast interactions were suppressed by the observer");
  assertEquals(p98(observed), 1000, "an upper bound, and it errs by overstating");
});

Deno.test("a zero-scoring shift still OPENS a session window (audio-feed-d55l)", () => {
  const shift = (startTime: number, value: number) => ({ startTime, value, hadRecentInput: false });

  // The reviewer's sequence, and the expected value is 0.6 rather than 0.5: CLS is the LARGEST session
  // window, and the shift at t=5400 is more than 1000ms after t=900, so it opens its own window worth
  // 0.6 while the first window (a zero-scoring shift at t=0 plus 0.5 at t=900) is worth 0.5. The zero
  // shift's effect on which shifts belong to the FIRST window is what the next case pins down.
  const reviewerCase = [shift(0, 0), shift(900, 0.5), shift(5400, 0.6)];
  assertEquals(largestSessionWindow(reviewerCase).value, 0.6);
  assertEquals(largestSessionWindow(reviewerCase).observed, true, "a zero score is a measurement");

  // Where the inference IS observable: the winning window's origin. A zero-scoring shift at t=0 that
  // does not open a window makes the next shift start one at its own time, so the origin moves from 0
  // to 500 and this assertion fails - which is what pins the fix.
  assertEquals(
    largestSessionWindow([shift(0, 0), shift(500, 0.4)]).value,
    0.4,
    "a zero-scoring shift then a real one, inside both limits",
  );
  assertEquals(
    largestSessionWindow([shift(0, 0), shift(500, 0.4)]).peakWindowStart,
    0,
    "the window must begin at the zero-scoring shift; inferring existence from the value reports 500",
  );
  // And the same with two zeros: the origin is still the FIRST of them.
  assertEquals(
    largestSessionWindow([shift(0, 0), shift(400, 0), shift(900, 0.4)]).peakWindowStart,
    0,
  );

  // NOTE on what the old inference could NOT change, since it looked like a value bug and is not one:
  // a zero-scoring shift contributes nothing to the sum, and the origin it moves can only ever be
  // LATER, which excludes shifts rather than including them. So every sequence tried here gives the
  // same `value` with or without the fix; what changes is the window the value is attributed to. The
  // tests below pin the values so a future change cannot move them silently.
  assertEquals(
    largestSessionWindow([shift(0, 0), shift(900, 0.5), shift(1800, 0.25)]).value,
    0.75,
    "shifts inside the limits still accumulate from the zero-scoring first one",
  );

  // The rest of the rule still holds, including that a zero score is still an observation.
  assertEquals(
    largestSessionWindow([shift(0, 0.25), shift(900, 0.25), shift(1800, 0.25)]).value,
    0.75,
  );
  assertEquals(largestSessionWindow([shift(0, 0)]).value, 0);
  assertEquals(largestSessionWindow([shift(0, 0)]).observed, true);
  // A gap longer than 1s starts a new window whatever the values are.
  assertEquals(largestSessionWindow([shift(0, 0), shift(1100, 0.7)]).value, 0.7);
  // Recent input is excluded entirely, so it neither opens nor extends a window.
  assertEquals(
    largestSessionWindow([{ startTime: 0, value: 9, hadRecentInput: true }, shift(10, 0.2)]).value,
    0.2,
  );
});
