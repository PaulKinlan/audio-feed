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
 */
export function htmlContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Build an HTML response with the nonce-bearing CSP already attached. Routes use this rather
 * than `new Response(html, ...)` so the header can never drift from the nonce they stamped.
 */
export function htmlResponse(
  html: string,
  nonce: string,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy", htmlContentSecurityPolicy(nonce));
  return new Response(html, { status: init.status ?? 200, headers });
}
