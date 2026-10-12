# Evidence: observability (4) — traces and real-user CWV

- Script: scripts/verify_i7vi_browser.ts
- Asserts: the collector is inlined in the served page; a real browser sent at least one CWV report;
  an LCP value arrived from the browser; the arrived value is inside the plausible range; the beacon
  never became a request-log field; a page label came with it

`audio-feed-i7vi`. Branch `fleet/i7vi`.

## What was verified, and how

`scripts/verify_i7vi_events.ts` drives the **real server** (`bootstrap`, not `createApp`) and its
transcript is `verify-events.txt`. Run it with:

```sh
deno run -A --unstable-kv scripts/verify_i7vi_events.ts
```

It shows, on the real path:

- three real beacons accepted `204`, a payload that is not a measurement refused `400`;
- the three accepted reports stored as typed `cwv.report` records, and their severities following
  the published web-vitals bands — 1800ms LCP is `info`, 320ms INP `warn`, 0.42 CLS **`error`**,
  which is what puts a bad metric into the errors feed by default;
- **only the refused beacon** recorded as an `http.request`. A successful beacon is not recorded at
  all, because a page sends it and a record per report would be an event inside the store being
  measured — while a caller being turned away is a finding and stays visible;
- no part of a refused payload or its page label anywhere in the store (canary check);
- a span that joins to its episode and whose phases sum to its total, and a slow synthesis becoming
  a `warn` with a reason;
- the point of the whole bead: `cwv.report`, `http.request` and `synthesis.span` are all records in
  **one** store, so obs-1's API serves errors, traces and vitals together instead of an operator
  correlating two systems.

The unit suites cover what this script cannot: `tests/observability_cwv_test.ts` for every refusal,
the rate-limit boundary and the span arithmetic, and the worker test suite for the span emission
through the real synthesis path. `deno task test:fast` is green on the whole tree.

## The browser collector, driven

Coord's requirement, and the right one: a browser asset has to be DRIVEN, not reasoned about.
`scripts/verify_i7vi_browser.ts` runs the real server, loads `/` in headless Chrome over CDP, lets
the browser observe its own metrics, dispatches a trusted click, navigates away so the pagehide
beacon fires, and reads the record back OUT of the store. Transcript: `verify-browser-cwv.txt`.

```sh
deno run -A --unstable-kv scripts/verify_i7vi_browser.ts
```

Result (exit 0, all checks passed): the collector is in the served page; a real browser sent
`cwv.report` records carrying **real LCP values** (160ms and 76ms in that run); the value is inside
the same plausible range the endpoint enforces; the page label arrived as `home`; and the beacon
never became a request-log field — the two `http.request` records in that run are the page loads
themselves, which belong in the log.

Bounded as the mandate requires: one browser, killed in a `finally`, its temp profile removed, the
server shut down in the same `finally`, and the whole run under a 90s wall clock.

## What is still not covered

- **INP was not observed in that run.** The collector sent LCP only. A trusted click was dispatched,
  but headless Chrome did not produce an interaction entry from it, so the INP branch of the
  collector is unexercised in the transcript. The script prints `INP: not observed in this run`
  rather than asserting a value it did not get.
- **CLS was zero**, and the collector deliberately sends nothing for a metric that is zero (a page
  with no layout shift has no CLS to report), so the CLS send path is likewise unexercised here.
  0.42 CLS arriving and becoming an `error` event is covered by the server-side cases instead.

So: the ingest contract, the severity bands and the LCP path are verified end to end from a real
browser. INP and CLS are verified as far as the parser, severities and refusals, and are honestly
marked as not-yet-observed from a browser rather than claimed.

## The interaction count: attempted, measured, and withdrawn (audio-feed-dzgj)

INP needs the number of interactions, because the platform never reports the interactions it
suppresses below its 16ms clamp. Two ways of counting were tried and BOTH were withdrawn on
measurement rather than on argument:

1. **Counting input events** (`pointerdown`/`keydown`). A pointerdown on a scroll is not an
   interaction, so this OVERCOUNTED, which shifts the percentile's rank down and reports a poor
   interaction as good — the dangerous direction. A held key also repeats `keydown`, which the
   platform counts as one interaction, and that inflated the count too.
2. **Deriving the count from the ids** (`max(interactionId)`), on the premise that Chromium assigns
   ids sequentially from 1. Measure that premise and it fails: in a real headless browser the
   highest id seen was **3892** in one run and **7381** in another, because `interactionId` is a
   browser-wide identifier, not a per-document count. Used as N it makes the nearest rank fall
   inside the "not reported" range for any realistic page, so INP collapses to the threshold — every
   page reported fast, the dangerous direction again, and worse than the bias it was meant to
   remove.

**What ships:** INP as the nearest-rank p98 over the interactions the observer REPORTED, grouped by
`interactionId` so one interaction contributes one latency, with `interactionId` 0 excluded because
a scroll or hover is not an interaction. That is an UPPER BOUND when short interactions were
suppressed: it can overstate a page's INP, and it can never report a poor interaction as good. The
standard web-vitals library reports the same bound for the same reason — the platform does not
expose a usable count.

**What the harness still verifies** (`verify-browser-count.txt`, run per dispatch kind): the
collector is in the page, real LCP values arrive, a beacon is sent and read back out of the store,
the beacon never becomes a request-log field, and the observed interaction durations are reported —
16ms entries now appear, which the earlier 40ms threshold had been hiding.

## Real-input INP verification under trusted user events (audio-feed-s3uk)

`scripts/verify_s3uk_real_browser.ts` drives a real interacted browser session against the live home
page (`/`), interacting directly with form inputs using CDP trusted events (`isTrusted: true`) for
both pointer and keyboard actions. Transcript: `verify-browser-real-input.txt`.

Results:

- **`isTrusted: true` established for all events**: all dispatched DOM events (`pointerdown`,
  `pointerup`, `click`, `keydown`, `keyup`) have `isTrusted === true`.
- **Event Timing assigns distinct interactionIds**: Pointer and keyboard interactions receive valid,
  distinct `interactionId` values from Chromium's internal Event Timing implementation (e.g. 537,
  6466, 6487).
- **Multi-event grouping verified**: Events from a single interaction (`pointerdown`, `pointerup`,
  `click` or `keydown`, `keypress`) share the same `interactionId`.
- **`cwvState.observed()` correctly groups by `interactionId`**: Excludes `interactionId: 0`
  (scroll/hover) and yields distinct per-interaction durations.
- **End-to-end beacon persistence**: On page navigation (`pagehide`), the collector flushes `lcp`
  and `inp` metrics via `sendBeacon` to `/api/cwv`, and verified `cwv.report` records are persisted
  to the metadata store.
