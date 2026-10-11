/**
 * The Core Web Vitals arithmetic the collector needs (audio-feed-i7vi).
 *
 * Plain top-level functions, deliberately: this file is inlined into the page before the collector,
 * so it cannot be a module, and it defines no state so a test can call it with a plain array.
 *
 * It exists because "inspection plus a browser run" is how the two bugs here were born: CLS summed
 * every shift instead of taking the largest session window, and INP took the maximum instead of the
 * 98th percentile. Both are small pure functions, and a test can call them directly with the exact
 * sequences that expose those mistakes — including a zero-CLS page and a case where max !== p98.
 */

/**
 * The nearest-rank 98th percentile, which is the definition INP uses.
 *
 * Nearest-rank rather than interpolated: the value reported is always one a real interaction
 * actually had, never an average of two, which is what makes it meaningful as "what a user felt".
 */
function p98(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(0.98 * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

/**
 * CLS as the largest session window, which is the definition the metric uses.
 *
 * A session window opens at a layout shift and stays open while shifts keep arriving within 1s of
 * the previous one and the window has not yet lasted 5s. The score is the BIGGEST window's total, so
 * a page that jitters all session cannot accumulate a score that no window ever had.
 *
 * Returns the largest window total and whether the page shifted at all — because a score of exactly
 * zero from a page that did shift is a real, good measurement, while a page that never shifted has
 * nothing to report. Collapsing those two into "0" is what made the collector silent about good
 * pages (audio-feed-d55l).
 */
function largestSessionWindow(entries) {
  let observed = false;
  let best = 0;
  // The start of the window that is currently winning. Exposed so the window's ORIGIN is testable:
  // a change to how existence is inferred moves this number without moving the value, which is the
  // only way the zero-scoring-shift bug (audio-feed-d55l) can be observed at all.
  let peakWindowStart = 0;
  let windowValue = 0;
  // A window is open when the accumulated score is POSITIVE, which is what web-vitals' continuation test
  // requires. A zero-valued shift therefore neither opens nor continues a window: it is skipped, and the
  // next positive shift starts a window of its own with that shift's time as the origin
  // (audio-feed-d55l, reviewer ruling). The earlier change here held a window open on any prior entry
  // (`windowStart !== null`), which misreported six 0.1 shifts after a zero at t=0 as 0.5 from an origin
  // of 0 instead of 0.6 from an origin of 900 - correct behaviour replaced by wrong behaviour.
  let windowStart = null;
  let windowLast = 0;
  for (const entry of entries) {
    if (entry.hadRecentInput) continue;
    observed = true;
    const start = entry.startTime;
    // The continuation test is web-vitals', and the FIRST term is the accumulated session score:
    //
    //   if (sessionValue && firstSessionEntry && lastSessionEntry &&
    //       entry.startTime - lastSessionEntry.startTime < 1000 &&
    //       entry.startTime - firstSessionEntry.startTime < 5000) {
    //     sessionValue += entry.value;
    //   } else {
    //     sessionValue = entry.value;
    //   }
    //
    //   -- GoogleChrome/web-vitals, src/onCLS.ts, verbatim.
    //
    // JavaScript 0 is falsy, so `sessionValue` being the first term means a zero-valued shift neither
    // continues nor opens a window: the next positive shift RESTARTS the window with its own startTime
    // as the origin, which moves the 5s cap later. This is a deliberate quirk, not an oversight. An
    // earlier change here used `windowStart !== null` - the more obvious "is a window open?" test - and
    // it reported 0.5 from an origin of 0 for a zero shift followed by six 0.1 shifts, where web-vitals,
    // CrUX and every other RUM tool report 0.6 from an origin of 900 (six shifts of 0.1, 900ms gaps,
    // 4500ms span). Our CLS must agree with what operators see in CrUX, so do NOT "fix" this back to a
    // null check (audio-feed-d55l, reviewer ruling, quoted source above).
    const joins = windowValue !== 0 && start - windowLast < 1000 && start - windowStart < 5000;
    if (!joins) {
      windowStart = start;
      windowValue = 0;
    }
    windowValue += entry.value;
    windowLast = start;
    if (windowValue > best) {
      best = windowValue;
      peakWindowStart = windowStart;
    }
  }
  return { value: best, observed, peakWindowStart };
}

/**
 * Published on the page's global scope, which is how the collector inlined AFTER this file reaches
 * them — an inlined classic script cannot import, so the page's scope is the interface. Naming them
 * here also means the linter sees two definitions that are used, rather than two it wants to
 * underscore (which would break every call site).
 *
 * tests/cwv_stats_test.ts evaluates THIS file rather than a copy of the arithmetic, so the browser
 * and the test cannot drift apart.
 */
/**
 * INP from Event Timing entries: GROUP FIRST, then take the percentile.
 *
 * Event Timing reports EVERY event of an interaction as its own entry, all sharing one
 * `interactionId`. Feeding those entries to a percentile counts one slow interaction several times,
 * so its entries can occupy the whole top of the distribution on their own — a single 1000ms
 * interaction with two entries produced a shipped INP of 1000ms where the real answer was 80
 * (audio-feed-dzgj).
 *
 * One interaction contributes ONE latency: the longest entry it produced. Entries with an
 * `interactionId` of 0 are not interactions at all (a scroll, a hover) and are excluded, which is
 * what the metric does.
 */
function interactionLatencies(entries) {
  const longest = new Map();
  for (const entry of entries) {
    const id = entry.interactionId;
    if (!id) continue;
    const duration = entry.duration;
    const current = longest.get(id);
    if (current === undefined || duration > current) longest.set(id, duration);
  }
  return [...longest.values()];
}

/**
 * THE INTERACTION COUNT CANNOT BE DERIVED, measured rather than assumed (audio-feed-dzgj).
 *
 * The proposal was to take the highest observed `interactionId` as the interaction count, on the
 * premise that Chromium assigns ids sequentially from 1. It does not: measured in a real headless
 * browser, the highest id seen was 3892 in one run and 7381 in another, because the id is a
 * browser-wide monotonic identifier rather than a per-document count. Using it as N made every page
 * look fast — with N in the thousands, the nearest rank falls inside the "not reported" range for any
 * realistic page, so the value collapses to the threshold. That is the dangerous direction, and worse
 * than the bias it was meant to remove.
 *
 * So INP is the percentile over the interactions the observer REPORTED, which is an UPPER BOUND when
 * the observer suppressed short interactions: it can overstate a page's INP but can never report a poor
 * interaction as good. The honest fix would be an interaction count the platform does not expose; the
 * standard library has the same limitation and reports the same bound.
 */
/**
 * INP: the nearest-rank 98th percentile across DISTINCT INTERACTIONS (see interactionLatencies), and an
 * upper bound when the observer suppressed short interactions — see the note above on why the count
 * cannot be derived from the ids (audio-feed-dzgj).
 */
function interactionP98(entries) {
  return p98(interactionLatencies(entries));
}

globalThis.cwvStats = {
  p98,
  largestSessionWindow,
  interactionLatencies,
  interactionP98,
};
