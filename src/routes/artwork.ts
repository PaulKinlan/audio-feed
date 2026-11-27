/**
 * Artwork, Podcasting 2.0 JSON Chapters, and in-app Read Along routes:
 *   - `GET /icon.png`                                   — 512x512 raster app icon PNG
 *   - `GET /feed/:token/art/:target`                    — token-gated show & episode cover PNG/JPEG
 *   - `GET /feed/:token/chapters/:episodeId`            — Podcasting 2.0 JSON Chapters v1.2.0
 *   - `GET /listen/:token/episodes/:episodeId/article`  — token-gated Read Along text/transcript
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { notFound } from "../http.ts";
import { getUserByFeedToken } from "../auth/users.ts";
import { extractClientIp, SlidingWindowRateLimiter } from "../auth/rate_limit.ts";
import { collect } from "../storage/mod.ts";
import { isSafeBlobKey } from "../storage/blob_key.ts";
import { artworkBlobKey, fetchSafeArtworkImage } from "../artwork/generate.ts";
import { getAppIconPng, renderCoverPng } from "../artwork/png.ts";
import { buildJsonChaptersDocument } from "../synthesis/chapters.ts";
import type { Episode, User } from "../types.ts";

const ART_RATE_LIMIT = { maxRequests: 240, windowMs: 5 * 60 * 1000 } as const;
const ART_WINDOW = "feed_art_read";

async function resolveApprovedFeedUser(
  route: RouteContext<AppContext>,
): Promise<User | Response> {
  const { ctx, params, req, remoteAddr } = route;
  const token = (params.token ?? "").trim();
  if (!token) return notFound("Unknown feed");

  const limiter = new SlidingWindowRateLimiter(ART_RATE_LIMIT, ctx.stores.metadata, ART_WINDOW);
  const ip = extractClientIp(req, ctx.config.trustProxyHeaders, remoteAddr);
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

/** `GET /icon.png` — 512x512 raster PNG app icon for PWA, Apple touch icon, and Media Session. */
export async function handleAppIconPng(): Promise<Response> {
  const bytes = await getAppIconPng();
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
    },
  });
}

function stripImageExt(target: string): string {
  return target.replace(/\.(png|jpe?g|webp)$/i, "");
}

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=604800",
      "x-robots-tag": "noindex",
    },
  });
}

async function readCachedBlob(
  ctx: AppContext,
  key: string | undefined,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!key || !isSafeBlobKey(key)) return null;
  const obj = await ctx.stores.blobs.get(key).catch(() => null);
  if (!obj) return null;
  const bytes = await collect(obj.body);
  if (bytes.byteLength === 0) return null;
  const contentType = obj.contentType && obj.contentType.startsWith("image/")
    ? obj.contentType
    : key.endsWith(".jpg")
    ? "image/jpeg"
    : key.endsWith(".webp")
    ? "image/webp"
    : "image/png";
  return { bytes, contentType };
}

/**
 * `GET /feed/:token/art/:target` — token-gated show & episode cover artwork.
 *
 * Supported targets:
 *   - `master.png`
 *   - `source-<sourceId>.png`
 *   - `episode-<episodeId>.png`
 */
export async function handleFeedArtwork(route: RouteContext<AppContext>): Promise<Response> {
  const userOrErr = await resolveApprovedFeedUser(route);
  if (userOrErr instanceof Response) return userOrErr;
  const user = userOrErr;
  const { ctx, params } = route;
  const target = stripImageExt((params.target ?? "").trim());
  if (!target) return notFound("Unknown artwork");

  if (target === "master") {
    const key = artworkBlobKey(user.id, "master");
    const cached = await readCachedBlob(ctx, key);
    if (cached) return imageResponse(cached.bytes, cached.contentType);
    const png = await renderCoverPng({
      seed: `master:${user.id}`,
      title: user.displayName || "Audio Feed",
      mode: "master",
      brandPalette: true,
      size: 512,
    });
    await ctx.stores.blobs.put(key, png, { contentType: "image/png" }).catch(() => {});
    return imageResponse(png, "image/png");
  }

  if (target.startsWith("source-")) {
    const sourceId = target.slice("source-".length);
    if (!sourceId) return notFound("Unknown artwork");
    const source = await ctx.stores.metadata.getSource(user.id, sourceId);
    if (!source) return notFound("Unknown artwork");

    const cached = await readCachedBlob(ctx, source.artworkKey) ??
      await readCachedBlob(ctx, artworkBlobKey(user.id, "source", sourceId));
    if (cached) return imageResponse(cached.bytes, cached.contentType);

    if (source.imageUrl) {
      const fetched = await fetchSafeArtworkImage(source.imageUrl);
      if (fetched) {
        const key = artworkBlobKey(user.id, "source", sourceId, fetched.ext);
        await ctx.stores.blobs.put(key, fetched.bytes, { contentType: fetched.contentType }).catch(
          () => {},
        );
        return imageResponse(fetched.bytes, fetched.contentType);
      }
    }

    const png = await renderCoverPng({
      seed: `source:${source.id}:${source.title}`,
      title: source.title,
      mode: source.modes.includes("deepdive") && !source.modes.includes("direct")
        ? "deepdive"
        : "direct",
      size: 512,
    });
    const key = artworkBlobKey(user.id, "source", sourceId, "png");
    await ctx.stores.blobs.put(key, png, { contentType: "image/png" }).catch(() => {});
    return imageResponse(png, "image/png");
  }

  if (target.startsWith("episode-")) {
    const episodeId = target.slice("episode-".length);
    if (!episodeId) return notFound("Unknown artwork");
    const episode = await ctx.stores.metadata.getEpisode(user.id, episodeId);
    if (!episode) return notFound("Unknown artwork");

    const cached = await readCachedBlob(ctx, episode.artworkKey) ??
      await readCachedBlob(ctx, artworkBlobKey(user.id, "episode", episodeId, "png")) ??
      await readCachedBlob(ctx, artworkBlobKey(user.id, "episode", episodeId, "jpg"));
    if (cached) return imageResponse(cached.bytes, cached.contentType);

    const png = await renderCoverPng({
      seed: `${episode.sourceId}:${episode.id}:${episode.title}`,
      title: episode.sourceTitle ?? episode.title,
      mode: episode.mode,
      size: 512,
    });
    const key = artworkBlobKey(user.id, "episode", episodeId, "png");
    await ctx.stores.blobs.put(key, png, { contentType: "image/png" }).catch(() => {});
    return imageResponse(png, "image/png");
  }

  return notFound("Unknown artwork");
}

/**
 * `GET /feed/:token/chapters/:episodeId` — Podcasting 2.0 JSON Chapters v1.2.0.
 * Accepts `/feed/:token/chapters/<id>.json` or `/feed/:token/chapters/<id>`.
 */
export async function handleEpisodeChapters(route: RouteContext<AppContext>): Promise<Response> {
  const userOrErr = await resolveApprovedFeedUser(route);
  if (userOrErr instanceof Response) return userOrErr;
  const user = userOrErr;
  const rawId = (route.params.episodeId ?? "").trim();
  const episodeId = rawId.replace(/\.json$/i, "");
  if (!episodeId) return notFound("Unknown episode");

  const episode = await route.ctx.stores.metadata.getEpisode(user.id, episodeId);
  if (!episode) return notFound("Unknown episode");

  const doc = buildJsonChaptersDocument(episode.chapters ?? []);
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: {
      "content-type": "application/json+chapters; charset=utf-8",
      "cache-control": "private, max-age=3600",
      "x-robots-tag": "noindex",
    },
  });
}

function safePublicHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function formatReadAlongPayload(episode: Episode, article: {
  title?: string;
  author?: string;
  url?: string;
  content?: string;
} | null) {
  const rawText = episode.mode === "deepdive" && episode.transcript
    ? episode.transcript
    : article?.content ?? episode.transcript ?? episode.description ?? "";
  const paragraphs = rawText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 400);
  return {
    id: episode.id,
    title: episode.title,
    author: article?.author,
    source: episode.sourceTitle ?? episode.sourceId,
    url: safePublicHttpUrl(article?.url),
    mode: episode.mode,
    chapters: episode.chapters ?? [],
    paragraphs,
  };
}

/**
 * `GET /listen/:token/episodes/:episodeId/article` — in-app Read Along & transcript payload.
 */
export async function handleListenArticle(route: RouteContext<AppContext>): Promise<Response> {
  const userOrErr = await resolveApprovedFeedUser(route);
  if (userOrErr instanceof Response) return userOrErr;
  const user = userOrErr;
  const episodeId = (route.params.episodeId ?? "").trim();
  if (!episodeId) return notFound("Unknown episode");

  const episode = await route.ctx.stores.metadata.getEpisode(user.id, episodeId);
  if (!episode) return notFound("Unknown episode");
  const article = await route.ctx.stores.metadata.getArticle(user.id, episode.articleId);

  return new Response(JSON.stringify(formatReadAlongPayload(episode, article)), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
