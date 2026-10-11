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
- the three accepted reports stored as typed `cwv.report` records, and their severities following the
  published web-vitals bands — 1800ms LCP is `info`, 320ms INP `warn`, 0.42 CLS **`error`**, which is
  what puts a bad metric into the errors feed by default;
- **only the refused beacon** recorded as an `http.request`. A successful beacon is not recorded at
  all, because a page sends it and a record per report would be an event inside the store being
  measured — while a caller being turned away is a finding and stays visible;
- no part of a refused payload or its page label anywhere in the store (canary check);
- a span that joins to its episode and whose phases sum to its total, and a slow synthesis becoming a
  `warn` with a reason;
- the point of the whole bead: `cwv.report`, `http.request` and `synthesis.span` are all records in
  **one** store, so obs-1's API serves errors, traces and vitals together instead of an operator
  correlating two systems.

The unit suites cover what this script cannot: `tests/observability_cwv_test.ts` for every refusal,
the rate-limit boundary and the span arithmetic, and the worker test suite for the span emission
through the real synthesis path. `deno task test:fast` is green on the whole tree.

## What was NOT verified here

**The browser collector has not been driven in a real browser.** `src/assets/cwv.js` is rendered into
the shell and its server contract is tested, but no LCP, INP or CLS value has been observed arriving
from a browser in this lane. That is the one claim this evidence does not support, and the command to
settle it is:

```sh
# Load a page with a real browser, wait for the beacon, then read the record back.
deno run -A --unstable-kv scripts/verify_i7vi_events.ts   # then, separately, a CDP session that
                                                          # navigates and asserts a cwv.report appears
```

Until that runs, the collector should be treated as **unverified**, not as tested.

## A correction this script forced

Its first version asserted that *no* `http.request` record existed, which failed — correctly, and
against my own assertion rather than the code: a refused beacon is recorded by design. The check now
asserts the designed behaviour (exactly one request record, the refusal) rather than a weaker "nothing
was logged", which is the difference between a test that can pass for the wrong reason and one that
cannot.
