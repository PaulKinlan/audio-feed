# Post-landing live verification of canonical RSS & listen URLs (audio-feed-ieek)

- Script: scripts/verify_ieek_canonical_urls.ts
- Asserts: RSS feed emits canonical enclosure URL and resolves byte-for-byte matching stored audio payload; already-canonical episode is unaffected by landing emitting unmodified canonical route; RSS feed and listen web player agree character-for-character on canonical URL shape; headless Chrome loads listen page and mounts canonical URL in audio element; listen.js adopts legacy scoped keys to subscriber id scope and removes capability token; historical flat-only episode fails closed with 404 at canonical URL without serving wrong bytes; historical flat-only episode fails closed with 404 at direct flat URL closing capability bypass

## Canonical URL Contract
Canonical URL shape: `/audio/<userId>/<mode>/<filename>.<ext>`
Governed by: `src/feed/adapter.ts` (`canonicalAudioKey`, `enclosureUrl`), `src/types.ts` (`audioBlobKey`), and `src/routes/listen.ts`.

Read in this run: see `docs/evidence/audio-feed-ieek/verification.json` for exact ephemeral values (commit SHA, tree SHA, ephemeral server port, payload hashes, and timing).

## Verification Summary
- Row 1 (RSS & payload bytes): PASS. Enclosure URL resolves 200 with byte-for-byte equality to stored audio.
- Row 2 (Already-canonical episode): PASS. Stored canonical key emits without modification; HEAD and Range 206 resolve.
- Row 3 (RSS and Listen agreement): PASS. Both RSS and /listen surfaces emit the identical canonical route.
- Row 4 (Headless Chrome execution): PASS. Player mounts canonical audio source, verifies `adoptScopedKey`, captures screenshot.
- Historical flat-only episode: PASS. Direction A (canonical URL) and Direction B (direct flat key) both fail closed with 404.

## Screenshots
- `01-listen-canonical-playback.png`: Web player rendering canonical episode with loaded audio element.
