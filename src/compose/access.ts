/**
 * Public request-access handler (audio-feed-r97).
 *
 * Allows prospective subscribers to request access from the front door.
 * Creates a user with `status: "pending"`. No synthesis is ever performed
 * until an administrator explicitly approves the user.
 *
 * ABUSE POSTURE:
 * - Rate-limited by client IP (default: 5 requests per hour).
 * - Exceeding rate limit returns 429 with Retry-After header.
 * - Email deduplication: re-submitting an existing email returns an honest status
 *   without creating additional rows or leaking private tokens.
 * - Tokens are NEVER returned to the applicant.
 */

import type { AppContext, AppHandlers } from "../app.ts";
import { createUser, isValidEmail, normaliseEmail } from "../auth/users.ts";
import {
  extractClientIp,
  type RateLimitConfig,
  SlidingWindowRateLimiter,
} from "../auth/rate_limit.ts";

export interface RequestAccessDeps {
  /** Optional rate limiter override for testing. */
  rateLimiter?: SlidingWindowRateLimiter;
  /** Rate limiter configuration if default limiter is instantiated. */
  rateLimitConfig?: RateLimitConfig;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 5,
  windowMs: 60 * 60 * 1000, // 1 hour
};

export function createRequestAccessHandler(
  ctx: AppContext,
  deps: RequestAccessDeps = {},
): AppHandlers["requestAccess"] {
  const limiter = deps.rateLimiter ??
    new SlidingWindowRateLimiter(deps.rateLimitConfig ?? DEFAULT_RATE_LIMIT);

  return async ({ req }) => {
    // 1. Rate limiting by client IP
    const clientIp = extractClientIp(req, ctx.config.trustProxyHeaders ?? false);
    const limitResult = limiter.check(clientIp);

    if (!limitResult.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(limitResult.resetMs / 1000));
      return Response.json(
        { error: "Too many access requests. Please try again later." },
        {
          status: 429,
          headers: {
            "retry-after": retryAfterSec.toString(),
            "cache-control": "no-store",
          },
        },
      );
    }

    // 2. Parse request payload (JSON or Form POST)
    const contentType = req.headers.get("content-type") ?? "";
    let email = "";
    let displayName = "";

    try {
      if (contentType.includes("application/json")) {
        const body = await req.json();
        email = typeof body.email === "string" ? body.email.trim() : "";
        displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      } else if (
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data")
      ) {
        const formData = await req.formData();
        email = (formData.get("email") as string | null)?.trim() ?? "";
        displayName = (formData.get("displayName") as string | null)?.trim() ?? "";
      } else {
        return Response.json(
          {
            error:
              "Unsupported Content-Type. Use application/json or application/x-www-form-urlencoded.",
          },
          { status: 415, headers: { "cache-control": "no-store" } },
        );
      }
    } catch {
      return Response.json(
        { error: "Malformed request payload." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }

    // 3. Validation
    if (!email || !isValidEmail(email)) {
      return Response.json(
        { error: "A valid email address is required." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }

    const cleanEmail = normaliseEmail(email);
    const cleanName = displayName.slice(0, 100) || undefined;

    // 4. Idempotency & user lookup
    const existing = await ctx.stores.metadata.getUserByEmail(cleanEmail);
    if (existing) {
      if (existing.status === "approved") {
        return Response.json(
          {
            ok: true,
            status: "approved",
            message:
              "An account with this email is already approved. You can sign in at /login or use your feed token.",
          },
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }

      return Response.json(
        {
          ok: true,
          status: existing.status,
          message: "Your access request is already pending administrator review.",
        },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }

    // 5. Create new pending user
    try {
      await createUser(ctx.stores.metadata, {
        email: cleanEmail,
        displayName: cleanName,
      });

      return Response.json(
        {
          ok: true,
          status: "pending",
          message:
            "Access request received. An administrator will review your request before audio generation is enabled.",
        },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      const message = (err as Error)?.message ?? "Could not create access request.";
      return Response.json(
        { error: message },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
