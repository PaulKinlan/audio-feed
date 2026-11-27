/**
 * WebVTT & timed JSON transcript generation for Podcasting 2.0 `<podcast:transcript>`
 * and synced `/listen/` Read-Along.
 *
 * Handles three episode shapes gracefully:
 *   1. Deepdive episodes with `episode.transcript` ("Speaker: text" turns) or `scriptTurns`:
 *      allocates timestamps proportionally by UTF-8 byte length across `durationSeconds`,
 *      emitting `<v Speaker>` voice tags in WebVTT.
 *   2. Direct episodes with chapter markers + article text:
 *      aligns cues to chapter boundaries (`startTime` / duration) by matching section
 *      headings when present or partitioning cleanly across chapter windows.
 *   3. Older ready episodes without chapters:
 *      splits article/transcript text into clean ~10-15s readable WebVTT cues across
 *      `durationSeconds`.
 */

import { normalizeChapterTitle } from "./chapters.ts";
import type { AudioMode, EpisodeChapter } from "../types.ts";

const ENCODER = new TextEncoder();

/** Target duration (seconds) per readable cue (~10-15s window). */
const TARGET_CUE_SECONDS = 12;
/** Sub-split deepdive speaker turns longer than this threshold (seconds). */
const LONG_TURN_SPLIT_SECONDS = 18;
const MIN_CHUNK_CHARS = 70;
const MAX_CHUNK_CHARS = 240;
/** Fallback speaking rate (~150 words/min ≈ 15 UTF-8 bytes/sec) when durationSeconds is absent. */
const FALLBACK_BYTES_PER_SECOND = 15;

export interface TranscriptCue {
  /** Start offset in seconds (>= 0). */
  startTime: number;
  /** End offset in seconds (> startTime). */
  endTime: number;
  /** Clean spoken text for this cue (unescaped). */
  text: string;
  /** Optional speaker label (populated for deepdive dialogue turns). */
  speaker?: string;
  /** Optional chapter title covering this cue's startTime. */
  chapterTitle?: string;
}

export interface TranscriptInput {
  /** Episode presentation mode ("direct" | "deepdive"). */
  mode?: AudioMode;
  /** Total audio duration in seconds; estimated from text length if absent/0. */
  durationSeconds?: number;
  /** Persisted dialogue transcript ("Speaker: text\n\n...") or plain transcript. */
  transcript?: string;
  /** Optional structured dialogue turns. */
  scriptTurns?: ReadonlyArray<{ speaker: string; text: string }>;
  /** Chapter markers aligned to audio timestamps. */
  chapters?: ReadonlyArray<EpisodeChapter>;
  /** Article body text (used for direct reads and legacy episodes). */
  articleText?: string;
  /** Fallback title if no body/transcript/description exists. */
  title?: string;
  /** Fallback description if no body/transcript exists. */
  description?: string;
}

export interface TranscriptJsonDocument {
  version: "1.0";
  durationSeconds: number;
  cues: TranscriptCue[];
}

interface DialogueTurn {
  speaker?: string;
  text: string;
}

interface ChapterWindow {
  startTime: number;
  endTime: number;
  title: string;
}

function roundMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * 1000) / 1000;
}

function utf8Weight(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 1;
  return Math.max(1, ENCODER.encode(trimmed).byteLength);
}

/**
 * Format a timestamp in seconds as WebVTT `HH:MM:SS.mmm`.
 * Rounds to integer milliseconds before component extraction so `00:01:60.000`
 * can never be emitted.
 */
export function formatVttTimestamp(seconds: number): string {
  const totalMs = !Number.isFinite(seconds) || seconds <= 0 ? 0 : Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mins = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${
    String(secs).padStart(2, "0")
  }.${String(ms).padStart(3, "0")}`;
}

/**
 * Sanitize and escape cue text for WebVTT compliance:
 * - strips control characters
 * - removes blank lines (which would terminate a cue prematurely)
 * - escapes `&`, `<`, `>` (which also neutralizes any literal `-->` into `--&gt;`)
 */
export function escapeVttText(text: string): string {
  // deno-lint-ignore no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t+/g, " ");
  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines
    .join("\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeVttSpeaker(speaker: string): string {
  // deno-lint-ignore no-control-regex
  return speaker.replace(/[\u0000-\u001F\u007F<>&]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function cleanPlainLine(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split raw article text into ordered blocks, separating blank-line paragraphs
 * and standalone Markdown heading lines (`#`–`######`) into their own blocks.
 */
function splitIntoBlocks(rawText: string): string[] {
  const normalized = rawText.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const blocks: string[] = [];
  const rawParagraphs = normalized.split(/\n{2,}/);
  for (const para of rawParagraphs) {
    const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    let buf: string[] = [];
    for (const line of lines) {
      if (/^#{1,6}\s+\S/.test(line)) {
        if (buf.length > 0) {
          blocks.push(buf.join(" "));
          buf = [];
        }
        blocks.push(line);
      } else {
        buf.push(line);
      }
    }
    if (buf.length > 0) {
      blocks.push(buf.join(" "));
    }
  }
  return blocks;
}

/**
 * Split a single long sentence/clause cleanly at clause punctuation or word
 * boundaries so no cue exceeds `maxChars`.
 */
function splitLongSentence(sentence: string, maxChars: number): string[] {
  const trimmed = sentence.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const pieces: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const minBreak = Math.floor(maxChars * 0.45);
    let splitAt = -1;

    // Prefer clause boundary punctuation (comma, semicolon, colon, em/en-dash).
    for (let i = window.length - 1; i >= minBreak; i--) {
      const ch = window[i]!;
      const next = window[i + 1];
      if ((ch === "," || ch === ";" || ch === ":" || ch === "\u2014" || ch === "\u2013") &&
        (next === " " || next === undefined)) {
        splitAt = i + 1;
        break;
      }
    }

    // Fallback to nearest whitespace boundary.
    if (splitAt === -1) {
      const spaceIdx = window.lastIndexOf(" ");
      if (spaceIdx >= minBreak) {
        splitAt = spaceIdx;
      } else if (spaceIdx > 0) {
        splitAt = spaceIdx;
      } else {
        // Single unbroken token longer than maxChars.
        splitAt = maxChars;
      }
    }

    const head = remaining.slice(0, splitAt).trim();
    if (head) pieces.push(head);
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

/** Split cleaned text blocks into sentence/clause units bounded by `maxChars`. */
function splitBlocksIntoUnits(blocks: readonly string[], maxChars = MAX_CHUNK_CHARS): string[] {
  const units: string[] = [];
  for (const block of blocks) {
    const cleaned = cleanPlainLine(block);
    if (!cleaned) continue;
    const sentences = cleaned
      .split(/(?<=[.!?]["'”’)\]]*)\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      units.push(...splitLongSentence(sentence, maxChars));
    }
  }
  return units;
}

/**
 * Pack sentence/clause units into readable ~10-15s cue strings sized for `windowDuration`.
 */
function packUnitsIntoChunks(units: readonly string[], windowDuration: number): string[] {
  if (units.length === 0) return [];
  if (units.length === 1) return [units[0]!];

  const totalChars = units.reduce((acc, u) => acc + u.length, 0);
  const desiredCount = Math.max(1, Math.round(Math.max(1, windowDuration) / TARGET_CUE_SECONDS));
  const targetChars = Math.max(
    MIN_CHUNK_CHARS,
    Math.min(MAX_CHUNK_CHARS, Math.round(totalChars / desiredCount)),
  );
  const softMax = Math.min(MAX_CHUNK_CHARS, Math.round(targetChars * 1.25));
  const minBeforeFlush = Math.min(MIN_CHUNK_CHARS, Math.round(targetChars * 0.55));

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    const candidateLen = current.length + 1 + unit.length;
    if (candidateLen <= softMax || current.length < minBeforeFlush && candidateLen <= MAX_CHUNK_CHARS) {
      current = `${current} ${unit}`;
    } else {
      chunks.push(current);
      current = unit;
    }
  }
  if (current) chunks.push(current);

  // Avoid leaving a tiny orphan trailing cue if it fits cleanly onto the previous one.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1]!;
    const prev = chunks[chunks.length - 2]!;
    if (last.length < Math.round(MIN_CHUNK_CHARS * 0.45) && prev.length + 1 + last.length <= MAX_CHUNK_CHARS + 32) {
      chunks[chunks.length - 2] = `${prev} ${last}`;
      chunks.pop();
    }
  }

  return chunks;
}

function splitTextIntoReadableChunks(text: string, windowDuration: number): string[] {
  const blocks = splitIntoBlocks(text);
  const units = splitBlocksIntoUnits(blocks, MAX_CHUNK_CHARS);
  return packUnitsIntoChunks(units, windowDuration);
}

/**
 * Allocate timestamps proportionally by UTF-8 byte weight across `[windowStart, windowEnd]`.
 */
function allocateWindowCues(
  texts: readonly string[],
  windowStart: number,
  windowEnd: number,
  meta: { speaker?: string; chapterTitle?: string } = {},
): TranscriptCue[] {
  const nonEmpty = texts.map((t) => t.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return [];

  const start = Math.max(0, windowStart);
  const end = Math.max(start + 0.001, windowEnd);
  const span = end - start;

  const weights = nonEmpty.map((t) => utf8Weight(t));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);

  const cues: TranscriptCue[] = [];
  let accWeight = 0;
  for (let i = 0; i < nonEmpty.length; i++) {
    const cueStart = i === 0 ? start : start + (span * accWeight) / totalWeight;
    accWeight += weights[i]!;
    const cueEnd = i === nonEmpty.length - 1 ? end : start + (span * accWeight) / totalWeight;
    cues.push({
      startTime: cueStart,
      endTime: cueEnd,
      text: nonEmpty[i]!,
      ...(meta.speaker ? { speaker: meta.speaker } : {}),
      ...(meta.chapterTitle ? { chapterTitle: meta.chapterTitle } : {}),
    });
  }
  return cues;
}

/**
 * Parse `"Speaker: text"` dialogue transcripts (e.g. deepdive scripts) into turns.
 * Returns `[]` if no valid speaker turns are recognized.
 */
export function parseDialogueTurns(
  transcript?: string,
  scriptTurns?: ReadonlyArray<{ speaker: string; text: string }>,
): DialogueTurn[] {
  if (scriptTurns && scriptTurns.length > 0) {
    const clean = scriptTurns
      .map((t) => ({
        speaker: sanitizeVttSpeaker(t.speaker ?? ""),
        text: cleanPlainLine(t.text ?? ""),
      }))
      .filter((t) => t.text.length > 0);
    if (clean.length > 0) {
      return clean.map((t) => (t.speaker ? { speaker: t.speaker, text: t.text } : { text: t.text }));
    }
  }

  if (!transcript || !transcript.trim()) return [];

  const lines = transcript.replace(/\r\n?/g, "\n").split("\n");
  const turns: DialogueTurn[] = [];
  let speakerMatches = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = /^([\p{L}][\p{L}\p{N} _.'-]{0,39}):\s+(.+)$/u.exec(line);
    const candidateSpeaker = match?.[1]?.trim();
    const candidateText = match?.[2]?.trim();
    const lowerSpeaker = candidateSpeaker?.toLowerCase();
    const isUrlPrefix = lowerSpeaker === "http" || lowerSpeaker === "https" ||
      candidateText?.startsWith("//");

    if (candidateSpeaker && candidateText && !isUrlPrefix) {
      speakerMatches++;
      const cleanSpeaker = sanitizeVttSpeaker(candidateSpeaker);
      const cleanText = cleanPlainLine(candidateText);
      if (cleanText) {
        turns.push({
          ...(cleanSpeaker ? { speaker: cleanSpeaker } : {}),
          text: cleanText,
        });
      }
    } else if (turns.length > 0) {
      const cont = cleanPlainLine(line);
      if (cont) {
        turns[turns.length - 1]!.text = `${turns[turns.length - 1]!.text} ${cont}`;
      }
    } else {
      const plain = cleanPlainLine(line);
      if (plain) turns.push({ text: plain });
    }
  }

  return speakerMatches > 0 ? turns : [];
}

function normalizeChapterWindows(
  chapters: ReadonlyArray<EpisodeChapter> | undefined,
  totalDuration: number,
): ChapterWindow[] {
  if (!chapters || chapters.length === 0) return [];
  const valid = chapters
    .filter((c) =>
      Number.isFinite(c.startTime) &&
      c.startTime >= 0 &&
      c.startTime < totalDuration &&
      typeof c.title === "string" &&
      c.title.trim().length > 0
    )
    .map((c) => ({ startTime: c.startTime, title: c.title.trim() }))
    .sort((a, b) => a.startTime - b.startTime);

  if (valid.length === 0) return [];

  const deduped: Array<{ startTime: number; title: string }> = [];
  for (const ch of valid) {
    const prev = deduped[deduped.length - 1];
    if (!prev || ch.startTime > prev.startTime) {
      deduped.push(ch);
    }
  }

  if (deduped[0]!.startTime > 0) {
    deduped.unshift({ startTime: 0, title: "Introduction" });
  }

  return deduped.map((ch, idx) => ({
    startTime: ch.startTime,
    endTime: idx + 1 < deduped.length ? deduped[idx + 1]!.startTime : totalDuration,
    title: ch.title,
  }));
}

function chapterTitleAt(windows: readonly ChapterWindow[], time: number): string | undefined {
  let active: string | undefined;
  for (const w of windows) {
    if (w.startTime <= time + 0.001) {
      active = w.title;
    } else {
      break;
    }
  }
  return active;
}

/**
 * Partition an ordered list of text units across chapter windows proportionally
 * to each window's duration while guaranteeing at least one unit per window
 * when `units.length >= windows.length`.
 */
function partitionUnitsAcrossWindows(
  units: readonly string[],
  windows: readonly ChapterWindow[],
): string[][] {
  const result: string[][] = windows.map(() => []);
  if (units.length === 0 || windows.length === 0) return result;
  if (windows.length === 1) {
    result[0] = [...units];
    return result;
  }

  const totalDuration = windows.reduce((acc, w) => acc + Math.max(0.001, w.endTime - w.startTime), 0);
  const weights = units.map((u) => utf8Weight(u));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);

  let unitIdx = 0;
  let cumWeight = 0;
  let cumDuration = 0;

  for (let wIdx = 0; wIdx < windows.length; wIdx++) {
    const w = windows[wIdx]!;
    cumDuration += Math.max(0.001, w.endTime - w.startTime);
    const targetCumWeight = (totalWeight * cumDuration) / totalDuration;
    const remainingWindowsAfter = windows.length - 1 - wIdx;

    if (wIdx === windows.length - 1) {
      while (unitIdx < units.length) {
        result[wIdx]!.push(units[unitIdx]!);
        unitIdx++;
      }
      break;
    }

    // Ensure at least 1 unit when available, while leaving at least 1 unit per remaining window.
    while (unitIdx < units.length - remainingWindowsAfter) {
      const nextWeight = weights[unitIdx]!;
      const alreadyHasUnit = result[wIdx]!.length > 0;
      if (alreadyHasUnit && cumWeight + nextWeight / 2 > targetCumWeight) {
        break;
      }
      result[wIdx]!.push(units[unitIdx]!);
      cumWeight += nextWeight;
      unitIdx++;
    }
  }

  return result;
}

/**
 * Align article text to chapter windows:
 * 1. When non-zero chapter titles match section headings in the article text,
 *    bind each section's text directly to its chapter's `[startTime, endTime]`.
 * 2. Otherwise (auto-part chapters like "Part 2" or DOM-only headings), partition
 *    the text proportionally across the chapter windows so cues land cleanly on
 *    every chapter boundary.
 */
function buildChapterAlignedCues(
  articleText: string,
  windows: readonly ChapterWindow[],
): TranscriptCue[] {
  const blocks = splitIntoBlocks(articleText);
  if (blocks.length === 0) return [];

  const normalizedWindowTitles = windows.map((w) => normalizeChapterTitle(w.title).toLowerCase());

  // Attempt verbatim heading alignment (mirrors src/synthesis/chapters.ts).
  const matchedBuckets: string[][] = windows.map(() => []);
  const matchedIndices = new Set<number>([0]);
  let currentWindowIdx = 0;
  let nonZeroMatches = 0;

  for (const block of blocks) {
    const singleLine = !block.includes("\n");
    const cleanHeading = singleLine ? normalizeChapterTitle(block).toLowerCase() : "";
    if (cleanHeading) {
      let foundIdx = -1;
      for (let k = currentWindowIdx + 1; k < windows.length; k++) {
        if (normalizedWindowTitles[k] === cleanHeading) {
          foundIdx = k;
          break;
        }
      }
      if (foundIdx !== -1) {
        currentWindowIdx = foundIdx;
        matchedIndices.add(foundIdx);
        nonZeroMatches++;
      }
    }
    matchedBuckets[currentWindowIdx]!.push(block);
  }

  if (nonZeroMatches > 0) {
    // Fill any unmatched intermediate windows by partitioning from the preceding matched anchor.
    const anchorOrder = [...matchedIndices].sort((a, b) => a - b);
    const finalBuckets: string[][] = windows.map(() => []);
    for (let a = 0; a < anchorOrder.length; a++) {
      const startWin = anchorOrder[a]!;
      const endWinExclusive = a + 1 < anchorOrder.length ? anchorOrder[a + 1]! : windows.length;
      const bucketBlocks = matchedBuckets[startWin]!;
      if (endWinExclusive - startWin === 1) {
        finalBuckets[startWin] = bucketBlocks;
      } else {
        const subWindows = windows.slice(startWin, endWinExclusive);
        const subUnits = splitBlocksIntoUnits(bucketBlocks, MAX_CHUNK_CHARS);
        const distributed = partitionUnitsAcrossWindows(subUnits, subWindows);
        for (let offset = 0; offset < subWindows.length; offset++) {
          finalBuckets[startWin + offset] = distributed[offset]!;
        }
      }
    }

    const cues: TranscriptCue[] = [];
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!;
      const bucket = finalBuckets[i]!;
      const units = splitBlocksIntoUnits(bucket, MAX_CHUNK_CHARS);
      const chunks = units.length > 0
        ? packUnitsIntoChunks(units, w.endTime - w.startTime)
        : [w.title];
      cues.push(
        ...allocateWindowCues(chunks, w.startTime, w.endTime, { chapterTitle: w.title }),
      );
    }
    return cues;
  }

  // No verbatim heading matches: partition sentences cleanly across chapter windows.
  const allUnits = splitBlocksIntoUnits(blocks, MAX_CHUNK_CHARS);
  if (allUnits.length === 0) return [];

  if (allUnits.length < windows.length) {
    const totalEnd = windows[windows.length - 1]!.endTime;
    const raw = allocateWindowCues(allUnits, 0, totalEnd);
    return raw.map((cue) => {
      const chapterTitle = chapterTitleAt(windows, cue.startTime);
      return chapterTitle ? { ...cue, chapterTitle } : cue;
    });
  }

  const partitioned = partitionUnitsAcrossWindows(allUnits, windows);
  const cues: TranscriptCue[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const units = partitioned[i]!;
    const chunks = packUnitsIntoChunks(units, w.endTime - w.startTime);
    cues.push(...allocateWindowCues(chunks, w.startTime, w.endTime, { chapterTitle: w.title }));
  }
  return cues;
}

function resolveEffectiveDuration(input: TranscriptInput, fallbackText: string): number {
  if (typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds) &&
    input.durationSeconds > 0) {
    return input.durationSeconds;
  }
  const estimated = Math.max(1, Math.round(utf8Weight(fallbackText) / FALLBACK_BYTES_PER_SECOND));
  const maxChapterStart = (input.chapters ?? []).reduce(
    (max, ch) => (Number.isFinite(ch.startTime) && ch.startTime > max ? ch.startTime : max),
    0,
  );
  return Math.max(estimated, maxChapterStart + 30);
}

/**
 * Normalize cue timestamps to integer milliseconds, guaranteeing monotonic
 * non-overlapping intervals with strictly positive duration (`endTime > startTime`).
 */
function finalizeCueTimestamps(cues: TranscriptCue[], totalDuration: number): TranscriptCue[] {
  if (cues.length === 0) return [];
  const totalRounded = Math.max(0.001, roundMs(totalDuration));
  const out: TranscriptCue[] = [];
  let prevEnd = 0;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const isLast = i === cues.length - 1;
    const start = Math.max(prevEnd, roundMs(cue.startTime));
    let end = isLast ? Math.max(start + 0.001, totalRounded) : roundMs(cue.endTime);

    if (end <= start) {
      end = roundMs(start + 0.001);
    }

    out.push({
      ...cue,
      startTime: start,
      endTime: end,
    });
    prevEnd = end;
  }
  return out;
}

/**
 * Build timed transcript cues for any episode shape (deepdive, direct+chapters,
 * or legacy unchaptered). Suitable both for WebVTT rendering and for `/listen/`
 * synced Read-Along.
 */
export function buildTranscriptCues(input: TranscriptInput): TranscriptCue[] {
  // Case 1: Deepdive dialogue turns (or any episode with structured/speaker transcript).
  const isDeepdive = input.mode === "deepdive";
  const dialogueTurns = (isDeepdive || input.scriptTurns?.length)
    ? parseDialogueTurns(input.transcript, input.scriptTurns)
    : [];

  if (dialogueTurns.length > 0) {
    const combinedText = dialogueTurns.map((t) => t.text).join(" ");
    const totalDuration = resolveEffectiveDuration(input, combinedText);
    const windows = normalizeChapterWindows(input.chapters, totalDuration);

    const turnCues = allocateWindowCues(
      dialogueTurns.map((t) => t.text),
      0,
      totalDuration,
    );

    const expanded: TranscriptCue[] = [];
    for (let i = 0; i < turnCues.length; i++) {
      const turnCue = turnCues[i]!;
      const turn = dialogueTurns[i]!;
      const span = turnCue.endTime - turnCue.startTime;
      if (span > LONG_TURN_SPLIT_SECONDS && turn.text.length > MAX_CHUNK_CHARS) {
        const subChunks = splitTextIntoReadableChunks(turn.text, span);
        const subCues = allocateWindowCues(subChunks, turnCue.startTime, turnCue.endTime, {
          speaker: turn.speaker,
        });
        for (const sub of subCues) {
          const ch = chapterTitleAt(windows, sub.startTime);
          expanded.push(ch ? { ...sub, chapterTitle: ch } : sub);
        }
      } else {
        const ch = chapterTitleAt(windows, turnCue.startTime);
        expanded.push({
          ...turnCue,
          ...(turn.speaker ? { speaker: turn.speaker } : {}),
          ...(ch ? { chapterTitle: ch } : {}),
        });
      }
    }

    return finalizeCueTimestamps(expanded, totalDuration);
  }

  // Resolve primary prose text for direct / legacy episodes.
  const prose = (
    isDeepdive
      ? input.transcript?.trim() || input.articleText?.trim()
      : input.articleText?.trim() || input.transcript?.trim()
  ) || input.description?.trim() || input.title?.trim() || "";

  if (!prose) return [];

  const totalDuration = resolveEffectiveDuration(input, prose);
  const windows = normalizeChapterWindows(input.chapters, totalDuration);

  // Case 2: Direct episode with chapters + article text.
  if (windows.length > 0) {
    const aligned = buildChapterAlignedCues(prose, windows);
    if (aligned.length > 0) {
      return finalizeCueTimestamps(aligned, totalDuration);
    }
  }

  // Case 3: Older/legacy ready episode without chapters.
  const chunks = splitTextIntoReadableChunks(prose, totalDuration);
  if (chunks.length === 0) return [];
  return finalizeCueTimestamps(allocateWindowCues(chunks, 0, totalDuration), totalDuration);
}

/**
 * Render an array of `TranscriptCue` entries as a standards-compliant WebVTT document.
 */
export function renderWebVtt(cues: readonly TranscriptCue[]): string {
  if (cues.length === 0) return "WEBVTT\n";

  const blocks: string[] = ["WEBVTT"];
  for (const cue of cues) {
    const escaped = escapeVttText(cue.text);
    if (!escaped) continue;
    const timing = `${formatVttTimestamp(cue.startTime)} --> ${formatVttTimestamp(cue.endTime)}`;
    const speaker = cue.speaker ? sanitizeVttSpeaker(cue.speaker) : "";
    const payload = speaker ? `<v ${speaker}>${escaped}</v>` : escaped;
    blocks.push(`${timing}\n${payload}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Generate a complete WebVTT document directly from episode/article inputs. */
export function generateEpisodeWebVtt(input: TranscriptInput): string {
  return renderWebVtt(buildTranscriptCues(input));
}

/**
 * Lightweight JSON cue document helper for `/listen/` synced Read-Along.
 */
export function buildTranscriptJsonDocument(input: TranscriptInput): TranscriptJsonDocument {
  const cues = buildTranscriptCues(input);
  const lastEnd = cues.length > 0 ? cues[cues.length - 1]!.endTime : 0;
  const durationSeconds =
    typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds) &&
      input.durationSeconds > 0
      ? roundMs(input.durationSeconds)
      : lastEnd;
  return {
    version: "1.0",
    durationSeconds,
    cues,
  };
}
