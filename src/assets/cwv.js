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
  if (typeof navigator === "undefined") return;
  // audio-feed-mpmc: DO NOT bail out when sendBeacon is missing. Both holes this closes were silent:
  // a browser or context without sendBeacon used to leave this whole script and report NOTHING, and a
  // beacon the browser REFUSED (sendBeacon returns false) was indistinguishable from one accepted, so
  // beacon loss could not be measured from either side. The transport is chosen per beacon in send()
  // and every choice is counted, because a beacon path that cannot say whether it sent is the
  // confident-empty-answer failure in miniature.

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

  // Which transport carried each beacon, so a refusal is visible FROM THE PAGE rather than only as an
  // absence on the server: `beacon` + `fallback` are attempts, and `failed` counts fallbacks the
  // browser rejected (or that could not be started) - the attempts that are known to have been lost.
  const transports = { beacon: 0, fallback: 0, failed: 0 };

  const send = (metric, value) => {
    const body = JSON.stringify({ metric: metric, value: value, page: label });
    // PRIMARY: sendBeacon. Its boolean return is the browser's answer to "did you take this?", and
    // `false` means it did not - so it is read rather than discarded (audio-feed-mpmc).
    if (typeof navigator.sendBeacon === "function") {
      try {
        if (navigator.sendBeacon("/api/cwv", new Blob([body], { type: "application/json" }))) {
          transports.beacon++;
          return;
        }
      } catch (_) {
        // A throw is a refusal too: fall through to the fallback instead of losing the metric.
      }
    }
    // FALLBACK: a keepalive fetch, which is the same fire-and-forget shape - the response is not read,
    // because there is nothing useful to do with it from here. `keepalive` is Baseline widely
    // available, so this needs no feature guard and no TODO(baseline/...) comment.
    transports.fallback++;
    try {
      fetch("/api/cwv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body,
        keepalive: true,
      }).then(
        () => {},
        () => {
          transports.failed++;
        },
      );
    } catch (_) {
      transports.failed++;
    }
  };

  // Interactions are counted from the input events that BEGIN one (audio-feed-s3uk).
  // `click` is not counted because it follows pointerdown for the same interaction.
  // A held key fires keydown repeatedly; held-key repeat is suppressed via event.repeat and keysDown
  // so a held key is counted as ONE interaction.
  let interactionStarts = 0;
  let pointerStarts = 0;
  let keyStarts = 0;
  let allEventsTrusted = true;
  const keysDown = new Set();

  const countPointer = (event) => {
    if (event.isTrusted === false) allEventsTrusted = false;
    pointerStarts++;
    interactionStarts++;
  };

  const countKey = (event) => {
    if (event.isTrusted === false) allEventsTrusted = false;
    if (event.repeat || keysDown.has(event.code)) return;
    keysDown.add(event.code);
    keyStarts++;
    interactionStarts++;
  };

  const keyUp = (event) => keysDown.delete(event.code);

  addEventListener("pointerdown", countPointer, { capture: true, passive: true });
  addEventListener("keydown", countKey, { capture: true, passive: true });
  addEventListener("keyup", keyUp, { capture: true, passive: true });

  // Read-only view of what the collector counted and observed, published on the page scope so a
  // verification run can compare it against interactions it dispatched deliberately (audio-feed-s3uk).
  globalThis.cwvState = {
    starts: () => interactionStarts,
    pointerStarts: () => pointerStarts,
    keyStarts: () => keyStarts,
    isTrusted: () => allEventsTrusted,
    observed: () => interactionLatencies(interactions),
    transports: () => ({
      beacon: transports.beacon,
      fallback: transports.fallback,
      failed: transports.failed,
    }),
  };

  const flush = () => {
    if (sent) return;
    sent = true;
    if (lcp > 0) send("lcp", Math.round(lcp));
    // INP as the percentile over the interactions the observer REPORTED — an upper bound when short
    // interactions were suppressed, and deliberately so: overstating a page's INP is recoverable,
    // reporting a poor interaction as good is not (audio-feed-dzgj).
    const observed = interactionLatencies(interactions);
    if (observed.length > 0) send("inp", Math.round(p98(observed)));
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
