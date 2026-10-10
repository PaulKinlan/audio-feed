# 0001. Split `MetadataStore` into domain repositories

- **Status:** Accepted. Phase 1 implemented in `audio-feed-d9sl`; Phases 2-3 are tracked beads.
- **Date:** 2026-10-10
- **Decision bead:** `audio-feed-f96o` (this record) · **Phase 1:** `audio-feed-d9sl` · **Phases
  2-3:** `audio-feed-8r1e`, `audio-feed-fydf`

## Context

`MetadataStore` is one interface in `src/storage/mod.ts` covering every entity the product has: 62
methods across users, sources, articles, episodes, synthesis segments, orphaned blobs, usage
counters, the notification outbox, run history and auth. Two adapters implement it in full
(`src/storage/kv.ts`, 1,630 lines; `src/storage/memory.ts`, 1,025 lines), and one conformance suite
pins their behaviour (`tests/conformance/metadata.ts`, 2,010 lines / 81KB). 71 files reach for
`stores.metadata`.

Those three files are the repository's top collision hotspots: kv.ts 30 changes in 30 days,
memory.ts 29, the conformance suite 26. The conflicts are not about shared logic — they are two
lanes editing _different entities_ in the same file. A lane adding an auth field and a lane adding
an episode transition both touch kv.ts, memory.ts and the same conformance file, so every pair pays
a rebase and a re-review for no shared reason. The conformance suite has grown past the size where a
reviewer can see what a change affects, and the interface hands every caller all 62 methods, so
nothing in the type system says which entity a module is actually about.

## Decision

Split along entity boundaries, in three phases, because the mechanical work is 1-2 lane-days and a
single-pass split of 3,600 lines of storage implementation plus an 81KB conformance suite is not
reviewable.

**Phase 1 (this change, `audio-feed-d9sl`) — type-level only.** Body moved into a dedicated change
confined to types:

- `src/storage/mod.ts` declares ten domain interfaces — `UserRepository`, `SourceRepository`,
  `ArticleRepository`, `EpisodeRepository`, `SynthesisSegmentRepository`, `OrphanBlobRepository`,
  `UsageRepository`, `NotificationRepository`, `RunRepository`, `AuthRepository` — each carrying
  exactly the methods that already existed, with their signatures, order and doc comments intact.
- `MetadataStore` **composes** those interfaces and keeps only the two members that belong to no
  entity (`atomicUpdate`, `close`). Because composition preserves membership, every existing caller
  — `stores.metadata.getEpisode(…)`, `MetadataStore["putEpisode"]` — compiles and behaves
  identically. No call site changes.
- `MetadataRepositories` + `metadataRepositories(store)` expose the ten domains as named views, and
  both adapters provide `store.repositories`. In Phase 1 each view _is_ the store, narrowed by type.
  That is deliberate and documented in the code: the value is that a lane can depend on one domain
  (and migrate its call sites one domain at a time) before the implementation split lands.
- `tests/storage_repositories_test.ts` makes the grouping self-checking at compile time: a method
  that belongs to no domain, a domain method the store does not have, or a method reachable from two
  domains each fail `deno check`, naming the offending methods.

**Phase 2 (`audio-feed-8r1e`)** — extract each domain's implementation into its own module and
reduce `kv.ts`/`memory.ts` to their shared infrastructure.

**Phase 3 (`audio-feed-fydf`)** — split `tests/conformance/metadata.ts` along the same boundaries,
so a lane's test change and its interface change are reviewable together.

## Consequences

**Bought.** An entity now has an interface to own, so a lane touches one domain's declarations
instead of a 62-method block. The compile-time check makes the grouping impossible to rot silently.
New code can take the narrow interface it needs (`EpisodeRepository`) instead of the whole store, so
"A module about episodes that also calls the auth store" becomes visible at the import. The
conformance split (Phase 3) is what actually defuses the test-file hotspot; Phase 1 only makes the
boundary explicit enough to split it.

**Cost, and the constraint Phase 2 must respect.** Entity boundaries are _not_ transaction
boundaries. `insertArticleWithEpisodeIfAbsent` and `putArticleWithEpisode` write an Article and an
Episode in one atomic commit (audio-feed-2th), sharing the `#writeEpisode(tx, …)` helper with
`putEpisode`; a scan of kv.ts finds 25 of its 66 methods touching more than one key prefix, most of
them an entity plus its own indexes. So Phase 2 cannot be a uniform "one class per repository" cut:
the cross-entity atomic paths must stay with a coordinator (or share an explicit transaction
context), or the pair-write guarantee is silently lost — a subscriber would see an article with no
episode. Phase 1 chose types precisely because that constraint needs a design, not a script.

**Not bought, and not to be implied.** Until Phase 2, the implementations still live in the same two
files: a defect or a merge conflict in `AuthRepository`'s _implementation_ is still a conflict in
kv.ts. The facade isolates _callers_, not code.

**Neutral.** `MetadataStore` keeps all 62 members, so the 71 call sites are untouched and the
conformance suite still passes unchanged — that is the property that made Phase 1 safe to land on
its own.

## Alternatives considered

1. **Do nothing.** Rejected: the collision rate is measured, not hypothetical, and it grows with the
   entity count.
2. **Split everything in one pass** (implementation + tests + call sites). Rejected: an unreviewable
   diff and a long-lived branch across the repo's busiest files, which maximises exactly the merge
   conflicts the change exists to remove. Three phases keep each diff reviewable and landable on its
   own.
3. **Extract domain classes now, keep the God interface as a delegator.** Rejected: it moves the
   1,630-line file problem without removing it (the delegator still has 62 methods), and it forces
   the cross-entity atomicity question — the hard part — into the first, largest step.
4. **Split by storage backend (KV vs memory) instead of by entity.** Rejected: it does not reduce
   entity-level collisions at all; both adapters would still hold every entity.

## Verification (Phase 1)

- Signature set is unchanged: extracting every declaration from `MetadataStore` on `main` and from
  the composed interfaces + store afterwards gives 64 before and 64 after with no additions,
  removals or edits (script and output recorded on `audio-feed-d9sl`).
- The conformance suite runs unchanged against both adapters, plus two new cases per adapter that
  pin the facade's identity and the domain list.
- `tests/storage_repositories_test.ts` fails to compile when a method is left uncovered — verified
  by deliberately leaving `atomicUpdate` out of the shared set and observing
  `TS2344: Type '"atomicUpdate"' does not satisfy the constraint 'never'`.

## Phase 2 (audio-feed-8r1e) — implemented

Phase 1 moved types; Phase 2 moved the code. Each adapter keeps a class, the substrate lifecycle and
its shared counter, and forwards every one of the 62 methods to a per-domain object built from a
factory: `src/storage/kv/<domain>.ts` and `src/storage/memory/<domain>.ts`.

What the phase actually decided, beyond "move the bodies":

1. **There is one shared context per adapter, and it is small on purpose.** `src/storage/kv/core.ts`
   holds the KV handle, the key helpers, and the four functions more than one repository needs —
   `writeEpisode`, `writeQueueIndexes`, `pendingKey`, `pendingKeys`. Those four ARE the cross-entity
   path this ADR warned about: `insertArticleWithEpisodeIfAbsent` and `putArticleWithEpisode` write
   an Article and an Episode in one commit (audio-feed-2th) and share the episode index write with
   `putEpisode`. Everything else moved out, so the exception is one file with four functions rather
   than a rule that was quietly ignored. The memory adapter's `state.ts` is the same idea: the
   collections are per store, each owned by one domain, declared together because the pair write has
   to reach the episode indexes from the article path.
2. **A sibling call goes back through the store (`host()`), not straight to the domain object.**
   Forced by evidence, not taste: `MemoryMetadataStore.listPendingEpisodes` used to call
   `this.getEpisode`, and `tests/storage_test.ts` counts exactly those calls by replacing
   `store.getEpisode` to hold audio-feed-2np's "work per page is O(limit)" guarantee. Calling the
   domain object directly made that instrumentation silently miss the call and the test failed —
   which is what a caller, a test double or a debugger wrapping a store method would also see.
3. **A domain object is narrow.** The conformance suite now asserts each domain exposes its own
   methods and _not_ the neighbouring entity's, which Phase 1 could not check at all (every view was
   the store, so every view exposed everything).
4. **`metadataRepositories(store)` is gone.** It existed to hand out the store narrowed by type;
   after Phase 2 the store property is the real facade, and keeping a second one whose members were
   _not_ the same objects would have been misleading.

Still not done, deliberately: `MemoryBlobStore` stays in `memory.ts` (it is a different interface,
not one of the ten domains), the adapters keep `atomicUpdate`, `close`, `open` and the
pending-episode backfill, and the 81KB `tests/conformance/metadata.ts` is still one file per suite
rather than one per entity (audio-feed-fydf).

## Verification (Phase 2)

- **Nothing was retyped.** Every code line of both adapters (845 in `kv.ts`, 510 in `memory.ts`) was
  put through the same receiver rewrites the extraction applies and then looked up in the new tree:
  0 lines unaccounted for, 3 present only because `deno fmt` re-wrapped them (script and output on
  `audio-feed-8r1e`). That is a move, not a rewrite — which is what makes the passing conformance
  suite evidence about the _split_, not about new code.
- Signature set unchanged: 64 method declarations on `main`, 64 now, none added, removed or edited.
- 278 storage and conformance tests pass across both adapters, `deno fmt`/`deno lint`/`deno check`
  clean on the whole repo.
- The compile-time completeness check from Phase 1 still fails the build if a method is left out of
  every domain.
