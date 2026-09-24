# audio-feed-att — paging the uncapped episode scans

## What changed

`DELETE /api/admin/users/:id/sources/:sourceId` made four `listEpisodes` calls with
`limit: Number.POSITIVE_INFINITY` — three to count rows on the incomplete path, one to
backfill `sourceTitle` across retained episodes. Each materialised every matching
`Episode` into a single array.

Added `MetadataStore.listEpisodePage(query & { cursor }) → { episodes, cursor? }`, and the
handler now walks the scan in batches of 100, counting as it goes and discarding each
batch. `listEpisodes` is now a one-page delegation to `listEpisodePage`, so there is one
filter/order implementation rather than two.

A cap was **not** reinstated: audio-feed-c9q established that rows past a cap are silently
skipped and then orphaned unrecoverably.

## Measured

`deno run --allow-env --allow-read --allow-write --unstable-kv docs/evidence/att-paging/measure.ts`
against the real `KvMetadataStore` (`:memory:`), 2,000 user episodes of which one source owns 1,500:

| | calls | rows covered | peak resident | scan ms |
| --- | --- | --- | --- | --- |
| before (`limit: Infinity`) | 1 | 1500 | 489,061 B | 65 |
| after (batch 100) | 21 | 1500 | 32,901 B | 48 |

`coverageIdentical: true` — the paged scan counts exactly what the uncapped call returned.
Peak working set is now constant in the catalogue size instead of linear; at the bead's
50k-episode extrapolation this is ~16 MB → ~33 KB per call.

## The bug this found on the way, and the mutation evidence

The first cursor implementation resumed on an **array index**. The retained-episode scan
mutates as it walks (backfill), and a delete behind an index cursor shifts the array — so a
later episode would have been **skipped**, which is the c9q failure class this change exists
to remove. `audio-feed-hvn`'s test caught the shape by failing outright; the cursor is now
anchored on the last returned episode's position in the total order, so deletions behind it
cannot shift the resume point.

A second defect shipped and was caught the same way: the anchor comparison was inverted, so
every page resumed from the start. The compose-side no-progress guard turned what would have
been an infinite loop into a wrong count (200 instead of 1200), and `c9q` went red.

Mutations run against the final tree, each with the exact result:

| mutation | result |
| --- | --- |
| anchor comparison inverted (`< 0` → `> 0`) | FAILED \| 132 passed \| 5 failed — c9q, att handler test, and all three new conformance cases |
| scan stops after the first batch | FAILED \| 135 passed \| 2 failed — c9q, att handler test |
| 1000-row cap reinstated in the scan | FAILED \| 18 passed \| 2 failed — c9q, att handler test |
| `countEpisodeScan` returns a constant | FAILED \| 18 passed \| 2 failed |
| drop `failedBlobKeys.delete` (opus's 37p direction) | FAILED \| 19 passed \| 1 failed — 37p only |
| drop `failedBlobKeys.add` (opus's 6pn direction) | FAILED \| 19 passed \| 1 failed — 6pn only |

Both of opus's counter directions were re-run against the rewritten code as requested, and
each is still caught by exactly one test, a different one. Restored tree re-verified green
(137/137) with no `MUTANT` string left in `src/` or `tests/`.

## Cursor semantics, and what is still true

Cursors are opaque and adapter-defined. Both adapters address a **position in the index
scan**, so a paged scan is not a stable snapshot: an episode written or deleted mid-scan may
or may not appear. Callers here are safe because backfill is idempotent and counts are
best-effort diagnostics on an already-failed path. `listPendingEpisodes` still uses a plain
index cursor in the memory adapter — that is audio-feed-7li's scope, not changed here.

## Not verified

Deno Deploy. The `kv.list({ cursor })` path is exercised locally against
`KvMetadataStore.open(":memory:")` only.
