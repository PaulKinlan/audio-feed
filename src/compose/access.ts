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
import { esc } from "../routes/html.ts";
import { htmlContentSecurityPolicy, newCspNonce } from "../routes/csp.ts";
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

  return async ({ req, remoteAddr }) => {
    const isHtml = req.headers.get("accept")?.includes("text/html") ?? false;
    const sendHtml = (
      title: string,
      msg: string,
      status = 200,
      extraHeaders: Record<string, string> = {},
    ) => {
      const nonce = newCspNonce();
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${
          esc(title)
        } — Audio Feed</title><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:1.5rem;line-height:1.6;color:#17151f;background:#f7f6fb}.card{background:#fff;padding:2rem;border-radius:12px;border:1px solid #dcd8e8}h1{font-size:1.4rem;margin-top:0}a{color:#5b3fc4;text-decoration:underline}.return-link{margin-top:2rem}</style></head><body><div class="card"><h1>${
          esc(title)
        }</h1><p>${
          esc(msg)
        }</p><p class="return-link"><a href="/">← Return to Audio Feed</a></p></div></body></html>`,
        {
          status,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": htmlContentSecurityPolicy(nonce),
            "cache-control": "no-store",
            ...extraHeaders,
          },
        },
      );
    };

    // 1. Rate limiting by client IP
    const clientIp = extractClientIp(req, ctx.config.trustProxyHeaders ?? false, remoteAddr);
    const limitResult = limiter.check(clientIp);

    if (!limitResult.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(limitResult.resetMs / 1000));
      if (isHtml) {
        return sendHtml(
          "Too Many Requests",
          "Too many access requests. Please try again later.",
          429,
          { "retry-after": retryAfterSec.toString() },
        );
      }
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
      if (isHtml) return sendHtml("Invalid Email", "A valid email address is required.", 400);
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
        const message =
          "An account with this email is already approved. You can sign in at /login or use your feed token.";
        if (isHtml) return sendHtml("Account Approved", message);
        return Response.json(
          { ok: true, status: "approved", message },
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }

      if (existing.status === "suspended") {
        const message = "This account is suspended. Please contact the administrator.";
        if (isHtml) return sendHtml("Account Suspended", message, 403);
        return Response.json(
          { ok: false, status: "suspended", message },
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }

      if (existing.status === "rejected") {
        const message = "This access request was declined by an administrator.";
        if (isHtml) return sendHtml("Request Declined", message, 403);
        return Response.json(
          { ok: false, status: "rejected", message },
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }

      const message = "Your access request is already pending administrator review.";
      if (isHtml) return sendHtml("Request Pending", message);
      return Response.json(
        { ok: true, status: existing.status, message },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }

    // 5. Create new pending user
    try {
      await createUser(ctx.stores.metadata, {
        email: cleanEmail,
        displayName: cleanName,
      });

      const message =
        "Access request received. An administrator will review your request before audio generation is enabled.";
      if (isHtml) return sendHtml("Access Request Received", message, 201);
      return Response.json(
        { ok: true, status: "pending", message },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      const message = (err as Error)?.message ?? "Could not create access request.";
      if (isHtml) return sendHtml("Error", message, 400);
      return Response.json(
        { error: message },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
