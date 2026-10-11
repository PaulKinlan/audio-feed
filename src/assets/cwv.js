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
  // Both metrics are collected as ENTRIES and reduced by the tested arithmetic in cwv-stats.js,
  // inlined before this file: the collector's job is observation, and the maths is not its own.
  const shifts = [];
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

  // CLS: shifts are collected and reduced by largestSessionWindow (see cwv-stats.js).
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        shifts.push(entry);
      });
    }).observe({ type: "layout-shift", buffered: true });
  } catch (_) { /* as above */ }

  // INP: ENTRIES are collected, not latencies. Event Timing reports one entry per event, so several
  // entries can belong to one interaction and only interactionP98 can turn them into the metric
  // (audio-feed-dzgj).
  //
  // durationThreshold is 16ms, the lowest the platform allows. That does NOT make it an optimisation
  // by itself: entries below it are never reported, so the page's short interactions are invisible and
  // a percentile over reported entries alone is an upper bound. It is defeated by counting the
  // interactions SEPARATELY (below) and handing that count to inpFromObserved.
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        interactions.push(entry);
      });
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch (_) { /* as above */ }

  const send = (metric, value) => {
    try {
      const body = JSON.stringify({ metric: metric, value: value, page: label });
      navigator.sendBeacon("/api/cwv", new Blob([body], { type: "application/json" }));
    } catch (_) {
      // A metric that cannot be sent is not a reason to break the page, and there is nothing
      // useful to do about it from here.
    }
  };

  // Interactions are counted from the input events that BEGIN one, independently of Event Timing,
  // because that count is what the threshold hides. `click` is deliberately NOT counted: it follows
  // the pointerdown that began the same interaction, so counting it would count most mouse
  // interactions twice. A keyboard activation fires keydown, which is counted.
  let interactionStarts = 0;
  const countStart = () => {
    interactionStarts++;
  };
  addEventListener("pointerdown", countStart, { capture: true, passive: true });
  addEventListener("keydown", countStart, { capture: true, passive: true });

  const flush = () => {
    if (sent) return;
    sent = true;
    if (lcp > 0) send("lcp", Math.round(lcp));
    // Both halves are needed: the entries the observer reported, and how many interactions there
    // actually were, so the ones it could not report still count towards the percentile.
    const observed = interactionLatencies(interactions);
    if (interactionStarts > 0 || observed.length > 0) {
      send(
        "inp",
        Math.round(inpFromObserved(observed, Math.max(interactionStarts, observed.length))),
      );
    }
    // Sent whenever the page shifted at all, including a score of exactly zero (audio-feed-d55l):
    // zero is a real, good measurement. Three decimals, because CLS is a small ratio and rounding to
    // an integer would report every score as zero.
    const cls = largestSessionWindow(shifts);
    if (cls.observed) send("cls", Math.round(cls.value * 1000) / 1000);
  };

  // Both, because neither is reliable alone: `pagehide` is the documented place for this and fires
  // on bfcache too, and `visibilitychange` catches the tab going away in cases where unload does
  // not run. The guard in flush() means only the first one reports.
  addEventListener("pagehide", flush);
  addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });
})();
