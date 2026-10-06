# audio-feed-o9kc — premise verdict: insertUser IS atomic on both stores

**Claim under test** (from the audio-feed-xw7 review): "email uniqueness is a
check-then-create, not guaranteed atomic in the store layer — two concurrent
requests for the same fresh email could both pass the existence check;
storage/memory.ts putUser has no uniqueness guard; storage/kv.ts putUser lets
the second write win the email index, orphaning the first user."

**Verdict: premise disproved.** `insertUser` is genuinely atomic on both
stores; the route-level `getUserByEmail` (bootstrap's friendly 409) is an
advisory pre-check, not the guard. No production change needed — this
directory records the evidence.

## Why each store is atomic

**KV** (`src/storage/kv.ts` `insertUser`): reads the three keys (`user/<id>`,
`user_by_email/<email>`, `user_by_feed_token/<token>`) with their
versionstamps, then commits
`kv.atomic().check(each entry).set(...).set(...).set(...).commit()` — the
canonical Deno KV uniqueness pattern (optimistic CAS). Two concurrent inserts
for one fresh email both read "absent"; the engine serializes the commits;
the loser's `.check()` on the email key fails (versionstamp no longer null),
`commit()` returns `{ ok: false }`, and `insertUser` resolves `false` —
which `createUser` (src/auth/users.ts:107) maps to `Email already
registered`. Exactly one user row, one email pointer, one token pointer ever
exist.

**Memory** (`src/storage/memory.ts` `insertUser`): the duplicate scan and the
`Map.set` are synchronous with no `await` between them, so no two calls can
interleave at that boundary in single-threaded JS. (Uniqueness guards for id,
email and feed token are all in the scan.)

**putUser "orphan"** (`src/storage/kv.ts` `putUser` writes the email index
unconditionally): unreachable — every `putUser` caller spreads `...user` and
never changes `email` (`updateUser`: displayName/voice/feeds;
`rotateFeedToken`: feedToken; `decide`/approve/reject: status fields), so the
unconditional write always targets the user's own existing index key. Feed
token rotation generates a fresh token; collision with another user's token
is a random-token collision, not this claim.

## The guard is already tested — and proven live

`tests/conformance/metadata.ts` "concurrent inserts of one email produce
exactly one winner" fires 3 concurrent `insertUser` calls for one fresh email
against BOTH real adapters (`MemoryMetadataStore` and `KvMetadataStore` on
`Deno.openKv(":memory:")`) and asserts exactly one winner and one persisted
user. It runs in every full gate (most recently 993 passed / 0 failed on
f89d372).

**Positive controls** (run 2026-10-06, sabotage reverted immediately —
`git checkout --` verified clean):

1. KV checks removed (`kv.atomic()` without `.check()`s — exactly the claimed
   non-atomic behavior):

   ```
   KvMetadataStore: concurrent inserts of one email produce exactly one winner ... FAILED
   AssertionError: Values are not equal: exactly one insert may win
   ```

2. Memory `insertUser` given one `await` between scan and set (the claimed
   check-then-create interleaving point):

   ```
   MemoryMetadataStore: concurrent inserts of one email produce exactly one winner ... FAILED
   AssertionError: Values are not equal: exactly one insert may win
   ```

Both controls fail the existing test; the real implementations pass. The
concurrency guard is live, not vacuous.

## Worst reachable case in the race

Two concurrent bootstraps for one fresh email: one creates the account (200),
the loser's `createUser` throws `Email already registered` and the route
answers 500 rather than 409 — a cosmetic wart behind a valid-ADMIN_TOKEN
requirement, never a duplicate account, never promotion/reinstatement of an
existing one. Out of scope for this bead's acceptance (uniqueness), noted
here so the next reader does not re-derive it.
