# audio-feed-b6nr — the capability is not readable from browser storage

- Script: scripts/repro_b6nr_token_storage.ts
- Asserts: no key or value in localStorage contains feed token; legacy token-named keys removed; saved position adopted under subscriber ID; cold home-screen launch reaches player with empty storage

## The claim under test

`GET /listen/:token` resolves the subscriber *by* the token (`resolveTokenValue` →
`getUserByFeedToken`), so the feed token is a bearer credential for one subscriber's feed and audio,
not an identifier. The player used to write it into `localStorage` and then embed it in four more
keys (`audio-feed-positions:<token>`, `-played:`, `-dismissed:`, `-filter:`). A key name is as
readable as a value, so that was five places to find the credential in a browser profile — reachable
by an XSS, an extension, or anyone using a shared device.

The unit tests can check what the source says and the type checker can check the contract, but the
claim is about what a browser holds after a subscriber uses the player. That only exists at runtime,
so `scripts/repro_b6nr_token_storage.ts` drives real Chrome over CDP against the real app.

## What was measured

The script pre-seeds storage in the shape the old client wrote it (as a device that used the player
before this change would have), loads `/listen/<token>`, then reads **every key and value** out of
`localStorage`.

| | before | after |
| --- | --- | --- |
| keys or values naming the token | `audio-feed-token` | **none** |
| legacy token-named keys after the visit | present | adopted and removed |
| saved position | under `audio-feed-positions:<token>` | under `audio-feed-positions:<subscriber id>` |
| cold home-screen launch, storage cleared | — | lands on `/listen/<token>` |

`before.json` is the tree *without* the fix and **nothing pre-seeded**, so the entry it finds can only
have been written by the client itself. (`legacyKeysRemoved: true` in that file is vacuous — nothing
existed to remove. It is meaningful only in `repro.json`, where the pre-seeded legacy keys were
adopted and deleted.) `repro.json` is the fixed tree with the pre-seed in place, which is what
exercises the migration.

The four assertions the script fails on, rather than merely reporting:
no key or value contains the token; no token-named key survives the visit; the saved position is
adopted under the subscriber's key; and the player still reaches the player page from a cold
home-screen launch with storage emptied — the last one being the feature the persistence existed for.

```bash
deno run -A scripts/repro_b6nr_token_storage.ts              # expect no leak
deno run -A scripts/repro_b6nr_token_storage.ts --expect-leak # the pre-fix tree
```

## The gap this proof found (and the unit tests could not)

Removing the writer was not enough. On a device that had used an earlier version, the
`audio-feed-token` entry was still there: a writer that no longer runs cannot clean up after itself,
and every source-level assertion still passed while the credential sat in the profile. The proof
caught it on its first run (`FAIL: the token is still readable in 1 storage key(s)`), and the client
now removes that entry as well — which is why the "legacy keys after the visit" row above is an
assertion and not just a description. This is the argument for driving the real artifact: the tests
that existed checked spelling, and the thing that mattered was which bytes a browser was left with.

## What is deliberately unchanged

- The capability is still in the **URL path** of the player (`/listen/<token>`), because that is the
  product: a podcast feed URL is a capability, and it is what makes the player work without an
  account. This change is about *persistence*.
- `x-forwarded-host` handling in `src/origin.ts` is untouched (unrelated).
- A subscriber with no session who only ever visits the landing page keeps whatever a previous
  version stored until they next open the player, which is where the cleanup runs.
