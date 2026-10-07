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

import { forbidden, notFound, problem } from "../http.ts";
import { parseRangeHeader, RangeNotSatisfiableError } from "../storage/mod.ts";
import type { RouteContext } from "../router.ts";
import type { AppContext } from "../app.ts";
import { isAudioMode } from "../types.ts";

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
 * Keys are `audio/<userId>/<mode>/<id>.<ext>` (audio-feed-3hb). A legacy flat
 * key carries no user, so its requests count toward the total only — an
 * unattributed request is better than a wrongly attributed one.
 */
export function userIdFromBlobKey(key: string): string | null {
  const parts = key.split("/");
  if (parts.length < 4 || parts[0] !== "audio") return null;
  return parts[1] || null;
}

/** Blob keys are path-shaped; reject anything that tries to escape the prefix. */
export function isSafeBlobKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (key.startsWith("/") || key.includes("//")) return false;
  if (key.includes("\0") || key.includes("\\")) return false;
  return !key.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Restrict keys to canonical audio/ keys or legacy flat keys (*.wav, *.mp3).
 * Explicitly rejects intermediate synthesis segments (audio-segments/), voice samples
 * (voice-samples/), arbitrary multi-segment prefixes, and non-audio files.
 *
 * Canonical audio keys are either:
 *   - `audio/<userId>/<mode>/<file>` (4 segments, starts with "audio/")
 *   - `<userId>/<mode>/<file>` (3 segments, route-trimmed by /audio/:key+)
 * where <mode> is an AudioMode ("direct" | "deepdive") and <file> is *.wav | *.mp3.
 *
 * Legacy flat keys are single-segment filenames:
 *   - `<file>` or `audio/<file>` where <file> is *.wav | *.mp3.
 *
 * Owned by: audio-feed-5iue.
 */
export function isAllowedAudioKey(rawKey: string): boolean {
  if (!isSafeBlobKey(rawKey)) return false;

  // Must end in .wav or .mp3
  if (!/\.(wav|mp3)$/i.test(rawKey)) {
    return false;
  }

  // Explicitly reject forbidden prefixes anywhere in the key
  if (
    rawKey.startsWith("audio-segments/") ||
    rawKey.includes("/audio-segments/") ||
    rawKey.startsWith("voice-samples/") ||
    rawKey.includes("/voice-samples/") ||
    rawKey.startsWith("internal-cache/") ||
    rawKey.includes("/internal-cache/") ||
    rawKey.startsWith("tts-secrets/") ||
    rawKey.includes("/tts-secrets/")
  ) {
    return false;
  }

  const parts = rawKey.split("/");

  // 1. Legacy flat key: e.g. "legacy.wav", "episode-1.mp3"
  if (parts.length === 1) {
    return true;
  }

  // 2. Legacy key prefixed with audio/: e.g. "audio/ready.wav"
  if (parts.length === 2) {
    return parts[0] === "audio";
  }

  // 3. Route-trimmed canonical key: <userId>/<mode>/<file>
  // Mode must be a valid AudioMode ("direct" | "deepdive")
  if (parts.length === 3) {
    const [userId, mode] = parts;
    return Boolean(userId) && isAudioMode(mode);
  }

  // 4. Canonical key: audio/<userId>/<mode>/<file>
  // Must start with "audio" and mode must be a valid AudioMode
  if (parts.length === 4) {
    const [prefix, userId, mode] = parts;
    return prefix === "audio" && Boolean(userId) && isAudioMode(mode);
  }

  return false;
}

/** Check user approval on the key that actually resolved; fails closed if user missing or not approved. */
async function checkUserApproval(
  ctx: RouteContext<AppContext>["ctx"],
  resolvedKey: string,
): Promise<Response | null> {
  const userId = userIdFromBlobKey(resolvedKey);
  if (!userId) return null;
  const user = await ctx.stores.metadata.getUser(userId);
  if (!user || user.status !== "approved") {
    const status = user?.status ?? "unknown";
    console.warn(`[audio-feed] audio 403: user "${userId}" is ${status}`);
    return forbidden(`User account is ${status}`);
  }
  return null;
}

export async function handleAudio(
  { req, params, ctx }: RouteContext<AppContext>,
): Promise<Response> {
  const rawKey = params.key;
  if (!rawKey || !isAllowedAudioKey(rawKey)) {
    console.warn(`[audio-feed] audio 404: disallowed or unsafe key "${rawKey}"`);
    return notFound("Unknown audio object");
  }

  const isHead = req.method === "HEAD";

  // For keys not starting with "audio/", the canonical shape in storage is
  // audio/${rawKey}. For multi-segment keys, only audio/${rawKey} is checked
  // (blob storage never stores multi-segment audio outside the audio/ prefix).
  // For legacy flat keys, check audio/${rawKey} first, then rawKey (audio-feed-1rx, audio-feed-vlw).
  const candidateKeys = rawKey.startsWith("audio/")
    ? [rawKey]
    : rawKey.includes("/")
    ? [`audio/${rawKey}`]
    : isSafeBlobKey(`audio/${rawKey}`)
    ? [`audio/${rawKey}`, rawKey]
    : [rawKey];

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
        `[audio-feed] audio HEAD 404: key "${rawKey}" not found (candidates: ${
          candidateKeys.join(", ")
        })`,
      );
      return notFound("Unknown audio object");
    }

    const refusal = await checkUserApproval(ctx, resolvedKey);
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
  if (!isHead && !isCorsConstrained(req)) {
    let everyKeyHasDirectUrl = true;
    for (const key of candidateKeys) {
      const direct = await ctx.stores.blobs.url(key);
      if (!direct) {
        everyKeyHasDirectUrl = false;
        continue;
      }
      const info = await ctx.stores.blobs.head(key);
      if (info) {
        const refusal = await checkUserApproval(ctx, key);
        if (refusal) return refusal;

        if (!req.headers.get("range")) {
          await ctx.stores.metadata.recordDownload(userIdFromBlobKey(key));
        }
        return new Response(null, { status: 302, headers: { location: direct } });
      }
    }
    if (everyKeyHasDirectUrl) {
      console.warn(
        `[audio-feed] audio direct-url 404: key "${rawKey}" not found (candidates: ${
          candidateKeys.join(", ")
        })`,
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
      `[audio-feed] audio GET 404: key "${rawKey}" not found in storage (candidates: ${
        candidateKeys.join(", ")
      })`,
    );
    return notFound("Unknown audio object");
  }

  const refusal = await checkUserApproval(ctx, resolvedKey);
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

  await ctx.stores.metadata.recordDownload(userIdFromBlobKey(resolvedKey));

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
