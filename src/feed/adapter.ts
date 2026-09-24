/**
 * Storage record → feed record projection (audio-feed-b0a).
 *
 * Two unrelated types are both called `Episode`: the store persists one
 * (`src/types.ts` — id, userId, articleId, mode, status, audioKey…) and the RSS
 * generator consumes the other (`src/feed/types.ts` — guid, pubDate, audioUrl,
 * kind…). They compiled and passed their own tests precisely because the two
 * halves never met; the moment a feed was generated from stored episodes the gaps
 * became real decisions. This module owns those decisions, and nothing else in
 * the project converts between the two shapes.
 *
 * The rules, each of which was a judgement call:
 *
 * - `id → guid`. The episode id is already unique and stable, so it is the guid.
 * - `mode → kind`. Same `direct | deepdive` union under two names.
 * - `audioKey → audioUrl`. A blob key is not a URL. Feeds use the stable
 *   `/audio/:key` proxy path, NEVER a store-signed URL: a signed URL expires
 *   (S3/R2 default 1h) and a podcast client polls the same enclosure for months,
 *   so a signed enclosure is a feed that breaks an hour after it is published.
 * - `readyAt ?? createdAt → pubDate`. `createdAt` is when the job was queued and
 *   `readyAt` is when audio existed; clients sort by pubDate, so the audio's own
 *   timestamp is the honest one.
 * - `contentType → mimeType`, `durationSeconds → durationSeconds` unchanged.
 * - `status` has NO feed equivalent, so the filter lives here: an episode that is
 *   not `ready` with real bytes projects to `null`. Otherwise the generator would
 *   render an item whose enclosure URL 404s.
 *
 * Do NOT widen either type to satisfy the other. This projection is the seam.
 */
import { type Episode as StoredEpisode, isPublishable, type Source } from "../types.ts";
import type { Episode as FeedEpisode, FeedSource } from "./types.ts";

export interface FeedProjectionContext {
  /** Absolute site origin, e.g. https://audio.example.com */
  publicBaseUrl: string;
  /**
   * Size to publish when the stored record has none (or has `0`, which is the
   * same "unknown" state). The caller fills this from the blob store, because
   * deciding it needs IO and this module stays pure.
   */
  byteLength?: number;
}

/** The stable, non-expiring enclosure path served by `GET /audio/:key`. */
export function enclosureUrl(publicBaseUrl: string, audioKey: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/audio/${audioKey}`;
}

/**
 * Project one stored episode for the generator, or `null` when it must not be
 * syndicated. Returning null rather than throwing keeps a partially-written
 * catalogue from taking a whole feed down.
 */
export function toFeedEpisode(
  episode: StoredEpisode,
  context: FeedProjectionContext,
): FeedEpisode | null {
  if (!isPublishable(episode)) return null;

  const recorded = episode.byteLength && episode.byteLength > 0 ? episode.byteLength : undefined;
  return {
    guid: episode.id,
    title: episode.title,
    pubDate: episode.readyAt ?? episode.createdAt,
    audioUrl: enclosureUrl(context.publicBaseUrl, episode.audioKey),
    description: episode.description,
    kind: episode.mode,
    sourceId: episode.sourceId,
    sourceTitle: episode.sourceTitle,
    byteLength: recorded ?? context.byteLength,
    mimeType: episode.contentType,
    durationSeconds: episode.durationSeconds,
  };
}

/** Project a whole list, dropping everything unpublishable. */
export function toFeedEpisodes(
  episodes: StoredEpisode[],
  context: FeedProjectionContext,
): FeedEpisode[] {
  const projected: FeedEpisode[] = [];
  for (const episode of episodes) {
    const feedEpisode = toFeedEpisode(episode, context);
    if (feedEpisode) projected.push(feedEpisode);
  }
  return projected;
}

/**
 * Project a stored source for channel metadata. The store's `title`/`siteUrl`
 * are what a subscriber sees; `feedUrl` is deliberately ignored because the feed
 * URL is built from the capability token, not stored on the source.
 */
export function toFeedSource(source: Source): FeedSource {
  return {
    id: source.id,
    title: source.title,
    link: source.siteUrl,
    description: source.title,
  };
}
