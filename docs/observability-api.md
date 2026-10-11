# Observability API (audio-feed-s2pi / obs-1)

Two authenticated endpoints over the structured log store from obs-2 (`audio-feed-wzv9`). They read
that store directly — there is no second store, no second index and no second copy of the events.

```
GET /api/observability/errors?since=<cursor>&limit=N[&severity=error|warn|all][&until=<cursor>]
GET /api/observability/summary?since=<cursor>[&until=<cursor>][&severity=...]
```

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

**A log reader must not sit behind the switch whose position you are trying to diagnose.** During the
live 421 incident (`audio-feed-du8w`) the deployment refused every request because its allowed-host
set was empty, and the question "how do I read the error logs for the live deployment?" could not be
answered by this API: the host gate refuses *before any route runs*, so `/api/observability/errors`
answered 421 on the very host that was being diagnosed. The tool for reading the incident was itself
refused by the incident.

So these two endpoints — and only these two — are served even when the host gate is refusing:

| deployment state                                        | `/` , `/listen`, `/admin` | `/api/observability/errors` |
| ------------------------------------------------------- | ------------------------- | --------------------------- |
| host not in the allowed set                             | `421 misdirected_request` | served, if the key is right |
| allowed set empty (no `PUBLIC_BASE_URL`/`ALLOWED_HOSTS`) | `500 server_misconfigured` | served, if the key is right |

Both refusal bodies also name this endpoint, so an operator who meets a refusal is told where the
errors are instead of having to already know.

Why this is not a hole, in the terms of the gate's own threat model:

- **It is still authenticated.** Exemption from the *host* check is not exemption from
  authentication: the shared key remains the only requirement, and it is still required. An exempt
  path without the key is `401`; with no key configured it is `503 observability_not_configured`,
  which names the variable to set — including on a refused host, so the operator is never left
  reading a generic failure.
- **It derives and emits nothing from the request.** The host gate exists so an attacker-chosen
  `Host` never becomes the advertised origin, feed `selfUrl`/enclosure URLs, a redirect or the
  WebAuthn RP ID (`audio-feed-fp4r`/`7lsy`/`4x4t`). These routes answer JSON built from the log
  store: no redirect, no URL, no `Access-Control-Allow-Origin`. The one place a request host reaches
  a response header is the CSP `report-uri`, and that branch is HTML-only. A test asserts the
  attacker's host appears in neither the body nor any response header.
- **It cannot be widened by accident.** Matching is exact against the same normalised pathname the
  router dispatches on, so `/api/observability/errors/extra`, a percent-encoded lookalike or a
  doubled slash is refused by the gate, and a test asserts every exempt path is a route the router
  actually declares.
- **The rest stays gated, deliberately.** The homepage, feeds, listen pages, `/admin` and the admin
  observability *page* are all still behind the gate. Only the two JSON endpoints an operator can
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
    "severity": "error",
    "type": "synthesis.failed",
    "route": null,
    "job": "synthesis",
    "message": "…",
    "stack": null,
    "correlationId": "epi-1"
  }],
  "hasMore": false,
  "scanned": 1,
  "returned": 1,
  "window": { "oldestRetained": 1, "newest": 42 }
}
```

`id` is the sequence in string form: it is the identity the store guarantees unique and ordered, and
a separate id would be a second identity that could disagree with the cursor.

`/summary` returns `{ cursor, since, total, bySeverity, byType, truncated, scanned, window }`.
`total: 0` is the cheap answer to "has anything happened since my cursor" — one bounded scan instead
of a page of events. It applies the same cursor rules, including the `410` when retention has moved
past the cursor, so a poller cannot be told "nothing new" when it has in fact missed events.

The summary's `cursor` is the last sequence it **SCANNED**, never the last it counted. A scan is
bounded, so a window larger than the bound is examined in part: `truncated: true` says so, `cursor`
names the last sequence the scan **reached**, and the next poll continues from there. Reporting the
newest sequence in the window instead counts part of a window while claiming all of it, so a poller
moves past events it was never told about — a real bug (`audio-feed-8d6r`), and the same rule as the
errors feed's cursor advancing over what was scanned rather than what was returned.

Because that cursor may sit past records the summary's filter excluded, it is a safe way to ask "what
changed?" but not a safe durable cursor: a poller drains the errors endpoint from the cursor it last
consumed and only then moves its own (`audio-feed-2af8`, and the recipe below).

## What a poller does

```
durable = "0"
loop:
  s = GET /api/observability/summary?since=<durable>    # PROBE: is there anything?
  if s.total == 0 and not s.truncated:
      continue                                          # genuinely nothing new
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
them (`audio-feed-36qa`). `/summary` also reports `scanned` — zero examined means genuinely empty, and
a full bound means there is more.

The DURABLE cursor is a different thing, and it moves only after a drain. The recipe above reads
`/errors` from the cursor it last consumed, page by page, and assigns its own cursor only once a page
reports `hasMore: false`; it re-polls the SUMMARY from that same durable cursor each iteration and
never advances the probe cursor on its behalf. Following the recipe literally therefore cannot move
the wrong cursor, and the two rules above are the reason it is written that way.

On `410 cursor_too_old`, the cursor cannot be resumed: re-baseline from `window.oldestRetained - 1`
(accepting the gap, and saying so in whatever consumes the events) or from the current cursor, and
treat the lost interval as unknown rather than as quiet.
