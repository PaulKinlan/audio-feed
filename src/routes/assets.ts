/**
 * Static assets for the player (audio-feed-3xq).
 *
 * The problem this solves: the listen page's stylesheet and client used to live inside a template
 * literal in listen.ts. As a string, the browser code was invisible to `deno check` and `deno lint`
 * — which is how audio-feed-7s2 could ship a CSS block that landed inside an
 * `@media (prefers-reduced-motion: reduce)` query and rendered as unstyled bullets for everyone
 * except a user who had reduced motion on. Extracting the file is what makes tooling able to see it.
 *
 * Why the bytes are imported rather than read from disk: this runs on Deno Deploy, where a runtime
 * read of a relative path is not guaranteed to resolve. `with { type: "text" }` gives the server the
 * real file contents at module load, measured to work on Deno 2.9.7.
 *
 * Why the hash is in the URL: `immutable, max-age=31536000` is only honest if the URL changes when
 * the bytes do. A content-addressed name means a stale client keeps the old file (correct) and a new
 * deploy gets a new URL, with no cache purge step to forget.
 */
import listenCss from "../assets/listen.css" with { type: "text" };
import listenJs from "../assets/listen.js" with { type: "text" };
import { DESIGN_TOKENS } from "./tokens.ts";
import type { RouteContext } from "../router.ts";

/**
 * FNV-1a, 32-bit, hex. Chosen over SHA-256 because it is synchronous — a hash computed at module
 * load must not need top-level await in a file the request path imports — and because this is a
 * cache key, not a security primitive. Collisions across a handful of assets are not a threat
 * model; a stale stylesheet after a deploy is the thing being prevented.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Every asset this server can hand out, keyed by the name a page asks for. */
const ASSETS: Record<string, { body: string; contentType: string }> = {
  "listen.css": {
    body: `${DESIGN_TOKENS}\n${listenCss}`,
    contentType: "text/css; charset=utf-8",
  },
  "listen.js": { body: listenJs, contentType: "text/javascript; charset=utf-8" },
};

/** The URL a page should reference for an asset, content-addressed. */
export function assetUrl(name: string): string {
  const asset = ASSETS[name];
  if (!asset) throw new Error(`unknown asset: ${name}`);
  return `/assets/${fnv1a(asset.body)}.${name}`;
}

/** The URL shape this module both produces and accepts: /assets/<hash>.<name>. */
function splitAddress(segments: string): { hash: string; name: string } | null {
  const dot = segments.indexOf(".");
  if (dot <= 0) return null;
  return { hash: segments.slice(0, dot), name: segments.slice(dot + 1) };
}

/**
 * `GET /assets/:name` — immutable, content-addressed static responses.
 *
 * The hash in the URL is CHECKED, not ignored. Serving the current bytes for any hash would make
 * the address a placebo: a client holding an old URL would get new bytes under a cache header that
 * promises it never will, which is precisely the failure `immutable` exists to prevent. A mismatch
 * is a 404, and the caller falls back to whatever it linked before.
 */
export function handleAsset(
  { params }: RouteContext<unknown>,
): Response {
  const parts = splitAddress(params.name ?? "");
  const asset = parts === null ? undefined : ASSETS[parts.name];
  if (parts !== null && asset !== undefined && fnv1a(asset.body) !== parts.hash) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (!asset) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  // The URL carries the hash, so a hit on this path is by definition the bytes that hash names.
  return new Response(asset.body, {
    status: 200,
    headers: {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
