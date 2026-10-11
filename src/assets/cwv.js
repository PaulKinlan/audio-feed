/**
 * Real-user Core Web Vitals (audio-feed-i7vi / obs-4).
 *
 * Reports the three field metrics the page can observe — LCP, INP and CLS — to POST /api/cwv when
 * the page goes away, which is the only moment the values are final.
 *
 * Deliberately small, deferred, and free of any network request until unload: this script measures
 * how the page performs, so anything it does eagerly would make the numbers it reports worse. It
 * observes, it does not poll, and it sends at most three beacons in a page's whole life.
 *
 * The page label is derived here from the path and re-validated by the server against its own
 * allow-list, so a doctored label can only ever be one the server already knows about.
 */
(function () {
  "use strict";
  if (typeof PerformanceObserver !== "function") return;
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;

  const label = (() => {
    const path = location.pathname;
    if (path === "/") return "home";
    if (path.indexOf("/listen") === 0) return "listen";
    if (path.indexOf("/admin") === 0) return "admin";
    if (path.indexOf("/account") === 0) return "account";
    return "landing";
  })();

  let lcp = 0;
  let cls = 0;
  let clsObserved = false;
  // Interaction latencies, kept so INP can be the 98th percentile rather than the worst one
  // (audio-feed-dzgj): INP is defined over the distribution of interactions, and reporting the
  // single worst event makes every page look as bad as its unluckiest click.
  const interactions = [];
  let sent = false;

  // LCP: keep the latest candidate; the final one is only known at unload.
  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) lcp = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (_) { /* not supported: the metric is simply never reported */ }

  // CLS: the LARGEST SESSION WINDOW, not a running total (audio-feed-d55l). A session window ends
  // after a 1s gap in shifts or once it has lasted 5s, and the metric is the biggest window's score.
  // Summing every shift instead lets a page that jitters all session accumulate a score no window
  // ever had, and it grows without bound the longer a visitor stays.
  let clsWindowValue = 0;
  let clsWindowStart = 0;
  let clsWindowLast = 0;
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.hadRecentInput) return;
        clsObserved = true;
        const start = entry.startTime;
        const joined = clsWindowValue !== 0 && start - clsWindowLast < 1000 &&
          start - clsWindowStart < 5000;
        if (!joined) {
          clsWindowStart = start;
          clsWindowValue = 0;
        }
        clsWindowValue += entry.value;
        clsWindowLast = start;
        if (clsWindowValue > cls) cls = clsWindowValue;
      });
    }).observe({ type: "layout-shift", buffered: true });
  } catch (_) { /* as above */ }

  // INP: interaction latencies are collected, and the 98th percentile is sent below.
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        interactions.push(entry.duration);
      });
    }).observe({ type: "event", buffered: true, durationThreshold: 40 });
  } catch (_) { /* as above */ }

  /** The 98th percentile, the way the metric is defined. Nearest-rank: no interpolation, so the
   * value reported is always one a real interaction actually had. */
  const p98 = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const rank = Math.ceil(0.98 * sorted.length);
    return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
  };

  const send = (metric, value) => {
    try {
      const body = JSON.stringify({ metric: metric, value: value, page: label });
      navigator.sendBeacon("/api/cwv", new Blob([body], { type: "application/json" }));
    } catch (_) {
      // A metric that cannot be sent is not a reason to break the page, and there is nothing
      // useful to do about it from here.
    }
  };

  const flush = () => {
    if (sent) return;
    sent = true;
    if (lcp > 0) send("lcp", Math.round(lcp));
    if (interactions.length > 0) send("inp", Math.round(p98(interactions)));
    // CLS is sent whenever the page had ANY layout shift, including a score of exactly zero
    // (audio-feed-d55l): zero is a real, good measurement, and the previous `if (cls > 0)` meant a
    // well-built page reported nothing at all. Three decimals, because CLS is a small ratio and
    // rounding to an integer would report every score as zero.
    if (clsObserved) send("cls", Math.round(cls * 1000) / 1000);
  };

  // Both, because neither is reliable alone: `pagehide` is the documented place for this and fires
  // on bfcache too, and `visibilitychange` catches the tab going away in cases where unload does
  // not run. The guard in flush() means only the first one reports.
  addEventListener("pagehide", flush);
  addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });
})();
