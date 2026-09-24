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
import type { RouteContext } from "../router.ts";
import type { AppContext } from "../app.ts";

/** Blob keys are path-shaped; reject anything that tries to escape the prefix. */
export function isSafeBlobKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (key.startsWith("/") || key.includes("//")) return false;
  if (key.includes("\0") || key.includes("\\")) return false;
  return !key.split("/").some((segment) => segment === "." || segment === "..");
}

export async function handleAudio(
  { req, params, ctx }: RouteContext<AppContext>,
): Promise<Response> {
  const rawKey = params.key;
  if (!rawKey || !isSafeBlobKey(rawKey)) return notFound("Unknown audio object");

  const isHead = req.method === "HEAD";

  // For keys not starting with "audio/", the canonical shape emitted by new feeds
  // is audio/${rawKey}. Try the canonical candidate first, then rawKey (audio-feed-1rx).
  const candidateKeys = rawKey.startsWith("audio/")
    ? [rawKey]
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
    if (!info || !resolvedKey) return notFound("Unknown audio object");

    return headResponse(info.size, {
      "content-type": info.contentType,
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
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
  if (!isHead) {
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

  if (!object || !resolvedKey) return notFound("Unknown audio object");

  const headers = new Headers({
    "content-type": object.contentType,
    "accept-ranges": "bytes",
    // Episode ids are unguessable and audio is immutable once written.
    "cache-control": "public, max-age=31536000, immutable",
  });
  if (object.etag) headers.set("etag", object.etag);

  if (object.range) {
    const { start, end, total } = object.range;
    headers.set("content-range", `bytes ${start}-${end}/${total}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(object.body, { status: 206, headers });
  }

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
