/**
 * Audio playback route — serves episode enclosures.
 *
 * This is the endpoint podcast clients actually hammer, so it is written for
 * their behaviour rather than for a browser's:
 *   - `HEAD` before `GET` (clients probe size and type first).
 *   - `Range` requests for scrubbing and for resuming a partial download.
 *   - `Accept-Ranges: bytes` advertised on every response, or clients assume
 *     the stream is unseekable and disable the scrub bar.
 *   - Redirect to a signed/public URL when the blob store offers one, so audio
 *     bytes never transit the isolate.
 *
 * Owned by: audio-feed-0h8.
 */

import { notFound, problem } from "../http.ts";
import { parseRangeHeader, RangeNotSatisfiableError } from "../storage/mod.ts";
import { redactAudioKey, type RouteContext } from "../router.ts";
import type { AppContext } from "../app.ts";
import { isAudioMode, parseAudioBlobKey } from "../types.ts";
import { getLegacyKeyUniqueOwner, isCanonicalAudioKey } from "../storage/legacy_audio.ts";
import { extractClientIp, SlidingWindowRateLimiter } from "../auth/rate_limit.ts";

/**
 * Rate limit for the unauthenticated audio route (audio-feed-k21s0).
 *
 * The key is a capability, so the route is public by design — but every
 * request costs store reads (the legacy candidate fan-out, then blob
 * operations), and before this limit an unauthenticated caller could spend
 * them at an unbounded rate. 300 per 5 minutes per client is generous for a
 * podcast client (a HEAD probe, a download, and scrubbing Range requests for
 * a few episodes) and bounds what one client address can spend. The window
 * lives in the shared store, so the bound holds across isolates.
 */
export const AUDIO_RATE_LIMIT = { maxRequests: 300, windowMs: 5 * 60 * 1000 } as const;

/**
 * Upper bound on the legacy-fallback candidate lookups ONE request may cause
 * (audio-feed-k21s0).
 *
 * Legitimate names are `<episodeId>[-<revision>]`: episode ids are UUIDs (5
 * hyphen-separated parts) and a revision adds one or two more, so the deepest
 * real lookup is well under 16. The parts are attacker-controlled, though —
 * the 512-character key cap still admits ~160 hyphenated parts, and each one
 * was a metadata read. Longest-first order means a cap keeps every real
 * candidate and drops only attacker depth.
 */
export const MAX_FANOUT_CANDIDATES = 16;

/**
 * Whether this request is one the browser will apply CORS rules to.
 *
 * PRODUCTION BUG, found by Paul on the live deployment. The audio route 302s to
 * an R2 presigned URL, and R2's S3 endpoint sends no `access-control-allow-origin`
 * and answers a preflight with 403 — measured against production:
 *
 *     GET  <r2 presigned>  with Origin: <app>  -> 200, audio/wav, 16111024 bytes,
 *                                                 and NO access-control-allow-origin
 *     OPTIONS <r2 presigned> with Origin: <app> -> 403
 *
 * So the browser receives a perfectly good 200 it is not permitted to read. The
 * player's `<audio crossorigin="anonymous">` forced the media load into CORS
 * mode, and the service worker's `fetch(request)` is a CORS fetch by nature, so
 * both paths blocked.
 *
 * The redirect exists to keep audio bytes out of the isolate (audio-feed-vnb),
 * which is worth keeping for the clients that can use it: a podcast app fetching
 * an enclosure sends no `Origin` and is not subject to CORS at all. So the
 * redirect stays the default and is skipped only for requests that would be
 * blocked by it.
 *
 * `sec-fetch-mode` is checked as well as `Origin` because a same-origin `fetch()`
 * from the page or the service worker may omit `Origin` while still being a CORS
 * -mode request that follows the cross-origin redirect and then fails.
 */
export function isCorsConstrained(req: Request): boolean {
  if (req.headers.get("origin")) return true;
  const mode = req.headers.get("sec-fetch-mode")?.toLowerCase();
  return mode === "cors" || mode === "same-origin";
}

/**
 * Headers that let a browser actually READ the bytes it was sent.
 *
 * `access-control-expose-headers` is not optional here: without it a CORS
 * response hands the page only the safelisted headers, so `content-range` and
 * `content-length` are invisible and a seeking player cannot tell what it got.
 */
function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "accept-ranges, content-length, content-range, etag",
  };
}

/**
 * The owning user of a canonical audio key, or null (audio-feed-ndc).
 *
 * Keys are `audio/<userId>/<mode>/<id>.<ext>` (audio-feed-3hb). Legacy flat
 * keys without user attribution are rejected by isAllowedAudioKey (audio-feed-whsl).
 */
export function userIdFromBlobKey(key: string): string | null {
  const parts = key.split("/");
  if (parts.length >= 4 && parts[0] === "audio") return parts[1] || null;
  if (parts.length === 3 && isAudioMode(parts[1])) return parts[0] || null;
  return null;
}

/** Blob keys are path-shaped; reject anything that tries to escape the prefix. */
export function isSafeBlobKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (key.startsWith("/") || key.includes("//")) return false;
  if (key.includes("\0") || key.includes("\\")) return false;
  return !key.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Restrict keys to canonical audio/ keys (*.wav, *.mp3).
 * Explicitly rejects intermediate synthesis segments (audio-segments/), voice samples
 * (voice-samples/), arbitrary multi-segment prefixes, and non-audio files.
 *
 * Canonical audio keys are either:
 *   - `audio/<userId>/<mode>/<file>` (4 segments, starts with "audio/")
 *   - `<userId>/<mode>/<file>` (3 segments, route-trimmed by /audio/:key+)
 * where <mode> is an AudioMode ("direct" | "deepdive") and <file> is *.wav | *.mp3.
 *
 * Legacy flat keys (parts.length < 3, e.g. "legacy.wav", "audio/ready.wav") are rejected
 * to enforce user attribution and approval gating (audio-feed-whsl).
 *
 * Owned by: audio-feed-5iue, audio-feed-whsl.
 */
export function isAllowedAudioKey(rawKey: string): boolean {
  if (!isSafeBlobKey(rawKey)) return false;

  // Must end in .wav or .mp3
  if (!/\.(wav|mp3)$/i.test(rawKey)) {
    return false;
  }

  const lower = rawKey.toLowerCase();

  // Explicitly reject forbidden prefixes anywhere in the key
  if (
    lower.startsWith("audio-segments/") ||
    lower.includes("/audio-segments/") ||
    lower.startsWith("voice-samples/") ||
    lower.includes("/voice-samples/") ||
    lower.startsWith("internal-cache/") ||
    lower.includes("/internal-cache/") ||
    lower.startsWith("tts-secrets/") ||
    lower.includes("/tts-secrets/")
  ) {
    return false;
  }

  const parts = rawKey.split("/");

  // 1. Route-trimmed canonical key: <userId>/<mode>/<file>
  // Mode must be a valid AudioMode ("direct" | "deepdive")
  if (parts.length === 3) {
    const [userId, mode] = parts;
    return Boolean(userId) && isAudioMode(mode);
  }

  // 2. Canonical key: audio/<userId>/<mode>/<file>
  // Must start with "audio" and mode must be a valid AudioMode
  if (parts.length === 4) {
    const [prefix, userId, mode] = parts;
    return prefix === "audio" && Boolean(userId) && isAudioMode(mode);
  }

  // Legacy flat keys (parts.length < 3) and over-nested keys (parts.length > 4) are rejected.
  return false;
}

/**
 * Check user approval on the key that actually resolved; fails closed if user missing or not approved.
 *
 * The refusal is a 404 with the SAME body as a nonexistent object
 * (audio-feed-7kdhb): a 403 here would tell an unauthenticated caller that
 * the blob EXISTS but its owner is missing or unapproved — an existence
 * oracle independent of authorization. The real reason is logged internally
 * and never disclosed to the caller.
 */
async function checkUserApproval(
  ctx: RouteContext<AppContext>["ctx"],
  resolvedKey: string,
  canonicalUserId?: string | null,
): Promise<Response | null> {
  const userId = canonicalUserId ?? userIdFromBlobKey(resolvedKey);
  if (!userId) {
    console.warn(
      `[audio-feed] audio 404 (unauthorized): no owning user on key "${
        redactAudioKey(resolvedKey)
      }"`,
    );
    return notFound("Unknown audio object");
  }
  const user = await ctx.stores.metadata.getUser(userId);
  if (!user || user.status !== "approved") {
    const status = user?.status ?? "unknown";
    console.warn(
      `[audio-feed] audio 404 (unauthorized): user "${userId}" is ${status} for key "${
        redactAudioKey(resolvedKey)
      }"`,
    );
    return notFound("Unknown audio object");
  }
  return null;
}

export async function handleAudio(
  { req, params, ctx, remoteAddr }: RouteContext<AppContext>,
): Promise<Response> {
  // Rate-limit before ANY store work (audio-feed-k21s0): the route is
  // unauthenticated by design, so the rate of requests is the only bound on
  // what a caller can spend. Checked first so that garbage keys count too —
  // a limit that only applied to well-formed keys would leave probing free.
  const limiter = new SlidingWindowRateLimiter(
    AUDIO_RATE_LIMIT,
    ctx.stores.metadata,
    "audio",
  );
  const clientKey = extractClientIp(req, Boolean(ctx.config.trustProxyHeaders), remoteAddr);
  const limit = await limiter.check(clientKey);
  if (!limit.allowed) {
    const refused = problem({
      status: 429,
      title: "too_many_requests",
      detail: "Too many audio requests from this client; retry later.",
    });
    refused.headers.set("retry-after", String(Math.max(1, Math.ceil(limit.resetMs / 1000))));
    return refused;
  }

  const rawKey = params.key;
  if (!rawKey || !isAllowedAudioKey(rawKey)) {
    // audio-feed-0eae, audio-feed-f9wf: the key is a capability — and attacker-controlled
    // text. It is never logged in cleartext.
    console.warn(
      `[audio-feed] audio 404: disallowed or unsafe key "${redactAudioKey(rawKey)}"`,
    );
    return notFound("Unknown audio object");
  }

  const isHead = req.method === "HEAD";

  // For keys not starting with "audio/", the canonical shape in storage is
  // audio/${rawKey}.
  const canonicalKey = rawKey.startsWith("audio/") ? rawKey : `audio/${rawKey}`;
  const candidateKeys = [canonicalKey];
  const canonicalUserId = userIdFromBlobKey(canonicalKey);

  // Legacy blob fallback (audio-feed-rscz, audio-feed-7y8f, audio-feed-ni04):
  // When a canonical request arrives, if the canonical blob might be absent,
  // check whether the owning user has an episode stored with a legacy flat audioKey,
  // and append those legacy storage candidates to the candidate list.
  // The canonical candidate is always checked first (preferring canonical if both exist).
  if (canonicalUserId) {
    const parsed = parseAudioBlobKey(canonicalKey);
    if (parsed) {
      // Capped (audio-feed-k21s0): the parts of the requested name are
      // attacker-controlled, and each candidate is a metadata read.
      for (const candidateId of parsed.candidateIds.slice(0, MAX_FANOUT_CANDIDATES)) {
        try {
          const ep = await ctx.stores.metadata.getEpisode(parsed.userId, candidateId);
          if (ep) {
            if (ep.audioKey && !isCanonicalAudioKey(ep.audioKey, ep)) {
              // Verify global uniqueness before adding to candidates to prevent cross-tenant disclosure (audio-feed-65lf, audio-feed-ni04)
              const uniqueOwner = await getLegacyKeyUniqueOwner(
                ctx.stores.metadata,
                ep.audioKey,
              );
              if (uniqueOwner === canonicalUserId) {
                const legacy = ep.audioKey;
                const legacyCandidates = legacy.startsWith("audio/")
                  ? [legacy, legacy.slice(6)]
                  : [`audio/${legacy}`, legacy];
                for (const cand of legacyCandidates) {
                  if (isSafeBlobKey(cand) && !candidateKeys.includes(cand)) {
                    candidateKeys.push(cand);
                  }
                }
              } else {
                console.warn(
                  `[audio-feed] audio fallback refused: legacy key "${
                    redactAudioKey(ep.audioKey)
                  }" is ambiguous or unowned`,
                );
              }
            }
            break;
          }
        } catch {
          // Metadata read failure falls through to canonical-only
        }
      }
    }
  }

  if (isHead) {
    let resolvedKey: string | null = null;
    let info = null;
    for (const key of candidateKeys) {
      info = await ctx.stores.blobs.head(key);
      if (info) {
        resolvedKey = key;
        break;
      }
    }
    if (!info || !resolvedKey) {
      console.warn(
        `[audio-feed] audio HEAD 404: key "${redactAudioKey(rawKey)}" not found`,
      );
      return notFound("Unknown audio object");
    }

    const refusal = await checkUserApproval(ctx, resolvedKey, canonicalUserId);
    if (refusal) return refusal;

    return headResponse(info.size, {
      "content-type": info.contentType,
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      ...corsHeaders(),
      ...(info.etag ? { etag: info.etag } : {}),
    });
  }

  // A store-provided URL means the client can fetch bytes directly without transiting the isolate (audio-feed-vnb).
  //
  // Nothing here may assume url() answers the same way for EVERY key. That was the
  // audio-feed-gxn bug: a store that offers direct URLs for one prefix only (a CDN
  // mapped over "audio/", say) made the first candidate look like a redirecting
  // store, and when its head() missed the handler returned 404 for an object that
  // existed and that HEAD could see. The interface never promised per-key
  // consistency, so the handler must not depend on it.
  // …but a redirect the browser cannot follow is worse than no redirect. A
  // CORS-constrained request is served from the isolate instead, because the
  // object store the redirect points at does not answer CORS.
  if (!isHead && !isCorsConstrained(req)) {
    // Whether the store offered a direct URL for EVERY candidate, which is what
    // distinguishes a uniformly-redirecting store from a per-key one.
    let everyKeyHasDirectUrl = true;
    for (const key of candidateKeys) {
      const direct = await ctx.stores.blobs.url(key);
      if (!direct) {
        // `continue`, not `break`: a key with no direct URL says nothing about the
        // next candidate on a store that answers per key (audio-feed-gxn).
        everyKeyHasDirectUrl = false;
        continue;
      }
      const info = await ctx.stores.blobs.head(key);
      if (info) {
        const refusal = await checkUserApproval(ctx, key, canonicalUserId);
        if (refusal) return refusal;

        // Counted when the redirect is ISSUED, not when the client finishes —
        // on a redirecting store the bytes never reach us, so this is the last
        // point at which anything is observable. The dashboard says
        // "downloads / redirects" rather than implying a completed download
        // (audio-feed-ndc).
        if (!req.headers.get("range")) {
          await ctx.stores.metadata.recordDownload(canonicalUserId ?? userIdFromBlobKey(key));
        }
        return new Response(null, { status: 302, headers: { location: direct } });
      }
    }
    // Short-circuit a miss ONLY when the store offered a direct URL for every
    // candidate: that is the uniform case (S3 answers for any key), where get()
    // would be a wasted round trip for a definitive 404, and audio-feed-vlw pins
    // that behaviour with `getCalls === 0`.
    //
    // If any candidate had NO direct URL the store answers per key, so nothing here
    // can conclude that a missing object is missing — a CDN mapped over one prefix
    // would 404 objects that exist (audio-feed-gxn). Existence is then decided by
    // the get() loop below, which costs one get() on a genuine miss.
    if (everyKeyHasDirectUrl) {
      console.warn(
        `[audio-feed] audio direct-url 404: key "${redactAudioKey(rawKey)}" not found`,
      );
      return notFound("Unknown audio object");
    }
  }

  // GET: skip head() calls entirely to avoid extra store round trips (audio-feed-1rx).
  const range = parseRangeHeader(req.headers.get("range"));

  let resolvedKey: string | null = null;
  let object = null;

  for (const key of candidateKeys) {
    try {
      object = await ctx.stores.blobs.get(key, range ? { range } : undefined);
    } catch (error) {
      if (error instanceof RangeNotSatisfiableError) {
        const refusal = await checkUserApproval(ctx, key, canonicalUserId);
        if (refusal) return refusal;
        return new Response(null, {
          status: 416,
          headers: {
            "content-range": `bytes */${error.size}`,
            "accept-ranges": "bytes",
          },
        });
      }
      throw error;
    }
    if (object) {
      resolvedKey = key;
      break;
    }
  }

  if (!object || !resolvedKey) {
    console.warn(
      `[audio-feed] audio GET 404: key "${redactAudioKey(rawKey)}" not found in storage`,
    );
    return notFound("Unknown audio object");
  }

  const refusal = await checkUserApproval(ctx, resolvedKey, canonicalUserId);
  if (refusal) {
    await object.body.cancel?.();
    return refusal;
  }

  const headers = new Headers({
    "content-type": object.contentType,
    "accept-ranges": "bytes",
    // Episode ids are unguessable and audio is immutable once written.
    "cache-control": "public, max-age=31536000, immutable",
    // Unconditional: these bytes are already reachable by anyone holding the
    // key, so the header grants nothing new, and setting it only for requests
    // that carried an `Origin` would make the response vary by request in a way
    // a shared cache must then be told about.
    ...corsHeaders(),
  });
  if (object.etag) headers.set("etag", object.etag);

  if (object.range) {
    const { start, end, total } = object.range;
    headers.set("content-range", `bytes ${start}-${end}/${total}`);
    headers.set("content-length", String(end - start + 1));
    // Deliberately NOT counted. A podcast client resuming a download issues
    // several Range requests for one episode, and HEAD-then-GET is its normal
    // probe, so counting either inflates the figure two- to threefold
    // (audio-feed-ndc). One whole-object GET is the closest thing to "a
    // listener fetched this episode" that this layer can observe.
    return new Response(object.body, { status: 206, headers });
  }

  await ctx.stores.metadata.recordDownload(canonicalUserId ?? userIdFromBlobKey(resolvedKey));

  headers.set("content-length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/**
 * A `HEAD` response that reports the real object size.
 *
 * `new Response(null, { headers: { "content-length": "1000" } })` does NOT work:
 * `Deno.serve` overwrites the header with `0` when the body is `null`, so the
 * client is told the episode is zero bytes. Podcast clients probe with `HEAD`
 * before downloading, and a zero length there means "nothing to play".
 *
 * An empty stream keeps the explicit header intact while sending no bytes —
 * which is what `HEAD` requires. Verified over a real socket; an in-process
 * `fetch(new Request(...))` test cannot see this, because the override happens
 * during HTTP serialization.
 *
 * ONLY valid for `HEAD`. On a `GET` this shape declares a length it never
 * sends, and the connection errors mid-read.
 */
export function headResponse(size: number, headers: Record<string, string>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    { status: 200, headers: { ...headers, "content-length": String(size) } },
  );
}

/** Shared by lanes that need a "not wired yet" route without inventing a shape. */
export function notImplemented(feature: string): Response {
  return problem({
    status: 501,
    title: "not_implemented",
    detail: `${feature} is not wired in this deployment`,
  });
}
