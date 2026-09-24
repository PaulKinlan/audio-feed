/**
 * Shared feed types for audio-feed.
 *
 * Kept deliberately small: a source is a subscribable origin (an RSS feed or a
 * blog), an episode is one synthesised audio file attached to a source.
 */

/** The two audio presentations an episode can be generated in. */
export type EpisodeKind = "direct" | "deepdive";

export interface FeedSource {
  /** URL slug. Appears in /feed/<id>/direct.xml and /feed/<id>/deepdive.xml */
  id: string;
  /** Human title, used for the per-source channel and master episode prefixes. */
  title: string;
  /** Upstream site the articles come from, e.g. https://stratechery.com */
  link?: string;
  description?: string;
  /** Default voice preset for this source (Aoede, Charon, Fenrir, Kore, Puck). */
  voice?: string;
  imageUrl?: string;
  language?: string;
}

export interface Episode {
  /** Stable, unique id. Doubles as the RSS <guid>. */
  guid: string;
  title: string;
  /** ISO 8601 timestamp. Rendered as RFC 2822 for RSS <pubDate>. */
  pubDate: string;
  /** Public or signed URL to the synthesised audio file. */
  audioUrl: string;
  /** May contain HTML; emitted inside CDATA. */
  description?: string;
  kind?: EpisodeKind;
  /** Source this episode belongs to. Required for master-feed attribution. */
  sourceId?: string;
  /** Source title preserved for attribution if the source is deleted (audio-feed-ap6). */
  sourceTitle?: string;
  /** Article the audio was generated from. */
  link?: string;
  /** Bytes of the audio file. Encoders should set this; 0 is emitted if absent. */
  byteLength?: number;
  mimeType?: string;
  durationSeconds?: number;
  season?: number;
  episodeNumber?: number;
  /** Podcast 2.0 chapters JSON URL (deep dives emit chapter markers). */
  chaptersUrl?: string;
}

/** Channel-level metadata for a generated feed. */
export interface ChannelMeta {
  title: string;
  /** Absolute URL of the feed itself, emitted as atom:link rel="self". */
  selfUrl: string;
  /** Site URL shown in players. */
  link: string;
  description: string;
  imageUrl?: string;
  author?: string;
  ownerEmail?: string;
  language?: string;
  copyright?: string;
  explicit?: boolean;
  categories?: string[];
}
