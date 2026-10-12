# audio-feed-b75q — the episodes cases were moved, not rewritten

- Capture: no assertions
- Reason: Static case-manifest comparison and historical test-run capture from splitting tests/conformance/metadata/episodes.ts into three modules. No generating script writes to this directory; ongoing test assertions execute in tests/storage_test.ts.

`tests/conformance/metadata/episodes.ts` held 44 of the suite's 102 cases in 929 lines. It is now
three modules by concern — `episodes-queue.ts` (19: the record, cursor paging, the pending index),
`episodes-claims.ts` (14: claims, leases, completion), `episodes-regeneration.ts` (11) — and the
runner registers all three. No other module changed.

Same two-directional proof as audio-feed-fydf, over the whole suite rather than the moved file:

| file                  | what it is                                                                      |
| --------------------- | ------------------------------------------------------------------------------- |
| `manifest-before.txt` | all 102 cases as written before the split, one per line, with per-module counts |
| `manifest-after.txt`  | the same 102 after, showing `episodes.ts` replaced by the three modules         |
| `runtime-before.txt`  | every `KvMetadataStore:`/`MemoryMetadataStore:` test that ran, with status      |
| `runtime-after.txt`   | the same, after the split                                                       |
| `runtime.diff`        | their difference — **empty**                                                    |
| `cases-verbatim.txt`  | the 44 episode case bodies, each one matched verbatim in a new module           |

1. **Static:** the case-label multiset is identical, 102 before and 102 after, and the 44 episode
   cases are 19 + 14 + 11. A case deleted, dropped or reworded while moving cannot pass this.
2. **Runtime:** the sorted list of test names _and_ their pass/fail status is byte-identical across
   a real `deno test tests/storage_test.ts` run — a 0-line diff over 215 lines. This is the half
   that catches a module that no longer gets registered, which no static check can see.
3. **Verbatim:** 44 of 44 episode case bodies appear unchanged (whitespace-normalised), so no
   assertion was touched.

Unlike audio-feed-fydf there was no scope hazard here: the suite-scoped fixtures (`run`,
`drainPages`, `CLAIM`, `queued`, `published`, `FUTURE`) had already moved to
`tests/conformance/metadata/harness.ts`, and `episodes.ts` declared nothing at suite scope beyond
`const { test } = suite`. Reproduce either side with:

```sh
grep -hoE 'test\(".*?",' tests/conformance/metadata/episodes*.ts | wc -l   # 44
deno test --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/storage_test.ts
```
