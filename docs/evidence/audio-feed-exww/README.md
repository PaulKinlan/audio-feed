# Live claim-lease expiries on /admin/observability (audio-feed-exww)

- Script: scripts/exww-live-claims-browser-proof.ts
- Asserts: the worker recorded a REAL provider failure for ep-failing; the page serves 200 to the admin session; the live lease row for the held upload is rendered with its phase; the lease expiry shown is claimedAt + the claim's own lease; the exact lease instant is in the row's machine-readable datetime; a lease that has run out with no terminal write is called out, and timed; the expired claim's own expiry instant matches its claim time + lease; the REAL provider failure produced by the worker is in the failures section; the row whose lease is still live is NOT rendered as expired; the page names the instant the claim state was read, so the arithmetic is retraceable; with the worker healthy the lease section reports no failed read; a default-derived expiry SAYS it is the deployment default, in the cell; the page says the worker left no readable trace rather than swallowing it; the page's own verdict is that queued work is not being processed; the live lease row still renders with the worker path unhealthy; the exact lease expiry still renders with the worker path unhealthy; the expired upload is still called out with the worker path unhealthy; WORKER UNHEALTHY IS NOT STORE UNREACHABLE: the lease section reports no failed read; the page never claims no worker holds a claim while the worker is unhealthy; an unreachable episode store is reported as UNREADABLE, not as an empty lease set; no lease row is rendered when the store could not be read; 01-live-lease-expiries-worker-healthy.png is within the 150KB budget after a replay; 01-live-lease-expiries-worker-healthy.png covers the live-claims section with a live and an expired claim; 01-live-lease-expiries-worker-healthy.png captured the section's own box, not another region of the page; 01-live-lease-expiries-worker-healthy.png has "LEASE EXPIRED with no terminal write" inside the captured pixels, not merely painted somewhere on the page; 01-live-lease-expiries-worker-healthy.png shows ink where "LEASE EXPIRED with no terminal write" is painted, not a background-coloured claim; 02-live-lease-expiries-worker-unavailable.png is within the 150KB budget after a replay; 02-live-lease-expiries-worker-unavailable.png covers the live-claims section with the worker path unavailable and the default-lease label; 02-live-lease-expiries-worker-unavailable.png captured the section's own box, not another region of the page; 02-live-lease-expiries-worker-unavailable.png has "computed from the deployment lease" inside the captured pixels, not merely painted somewhere on the page; 02-live-lease-expiries-worker-unavailable.png shows ink where "computed from the deployment lease" is painted, not a background-coloured claim; 03-live-lease-expiries-store-unreachable.png is within the 150KB budget after a replay; 03-live-lease-expiries-store-unreachable.png covers the live-claims section reporting UNREADABLE; 03-live-lease-expiries-store-unreachable.png captured the section's own box, not another region of the page; 03-live-lease-expiries-store-unreachable.png has "Unavailable — the episode store could not be read" inside the captured pixels, not merely painted somewhere on the page; 03-live-lease-expiries-store-unreachable.png shows ink where "Unavailable — the episode store could not be read" is painted, not a background-coloured claim; 04-recent-failures-real-provider-error.png is within the 150KB budget after a replay; 04-recent-failures-real-provider-error.png covers the Recent failures section carrying the provider error; 04-recent-failures-real-provider-error.png captured the section's own box, not another region of the page; 04-recent-failures-real-provider-error.png has "provider status 500" inside the captured pixels, not merely painted somewhere on the page; 04-recent-failures-real-provider-error.png shows ink where "provider status 500" is painted, not a background-coloured claim; 01-live-lease-expiries-worker-healthy.png is not faded or mostly covered and has ink in each height band; 02-live-lease-expiries-worker-unavailable.png is not faded or mostly covered and has ink in each height band; 03-live-lease-expiries-store-unreachable.png is not faded or mostly covered and has ink in each height band; 04-recent-failures-real-provider-error.png is not faded or mostly covered and has ink in each height band; 01-live-lease-expiries-worker-healthy.png shows "LEASE EXPIRED with no terminal write" actually rendered, not just present in the DOM; 02-live-lease-expiries-worker-unavailable.png shows "computed from the deployment lease" actually rendered, not just present in the DOM; 03-live-lease-expiries-store-unreachable.png shows "Unavailable — the episode store could not be read" actually rendered, not just present in the DOM; 04-recent-failures-real-provider-error.png shows "provider status 500" actually rendered, not just present in the DOM

## How the state was produced
- The proof **injects a frozen clock at 2026-10-12T12:00:00.000Z** for fixture writes and
  page responses, so the committed captures show fixed lease/read instants and failure times.
  The failed worker also uses the injected owner `worker-proof`, so its attempt history is stable.
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
clip) and then has SEVEN assertions, and the first three bind the image to the section rather than
describing the intention: (0) the captured region is compared against the section's own box on BOTH
AXES, re-read after the capture, so a clip moved anywhere else on the page FAILS (audio-feed-g86r for
the vertical axis, audio-feed-9zgi for the horizontal one) - the clip is one object used both for the
request and for the assertions about it, because while it was a literal in the capture call every check
described what the proof MEANT to capture; (1) the image's own IHDR width and height match the clip's
dimensions at the full scale the artefacts are documented at, so a capture of the right box at the
WRONG SCALE FAILS rather than passing at a size no README entry describes, and the height reaches the
section's rendered bottom so a capture that stops short also FAILS (audio-feed-u3m1, audio-feed-9zgi);
(2) the file is within the repository's 150KB budget, and the proof
compresses its own output with the repository's own recipe (`convert -strip -colors 256 PNG8:`) so a
replay does not write over-budget PNGs (audio-feed-vvo7); (3) the section is not faded or
mostly covered and has ink in each height band - the original two independent floors over
the section's OWN rows and columns are retained, measured back out of the PNG:
the faded-section contrast-range floor 0.5 separates four clean captures (0.880095) from opacity
0.35 (0.312) and 0.15 (0.137); the partial-content-loss normalized standard-deviation floor
0.12 separates the least-distributed clean crop (0.167164) from an 85%-covered crop (0.0884)
whose surviving ink still passes the range floor (0.8818). The latter floor is the geometric
mean of the clean minimum and mutant value, rounded down (clean margin 0.0472; mutant margin
0.0316). Neither floor alone catches both failure shapes (audio-feed-l11d). A third,
height-band standard-deviation floor 0.04 splits that same section into four equal-height
bands: the lowest committed band is about 0.09 (margin at least 0.05), while covering the
bottom half of the healthy capture with background leaves two bands below 0.0004. This adds
one ImageMagick invocation per capture; it does not prove ink identity or reject random
noise, and localized losses that spare ink in every band may evade it; and (4) the text each
claim names is in a PAINTED element inside that section - no `display:none`, `visibility:hidden`,
`opacity:0` or empty box on that element or any ancestor up to the section - because hiding a section
leaves textContent and layout intact while the image records background; (5) that painted text lies
INSIDE THE CAPTURED PIXELS ON BOTH AXES, so text painted in the right section while the image shows
something else FAILS; (6) the claim's OWN box is measured back out of the PNG and must carry ink
(CONTRAST RANGE over the text's own element: 0.880 in the committed clean captures, about 0 when that
text is painted in the page's own background colour, and < 0.5 when washed out; threshold 0.5)
(audio-feed-9zgi, audio-feed-l11d); and the pixel measurements (3)
and (6) are refused outright when the section's or the claim's box is not inside the captured clip,
rather than reporting someone else's pixels as this section's content. A small overlay covering just the named claim may be caught by its own ink check; arbitrary
local occlusions are not guaranteed to lower the whole-section distribution below its floor.
The partial-content-loss floor is evidence for the measured 85%-covered shape; the height-band
floor catches the measured bottom-half occlusion, NOT every arbitrary local occlusion. A smaller
occlusion or one leaving ink in every band can still evade the pixel statistics.

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
