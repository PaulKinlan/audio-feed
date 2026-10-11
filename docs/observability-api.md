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
   skips: an event that cannot be served has to be reported as lost. A store that has pruned
   everything is reported as empty (`oldestRetained > newest`) rather than "too old", so a cursor
   from before it is still valid and simply returns nothing.
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

`/summary` returns `{ cursor, since, total, bySeverity, byType, window }`. `total: 0` is the cheap
answer to "has anything happened since my cursor" — one bounded scan instead of a page of events. It
applies the same cursor rules, including the `410` when retention has moved past the cursor, so a
poller cannot be told "nothing new" when it has in fact missed events.

## What a poller does

```
cursor = "0"
loop:
  r = GET /api/observability/summary?since=<cursor>     # cheap: total == 0 means nothing to do
  if r.total > 0:
      GET /api/observability/errors?since=<cursor>      # fetch and act
  cursor = r.cursor                                     # never moves backwards
```

On `410 cursor_too_old`, the cursor cannot be resumed: re-baseline from `window.oldestRetained - 1`
(accepting the gap, and saying so in whatever consumes the events) or from the current cursor, and
treat the lost interval as unknown rather than as quiet.
