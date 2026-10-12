# Live claim-lease expiries on /admin/observability (audio-feed-exww)

- Script: scripts/exww-live-claims-browser-proof.ts
- Asserts: the worker recorded a REAL provider failure for ep-failing; the page serves 200 to the admin session; the live lease row for the held upload is rendered with its phase; the lease expiry shown is claimedAt + the claim's own lease; the exact lease instant is in the row's machine-readable datetime; a lease that has run out with no terminal write is called out, and timed; the expired claim's own expiry instant matches its claim time + lease; the REAL provider failure produced by the worker is in the failures section; the row whose lease is still live is NOT rendered as expired; the page names the instant the claim state was read, so the arithmetic is retraceable; with the worker healthy the lease section reports no failed read; a default-derived expiry SAYS it is the deployment default, in the cell; the page says the worker left no readable trace rather than swallowing it; the page's own verdict is that queued work is not being processed; the live lease row still renders with the worker path unhealthy; the exact lease expiry still renders with the worker path unhealthy; the expired upload is still called out with the worker path unhealthy; WORKER UNHEALTHY IS NOT STORE UNREACHABLE: the lease section reports no failed read; the page never claims no worker holds a claim while the worker is unhealthy; an unreachable episode store is reported as UNREADABLE, not as an empty lease set; no lease row is rendered when the store could not be read; 01-live-lease-expiries-worker-healthy.png is within the 150KB budget after a replay; 01-live-lease-expiries-worker-healthy.png covers the live-claims section with a live and an expired claim; 02-live-lease-expiries-worker-unavailable.png is within the 150KB budget after a replay; 02-live-lease-expiries-worker-unavailable.png covers the live-claims section with the worker path unavailable and the default-lease label; 03-live-lease-expiries-store-unreachable.png is within the 150KB budget after a replay; 03-live-lease-expiries-store-unreachable.png covers the live-claims section reporting UNREADABLE; 04-recent-failures-real-provider-error.png is within the 150KB budget after a replay; 04-recent-failures-real-provider-error.png covers the Recent failures section carrying the provider error; 01-live-lease-expiries-worker-healthy.png is a capture of rendered content, not a flat single-colour clip; 02-live-lease-expiries-worker-unavailable.png is a capture of rendered content, not a flat single-colour clip; 03-live-lease-expiries-store-unreachable.png is a capture of rendered content, not a flat single-colour clip; 04-recent-failures-real-provider-error.png is a capture of rendered content, not a flat single-colour clip; 01-live-lease-expiries-worker-healthy.png shows "LEASE EXPIRED with no terminal write" actually rendered, not just present in the DOM; 02-live-lease-expiries-worker-unavailable.png shows "computed from the deployment lease" actually rendered, not just present in the DOM; 03-live-lease-expiries-store-unreachable.png shows "Unavailable — the episode store could not be read" actually rendered, not just present in the DOM; 04-recent-failures-real-provider-error.png shows "provider status 500" actually rendered, not just present in the DOM

## How the state was produced
- The **failure** is real, not hand-written: `scripts/exww-live-claims-browser-proof.ts` runs the actual
  `runSynthesisBatch` against a `GeminiTtsClient` whose transport answers HTTP 500, and records the run
  through the real `recordRun`. The page then renders the provider failure the worker wrote.
- The **live claims** are written by the REAL storage transitions (`claimEpisode` then
  `touchEpisodeClaim` with `phase: "uploading_audio"`). One claim is inside its 15-minute lease and
  one expired 5 minutes ago, so the page has to distinguish "still held" from "nobody finished it".
- `ep-failing` is a separate episode, failed by the worker BEFORE the two live claims are taken, so the
  synthetic run cannot consume the claims this view is about.

## Where "now" comes from, and why an expired row cannot read as live
The expiry is `claimedAt + leaseMs`. `claimedAt` and the phase are the episode record's own
fields; `leaseMs` is the claim's recorded lease from its `claim.lifecycle` start record, and when
that record is not readable the page uses the deployment lease and SAYS SO in the cell - phase B of
this proof shows that label, because the failing `listLogs` is what makes the claim record
unavailable.

"Expired" and "time left" are NOT decided in the browser: `buildObservabilityReport(stores, nowMs)`
takes one explicit `nowMs`, and every row carries `leaseExpired: boolean | null` and `remainingMs`
computed from it, so all rows share one clock and the render only formats them. The page prints the
instant it read ("Claim state read at ..."), derived from that same `nowMs`, so every figure can be
retraced: `remaining = (claimedAt + leaseMs) - readAt`.

The arithmetic is pinned at a FIXED now by the report-level case
`audio-feed-exww: the claim's OWN lease is used, and a default-derived expiry is labelled`: halfway
through a 60-second lease it asserts `remainingMs === 30000` and `leaseExpired === false`, and
thirty seconds after it expires it asserts `remainingMs === -30000` and `leaseExpired === true`.
The browser assertions here read the RENDERED values: the `<time datetime>` of the expired row
equals its claim instant plus the lease, and the live row for the same page does not carry the
expired marker.

Commands used here, so the numbers can be retraced: the proof is
`deno run --allow-all --unstable-kv scripts/exww-live-claims-browser-proof.ts`; the report-level
cases are `deno test --allow-net --allow-env --allow-read --allow-write --allow-run --unstable-kv tests/admin_observability_test.ts --filter audio-feed-exww`; and the adapter-side cases are
`deno test --allow-net --allow-env --allow-read --allow-write --allow-run --unstable-kv tests/storage_test.ts --filter listSynthesizingEpisodes`.

## How the worker path is made unhealthy
Stated plainly, because a check like this is easy to write so that it passes while nothing was
broken:

- **No synthesis worker is running** in this proof at all: the loop is never started, so nothing
  claims the queue and nothing reports progress.
- **The worker's durable traces are unavailable**: `listLogs` and `logBounds` reject with
  "the synthesis worker left no readable trace", which is what a worker that never came back to write
  leaves behind. The failure is explicit and visible - the page names it, and the check asserts the
  page says it rather than swallowing it.
- **The worker's progress is measured, not unavailable**: the run history still reads and its last
  synthesis run made no progress while work is queued, so the page's own drain verdict is "queued work
  is NOT being processed".
- **The episode store is deliberately left healthy in that phase**, because the distinction the design
  rests on is exactly this: a worker being unhealthy is not the store being unreachable. The check
  asserts the live-claims SECTION contains no "could not be read" text, so a page that fetched its
  lease rows through the worker would fail it.

Phase C breaks the other thing - the episode store - and asserts the page then says UNREADABLE rather
than rendering an empty lease set, so "I could not look" and "nobody is holding anything" cannot be
confused in either direction.

## Screenshots, and what each one is proved to cover
Every capture is clipped to the section its README entry describes (`captureBeyondViewport` plus a
clip) and then has FOUR assertions, three of them about the written file rather than about the DOM that
produced it: (1) the clip starts at or above the section's rendered top and the image's own IHDR pixel
height reaches its rendered bottom, so a capture that stops short of the section the README describes
FAILS the run (audio-feed-u3m1); (2) the file is within the repository's 150KB budget, and the proof
compresses its own output with the repository's own recipe (`convert -strip -colors 256 PNG8:`) so a
replay does not write over-budget PNGs (audio-feed-vvo7); (3) the pixels carry rendered content - the
STANDARD DEVIATION of grey over the section's OWN rows is measured back out of the PNG and must exceed
0.01, which separates the committed captures (0.188-0.195) from a clip whose section rows render
nothing, which is one flat colour and measures zero (about 1e-8, in whichever colour that flat fill
happens to be), because a blank
capture satisfies every geometry assertion (audio-feed-7yom). The metric is standard deviation rather
than mean darkness because the page background is #f7f7f7: an entirely blank clip measures 0.033 by
mean darkness, so the first version of this assertion passed on the very capture it was written to
reject; and (4) the text each
claim names is in a PAINTED element inside that section - no `display:none`, `visibility:hidden`,
`opacity:0` or empty box on that element or any ancestor up to the section - because hiding a section
leaves textContent and layout intact while the image records background. Not covered, and stated here
rather than left to be discovered: text painted in the background colour, and content covered by an
overlapping element.

- `01-live-lease-expiries-worker-healthy.png`: the lease table with a held upload and an expired
  upload (called out AND timed).
- `04-recent-failures-real-provider-error.png`: the Recent failures section itself, carrying the
  error the real worker recorded for a provider 500 - its own artifact, so the README never points at
  a picture of one thing while describing another.
- `02-live-lease-expiries-worker-unavailable.png`: the same lease rows with the worker's durable
  traces unavailable, the queue reported as not being processed, and the default-derived lease expiry
  label asserted in the cell.
- `03-live-lease-expiries-store-unreachable.png`: the lease section reporting UNREADABLE, never an
  empty lease set.
