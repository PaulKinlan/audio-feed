/**
 * Cross-device playback state sync routes:
 *   - `GET  /listen/:token/state` — fetch persisted playback state for the approved token owner
 *   - `POST /listen/:token/state` — validate, bound, and merge playback state updates (accepts
 *     both `application/json` and `text/plain` so `navigator.sendBeacon` works on `pagehide`)
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { resolveOrigin } from "../origin.ts";
import { getUserByFeedToken } from "../auth/users.ts";
import { extractClientIp, SlidingWindowRateLimiter } from "../auth/rate_limit.ts";
import { badRequest, payloadTooLarge, problem, readBoundedBody } from "../http.ts";
import { emptyPlaybackState, parsePlaybackStatePatch } from "../playback_state.ts";
import type { User } from "../types.ts";

/** Maximum accepted request payload size for `POST /listen/:token/state` (64 KiB). */
export const MAX_PLAYBACK_STATE_BYTES = 64 * 1024;

/** Sliding-window rate limits checked BEFORE token resolution. */
export const PLAYBACK_STATE_READ_RATE = { maxRequests: 120, windowMs: 5 * 60 * 1000 } as const;
export const PLAYBACK_STATE_WRITE_RATE = { maxRequests: 240, windowMs: 5 * 60 * 1000 } as const;

export const PLAYBACK_STATE_READ_WINDOW = "listen_state_read";
export const PLAYBACK_STATE_WRITE_WINDOW = "listen_state_write";

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex",
} as const;

function privateJson(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...PRIVATE_NO_STORE_HEADERS,
      ...(extraHeaders ?? {}),
    },
  });
}

function uniformNotFound(): Response {
  return privateJson({ error: "Unknown feed" }, 404);
}

function isDisallowedCrossOriginPost(req: Request, expectedOrigin: string): boolean {
  const site = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (site === "cross-site" || site === "same-site") return true;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  if (origin === expectedOrigin) return false;
  if (origin === "null" && site === "same-origin") return false;
  return true;
}

function isAcceptedSyncContentType(header: string | null): boolean {
  if (!header) return true;
  const mediaType = header.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "" || mediaType === "application/json" || mediaType === "text/plain";
}

async function resolveApprovedUser(
  ctx: AppContext,
  rawToken: string,
): Promise<User | null> {
  const trimmed = rawToken.trim();
  if (!trimmed) return null;
  let user = await getUserByFeedToken(ctx.stores.metadata, trimmed);
  if (!user && trimmed.includes("%")) {
    try {
      const decoded = decodeURIComponent(trimmed);
      user = await getUserByFeedToken(ctx.stores.metadata, decoded);
    } catch {
      return null;
    }
  }
  if (!user) return null;
  if (user.status !== "approved") {
    // Uniform 404 matching src/routes/listen.ts: never disclose moderation status to callers.
    console.warn(`[audio-feed] listen state 404 (unapproved): user "${user.id}" is ${user.status}`);
    return null;
  }
  return user;
}

async function refuseRateLimit(
  route: RouteContext<AppContext>,
  rate: { maxRequests: number; windowMs: number },
  namespace: string,
): Promise<Response | null> {
  const { ctx, req, remoteAddr } = route;
  const limiter = new SlidingWindowRateLimiter(rate, ctx.stores.metadata, namespace);
  const clientIp = extractClientIp(req, Boolean(ctx.config.trustProxyHeaders), remoteAddr);
  const check = await limiter.check(clientIp);
  if (check.allowed) return null;
  const refused = problem({
    status: 429,
    title: "too_many_requests",
    detail: "Too many playback sync requests from this client; retry later.",
  });
  refused.headers.set("retry-after", String(Math.max(1, Math.ceil(check.resetMs / 1000))));
  refused.headers.set("cache-control", "private, no-store");
  refused.headers.set("x-robots-tag", "noindex");
  return refused;
}

/** `GET /listen/:token/state` — returns `{ state }` for the approved subscriber. */
export async function handleGetPlaybackState(
  route: RouteContext<AppContext>,
): Promise<Response> {
  const rateRefusal = await refuseRateLimit(
    route,
    PLAYBACK_STATE_READ_RATE,
    PLAYBACK_STATE_READ_WINDOW,
  );
  if (rateRefusal) return rateRefusal;

  const user = await resolveApprovedUser(route.ctx, route.params.token ?? "");
  if (!user) return uniformNotFound();

  const existing = await route.ctx.stores.metadata.getPlaybackState(user.id);
  return privateJson({ state: existing ?? emptyPlaybackState() }, 200);
}

/** `POST /listen/:token/state` — merges bounded playback state updates and returns `{ state }`. */
export async function handlePostPlaybackState(
  route: RouteContext<AppContext>,
): Promise<Response> {
  const { ctx, req, params } = route;
  if (isDisallowedCrossOriginPost(req, resolveOrigin(ctx.config, req).baseUrl)) {
    return privateJson({ error: "Cross-origin request refused." }, 403);
  }

  const rateRefusal = await refuseRateLimit(
    route,
    PLAYBACK_STATE_WRITE_RATE,
    PLAYBACK_STATE_WRITE_WINDOW,
  );
  if (rateRefusal) return rateRefusal;

  const user = await resolveApprovedUser(ctx, params.token ?? "");
  if (!user) return uniformNotFound();

  if (!isAcceptedSyncContentType(req.headers.get("content-type"))) {
    const res = problem({
      status: 415,
      title: "unsupported_media_type",
      detail: "Expected content-type: application/json or text/plain.",
    });
    res.headers.set("cache-control", "private, no-store");
    return res;
  }

  const body = await readBoundedBody(req, MAX_PLAYBACK_STATE_BYTES);
  if (!body.ok) {
    const res = body.status === 413
      ? payloadTooLarge(
        `Playback state payload exceeds the ${MAX_PLAYBACK_STATE_BYTES}-byte limit.`,
      )
      : badRequest("Could not read request body.");
    res.headers.set("cache-control", "private, no-store");
    return res;
  }

  if (!body.text.trim()) {
    const res = badRequest("Playback state JSON payload is required.");
    res.headers.set("cache-control", "private, no-store");
    return res;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    const res = badRequest("Malformed JSON playback state payload.");
    res.headers.set("cache-control", "private, no-store");
    return res;
  }

  const patch = parsePlaybackStatePatch(parsed);
  if (!patch) {
    const res = badRequest("Invalid playback state payload.");
    res.headers.set("cache-control", "private, no-store");
    return res;
  }

  const merged = await ctx.stores.metadata.mergePlaybackState(user.id, patch);
  return privateJson({ state: merged }, 200);
}
