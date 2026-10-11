# Evidence: observability (4) — traces and real-user CWV

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

## The interaction count, checked in a real browser (audio-feed-dzgj)

INP needs the number of interactions, because the platform's reporter clamps at 16ms and never
reports the interactions it suppresses. That count is load-bearing, so
`scripts/verify_i7vi_browser.ts` dispatches a KNOWN number (three mouse press/releases, each also
emitting a click, plus two key presses) and reads the collector's own count back out of the page.
Transcript: `verify-browser-count.txt`.

WHAT WAS OBSERVED, across six runs: the page counted **2, 2, 4, 2, 2, 4** of the 5 dispatched, and
every reported duration was 32-96ms — the durations of the mouse interactions. No key interaction
was ever counted, and `Page.bringToFront` plus focusing the body did not change that, so keyboard
clicks in a headless page do not reach the collector at all. The overcount direction was never
observed.

WHAT THIS DOES AND DOES NOT ESTABLISH. It establishes that the collector counts the interactions the
page actually receives, that it never overcounted in six runs, and that the one concrete overcount
mechanism found while doing this — a held key repeating keydown, which the platform counts as ONE
interaction — is now guarded in the collector, because an inflated count makes `inpFromObserved`
subtract unobserved interactions that never existed and thereby UNDERSTATES INP. It does NOT
establish that `keydown` is counted when it does arrive, because this harness could not deliver one,
and it does not establish that the count is complete under real input in a real browser.

WHY AN UNDERCOUNT IS RECORDED RATHER THAN FIXED FURTHER: it is safe by construction.
`inpFromObserved` clamps `u = max(0, N - k)`, so a short count degrades to a percentile over the
reported entries — the upper bound this work exists to improve on — and can never subtract imagined
interactions from the rank. The honest claim is conditional: INP is the true 98th percentile when
every interaction is counted, and an upper bound when interactions went uncounted.
