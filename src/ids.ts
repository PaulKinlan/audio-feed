/**
 * Identifier minting.
 *
 * SECURITY INVARIANT — read before changing any of these.
 *
 * Podcast clients (Apple Podcasts, Pocket Casts, Overcast) cannot authenticate.
 * They fetch feed XML and enclosure audio with a bare GET and no credentials.
 * That means the URL *is* the credential: anything reachable at a guessable
 * path is effectively public.
 *
 * So two id classes must be unguessable, not merely unique:
 *   - `feedToken`  — the per-user capability in a feed URL.
 *   - `Episode.id` — appears in the audio blob key, which is the enclosure URL.
 *
 * Sequential, timestamp-derived, or content-derived ids for either of these
 * turns "private feed" into "public archive with a long path". Use these
 * helpers; do not hand-roll ids from counters or `Date.now()`.
 *
 * Owned by: audio-feed-0h8.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Unguessable, URL-safe token. 26 chars of base36 ≈ 134 bits. */
export function randomToken(length = 26): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // Modulo bias across 36 symbols from 256 values is ~0.3% — irrelevant at
    // this length, and worth the simplicity over rejection sampling.
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/** Per-user feed capability. Rotating it revokes every subscribed client. */
export function newFeedToken(): string {
  return randomToken(32);
}

/** Episode id. Unguessable because it lands in a public enclosure URL. */
export function newEpisodeId(): string {
  return crypto.randomUUID();
}

export function newUserId(): string {
  return crypto.randomUUID();
}

export function newArticleId(): string {
  return crypto.randomUUID();
}

/**
 * Constant-time string comparison for secret material (feed tokens, admin
 * tokens). `===` on secrets leaks length and prefix through timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Compare a fixed number of bytes so the loop length does not depend on the
  // secret; a length mismatch still fails, just without an early return.
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
