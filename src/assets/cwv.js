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
  let inp = 0;
  let cls = 0;
  let sent = false;

  // LCP: keep the latest candidate; the final one is only known at unload.
  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) lcp = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (_) { /* not supported: the metric is simply never reported */ }

  // CLS: sum of layout shifts that were not caused by user input, which is what the metric means.
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (!entry.hadRecentInput) cls += entry.value;
      });
    }).observe({ type: "layout-shift", buffered: true });
  } catch (_) { /* as above */ }

  // INP: the worst interaction latency observed. The entry type is `event`; the duration threshold
  // keeps the observer from reporting every trivial event.
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.duration > inp) inp = entry.duration;
      });
    }).observe({ type: "event", buffered: true, durationThreshold: 40 });
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

  const flush = () => {
    if (sent) return;
    sent = true;
    if (lcp > 0) send("lcp", Math.round(lcp));
    if (inp > 0) send("inp", Math.round(inp));
    // Three decimals: CLS is a small ratio and rounding it to an integer would report every score
    // as zero.
    if (cls > 0) send("cls", Math.round(cls * 1000) / 1000);
  };

  // Both, because neither is reliable alone: `pagehide` is the documented place for this and fires
  // on bfcache too, and `visibilitychange` catches the tab going away in cases where unload does
  // not run. The guard in flush() means only the first one reports.
  addEventListener("pagehide", flush);
  addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });
})();
