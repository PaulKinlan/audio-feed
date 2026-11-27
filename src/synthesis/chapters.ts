/**
 * Chapter extraction & segment-aligned timestamp computation.
 *
 * Generates exact, millisecond-accurate Podcasting 2.0 JSON Chapters (`EpisodeChapter[]`)
 * from real synthesized WAV segment durations — zero extra LLM cost for direct reads,
 * and automatic topic chapters for deep dives.
 */

import { assertTextSeams, splitTextUnderByteBudget } from "./limits.ts";
import type { EpisodeChapter } from "../types.ts";

const MIN_CHAPTER_GAP_SECONDS = 15;
const LONG_UNHEADED_THRESHOLD_SECONDS = 240; // 4 minutes
const AUTO_PART_INTERVAL_SECONDS = 180; // 3 minutes

/** Clean a raw heading candidate into a concise chapter title. */
export function normalizeChapterTitle(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

/**
 * Extract ordered section headings from article plain/markdown text or pre-extracted headings.
 * Recognizes Markdown `#`–`###` lines as well as pre-extracted DOM headings that appear
 * verbatim as standalone lines in the article body.
 */
export function extractArticleHeadings(text: string, htmlHeadings?: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const clean = normalizeChapterTitle(raw);
    if (clean.length < 3 || clean.length > 96) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^#{1,3}\s+\S/.test(trimmed)) {
      push(trimmed);
    }
  }
  if (htmlHeadings) {
    for (const h of htmlHeadings) push(h);
  }
  return out;
}

export interface ChapteredSegment {
  text: string;
  /** Heading that starts this segment, when aligned to a section boundary. */
  heading?: string;
}

/**
 * Split narration prompt under `maxBytes` while preferring breaks right before known
 * section headings so each chapter aligns cleanly to an exact WAV segment boundary.
 */
export function splitNarrationIntoChapteredSegments(
  prompt: string,
  headings: readonly string[],
  maxBytes: number,
): ChapteredSegment[] {
  const normalizedSet = new Map<string, string>();
  for (const h of headings) {
    const clean = normalizeChapterTitle(h);
    if (clean.length >= 3) normalizedSet.set(clean.toLowerCase(), clean);
  }

  if (normalizedSet.size === 0) {
    const plain = splitTextUnderByteBudget(prompt, maxBytes);
    if (plain.length > 0) assertTextSeams(prompt, plain);
    return plain.map((text) => ({ text }));
  }

  // Group paragraphs into sections whenever a standalone paragraph matches a heading.
  const blocks = prompt.split(/\n\n+/);
  const sections: Array<{ heading?: string; text: string }> = [];
  let currentHeading: string | undefined;
  let currentBlocks: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const cleanLine = normalizeChapterTitle(trimmed);
    const matchedHeading = !trimmed.includes("\n")
      ? normalizedSet.get(cleanLine.toLowerCase())
      : undefined;

    if (matchedHeading && currentBlocks.length > 0) {
      sections.push({ heading: currentHeading, text: currentBlocks.join("\n\n") });
      currentHeading = matchedHeading;
      currentBlocks = [trimmed];
    } else {
      if (matchedHeading && !currentHeading && sections.length > 0) {
        currentHeading = matchedHeading;
      }
      currentBlocks.push(trimmed);
    }
  }
  if (currentBlocks.length > 0) {
    sections.push({ heading: currentHeading, text: currentBlocks.join("\n\n") });
  }

  // Pack sections under `maxBytes`, keeping heading starts on fresh segments.
  const encoder = new TextEncoder();
  const segments: ChapteredSegment[] = [];
  for (const section of sections) {
    const pieces = splitTextUnderByteBudget(section.text, maxBytes);
    pieces.forEach((piece, idx) => {
      if (
        idx === 0 &&
        !section.heading &&
        segments.length > 0 &&
        encoder.encode(segments[segments.length - 1]!.text + "\n\n" + piece).length <= maxBytes
      ) {
        segments[segments.length - 1]!.text += "\n\n" + piece;
      } else {
        segments.push({
          text: piece,
          heading: idx === 0 ? section.heading : undefined,
        });
      }
    });
  }

  return segments.length > 0 ? segments : [{ text: prompt }];
}

/**
 * Compute final `EpisodeChapter[]` from ordered segment headings and measured WAV durations.
 */
export function buildChaptersFromSegments(
  segments: ReadonlyArray<{ heading?: string; durationSeconds: number }>,
  opts: { introTitle?: string; mode?: "direct" | "deepdive" } = {},
): EpisodeChapter[] {
  if (segments.length === 0) return [];
  const introTitle = opts.introTitle ?? "Introduction";
  const chapters: EpisodeChapter[] = [];
  let cursor = 0;
  let hasNamedHeadings = false;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.heading) {
      hasNamedHeadings = true;
      const startTime = Math.round(cursor);
      const last = chapters[chapters.length - 1];
      if (!last && startTime > MIN_CHAPTER_GAP_SECONDS) {
        chapters.push({ startTime: 0, title: introTitle });
      }
      if (!last || startTime - last.startTime >= MIN_CHAPTER_GAP_SECONDS) {
        chapters.push({ startTime: chapters.length === 0 ? 0 : startTime, title: seg.heading });
      }
    }
    cursor += Math.max(0, seg.durationSeconds);
  }

  const totalDuration = cursor;
  if (hasNamedHeadings && chapters.length >= 2) {
    if (chapters[0]!.startTime > 0) {
      chapters.unshift({ startTime: 0, title: introTitle });
    }
    return chapters;
  }

  // Fallback for long episodes without headings: create clean segment-aligned section markers
  // spaced ~3 minutes apart so listeners can scrub & jump cleanly.
  if (totalDuration >= LONG_UNHEADED_THRESHOLD_SECONDS && segments.length >= 3) {
    const auto: EpisodeChapter[] = [{ startTime: 0, title: introTitle }];
    let acc = 0;
    let lastMark = 0;
    let partNum = 2;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (
        i > 0 &&
        acc - lastMark >= AUTO_PART_INTERVAL_SECONDS &&
        totalDuration - acc >= 60
      ) {
        const label = opts.mode === "deepdive"
          ? `Discussion — Part ${partNum}`
          : `Part ${partNum}`;
        auto.push({ startTime: Math.round(acc), title: label });
        lastMark = acc;
        partNum++;
      }
      acc += Math.max(0, seg.durationSeconds);
    }
    if (auto.length >= 2) return auto;
  }

  return [];
}

/**
 * Format Podcasting 2.0 JSON Chapters v1.2.0 payload (`application/json+chapters`).
 */
export function buildJsonChaptersDocument(chapters: readonly EpisodeChapter[]): {
  version: "1.2.0";
  chapters: Array<{ startTime: number; title: string }>;
} {
  return {
    version: "1.2.0",
    chapters: chapters.map((c) => ({
      startTime: Math.max(0, Math.round(c.startTime)),
      title: c.title,
    })),
  };
}
