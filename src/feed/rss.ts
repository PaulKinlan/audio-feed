/**
 * Podcast RSS 2.0 / iTunes feed generation.
 *
 * Three feed shapes, per PRODUCT.md:
 *   /feed/<source-id>/direct.xml    single-voice author reads
 *   /feed/<source-id>/deepdive.xml  two-voice NotebookLM-style discussions
 *   /feed/master.xml                every subscribed episode, one feed
 *
 * No XML library: the output surface is small, fixed, and fully covered by
 * tests/feed/rss_test.ts.
 */
import type { ChannelMeta, Episode, EpisodeKind, FeedSource } from "./types.ts";

export const ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd";
export const ATOM_NS = "http://www.w3.org/2005/Atom";
export const PODCAST_NS = "https://podcastindex.org/namespace/1.0";
export const DEFAULT_MIME = "audio/mpeg";

/** Characters XML 1.0 forbids outright, including raw control chars from TTS output. */
// deno-lint-ignore no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Description fields may carry HTML, so they ship as CDATA. */
export function cdata(value: string): string {
  // `]]>` cannot appear inside CDATA. Splitting into two sections preserves the
  // literal text exactly; entity-escaping would not (&gt; is not decoded here).
  const safe = value.replace(INVALID_XML, "").replace(/]]>/g, "]]]]><![CDATA[>");
  return `<![CDATA[${safe}]]>`;
}

/** RSS pubDate is RFC 2822. Always emit UTC so players cannot misread the offset. */
export function toRfc2822(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid pubDate: ${iso}`);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${
    months[date.getUTCMonth()]
  } ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${
    pad(date.getUTCSeconds())
  } +0000`;
}

/** itunes:duration accepts seconds or HH:MM:SS. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

export function directFeedUrl(origin: string, sourceId: string): string {
  return `${origin}/feed/${sourceId}/direct.xml`;
}

export function deepDiveFeedUrl(origin: string, sourceId: string): string {
  return `${origin}/feed/${sourceId}/deepdive.xml`;
}

export function masterFeedUrl(origin: string): string {
  return `${origin}/feed/master.xml`;
}

/** Newest first, and one entry per guid even if a caller passes duplicates. */
function normalise(episodes: Episode[]): Episode[] {
  const seen = new Set<string>();
  return [...episodes]
    .filter((episode) => {
      if (seen.has(episode.guid)) return false;
      seen.add(episode.guid);
      return true;
    })
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
}

function itemXml(episode: Episode, title: string): string {
  const lines = [
    "    <item>",
    `      <title>${escapeXml(title)}</title>`,
    `      <guid isPermaLink="false">${escapeXml(episode.guid)}</guid>`,
    `      <pubDate>${toRfc2822(episode.pubDate)}</pubDate>`,
  ];

  if (episode.link) lines.push(`      <link>${escapeXml(episode.link)}</link>`);
  if (episode.description) {
    lines.push(`      <description>${cdata(episode.description)}</description>`);
  }
  if (episode.durationSeconds !== undefined) {
    lines.push(
      `      <itunes:duration>${formatDuration(episode.durationSeconds)}</itunes:duration>`,
    );
  }
  if (episode.season !== undefined) {
    lines.push(`      <itunes:season>${episode.season}</itunes:season>`);
  }
  if (episode.episodeNumber !== undefined) {
    lines.push(`      <itunes:episode>${episode.episodeNumber}</itunes:episode>`);
  }
  if (episode.kind) {
    lines.push(
      `      <itunes:episodeType>${
        episode.kind === "deepdive" ? "bonus" : "full"
      }</itunes:episodeType>`,
    );
  }
  if (episode.chaptersUrl) {
    lines.push(
      `      <podcast:chapters url="${
        escapeXml(episode.chaptersUrl)
      }" type="application/json+chapters"/>`,
    );
  }

  lines.push(
    `      <enclosure url="${escapeXml(episode.audioUrl)}" length="${
      episode.byteLength ?? 0
    }" type="${escapeXml(episode.mimeType ?? DEFAULT_MIME)}"/>`,
    "    </item>",
  );
  return lines.join("\n");
}

/**
 * Build a complete feed document.
 *
 * `titleFor` lets the master feed attribute an episode to its source
 * ("Stratechery: …") without rewriting the stored title.
 */
export function buildFeed(
  channel: ChannelMeta,
  episodes: Episode[],
  options: { titleFor?: (episode: Episode) => string } = {},
): string {
  const titleFor = options.titleFor ?? ((episode: Episode) => episode.title);
  const sorted = normalise(episodes);
  const lastBuild = sorted[0]?.pubDate ?? new Date().toISOString();

  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"',
    `  xmlns:itunes="${ITUNES_NS}"`,
    `  xmlns:atom="${ATOM_NS}"`,
    `  xmlns:podcast="${PODCAST_NS}">`,
    "  <channel>",
    `    <title>${escapeXml(channel.title)}</title>`,
    `    <link>${escapeXml(channel.link)}</link>`,
    `    <description>${escapeXml(channel.description)}</description>`,
    `    <language>${escapeXml(channel.language ?? "en")}</language>`,
    `    <lastBuildDate>${toRfc2822(lastBuild)}</lastBuildDate>`,
    `    <generator>audio-feed</generator>`,
    `    <atom:link href="${escapeXml(channel.selfUrl)}" rel="self" type="application/rss+xml"/>`,
    `    <itunes:explicit>${channel.explicit ? "true" : "false"}</itunes:explicit>`,
  ];

  if (channel.author) head.push(`    <itunes:author>${escapeXml(channel.author)}</itunes:author>`);
  if (channel.copyright) head.push(`    <copyright>${escapeXml(channel.copyright)}</copyright>`);
  if (channel.ownerEmail) {
    head.push(
      "    <itunes:owner>",
      `      <itunes:name>${escapeXml(channel.author ?? channel.title)}</itunes:name>`,
      `      <itunes:email>${escapeXml(channel.ownerEmail)}</itunes:email>`,
      "    </itunes:owner>",
    );
  }
  for (const category of channel.categories ?? []) {
    head.push(`    <itunes:category text="${escapeXml(category)}"/>`);
  }
  if (channel.imageUrl) {
    head.push(
      `    <itunes:image href="${escapeXml(channel.imageUrl)}"/>`,
      "    <image>",
      `      <url>${escapeXml(channel.imageUrl)}</url>`,
      `      <title>${escapeXml(channel.title)}</title>`,
      `      <link>${escapeXml(channel.link)}</link>`,
      "    </image>",
    );
  }

  const body = sorted.map((episode) => itemXml(episode, titleFor(episode)));
  return [...head, ...body, "  </channel>", "</rss>", ""].join("\n");
}

/** Per-source feed for one presentation mode. */
export function buildSourceFeed(
  options: {
    origin: string;
    source: FeedSource;
    kind: EpisodeKind;
    episodes: Episode[];
    ownerEmail?: string;
  },
): string {
  const { origin, source, kind, episodes, ownerEmail } = options;
  const modeLabel = kind === "deepdive" ? "Deep Dive" : "Direct Read";
  return buildFeed(
    {
      title: `${source.title} — ${modeLabel}`,
      link: source.link ?? origin,
      selfUrl: (kind === "deepdive" ? deepDiveFeedUrl : directFeedUrl)(origin, source.id),
      description: source.description ??
        `${modeLabel} audio of ${source.title} articles.` +
          (kind === "deepdive" ? " Two-voice discussion with background research." : ""),
      imageUrl: source.imageUrl,
      author: source.title,
      language: source.language ?? "en",
      ownerEmail,
      categories: ["News", "Technology"],
    },
    episodes.filter((episode) =>
      episode.sourceId === source.id &&
      (episode.kind === undefined || episode.kind === kind)
    ),
  );
}

/** Master feed: every episode, newest first, titled with its source. */
export function buildMasterFeed(
  options: {
    origin: string;
    episodes: Episode[];
    sources?: FeedSource[];
    title?: string;
    ownerEmail?: string;
    imageUrl?: string;
  },
): string {
  const { origin, episodes, sources = [], title, ownerEmail, imageUrl } = options;
  const titles = new Map(sources.map((source) => [source.id, source.title]));
  const channelTitle = title ?? "Audio Feed";

  return buildFeed(
    {
      title: channelTitle,
      link: origin,
      selfUrl: masterFeedUrl(origin),
      description: "All subscribed audio-feed episodes: direct reads and deep dives.",
      imageUrl,
      author: channelTitle,
      ownerEmail,
      language: "en",
      categories: ["News", "Technology"],
    },
    episodes,
    {
      // Attribute only when the source is known, so titles never read "undefined: …".
      titleFor: (episode) => {
        const sourceTitle = episode.sourceId ? titles.get(episode.sourceId) : undefined;
        return sourceTitle ? `${sourceTitle}: ${episode.title}` : episode.title;
      },
    },
  );
}
