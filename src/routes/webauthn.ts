/**
 * WebAuthn Related Origin Requests (ROR) endpoint (audio-feed-1o2).
 *
 * Implements W3C Related Origin Requests specification per web.dev/articles/webauthn-rp-id.
 * Serves GET /.well-known/webauthn returning JSON:
 *   { "origins": ["https://...", ...] }
 *
 * Allows cross-origin passkey recognition when transitioning between domains
 * without clashing.
 */

import type { AppContext } from "../app.ts";
import type { Handler } from "../router.ts";
import { resolveOrigin } from "../origin.ts";

export const handleWebAuthnRelatedOrigins: Handler<AppContext> = ({ req, ctx }) => {
  const origin = resolveOrigin(ctx.config, req).baseUrl;
  const origins = new Set<string>([origin]);

  if (ctx.config.publicBaseUrl) {
    try {
      origins.add(new URL(ctx.config.publicBaseUrl).origin);
    } catch {
      // ignore invalid
    }
  }

  if (Array.isArray(ctx.config.webAuthnRelatedOrigins)) {
    for (const ro of ctx.config.webAuthnRelatedOrigins) {
      try {
        origins.add(new URL(ro).origin);
      } catch {
        // ignore invalid
      }
    }
  }

  return Response.json(
    { origins: Array.from(origins) },
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    },
  );
};
