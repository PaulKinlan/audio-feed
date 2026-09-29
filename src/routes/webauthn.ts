/**
 * WebAuthn Related Origin Requests (ROR) endpoint (audio-feed-1o2).
 *
 * Implements W3C Related Origin Requests specification per web.dev/articles/webauthn-rp-id.
 * Serves GET /.well-known/webauthn returning JSON:
 *   { "origins": ["https://...", ...] }
 *
 * Security design:
 * Built strictly from operator CONFIGURATION (publicBaseUrl + webAuthnRelatedOrigins),
 * never from untrusted client Host headers, preventing cache-poisoning of authorized origins.
 * When completely unconfigured, returns { "origins": [] } with Cache-Control: no-store.
 * When configured, returns the pinned origins with Cache-Control: public, max-age=3600.
 */

import type { AppContext } from "../app.ts";
import type { Handler } from "../router.ts";

export const handleWebAuthnRelatedOrigins: Handler<AppContext> = ({ ctx }) => {
  const origins = new Set<string>();

  if (ctx.config.publicBaseUrl) {
    try {
      origins.add(new URL(ctx.config.publicBaseUrl).origin);
    } catch {
      console.warn(
        `[audio-feed] invalid publicBaseUrl for WebAuthn ROR: "${ctx.config.publicBaseUrl}"`,
      );
    }
  }

  if (Array.isArray(ctx.config.webAuthnRelatedOrigins)) {
    for (const ro of ctx.config.webAuthnRelatedOrigins) {
      try {
        origins.add(new URL(ro).origin);
      } catch {
        console.warn(`[audio-feed] invalid webAuthnRelatedOrigins entry skipped: "${ro}"`);
      }
    }
  }

  const cacheControl = origins.size > 0 ? "public, max-age=3600" : "no-store";

  return Response.json(
    { origins: Array.from(origins) },
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": cacheControl,
      },
    },
  );
};
