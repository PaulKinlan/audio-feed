/**
 * YouTube video transcript ingestion (Issue #54).
 *
 * Turns public YouTube URLs (watch, youtu.be, shorts, live, mobile, embed) into
 * structured `ExtractedArticle` records complete with thumbnail artwork and
 * chapter-aligned transcript paragraphs ready for TTS narration and Podcasting 2.0
 * JSON Chapters.
 *
 * Security & runtime invariants:
 * - Strict allowlist of YouTube hosts and 11-character `[A-Za-z0-9_-]{11}` video IDs;
 *   spoofed hosts (e.g. `evil-youtube.com`, `youtube.com.evil.com`), credentials,
 *   non-standard ports, and non-HTTP(S) schemes are rejected.
 * - Every outbound request (watch page, redirect hops, and caption track URL) passes
 *   through `articleUrl` validation, bounded redirect hops, and `readBounded` caps.
 * - `ytInitialPlayerResponse` extraction uses a linear-time JSON-aware balanced-brace
 *   scanner (no backtracking regex / ReDoS).
 * - Any injected `fetchFn` is invoked detached (`const doFetch = fetchFn; doFetch(...)`)
 *   for Cloudflare Workers (`workerd`) safety.
 */
import {
  articleUrl,
  clean,
  type ExtractedArticle,
  IngestError,
  MAX_ARTICLE_CONTENT_CHARS,
  readBounded,
  requestPublic,
  type Transport,
} from "./url.ts";

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_MAIN_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const YOUTUBE_SHORT_HOSTS: ReadonlySet<string> = new Set([
  "youtu.be",
  "www.youtu.be",
]);

export const MAX_YOUTUBE_HTML_BYTES = 4 * 1024 * 1024;
export const MAX_YOUTUBE_CAPTION_BYTES = 4 * 1024 * 1024;
const YOUTUBE_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 5;
const MAX_PLAYER_RESPONSE_ATTEMPTS = 16;

export interface YouTubeCaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  name?: {
    simpleText?: string;
    runs?: Array<{ text?: string }>;
  };
  isTranslatable?: boolean;
}

export interface YouTubeChapter {
  startSeconds: number;
  title: string;
}

export interface YouTubeCaptionCue {
  startSeconds: number;
  durationSeconds: number;
  text: string;
}

export interface YouTubeExtractOptions {
  /** SSRF-safe transport (defaults to `requestPublic` from `src/ingest/url.ts`). */
  transport?: Transport;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Overall timeout in milliseconds (defaults to 15_000). */
  timeoutMs?: number;
  /** Preferred caption language code (defaults to `"en"`). */
  preferredLanguage?: string;
}

/**
 * Parse and strictly validate a YouTube video ID from a public YouTube URL.
 *
 * Accepts:
 * - `youtube.com/watch?v=<id>` (including `www.`, `m.`, `music.`)
 * - `youtu.be/<id>`
 * - `youtube.com/shorts/<id>`
 * - `youtube.com/live/<id>`
 * - `youtube.com/embed/<id>` (and `youtube-nocookie.com/embed/<id>`)
 *
 * Rejects spoofed hosts, credentials, non-standard ports, non-HTTP(S) URLs,
 * and IDs that are not strictly 11 characters in `[A-Za-z0-9_-]`.
 */
export function parseYouTubeVideoId(input: string): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  let candidate: string | null = null;

  if (YOUTUBE_SHORT_HOSTS.has(host)) {
    if (segments.length === 1) {
      candidate = segments[0] ?? null;
    }
  } else if (YOUTUBE_MAIN_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === "watch") {
      candidate = url.searchParams.get("v");
    } else if (
      segments.length === 2 &&
      (segments[0] === "shorts" || segments[0] === "live" || segments[0] === "embed")
    ) {
      candidate = segments[1] ?? null;
    }
  } else {
    return null;
  }

  if (!candidate || !YOUTUBE_VIDEO_ID_RE.test(candidate)) return null;
  return candidate;
}

/**
 * Extract the `ytInitialPlayerResponse` JSON object from a YouTube watch page
 * using a linear-time, JSON-string-aware balanced-brace scanner (no ReDoS).
 */
export function extractYtInitialPlayerResponse(html: string): Record<string, unknown> | null {
  const marker = "ytInitialPlayerResponse";
  const maxScannedChars = Math.max(html.length * 2, 1024);
  let totalScanned = 0;
  let searchPos = 0;
  let attempts = 0;

  while (attempts < MAX_PLAYER_RESPONSE_ATTEMPTS && totalScanned < maxScannedChars) {
    const idx = html.indexOf(marker, searchPos);
    if (idx === -1) return null;
    searchPos = idx + marker.length;

    // Require an identifier boundary immediately before the marker.
    if (idx > 0) {
      const prev = html[idx - 1]!;
      if (/[A-Za-z0-9_$]/.test(prev)) continue;
    }

    let cursor = idx + marker.length;
    // Allow bracket notation: window["ytInitialPlayerResponse"] = {...}
    if (
      (html[cursor] === '"' || html[cursor] === "'") &&
      html[cursor + 1] === "]"
    ) {
      cursor += 2;
    }

    while (cursor < html.length && /\s/.test(html[cursor]!)) cursor++;
    // Must be an assignment `=`, not `==` or `===`.
    if (html[cursor] !== "=" || html[cursor + 1] === "=") continue;
    cursor++;
    while (cursor < html.length && /\s/.test(html[cursor]!)) cursor++;
    if (html[cursor] !== "{") continue;

    attempts++;
    const jsonStart = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let jsonEnd = -1;

    for (let i = jsonStart; i < html.length; i++) {
      totalScanned++;
      if (totalScanned > maxScannedChars) return null;
      const ch = html[i]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }

    if (jsonEnd === -1) {
      // Unclosed brace reached EOF; stop scanning further occurrences.
      return null;
    }

    searchPos = jsonEnd;
    try {
      const parsed: unknown = JSON.parse(html.slice(jsonStart, jsonEnd));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue to next occurrence if this snippet was not valid JSON.
    }
  }

  return null;
}

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
};

/**
 * Single-pass HTML entity decoder.
 *
 * Decodes numeric decimal (`&#39;`), numeric hex (`&#x27;`), and standard named
 * entities in a single regex pass so `&amp;lt;` decodes once to `&lt;` and never
 * double-decodes into `<`.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(
    /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z]{2,12}));/g,
    (match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (dec !== undefined) {
        const cp = Number.parseInt(dec, 10);
        if (cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          return String.fromCodePoint(cp);
        }
        return cp === 9 || cp === 10 || cp === 13 ? " " : match;
      }
      if (hex !== undefined) {
        const cp = Number.parseInt(hex, 16);
        if (cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          return String.fromCodePoint(cp);
        }
        return cp === 9 || cp === 10 || cp === 13 ? " " : match;
      }
      if (named !== undefined) {
        return NAMED_HTML_ENTITIES[named.toLowerCase()] ?? match;
      }
      return match;
    },
  );
}

/**
 * Choose the best caption track from `playerCaptionsTracklistRenderer.captionTracks`.
 *
 * Priority:
 * 1. Manual track matching preferred language (exact match before regional prefix, e.g. `en` before `en-US`)
 * 2. Any manual (human-authored) track
 * 3. Auto-generated ASR track (`kind === "asr"`) matching preferred language
 * 4. First remaining track with a non-empty `baseUrl`
 */
export function selectCaptionTrack(
  tracks: readonly YouTubeCaptionTrack[],
  preferredLanguage = "en",
): YouTubeCaptionTrack | null {
  const usable = tracks.filter(
    (t): t is YouTubeCaptionTrack =>
      !!t && typeof t.baseUrl === "string" && t.baseUrl.trim().length > 0,
  );
  if (usable.length === 0) return null;

  const pref = preferredLanguage.trim().toLowerCase() || "en";
  const prefBase = pref.split("-")[0]!;

  const isAsr = (t: YouTubeCaptionTrack) => t.kind?.toLowerCase() === "asr";
  const langOf = (t: YouTubeCaptionTrack) => (t.languageCode ?? "").trim().toLowerCase();
  const isExactLang = (t: YouTubeCaptionTrack) => langOf(t) === pref;
  const isBaseLang = (t: YouTubeCaptionTrack) => {
    const code = langOf(t);
    return code === prefBase || code.startsWith(`${prefBase}-`);
  };

  const manual = usable.filter((t) => !isAsr(t));
  const asr = usable.filter((t) => isAsr(t));

  return (
    manual.find(isExactLang) ??
      manual.find(isBaseLang) ??
      manual[0] ??
      asr.find(isExactLang) ??
      asr.find(isBaseLang) ??
      usable[0] ??
      null
  );
}

function parseTimestampToSeconds(raw: string): number | null {
  const parts = raw.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [minutes, seconds] = parts as [number, number];
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts as [number, number, number];
    if (minutes >= 60 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

function cleanChapterTitle(raw: string): string {
  return clean(raw)
    .replace(/^[-–—:|•*]+\s*/, "")
    .replace(/\s*[-–—:|]+$/, "")
    .trim()
    .slice(0, 96);
}

const LEADING_CHAPTER_RE =
  /^(?:[-*•]\s*)?[\[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*(?:[-–—:|]\s*)?(.+)$/;
const TRAILING_CHAPTER_RE =
  /^(?:[-*•]\s*)?(.+?)\s+(?:[-–—:|]\s*)?[\[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?$/;

/**
 * Parse video chapter markers from a YouTube video's `shortDescription`.
 *
 * Supports common formats such as:
 * - `0:00 Intro`
 * - `04:30 - Architecture`
 * - `1:02:15 | Scaling`
 * - `[00:00] Opening`
 * - `Intro - 0:00`
 *
 * Returns chapters in strictly ascending timestamp order when at least two
 * valid chapter markers are found.
 */
export function parseYouTubeChapters(
  description: string,
  durationSeconds?: number,
): YouTubeChapter[] {
  if (!description) return [];
  const runs: YouTubeChapter[][] = [];
  let currentRun: YouTubeChapter[] = [];

  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.length > 240) continue;

    let tsRaw: string | null = null;
    let titleRaw: string | null = null;

    const leading = LEADING_CHAPTER_RE.exec(line);
    if (leading?.[1] && leading[2]) {
      tsRaw = leading[1];
      titleRaw = leading[2];
    } else {
      const trailing = TRAILING_CHAPTER_RE.exec(line);
      if (trailing?.[1] && trailing[2] && !/(?:^|\s)https?:\/\//i.test(trailing[1])) {
        titleRaw = trailing[1];
        tsRaw = trailing[2];
      }
    }

    if (!tsRaw || !titleRaw) continue;
    const startSeconds = parseTimestampToSeconds(tsRaw);
    if (startSeconds === null) continue;
    if (
      typeof durationSeconds === "number" &&
      Number.isFinite(durationSeconds) &&
      durationSeconds > 0 &&
      startSeconds >= durationSeconds
    ) {
      continue;
    }

    const title = cleanChapterTitle(titleRaw);
    if (title.length < 2) continue;

    const prev = currentRun[currentRun.length - 1];
    if (prev && startSeconds <= prev.startSeconds) {
      if (currentRun.length > 0) runs.push(currentRun);
      currentRun = [{ startSeconds, title }];
    } else {
      currentRun.push({ startSeconds, title });
    }
  }
  if (currentRun.length > 0) runs.push(currentRun);

  const validRuns = runs.filter((run) => run.length >= 2);
  if (validRuns.length === 0) return [];

  // Prefer the longest run starting at 0:00; otherwise pick the longest ascending run.
  const zeroRuns = validRuns.filter((run) => run[0]!.startSeconds === 0);
  const candidates = zeroRuns.length > 0 ? zeroRuns : validRuns;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0]!;
}

/** Parse YouTube `fmt=json3` captions into normalized timed cues. */
export function parseJson3Captions(raw: string): YouTubeCaptionCue[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const events = (payload as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];

  const cues: YouTubeCaptionCue[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as {
      tStartMs?: unknown;
      dDurationMs?: unknown;
      segs?: unknown;
    };
    if (!Array.isArray(record.segs)) continue;
    const combined = record.segs
      .map((seg) =>
        seg && typeof seg === "object" && typeof (seg as { utf8?: unknown }).utf8 === "string"
          ? (seg as { utf8: string }).utf8
          : ""
      )
      .join("");
    const text = clean(decodeHtmlEntities(combined));
    if (!text) continue;
    const startMs = typeof record.tStartMs === "number" && Number.isFinite(record.tStartMs)
      ? Math.max(0, record.tStartMs)
      : 0;
    const durMs = typeof record.dDurationMs === "number" && Number.isFinite(record.dDurationMs)
      ? Math.max(0, record.dDurationMs)
      : 0;
    cues.push({
      startSeconds: startMs / 1000,
      durationSeconds: durMs / 1000,
      text,
    });
  }

  return cues.sort((a, b) => a.startSeconds - b.startSeconds);
}

const XML_ATTR_PATTERNS: Readonly<Record<"start" | "dur" | "t" | "d", RegExp>> = {
  start: /\bstart\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  dur: /\bdur\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  t: /\bt\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  d: /\bd\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
};

function readXmlAttr(attrs: string, name: "start" | "dur" | "t" | "d"): number {
  const match = XML_ATTR_PATTERNS[name].exec(attrs);
  const value = match?.[1] ?? match?.[2];
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function stripInlineXmlTags(raw: string): string {
  return raw.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
}

/**
 * Parse YouTube XML captions (`<text start="..." dur="...">` or timedtext `<p t="..." d="...">`)
 * into normalized timed cues with clean single-pass HTML entity decoding.
 */
export function parseXmlCaptions(raw: string): YouTubeCaptionCue[] {
  const cues: YouTubeCaptionCue[] = [];

  const textTagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = textTagRe.exec(raw)) !== null) {
    const attrs = match[1] ?? "";
    const inner = stripInlineXmlTags(match[2] ?? "");
    const text = clean(decodeHtmlEntities(inner));
    if (!text) continue;
    cues.push({
      startSeconds: readXmlAttr(attrs, "start"),
      durationSeconds: readXmlAttr(attrs, "dur"),
      text,
    });
  }

  if (cues.length === 0) {
    const pTagRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((match = pTagRe.exec(raw)) !== null) {
      const attrs = match[1] ?? "";
      const inner = stripInlineXmlTags(match[2] ?? "");
      const text = clean(decodeHtmlEntities(inner));
      if (!text) continue;
      cues.push({
        startSeconds: readXmlAttr(attrs, "t") / 1000,
        durationSeconds: readXmlAttr(attrs, "d") / 1000,
        text,
      });
    }
  }

  return cues.sort((a, b) => a.startSeconds - b.startSeconds);
}

/** Auto-detect and parse either JSON3 or XML YouTube caption payloads. */
export function parseYouTubeCaptions(raw: string): YouTubeCaptionCue[] {
  const trimmed = raw.trimStart();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    const jsonCues = parseJson3Captions(trimmed);
    if (jsonCues.length > 0) return jsonCues;
    return parseXmlCaptions(trimmed);
  }
  if (trimmed.startsWith("<")) {
    const xmlCues = parseXmlCaptions(trimmed);
    if (xmlCues.length > 0) return xmlCues;
    return parseJson3Captions(trimmed);
  }
  const jsonCues = parseJson3Captions(trimmed);
  return jsonCues.length > 0 ? jsonCues : parseXmlCaptions(trimmed);
}

const PARAGRAPH_SOFT_CHARS = 450;
const PARAGRAPH_HARD_CHARS = 700;
const PAUSE_BREAK_SECONDS = 2.5;
const PAUSE_MIN_PARAGRAPH_CHARS = 120;

function groupCuesIntoParagraphs(cues: readonly YouTubeCaptionCue[]): string[] {
  const paragraphs: string[] = [];
  let parts: string[] = [];
  let charCount = 0;
  let prevEndSeconds = 0;

  const flush = () => {
    if (parts.length === 0) return;
    const merged = clean(parts.join(" "));
    if (merged) paragraphs.push(merged);
    parts = [];
    charCount = 0;
  };

  for (const cue of cues) {
    const text = clean(cue.text);
    if (!text) continue;

    if (parts.length > 0) {
      const gap = cue.startSeconds - prevEndSeconds;
      const prevText = parts[parts.length - 1]!;
      const endsSentence = /[.!?]["')\]]*$/.test(prevText);

      if (
        (gap >= PAUSE_BREAK_SECONDS && charCount >= PAUSE_MIN_PARAGRAPH_CHARS) ||
        (charCount >= PARAGRAPH_SOFT_CHARS && endsSentence) ||
        charCount >= PARAGRAPH_HARD_CHARS
      ) {
        flush();
      }
    }

    parts.push(text);
    charCount += text.length + 1;
    prevEndSeconds = Math.max(
      prevEndSeconds,
      cue.startSeconds + Math.max(0, cue.durationSeconds),
    );
  }

  flush();
  return paragraphs;
}

/**
 * Group timed transcript cues into readable paragraphs, inserting standalone chapter
 * heading paragraphs aligned with video chapter timestamps so downstream chaptering
 * (`src/synthesis/chapters.ts`) and Read-Along alignment (`src/synthesis/transcript.ts`)
 * pick up every chapter boundary cleanly.
 */
export function formatYouTubeTranscript(
  cues: readonly YouTubeCaptionCue[],
  chapters: readonly YouTubeChapter[] = [],
): { body: string; lead: string; headings: string[] } {
  if (cues.length === 0) {
    return { body: "", lead: "", headings: [] };
  }

  if (chapters.length === 0) {
    const paragraphs = groupCuesIntoParagraphs(cues);
    const body = paragraphs.join("\n\n");
    const lead = (paragraphs[0] ?? body).slice(0, 300);
    return { body, lead, headings: [] };
  }

  const blocks: string[] = [];
  const headings: string[] = [];
  const seenHeadings = new Set<string>();
  let firstSpokenParagraph = "";

  // Any cues before the first chapter timestamp form an opening untitled section.
  const firstChapterStart = chapters[0]!.startSeconds;
  const preCues = cues.filter((c) => c.startSeconds < firstChapterStart);
  if (preCues.length > 0) {
    const preParas = groupCuesIntoParagraphs(preCues);
    if (preParas[0] && !firstSpokenParagraph) firstSpokenParagraph = preParas[0];
    blocks.push(...preParas);
  }

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const nextStart = i + 1 < chapters.length ? chapters[i + 1]!.startSeconds : Infinity;
    const sectionCues = cues.filter(
      (c) => c.startSeconds >= chapter.startSeconds && c.startSeconds < nextStart,
    );
    const sectionParas = groupCuesIntoParagraphs(sectionCues);
    if (sectionParas.length === 0) continue;

    const headingTitle = cleanChapterTitle(chapter.title);
    const key = headingTitle.toLowerCase();
    if (headingTitle.length >= 3 && !seenHeadings.has(key)) {
      seenHeadings.add(key);
      headings.push(headingTitle);
      blocks.push(headingTitle);
    }
    if (!firstSpokenParagraph) firstSpokenParagraph = sectionParas[0]!;
    blocks.push(...sectionParas);
  }

  if (blocks.length === 0) {
    const fallbackParas = groupCuesIntoParagraphs(cues);
    const body = fallbackParas.join("\n\n");
    return { body, lead: (fallbackParas[0] ?? body).slice(0, 300), headings: [] };
  }

  const body = blocks.join("\n\n");
  const lead = (firstSpokenParagraph || body).slice(0, 300);
  return { body, lead, headings };
}

function sanitizeText(text: string, maxLength: number): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 32 && code !== 127 && !(code >= 128 && code <= 159)) {
      out += text[i];
    } else {
      out += " ";
    }
  }
  return clean(out).slice(0, maxLength);
}

function selectThumbnailUrl(
  playerResponse: Record<string, unknown>,
  videoId: string,
): string | null {
  const videoDetails = playerResponse.videoDetails as Record<string, unknown> | undefined;
  const microformat = (playerResponse.microformat as Record<string, unknown> | undefined)
    ?.playerMicroformatRenderer as Record<string, unknown> | undefined;

  const rawThumbLists = [
    (videoDetails?.thumbnail as { thumbnails?: unknown } | undefined)?.thumbnails,
    (microformat?.thumbnail as { thumbnails?: unknown } | undefined)?.thumbnails,
  ].filter(Array.isArray) as Array<Array<{ url?: unknown; width?: unknown; height?: unknown }>>;

  if (rawThumbLists.length === 0) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  let bestUrl: string | null = null;
  let bestArea = -1;
  for (const list of rawThumbLists) {
    for (const item of list) {
      if (!item || typeof item.url !== "string" || !item.url.trim()) continue;
      let validated: string;
      try {
        validated = articleUrl(item.url.trim()).href;
      } catch {
        continue;
      }
      const w = typeof item.width === "number" && Number.isFinite(item.width) ? item.width : 0;
      const h = typeof item.height === "number" && Number.isFinite(item.height) ? item.height : 0;
      const area = w * h;
      if (bestUrl === null || area >= bestArea) {
        bestUrl = validated;
        bestArea = area;
      }
    }
  }
  return bestUrl;
}

function extractPublishedDate(playerResponse: Record<string, unknown>): string | null {
  const microformat = (playerResponse.microformat as Record<string, unknown> | undefined)
    ?.playerMicroformatRenderer as Record<string, unknown> | undefined;
  const raw = typeof microformat?.publishDate === "string"
    ? microformat.publishDate
    : typeof microformat?.uploadDate === "string"
    ? microformat.uploadDate
    : "";
  const trimmed = clean(raw);
  if (!trimmed) return null;
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : new Date(ts).toISOString();
}

function decompressStream(
  body: ReadableStream<Uint8Array> | null,
  encoding: string | null,
): ReadableStream<Uint8Array> | null {
  if (!body || !encoding) return body;
  const normalized = encoding.trim().toLowerCase();
  if (normalized === "" || normalized === "identity") return body;
  if (normalized === "gzip" || normalized === "x-gzip") {
    return body.pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  }
  if (normalized === "deflate") {
    return body.pipeThrough(
      new DecompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  }
  throw new IngestError(422, `Article uses an unsupported content-encoding: ${encoding}.`);
}

async function fetchPublicYouTubeText(
  inputUrl: string,
  params: {
    fetchFn?: typeof fetch;
    transport?: Transport;
    signal: AbortSignal;
    maxBytes: number;
    accept: string;
    resourceLabel: string;
  },
): Promise<{ text: string; finalUrl: string }> {
  let currentUrl = articleUrl(inputUrl);
  const headers: Record<string, string> = {
    "Accept": params.accept,
    "Accept-Language": "en-US,en;q=0.9",
  };

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let response: Response;
    if (params.fetchFn) {
      // Invoke fetchFn detached (`this` unbound) for Cloudflare Workers (`workerd`) safety.
      const doFetch = params.fetchFn;
      response = await doFetch(currentUrl.href, {
        method: "GET",
        redirect: "manual",
        signal: params.signal,
        headers: {
          "Accept-Encoding": "gzip, identity",
          "User-Agent":
            "AudioFeed/1.0 (podcast generator; +https://github.com/PaulKinlan/audio-feed)",
          ...headers,
        },
      });
    } else {
      const transport = params.transport ?? requestPublic;
      response = await transport(currentUrl, params.signal, { headers });
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || hop === MAX_REDIRECT_HOPS) {
        throw new IngestError(422, "Article has an invalid or excessive redirect chain.");
      }
      currentUrl = articleUrl(new URL(location, currentUrl).href);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new IngestError(
        422,
        `Unable to retrieve YouTube ${params.resourceLabel} (HTTP ${response.status}).`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    // Standard Fetch implementations (Cloudflare Workers / Node undici) transparently decompress
    // gzip/deflate while sometimes retaining the Content-Encoding header; only decompress raw
    // transport streams (Node http/https requestPublic).
    const encoding = params.fetchFn ? null : response.headers.get("content-encoding");
    if (Number(response.headers.get("content-length")) > params.maxBytes) {
      await response.body?.cancel();
      throw new IngestError(413, `YouTube ${params.resourceLabel} exceeds the size limit.`);
    }

    let decompressedBody: ReadableStream<Uint8Array> | null;
    try {
      decompressedBody = decompressStream(response.body, encoding);
    } catch (err) {
      await response.body?.cancel();
      throw err instanceof IngestError
        ? err
        : new IngestError(422, `YouTube ${params.resourceLabel} decompression failed.`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBounded(decompressedBody, params.maxBytes, 413, params.signal);
    } catch (err) {
      if (err instanceof IngestError) throw err;
      throw new IngestError(422, `YouTube ${params.resourceLabel} decompression failed.`);
    }

    const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
    let text: string;
    try {
      text = new TextDecoder(charset).decode(bytes);
    } catch {
      throw new IngestError(422, "Article uses an unsupported character encoding.");
    }

    return { text, finalUrl: currentUrl.href };
  }

  throw new IngestError(422, `Unable to fetch YouTube ${params.resourceLabel}.`);
}

function buildCaptionFetchUrl(baseUrl: string): string {
  const parsed = articleUrl(baseUrl);
  if (!parsed.searchParams.has("fmt")) {
    parsed.searchParams.set("fmt", "json3");
  }
  return parsed.href;
}

/**
 * Fetch a YouTube video watch page and its caption track through the repo's SSRF-safe
 * fetch path and assemble an `ExtractedArticle` with thumbnail cover art and video chapters.
 *
 * Accepts either:
 * - `extractYouTubeArticle(url, fetchFn, opts)` (detached `fetchFn` for custom callers/tests), or
 * - `extractYouTubeArticle(url, opts)` (uses `opts.transport ?? requestPublic`, matching `fetchArticle`).
 */
export async function extractYouTubeArticle(
  input: string,
  fetchFnOrOptions?: typeof fetch | YouTubeExtractOptions,
  maybeOpts?: YouTubeExtractOptions,
): Promise<ExtractedArticle> {
  const fetchFn = typeof fetchFnOrOptions === "function" ? fetchFnOrOptions : undefined;
  const options: YouTubeExtractOptions =
    typeof fetchFnOrOptions === "function" ? (maybeOpts ?? {}) : (fetchFnOrOptions ?? {});

  const validatedInput = articleUrl(input);
  const videoId = parseYouTubeVideoId(validatedInput.href);
  if (!videoId) {
    throw new IngestError(400, "Provide a valid public YouTube video URL.");
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? YOUTUBE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    const watchPage = await fetchPublicYouTubeText(canonicalUrl, {
      fetchFn,
      transport: options.transport,
      signal,
      maxBytes: MAX_YOUTUBE_HTML_BYTES,
      accept: "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
      resourceLabel: "video page",
    });

    const playerResponse = extractYtInitialPlayerResponse(watchPage.text);
    if (!playerResponse) {
      throw new IngestError(
        422,
        "Unable to extract metadata from this YouTube video page; the video may be private or unavailable.",
      );
    }

    const playability = playerResponse.playabilityStatus as
      | { status?: unknown; reason?: unknown }
      | undefined;
    const playStatus = typeof playability?.status === "string"
      ? playability.status.toUpperCase()
      : "";
    if (playStatus && playStatus !== "OK") {
      throw new IngestError(
        422,
        "This YouTube video is unavailable, private, or requires signing in.",
      );
    }

    const captionsRoot = playerResponse.captions as
      | { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } }
      | undefined;
    const rawTracks = captionsRoot?.playerCaptionsTracklistRenderer?.captionTracks;
    const tracks = Array.isArray(rawTracks) ? (rawTracks as YouTubeCaptionTrack[]) : [];
    const selectedTrack = selectCaptionTrack(tracks, options.preferredLanguage ?? "en");
    if (!selectedTrack) {
      throw new IngestError(
        422,
        "This YouTube video does not have captions or a transcript available.",
      );
    }

    let captionUrl: string;
    try {
      captionUrl = buildCaptionFetchUrl(selectedTrack.baseUrl);
    } catch {
      throw new IngestError(
        422,
        "This YouTube video does not have a valid public caption track URL.",
      );
    }

    const captionDoc = await fetchPublicYouTubeText(captionUrl, {
      fetchFn,
      transport: options.transport,
      signal,
      maxBytes: MAX_YOUTUBE_CAPTION_BYTES,
      accept: "application/json, text/xml, application/xml, text/plain;q=0.8, */*;q=0.5",
      resourceLabel: "captions",
    });

    const cues = parseYouTubeCaptions(captionDoc.text);
    if (cues.length === 0) {
      throw new IngestError(
        422,
        "This YouTube video does not have captions or a transcript available.",
      );
    }

    const videoDetails = (playerResponse.videoDetails ?? {}) as Record<string, unknown>;
    const rawTitle = typeof videoDetails.title === "string" ? videoDetails.title : "";
    const title = sanitizeText(rawTitle, 200) || `YouTube Video ${videoId}`;
    const rawAuthor = typeof videoDetails.author === "string" ? videoDetails.author : "";
    const author = sanitizeText(rawAuthor, 100) || null;
    const shortDescription = typeof videoDetails.shortDescription === "string"
      ? videoDetails.shortDescription
      : "";
    const rawLength = videoDetails.lengthSeconds;
    const durationSeconds = typeof rawLength === "number"
      ? rawLength
      : typeof rawLength === "string"
      ? Number.parseInt(rawLength, 10)
      : undefined;

    const chapters = parseYouTubeChapters(
      shortDescription,
      Number.isFinite(durationSeconds) ? durationSeconds : undefined,
    );
    const { body, lead, headings } = formatYouTubeTranscript(cues, chapters);

    if (!body) {
      throw new IngestError(
        422,
        "This YouTube video does not have captions or a transcript available.",
      );
    }
    if (body.length > MAX_ARTICLE_CONTENT_CHARS) {
      throw new IngestError(
        413,
        `Article content exceeds the character limit (${body.length} > ${MAX_ARTICLE_CONTENT_CHARS}).`,
      );
    }

    const imageUrl = selectThumbnailUrl(playerResponse, videoId);
    const publishedAt = extractPublishedDate(playerResponse);

    return {
      url: canonicalUrl,
      title,
      author,
      publishedAt,
      lead: lead || title,
      body,
      ...(imageUrl ? { imageUrl } : {}),
      ...(headings.length > 0 ? { headings } : {}),
    };
  } catch (error) {
    if (signal.aborted) throw new IngestError(504, "Article fetch timed out or was cancelled.");
    if (error instanceof IngestError) throw error;
    throw new IngestError(422, "Unable to fetch the YouTube video transcript.");
  } finally {
    clearTimeout(timeout);
  }
}
