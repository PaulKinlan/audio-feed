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
  let windowValue = 0;
  let windowStart = 0;
  let windowLast = 0;
  for (const entry of entries) {
    if (entry.hadRecentInput) continue;
    observed = true;
    const start = entry.startTime;
    const joins = windowValue !== 0 && start - windowLast < 1000 && start - windowStart < 5000;
    if (!joins) {
      windowStart = start;
      windowValue = 0;
    }
    windowValue += entry.value;
    windowLast = start;
    if (windowValue > best) best = windowValue;
  }
  return { value: best, observed };
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
globalThis.cwvStats = { p98, largestSessionWindow };
