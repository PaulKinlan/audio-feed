/**
 * Content-Security-Policy for HTML documents (audio-feed-syhu).
 *
 * The app ships inline `<style>` blocks and a small inline boot script, so the policy
 * carries a **per-response nonce** instead of `'unsafe-inline'`. The nonce is random for
 * every response and is stamped on exactly the tags the templates emit, so an injected
 * `<script>`/`<style>`/`style=` cannot guess it and therefore cannot run: CSP stays a real
 * last line of defence on the credentialed documents.
 *
 * Do NOT reintroduce `'unsafe-inline'`: `tests/security_audit_test.ts` fails if the emitted
 * policy contains it, and the nonce-mismatch test fails if the header and the tags diverge.
 */

/** Base64 of 16 random bytes — unguessable, and valid inside the CSP nonce grammar. */
export function newCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, "");
}

/**
 * The one HTML policy. `style-src` carries the nonce too: inline `style="..."` ATTRIBUTES are
 * not covered by a nonce (CSP hashes/nonces do not apply to attributes), so the app has no
 * inline style attributes — page CSS lives in the shared stylesheet or a nonced `<style>`.
 *
 * `img-src` and `media-src` (audio-feed-327mm):
 * Enumerate where images/media are served from:
 * 1. Images: templates and CSS render zero `<img>` tags. The app mark and touch icons are
 *    served from `/icon.svg` ('self') or inline `<svg>` elements. Remote podcast artwork (imageUrl)
 *    is parsed from upstream feeds and emitted only into generated RSS XML feeds (src/feed/rss.ts)
 *    for external podcast client consumption; it is never rendered in HTML pages.
 * 2. Media: `<audio>` tags are rendered on `/account` and `/listen` and set src to same-origin
 *    paths (`/audio/...`). A browser media load is a no-cors request — listen.ts renders the
 *    player with NO crossorigin attribute, deliberately (the production playback bug) — and
 *    `isCorsConstrained` (src/routes/audio.ts) returns false for such a request: it skips the
 *    redirect ONLY when a request carries an `Origin` header or a cors/same-origin
 *    `sec-fetch-mode`. The plain player request therefore takes audio.ts's 302 to the blob
 *    store's direct playback URL, which is CROSS-ORIGIN on an R2/S3 deployment, and CSP
 *    re-evaluates media-src against the redirect target. So the player pages pass the store's
 *    direct-URL origin (BlobStore.directUrlOrigin — the same store configuration audio.ts's
 *    `url()` builds the redirect from) into htmlResponse, and media-src is
 *    `'self' blob: <store-origin>` there; a store that never redirects (e.g. memory) yields no
 *    origin, and pages without a player keep plain `'self' blob:` — their no-cors player
 *    requests do not exist, and one on a redirecting store would otherwise be blocked dead.
 * The previous wildcard `https:` in `img-src` and `media-src` was unneeded boilerplate that
 * permitted arbitrary beaconing out. Tightened to `'self' data:` for images, and for media to
 * `'self' blob:` plus exactly the one origin the blob store itself redirects to — never a bare
 * scheme-source, which would permit arbitrary beaconing out again.
 */
export function htmlContentSecurityPolicy(
  nonce: string,
  reportUrl?: string,
  mediaSrcOrigin?: string | null,
): string {
  const mediaSrc = mediaSrcOrigin
    ? `media-src 'self' blob: ${mediaSrcOrigin}`
    : "media-src 'self' blob:";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    mediaSrc,
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (reportUrl) {
    directives.push("report-to csp-endpoint");
    directives.push(`report-uri ${reportUrl}`);
  }
  return directives.join("; ");
}

/**
 * Build an HTML response with the nonce-bearing CSP and default Referrer-Policy attached.
 * Routes use this rather than `new Response(html, ...)` so the header can never drift from
 * the nonce they stamped, and so capability-bearing pages default to `no-referrer`
 * without requiring every call site to remember it (audio-feed-fhnrr).
 *
 * An explicit opt-out is supported via `referrerPolicy: null` (strips the header) or
 * a custom policy string (e.g. `referrerPolicy: "strict-origin-when-cross-origin"`).
 */
export function htmlResponse(
  html: string,
  nonce: string,
  init: {
    status?: number;
    headers?: HeadersInit;
    reportUrl?: string;
    referrerPolicy?: ReferrerPolicy | "" | null;
    /**
     * The blob store's direct-URL origin, when this page renders the player
     * (audio-feed-327mm delta) — see the media paragraph on htmlContentSecurityPolicy.
     * Pass `blobStoreDirectUrlOrigin(ctx.stores.blobs)`; `null`/undefined keeps plain
     * `'self' blob:`.
     */
    mediaSrcOrigin?: string | null;
  } = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  if (init.referrerPolicy === null) {
    headers.delete("referrer-policy");
  } else if (init.referrerPolicy !== undefined) {
    headers.set("referrer-policy", init.referrerPolicy);
  } else if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "no-referrer");
  }
  headers.set(
    "content-security-policy",
    htmlContentSecurityPolicy(nonce, init.reportUrl, init.mediaSrcOrigin),
  );
  return new Response(html, { status: init.status ?? 200, headers });
}
