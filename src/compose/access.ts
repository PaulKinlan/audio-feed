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
 * - Atomic email deduplication: re-submitting an existing email does not create
 *   another row or reveal the account's existence/status.
 * - Tokens are NEVER returned to the applicant.
 */

import type { AppContext, AppHandlers } from "../app.ts";
import {
  createUser,
  DuplicateUserEmailError,
  isValidEmail,
  normaliseEmail,
} from "../auth/users.ts";
import { esc } from "../routes/html.ts";
import { htmlResponse, newCspNonce } from "../routes/csp.ts";
import { readBoundedBody } from "../http.ts";
import {
  extractClientIp,
  type RateLimitConfig,
  SlidingWindowRateLimiter,
} from "../auth/rate_limit.ts";

/** The request-body cap for this public endpoint (audio-feed-oxw5g): email + displayName are small; 4KiB matches the CWV beacon cap's scale. */
export const MAX_ACCESS_BODY_BYTES = 4096;

export interface RequestAccessDeps {
  /** Optional rate limiter override for testing. */
  rateLimiter?: SlidingWindowRateLimiter;
  /** Rate limiter configuration if default limiter is instantiated. */
  rateLimitConfig?: RateLimitConfig;
}

/** Namespaces this limiter's window, so a front-door post and a failed admin
 *  guess for the same client can never share a row (audio-feed-2zvc). */
const REQUEST_ACCESS_NAMESPACE = "request_access";

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 5,
  windowMs: 60 * 60 * 1000, // 1 hour
};

export function createRequestAccessHandler(
  ctx: AppContext,
  deps: RequestAccessDeps = {},
): AppHandlers["requestAccess"] {
  const limiter = deps.rateLimiter ??
    new SlidingWindowRateLimiter(
      deps.rateLimitConfig ?? DEFAULT_RATE_LIMIT,
      ctx.stores.metadata,
      REQUEST_ACCESS_NAMESPACE,
    );

  return async ({ req, remoteAddr }) => {
    const isHtml = req.headers.get("accept")?.includes("text/html") ?? false;
    const sendHtml = (
      title: string,
      msg: string,
      status = 200,
      extraHeaders: Record<string, string> = {},
    ) => {
      const nonce = newCspNonce();
      return htmlResponse(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${
          esc(title)
        } — Audio Feed</title><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:1.5rem;line-height:1.6;color:#17151f;background:#f7f6fb}.card{background:#fff;padding:2rem;border-radius:12px;border:1px solid #dcd8e8}h1{font-size:1.4rem;margin-top:0}a{color:#5b3fc4;text-decoration:underline}.return-link{margin-top:2rem}</style></head><body><div class="card"><h1>${
          esc(title)
        }</h1><p>${
          esc(msg)
        }</p><p class="return-link"><a href="/">← Return to Audio Feed</a></p></div></body></html>`,
        nonce,
        {
          status,
          headers: {
            "cache-control": "no-store",
            ...extraHeaders,
          },
        },
      );
    };

    // 1. Rate limiting by client IP
    const clientIp = extractClientIp(req, ctx.config.trustProxyHeaders ?? false, remoteAddr);
    const limitResult = await limiter.check(clientIp);

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

    // The body is bounded BEFORE parsing (audio-feed-oxw5g): this is a PUBLIC
    // endpoint and the old code called req.json()/req.formData() unbounded, so a
    // giant body was fully buffered by the platform parser before the email check
    // ever ran. email + displayName are small; 4KiB covers them with room and
    // matches the CWV beacon cap's scale. The declared-length fast path refuses
    // oversized bodies before the read; a chunked or lying declared length is
    // bounded BY CONSTRUCTION by the shared reader.
    if (
      contentType.includes("application/json") ||
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const capped = await readBoundedBody(req, MAX_ACCESS_BODY_BYTES);
      if (!capped.ok) {
        if (isHtml) return sendHtml("Payload Too Large", "The submitted form was too large.", 413);
        return Response.json(
          { error: "Payload too large." },
          { status: capped.status, headers: { "cache-control": "no-store" } },
        );
      }
      try {
        if (contentType.includes("application/json")) {
          const body = JSON.parse(capped.text);
          email = typeof body.email === "string" ? body.email.trim() : "";
          displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(capped.text);
          email = (params.get("email") ?? "").trim();
          displayName = (params.get("displayName") ?? "").trim();
        } else {
          // multipart/form-data: the endpoint only reads two text fields, so
          // re-parsing the capped TEXT through a synthetic Request keeps the
          // formData() semantics on a bounded body.
          const synthetic = new Request("http://local/access", {
            method: "POST",
            headers: { "content-type": contentType },
            body: capped.text,
          });
          const formData = await synthetic.formData();
          email = (formData.get("email") as string | null)?.trim() ?? "";
          displayName = (formData.get("displayName") as string | null)?.trim() ?? "";
        }
      } catch {
        return Response.json(
          { error: "Malformed request payload." },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
    } else {
      return Response.json(
        {
          error:
            "Unsupported Content-Type. Use application/json or application/x-www-form-urlencoded.",
        },
        { status: 415, headers: { "cache-control": "no-store" } },
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

    // Always attempt the same atomic insert: a preliminary lookup would both
    // reveal account state and skip token generation/write work for known emails.
    try {
      await createUser(ctx.stores.metadata, {
        email: cleanEmail,
        displayName: cleanName,
      });
    } catch (err) {
      // A duplicate (including a concurrent signup) is an accepted request.
      // Do not turn unrelated storage failures into apparent successes.
      if (!(err instanceof DuplicateUserEmailError)) {
        const message = "Could not process access request. Please try again later.";
        if (isHtml) return sendHtml("Error", message, 500);
        return Response.json(
          { error: message },
          { status: 500, headers: { "cache-control": "no-store" } },
        );
      }
    }

    const message =
      "If this address is eligible, your access request will be reviewed by an administrator.";
    if (isHtml) return sendHtml("Access Request Received", message);
    return Response.json(
      { ok: true, message },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  };
}
