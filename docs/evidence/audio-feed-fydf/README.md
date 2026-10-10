# audio-feed-fydf — the conformance split did not lose a case

`tests/conformance/metadata.ts` was one 2,108-line file holding 102 cases for both adapters. The
split puts them in one module per domain (`tests/conformance/metadata/`) behind a shared harness.

The risk in that move is not a compile error — it is a case that stops being _registered_, which
resembles a passing suite. So the move is proved twice, from both directions:

| file                  | what it is                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `manifest-before.txt` | the 102 cases as written in the original file, in source order                                           |
| `manifest-after.txt`  | the same 102 cases after the split, grouped by domain                                                    |
| `runtime-before.txt`  | every `KvMetadataStore:`/`MemoryMetadataStore:` test that actually ran before the split, with its status |
| `runtime-after.txt`   | the same, after the split                                                                                |
| `runtime.diff`        | their difference — **empty**                                                                             |

What the two proofs say together:

1. **Static (nothing was dropped):** the multiset of case labels is identical, 102 before and 102
   after, with no duplicates introduced. A case that was deleted, commented out, or reworded while
   moving cannot pass this.
2. **Runtime (nothing stopped running):** the sorted list of test names _and_ their pass/fail status
   is byte-identical across an actual `deno test tests/storage_test.ts` run — a 0-line diff over 215
   lines. A case that was moved but never registered would be missing from the after-run; that is
   the failure mode static extraction alone cannot see.

Reproduce either side with:

```sh
# static
git show HEAD:tests/conformance/metadata.ts | grep -oE 'test\(".*?",' | wc -l   # 102 (before)
grep -hoE 'test\(".*?",' tests/conformance/metadata/*.ts | wc -l                # 102 (after)

# runtime (empty diff is the pass)
deno test --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/storage_test.ts
```

## The one thing that is not a pure move

The cases were not edited — not a single assertion, label or comment inside a case body changed.
What did change is _scope_: six fixtures were declared inside the suite function body, in one
section, and used by cases in another. `run` was declared among the statistics cases and used by the
outbox cases; `drainPages` was declared in the paging section and used by the claim cases; `CLAIM`,
`queued`, `published` and `FUTURE` had the same shape. Concentrating each section into its own
module takes that shared scope apart, so they now live in `tests/conformance/metadata/harness.ts`,
named exactly as they were. Keeping the names is deliberate: it is why no case body had to be
touched, and the diff of a case body is the one thing a reviewer cannot check mechanically.

Two smaller structural notes, both visible in the diff:

- `metadata.ts` is now the entry point the adapters are wired through (`runMetadataConformance`),
  and it is only a list of registrars. A domain module that is not listed registers nothing — the
  pair of manifests above is what catches that.
- the harness is the only place that calls `Deno.test`, so the "fresh store per case, closed
  afterwards" guarantee cannot drift per domain.
