/**
 * Podcasting 2.0 WebVTT transcript route:
 *   - `GET /feed/:token/transcript/:episodeId` (accepts optional `.vtt` suffix)
 *
 * Mirrors the exact token-capability authentication, user approval gate,
 * sliding-window rate limiting, and private caching posture used by
 * `src/routes/artwork.ts` (`handleEpisodeChapters` / `handleFeedArtwork`).
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { notFound } from "../http.ts";
import { getUserByFeedToken } from "../auth/users.ts";
import { extractClientIp, SlidingWindowRateLimiter } from "../auth/rate_limit.ts";
import { computeEtag, ifNoneMatchMatches } from "../feed/etag.ts";
import { buildTranscriptCues, renderWebVtt } from "../synthesis/transcript.ts";
import type { User } from "../types.ts";

export const TRANSCRIPT_RATE_LIMIT = { maxRequests: 240, windowMs: 5 * 60 * 1000 } as const;
export const TRANSCRIPT_RATE_WINDOW = "feed_transcript_read";
const TRANSCRIPT_CACHE_CONTROL = "private, max-age=3600";

async function resolveApprovedFeedUser(
  route: RouteContext<AppContext>,
): Promise<User | Response> {
  const { ctx, params, req, remoteAddr } = route;
  const token = (params.token ?? "").trim();
  if (!token) return notFound("Unknown feed");

  const limiter = new SlidingWindowRateLimiter(
    TRANSCRIPT_RATE_LIMIT,
    ctx.stores.metadata,
    TRANSCRIPT_RATE_WINDOW,
  );
  const ip = extractClientIp(req, Boolean(ctx.config.trustProxyHeaders), remoteAddr);
  const res = await limiter.check(ip);
  if (!res.allowed) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: {
        "retry-after": String(Math.max(1, Math.ceil(res.resetMs / 1000))),
        "cache-control": "no-store",
      },
    });
  }

  const user = await getUserByFeedToken(ctx.stores.metadata, token);
  if (!user || user.status !== "approved") return notFound("Unknown feed");
  return user;
}

/**
 * `GET /feed/:token/transcript/:episodeId` — Podcasting 2.0 WebVTT transcript.
 * Accepts `/feed/:token/transcript/<id>.vtt` or `/feed/:token/transcript/<id>`.
 */
export async function handleEpisodeTranscript(
  route: RouteContext<AppContext>,
): Promise<Response> {
  const userOrErr = await resolveApprovedFeedUser(route);
  if (userOrErr instanceof Response) return userOrErr;
  const user = userOrErr;

  const rawId = (route.params.episodeId ?? "").trim();
  const episodeId = rawId.replace(/\.vtt$/i, "");
  if (!episodeId) return notFound("Unknown episode");

  const episode = await route.ctx.stores.metadata.getEpisode(user.id, episodeId);
  if (!episode) return notFound("Unknown episode");

  const article = episode.articleId
    ? await route.ctx.stores.metadata.getArticle(user.id, episode.articleId)
    : null;

  const cues = buildTranscriptCues({
    mode: episode.mode,
    durationSeconds: episode.durationSeconds,
    transcript: episode.transcript,
    scriptTurns: episode.scriptTurns,
    chapters: episode.chapters,
    articleText: article?.content,
    title: episode.title,
    description: episode.description,
  });

  if (cues.length === 0) {
    return notFound("Transcript unavailable");
  }

  const vtt = renderWebVtt(cues);
  const etag = await computeEtag(vtt);

  if (ifNoneMatchMatches(route.req.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": TRANSCRIPT_CACHE_CONTROL,
        "x-robots-tag": "noindex",
      },
    });
  }

  return new Response(vtt, {
    status: 200,
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      etag,
      "cache-control": TRANSCRIPT_CACHE_CONTROL,
      "x-robots-tag": "noindex",
    },
  });
}
