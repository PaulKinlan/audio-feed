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
 * Always uncacheable (Cache-Control: no-store): the origins come from deployment
 * configuration, so a cached answer could outlive a reconfiguration. Returns
 * { "origins": [] } when unconfigured. The header is defence in depth rather
 * than the poisoning protection - an unrecognised Host is refused with 421
 * before this handler runs (src/app.ts).
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

  // no-store, unconditionally (audio-feed-7lsy review): this is passkey/auth metadata derived from
  // deployment configuration, so an intermediary or shared cache could serve an answer from before a
  // reconfiguration - and a stale origins list is exactly what breaks passkey registration after a
  // domain change. There is no caching benefit on this endpoint worth that risk.
  //
  // What this header is NOT any more: load-bearing for Host poisoning. A request arriving on a host the
  // deployment does not recognise is refused with 421 before the router runs (src/app.ts), so the
  // protection is the refusal and this is defence in depth rather than the mechanism.
  const cacheControl = "no-store";

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
