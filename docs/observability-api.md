# Observability API (audio-feed-s2pi / obs-1)

Two authenticated endpoints over the structured log store from obs-2 (`audio-feed-wzv9`). They read
that store directly — there is no second store, no second index and no second copy of the events.

```
GET /api/observability/errors?since=<cursor>&limit=N[&severity=error|warn|info|all][&until=<cursor>]
GET /api/observability/summary?since=<cursor>[&until=<cursor>][&severity=error|warn|info|all]
```

### Severity filter default (`warn` + `error`) (`audio-feed-elr5`)

When `severity` is omitted, both `/api/observability/errors` and `/api/observability/summary`
**default to `severity=warn`**, which includes **`warn` and `error` records only** and excludes all
`info` and `debug` records:

| `severity` query parameter | severities included              | typical use                                                         |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| _(omitted)_ or `warn`      | `warn`, `error`                  | **Default.** Failure and warning polling (`total: 0` = no warn/err) |
| `error`                    | `error`                          | Terminal failures and unhandled errors only                         |
| `info`                     | `info`, `warn`, `error`          | Operational events + completions + warnings/errors (no `debug`)     |
| `all`                      | `debug`, `info`, `warn`, `error` | Full retained event stream, including completion and stage marks    |

> [!IMPORTANT]
> **Completion and progress checks MUST pass `?severity=all` (or `?severity=info`).** Synthesis
> completion and progress events — `claim.lifecycle` with `phase: "ready"` or
> `phase: "synthesized_N_of_M"`, `synthesis.invocation` `started`/`terminal` marks, and successful
> `synthesis.stage` records — are emitted at **`info`** severity. Querying `/errors` or `/summary`
> with the default filter omits every `info` record, making a quiet error feed indistinguishable
> from an idle pipeline where nothing ran or completed.

## Authentication

`Authorization: Bearer <key>`, where the key is the `AUDIOFEED_OBSERVABILITY_KEY` environment
variable. Header only: a query parameter would be logged by proxies and kept in browser history.

| situation                           | response                                                          |
| ----------------------------------- | ----------------------------------------------------------------- |
| no key configured on the deployment | `503 observability_not_configured` — closed, and honest about why |
| missing or wrong key                | `401 unauthorised` + `WWW-Authenticate: Bearer`                   |
| correct key                         | the request proceeds                                              |

The key is compared in constant time, is never logged, never echoed in a response, and never stored
— the log record for a request carries no headers at all (`audio-feed-ao4s`), which is what makes
that a guarantee rather than a habit. Authentication is checked before parameter parsing, so an
unauthenticated caller learns nothing about the query language.

## Reachability: these two paths are NOT behind the host gate (`audio-feed-2tbv`)

**A log reader must not sit behind the switch whose position you are trying to diagnose.** During
the live 421 incident (`audio-feed-du8w`) the deployment refused every request because its
allowed-host set was empty, and the question "how do I read the error logs for the live deployment?"
could not be answered by this API: the host gate refuses _before any route runs_, so
`/api/observability/errors` answered 421 on the very host that was being diagnosed. The tool for
reading the incident was itself refused by the incident.

So these two endpoints — and only these two — are served even when the host gate is refusing:

| deployment state                                         | `/` , `/listen`, `/admin`  | `/api/observability/errors` |
| -------------------------------------------------------- | -------------------------- | --------------------------- |
| host not in the allowed set                              | `421 misdirected_request`  | served, if the key is right |
| allowed set empty (no `PUBLIC_BASE_URL`/`ALLOWED_HOSTS`) | `500 server_misconfigured` | served, if the key is right |

Both refusal bodies also name this endpoint, so an operator who meets a refusal is told where the
errors are instead of having to already know.

Why this is not a hole, in the terms of the gate's own threat model:

- **It is still authenticated.** Exemption from the _host_ check is not exemption from
  authentication: the shared key remains the only requirement, and it is still required. An exempt
  path without the key is `401`; with no key configured it is `503 observability_not_configured`,
  which names the variable to set — including on a refused host, so the operator is never left
  reading a generic failure.
- **It derives no origin or log content from the request host.** The host gate exists so an
  attacker-chosen `Host` never becomes the advertised origin, feed `selfUrl`/enclosure URLs, a
  redirect or the WebAuthn RP ID (`audio-feed-fp4r`/`7lsy`/`4x4t`). After authentication, a read can
  append a bounded overdue-invocation warning derived only from stored marks and the clock; it does
  not persist the request host. These routes answer JSON built from the log store: no redirect, no
  URL, no `Access-Control-Allow-Origin`. The one place a request host reaches a response header is
  the CSP `report-uri`, and that branch is HTML-only. A test asserts the attacker's host appears in
  neither the body nor any response header.
- **It cannot be widened by accident.** Matching is exact against the same normalised pathname the
  router dispatches on, so `/api/observability/errors/extra`, a percent-encoded lookalike or a
  doubled slash is refused by the gate, and a test asserts every exempt path is a route the router
  actually declares.
- **The rest stays gated, deliberately.** The homepage, feeds, listen pages, `/admin` and the admin
  observability _page_ are all still behind the gate. Only the two JSON endpoints an operator can
  poll without a browser session are exempt, and the test suite fails if a product route is added to
  the list or the match is loosened.

## Cursor semantics

**A cursor is a sequence number, not a time.** It is the `seq` of the last event the caller has
consumed, carried as a decimal string. The store assigns `seq` on append and it is durable,
monotonic and gap-free within what is retained. A timestamp is deliberately not the cursor: two
events in the same millisecond collide, and a poller that advances past a collision loses an event
silently — the one failure an errors feed cannot have. Because the sequence lives in the store and
not in a clock, a cursor also survives a restart: a redeploy continues the same sequence.

1. **Order.** `since=<cursor>` returns events with `seq` strictly greater than the cursor, in
   ascending `seq` order. The order is stable: identical requests return identical bodies until new
   events arrive.
2. **Advance.** A response's `cursor` is what the caller resumes from. It moves forward over
   everything the server **scanned**, not only what it returned — a filter must never produce a
   cursor that lets an event be skipped later. `scanned` and `returned` are reported so the
   difference is visible. `hasMore` is true when the page limit was hit with more behind it.
3. **Retention.** Events before `window.oldestRetained` no longer exist, so a cursor below it is
   refused with `410 cursor_too_old`, naming the oldest retained sequence. The API never silently
   skips: an event that cannot be served has to be reported as lost. This applies **even when
   retention has removed everything and the store looks empty** — `oldestRetained > newest` is what
   a fully-pruned store reports as well as a store that has never held an event, so the cursor is
   refused either way rather than answered with an empty feed. (A store that has never held an event
   reports `oldestRetained` of 1, so a poller that is simply early is not refused.)
4. **Validation.** `400 invalid_cursor` for a non-integer or negative `since`/`until` (and for
   `until` preceding `since`), `400 invalid_limit` outside `1..500`, `400 invalid_severity` for a
   filter this endpoint does not serve.

## Responses

`/errors`:

```json
{
  "cursor": "42",
  "events": [{
    "id": "42",
    "seq": 42,
    "time": "2026-10-11T12:00:42.000Z",
    "severity": "warn",
    "type": "synthesis.stage",
    "route": null,
    "job": "synthesis",
    "message": "synthesis stage tts FAILED after 123ms",
    "stack": null,
    "correlationId": "invocation-1",
    "episodeId": "epi-1",
    "phase": "tts",
    "attempt": null,
    "durationMs": 123,
    "context": { "invocationId": "invocation-1", "stageMark": "tts", "episodeId": "epi-1" }
  }],
  "hasMore": false,
  "scanned": 1,
  "returned": 1,
  "invocationDetection": {
    "scannedFromSeq": 1,
    "scannedThroughSeq": 42,
    "oldestRetainedSeq": 1,
    "olderStartsUnknown": false,
    "retentionGap": false,
    "incompleteMarkers": 0,
    "warningsWritten": 0,
    "inspectedAttempts": 0,
    "moreDue": false
  },
  "window": { "oldestRetained": 1, "newest": 42 }
}
```

`id` is the sequence in string form: it is the identity the store guarantees unique and ordered, and
a separate id would be a second identity that could disagree with the cursor. Every event has the
same top-level keys: absent `episodeId`, `phase`, `attempt`, and `durationMs` are `null`, not
missing. These are structured root fields from the stored record, not values inferred from `message`
or `context`. For `synthesis.stage`, `correlationId` names the **invocation** while `episodeId`
names the **episode**; group failed stages by `(episodeId, phase)` with `severity=warn` (which also
includes errors). Use `severity=all` to include successful `info` stage marks. Stage marks may be
capped by the producer, so missing marks do not prove a stage never ran.

**The one absence that IS evidence: `synthesis.upload` (`audio-feed-amhn`).** A stage mark is
written on the way _out_, so a terminal upload PUT that is killed mid-flight leaves no stage mark at
all — and that absence cannot be told apart from "the stage was never reached". On 2026-10-14 the
store held one `upload` mark while twelve episodes were killed inside the put. The producer
therefore writes `type: "synthesis.upload"`, `phase: "entering"`, **before** it awaits the put,
carrying `durationMs: null` and `context.bytesAttempted` (the payload size being attempted — the
size of a FAILED upload is recorded nowhere else, because `byteLength` is written only on
completion) plus `context.uploadRetry`. This record is not subject to the stage-mark cap: there is
at most one per terminal upload attempt.

**An entering record with no completion mark is a kill only when all three of these hold together**,
because the absence of a completion mark is not on its own proof — stage marks are capped, so a
completion mark can be suppressed even when the put succeeded, and the invocation deadline can
expire between the entering record and the put:

1. a `synthesis.upload` record with `phase: "entering"` for the episode, and
2. no `synthesis.stage` record with `phase: "upload"` for the same `correlationId`, and no `capped`
   event naming `upload` (which would make that absence a suppression rather than a death), and
3. **no `synthesis.invocation` terminal record for that same `correlationId`.**

Fact 3 is what separates a kill from a cancellation: an invocation that was cancelled or threw
closes its own terminal record, while an isolate that stopped existing leaves its start unpaired
(production pairs 864 of 889 starts). An entering record whose invocation DID close is a cancelled
or failed attempt, not a killed transfer — so `synthesis.upload` must never be read as "bytes were
sent" on its own. Taken together, the three facts locate a platform kill on the first pass without
reconstructing it from a silence, which is the read that cost a night on 2026-10-14. The episode
record carries the same size for the abandonment path: see `bytesAttempted` in `Episode` and in the
`claim.lifecycle` `context`, written as the worker enters the terminal stage (`audio-feed-amhn`).

**The second phase of that type: `synthesis.upload` with `phase: "skipped"` (`audio-feed-wnv8`).**
When the invocation deadline has already expired by the time the worker reaches the transfer, the PUT
is **not attempted at all** — the worker records `phase: "skipped"`, `severity: "warn"`, and ends the
stage with the abort reason it was already carrying. The record exists because a skip that left no
trace would be indistinguishable from an attempt that never got that far, which is the shape this
whole read exists to end; and it carries the two numbers that make the decision auditable rather than
asserted: **`context.deadlineMs`** (the invocation budget it was measured against) and
**`context.observedMs`** (how long the invocation had actually been running when the check ran), plus
`context.abortReason` naming what fired. Note the arithmetic a reader must not get wrong: a stage's
own cutoff is the budget minus its flush margin, so `observedMs` can legitimately sit a few
milliseconds BELOW `deadlineMs` — `abortReason` is what turns those numbers into a reason, not the
comparison between them. An `entering` record still means a PUT was handed to the storage layer: the check sits
BEFORE it, so this phase never appears alongside one.

Note what this does and does not buy, because the honest claim is small: the transfer it avoids was
already aborted by its own signal (`src/storage/s3.ts`), so the value is a cleaner record and a
request that never leaves the isolate — **not** a rescued upload or a saved transfer.

The existing `context` field remains available but is not a uniform join schema: it can contain
nested, source-specific data including CSP reports from a public endpoint. The store caps and
redacts context by **key name**, not by screening arbitrary user text. This bearer-key endpoint
therefore does not newly project `userId` (a subscriber identifier) or `reason` (potentially
free-form error text); admin-session pages expose those fields separately. The existing `message`
and `stack` projection and its writer-side text screening are unchanged. Do not treat a bearer key
as permission to redistribute free-form log text.

The existing `window.oldestRetained` reports the retention boundary; if a cursor is older, `410`
reports a gap rather than silent loss. `invocationDetection.olderStartsUnknown`, `retentionGap`, and
`moreDue` already describe limits of the overdue-invocation scan; this change adds no competing
coverage fields. Neither those indicators nor the structured event fields reconstruct pruned logs.

`/summary` returns
`{ cursor, since, total, bySeverity, byType, byTypeTruncated, truncated, scanned, invocationDetection, queue, window }`.
`byType` lists the 25 most frequent types in the counted window; `byTypeTruncated: true` means other
types were counted but omitted from that list. An absent type then means **unknown**, not zero —
fetch `/errors` over the same cursor window to inspect it. This flag is independent of `truncated`,
which means the scan did not yet reach all sequences in the requested window. `total: 0` is the
cheap answer to "has anything happened since my cursor" — one bounded scan instead of a page of
events. It applies the same cursor rules, including the `410` when retention has moved past the
cursor, so a poller cannot be told "nothing new" when it has in fact missed events.

### Queue snapshot on `/summary` (`audio-feed-1qac`, `audio-feed-ciuw`)

An idle `*/2` synthesis cron tick writes to the metadata KV run-history store rather than the log
store, so log silence alone cannot distinguish **"nothing is queued"** from **"work is queued and
stalled"**. `/api/observability/summary` therefore includes a `queue` snapshot read directly from
durable episode and run-history storage:

```json
"queue": {
  "claimable": 0,
  "claimableCapped": false,
  "oldestClaimableAt": null,
  "drain": "empty",
  "lastSynthesisRun": {
    "id": "run-1",
    "kind": "synthesis",
    "trigger": "cron",
    "startedAt": "2026-10-14T11:00:00.000Z",
    "durationMs": 1420,
    "ready": 1,
    "failed": 0,
    "deferred": 0
  },
  "readError": null,
  "runsReadError": null
}
```

- `claimable`: `number | null` — episodes claimable right now (`pending`, or a `synthesizing` claim
  whose lease has expired), capped at `100` (`REPORT_QUEUE_CAP`). **`null` means the durable queue
  read failed (`audio-feed-ciuw`), never `0`** — callers must never interpret `null` as an empty
  queue.
- `claimableCapped`: `boolean` — `true` when more than `100` episodes are claimable.
- `oldestClaimableAt`: `string | null` — ISO 8601 `createdAt` timestamp of the oldest claimable
  episode, or `null` when none are queued or the queue read failed.
- `drain`: `"empty" | "draining" | "stalled" | "unknown" | "unreadable"`
  - `"empty"` — `claimable === 0` AND the last synthesis run is either absent, or started within
    `3 * SYNTHESIS_TICK_MS` (30 minutes) with no top-level `error` and `failed === 0`. **`"empty"` is
    EARNED, not assumed** (`audio-feed-n1f7`): negative evidence is allowed to speak, so a run that
    failed, was recorded with an error, or went stale reports `"stalled"` instead - which was
    impossible before, because `claimable === 0` short-circuited the verdict ahead of the run history.
    No run history at all is still `"empty"` when nothing is claimable: there is no evidence to mask,
    and `lastSynthesisRun: null` carries the caveat.
  - `"draining"` — `claimable > 0` and `lastSynthesisRun` started within `3 * SYNTHESIS_TICK_MS` (30
    minutes), had no top-level `error`, and recorded `ready > 0`.
  - `"stalled"` — `claimable > 0` and `lastSynthesisRun` is stale, errored, or finished `0`
    episodes, **or `claimable === 0` while the last run is stale, errored, or recorded a failure**
    (`audio-feed-n1f7`). This second arm is the one that was unreachable before.
  - `"unknown"` — the run-history read failed (`runsReadError !== null`), **or** `claimable > 0` with
    no synthesis run retained in `listRuns(20, "synthesis")`. The read-failure case is checked BEFORE
    the `claimable === 0` arm, because a run history that could not be read is not evidence of a
    healthy drain (`audio-feed-ciuw`: a failed read must never render as a healthy value).
  - `"unreadable"` — the queue read failed (`claimable === null`, `readError !== null`).

  **The limit, stated rather than implied:** `drain` is derived from the pending queue and the last
  synthesis run only. It cannot see a claim held past its budget, nor an episode abandoned at
  `maxClaims`: both leave nothing claimable and make a healthy run correctly report nothing ready,
  which this field cannot distinguish from a genuinely empty queue. Those two states stay answerable
  through the admin report's `liveClaims` and `abandoned` counts, which are not part of this
  key-gated snapshot.
- `lastSynthesisRun`: `RunRecord | null` — most recent synthesis run from
  `listRuns(20, "synthesis")`, scoped to `"synthesis"` so feed-poll runs cannot crowd it out
  (`audio-feed-506m`).
- `readError`: `string | null` — bounded error message when `listPendingEpisodes` failed.
- `runsReadError`: `string | null` — bounded error message when `listRuns` failed.

## Overdue synthesis invocations (audio-feed-a7i0)

An authenticated `/summary` or `/errors` read first checks the **newest 500 retained log records**
for `synthesis.invocation` start/terminal pairs. Strictly more than twice the budget recorded on a
start (`context.budgetMs`; 180 seconds by default) with no observed terminal in that snapshot
produces one durable `warn` event, `synthesis.invocation.overdue`. The log's sequence check forces a
rescan if any writer, including a late terminal, commits before the warning; a per-invocation guard
prevents concurrent readers from appending two warnings. It reports **only** that no terminal mark
was observed as of the scan. It cannot establish that an isolate died, whether work is still
running, or whether a terminal write failed. What it does record is the last activity it was able to
see, which is a measurement of silence rather than a substitute for those answers (see `What the
warning records, and what it still cannot know` below). The normal warn/error filter returns the
event, and summary sees it before deciding a poll is idle.

This is deliberately not an all-history detector. `invocationDetection.scannedFromSeq` and
`scannedThroughSeq` say which window was actually checked; `olderStartsUnknown` is true when the
window truncated older retained records, retention pruned earlier records, or a start mark lacked a
usable recorded budget. `retentionGap` says earlier records were pruned. `moreDue` means the
per-request attempt/warning cap stopped with visible due work still pending: poll again, never read
it as "zero overdue". A store read, partial sequence window, or warning-write failure returns
`503 invocation_detection_unavailable` without a feed cursor or a quiet `total: 0`. A reader can
therefore distinguish no overdue start **in the observed window** from an inability to see earlier
starts. Older starts outside that window are not enumerated by this detector.

### What the warning records, and what it still cannot know (audio-feed-fsd9)

Each warning also carries **what was last SEEN of that invocation**, read from the same snapshot it
already held, so a reader does not have to compare the scan's wall clock against a start time and
guess whether a budget was consumed or the turn is merely long:

- `context.lastSeenAt`, `lastSeenSeq`, `lastSeenType` and `lastSeenPhase` — the newest stored record
  carrying that invocation's `correlationId`, at or after its start mark. When nothing was stored
  after the start, these describe the start mark itself and the message says so in words.
- `context.lastSeenAgoMs` — how long the store had been **silent** about it at scan time.
- `context.observedActiveMs` — how far into the invocation that last observation was, which is what
  `context.budgetMs` should be compared against. **It is a LOWER BOUND on consumption:** a killed
  invocation stops being observed, so a small value is a fact about observation, not a claim that
  little time passed in the isolate.

These are measurements of **silence, never of death**. A large `lastSeenAgoMs` is equally consistent
with an isolate that was killed, one that is still running something slow, and one whose writes are
failing, and the warning's wording keeps saying so.

**A surface that has no field, deliberately: the reason a platform-ended invocation ended.** There is
no `killReason`, `oomBytes` or exit-code field on this record and there should not be one. A kill runs
none of our code, so a field written at that moment cannot exist; the only way to populate it would be
to write a value we never observed — a permanently `null` field that looks like coverage while
answering nothing. The honest surface is the one above: the last stage observed, how long ago it was
observed, the bytes attempted (`bytesAttempted`, see the terminal-upload records), and this stated
limit. The kill reason and memory state are available **platform-side only** (Deno Deploy isolate
logs), which is why an investigation that needs them is an operator request and not a read of this
API.

The summary's `cursor` is the last sequence it **SCANNED**, never the last it counted. A scan is
bounded, so a window larger than the bound is examined in part: `truncated: true` says so, `cursor`
names the last sequence the scan **reached**, and the next poll continues from there. Reporting the
newest sequence in the window instead counts part of a window while claiming all of it, so a poller
moves past events it was never told about — a real bug (`audio-feed-8d6r`), and the same rule as the
errors feed's cursor advancing over what was scanned rather than what was returned.

Because that cursor may sit past records the summary's filter excluded, it is a safe way to ask
"what changed?" but not a safe durable cursor: a poller drains the errors endpoint from the cursor
it last consumed and only then moves its own (`audio-feed-2af8`, and the recipe below).

## What a poller does

```
durable = "0"
loop:
  s = GET /api/observability/summary?since=<durable>    # PROBE: is there anything?
  if s.total == 0 and not s.truncated:
      # No new matching EVENTS; inspect s.invocationDetection before claiming history is clear.
      continue                                          # no newly emitted warning in this page
  # DRAIN FIRST, from the cursor you last consumed, and only then move it. A probe may look past
  # records its filter excluded; the durable cursor may not (audio-feed-2af8).
  cursor = durable
  while true:
      page = GET /api/observability/errors?since=<cursor>
      act on page.events                                # this is where events are actually consumed
      cursor = page.cursor                              # safe: it advances over what was SCANNED
      if not page.hasMore: break
  durable = cursor                                      # past everything READ, never past a count
```

A truncated probe is a reason to drain even when `total` is 0: the scan bound filled with records
the filter excluded and the ones you asked for sit behind it (`audio-feed-36qa`).

The rule for the consumer is the same one the API holds itself to: **a cursor may only advance over
what has been consumed.** A PROBE may look past records its filter excluded; a DURABLE cursor may
not. So the summary's boundary is a limit to drain UP TO, never a value to jump to: advancing to it
while matched events below it are unread loses them (`audio-feed-2af8`, after `audio-feed-c0kx`).
The summary answers "is there anything new" cheaply; the errors pages are what you actually read,
and the durable cursor belongs to the reading, not to the check.

**`truncated: true` means "ask again", never "nothing to see".** It is a statement about the PROBE:
`cursor` on a summary response is where the next SUMMARY call continues from, and it may sit past
records that filter excluded. The summary counts only the records its filter matched, but its cursor
advances over everything the scan EXAMINED, so a scan whose bound fills with filtered-out records
answers `total: 0, truncated: true`. A caller that treats `total: 0` as "quiet" stops forever in
exactly that case: the bound fills with events it did not ask for and the ones it wanted sit behind
them (`audio-feed-36qa`). `/summary` also reports `scanned` — zero examined means genuinely empty,
and a full bound means there is more.

The DURABLE cursor is a different thing, and it moves only after a drain. The recipe above reads
`/errors` from the cursor it last consumed, page by page, and assigns its own cursor only once a
page reports `hasMore: false`; it re-polls the SUMMARY from that same durable cursor each iteration
and never advances the probe cursor on its behalf. Following the recipe literally therefore cannot
move the wrong cursor, and the two rules above are the reason it is written that way.

On `410 cursor_too_old`, the cursor cannot be resumed: re-baseline from `window.oldestRetained - 1`
(accepting the gap, and saying so in whatever consumes the events) or from the current cursor, and
treat the lost interval as unknown rather than as quiet.

## Distribution query for synthesis & ingest outcomes (`audio-feed-dndq`, `audio-feed-m0sk`)

To compute the full distribution of where articles and synthesis attempts succeed, yield, stall, or
fail across the retained log window, run the following read sequence with
`Authorization: Bearer $AUDIOFEED_OBSERVABILITY_KEY`:

### 1. Exact requests to run

1. **Snapshot the queue and log window with `severity=all`:**
   ```
   GET /api/observability/summary?since=0&severity=all
   ```
   Read `queue` (`claimable`, `claimableCapped`, `oldestClaimableAt`, `drain`, `lastSynthesisRun`,
   `readError`, `runsReadError`), `invocationDetection`, `bySeverity`, `byType`, `byTypeTruncated`,
   and `window` (`oldestRetained`, `newest`).
2. **Drain the full retained event stream with `severity=all`:**
   ```
   GET /api/observability/errors?since=<cursor>&limit=500&severity=all
   ```
   Start at `cursor = String(window.oldestRetained - 1)` (or `0` when `oldestRetained === 1`) and
   advance `cursor = page.cursor` until `page.hasMore === false`. `severity=all` (or
   `severity=info`) is mandatory because claim starts, intermediate progress, stage completions, and
   `phase: "ready"` events are written at `info` severity (`audio-feed-elr5`).

### 2. Grouping the five distributions from structured fields

- **(a) Episodes attempted vs. completed vs. retrying vs. failed (`type === "claim.lifecycle"`):**
  Group records by `episodeId` and `attempt`:
  - **Attempt started:** `phase === "claimed"` with no `durationMs`, no `context.claimOutcome`, and
    no `context.workerState`.
  - **Completed (`ready`):** `phase === "ready"` and `severity === "info"` (`durationMs` holds
    lease-to-terminal duration).
  - **Deliberately yielded / retrying (`audio-feed-2sec`):** `context.claimOutcome === "yielded"`
    (e.g., `phase` `"synthesized_N_of_M"` or `"upload_retry"`, with `context.uploadRetry`).
  - **Terminal worker failure:** `severity === "error"` with `context.workerState === undefined`.
  - **Abandoned / expired claim lease (`audio-feed-kd5r`, `audio-feed-aueh`):**
    `context.workerState === "unknown"` (`severity === "error"` on final abandonment) or
    `context.claimOutcome === "expired"` (`severity === "warn"` on intermediate lease expiry).
  - **Article, source, and input-size metadata (`audio-feed-4y9v`):** read `context.articleId`,
    `context.sourceId`, `context.sourceTitle`, `context.mode`, `context.inputByteLength`,
    `context.wordCount`, `context.segmentCount`, `context.scriptTurnCount`, `context.byteLength`,
    and `context.durationSeconds`.
- **(b) Failures by synthesis stage (`type === "synthesis.stage"`):** Group records by
  `(episodeId, phase)` where `phase` is in `{"tts", "verify", "upload", "yield"}` and
  `correlationId` identifies the invocation. Failed stages have `severity === "warn"` (or
  `"error"`); completed stages have `severity === "info"`.
- **(c) Invocations lost with no terminal record (`audio-feed-a7i0`, `audio-feed-4nbt`):** Inspect
  `invocationDetection` (`incompleteMarkers`, `warningsWritten`, `olderStartsUnknown`,
  `retentionGap`, `moreDue`) and events with `type === "synthesis.invocation.overdue"` or
  `type === "synthesis.invocation"` (`context.budgetMs`).
- **(d) Pre-episode ingest failures and post-commit degradation (`type === "ingest.failed"`,
  `type === "ingest.source_seed_failed"`):**
  - `ingest.failed` (`severity === "warn"`): articles rejected before episode creation, carrying
    `context.status`, `context.mode`, `context.error` (screened), `context.articleUrl`, and
    `context.articleTitle`.
  - `ingest.source_seed_failed` (`severity === "warn"`): episodes that committed (`status: 202`)
    whose auxiliary inbox source seeding failed afterward, carrying `context.episodeId`,
    `context.articleId`, `context.sourceId`, and `context.error` (screened).
- **(e) HTTP host and route refusals (`type === "http.request"`):** Inspect `route`,
  `context.status`, and `context.host` (normalised hostname or `"<other>"` when screened,
  `audio-feed-4y9v`).

### 3. Three-way zero disambiguation & structural boundaries

- **Retention & scan bounds:** Any `0` count is scoped to `[window.oldestRetained, window.newest]`.
  If `window.oldestRetained > 1` or `invocationDetection.retentionGap === true`, earlier records
  have aged out. If `invocationDetection.olderStartsUnknown === true` or `moreDue === true`, the
  500-record overdue-invocation scan bound was reached. On `/summary`, `byTypeTruncated: true` means
  types outside the top 25 were counted in `total` but omitted from `byType`.
- **Queue read failures (`audio-feed-ciuw`):** `queue.claimable === 0` means the queue is empty;
  `queue.claimable === null` (`queue.drain === "unreadable"`) means the queue read failed
  (`queue.readError`).
- **Deliberate privacy & containment boundaries:**
  - `userId` and unscreened `reason` prose are excluded from the bearer-key projection.
  - Feed items skipped as already-existing during normal feed polls do not emit error records.
  - **Accepted post-commit containment trade (`audio-feed-m0sk`):** In `src/compose/ingest.ts`, once
    `putArticleWithEpisode` commits, the episode is durably queued and `POST /api/ingest` must
    return `202` so clients do not retry and duplicate the episode. If inbox source seeding fails
    and the subsequent `appendLog` for `ingest.source_seed_failed` also fails (because the metadata
    store is unavailable), the nested `catch` logs a screened warning to operational stderr rather
    than failing the committed `202`. During a log-store outage, that auxiliary degradation is
    visible on stderr (`[audio-feed] failed to record source_seed_failed log...`) and not in the
    durable log feed.
