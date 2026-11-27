/**
 * Pure validation, bounding, conflict-free merge, and WebVTT cue helpers for
 * cross-device playback sync and synced Read-Along.
 *
 * Kept pure (zero storage or DOM dependencies) so both D1/Memory storage adapters,
 * HTTP route handlers, and unit tests share one authoritative implementation.
 */

import {
  PLAYBACK_MAX_ID_LENGTH,
  PLAYBACK_MAX_PLAYED,
  PLAYBACK_MAX_POSITIONS,
  PLAYBACK_MAX_QUEUE,
  PLAYBACK_MAX_RATE,
  PLAYBACK_MIN_RATE,
  type PlaybackPosition,
  type PlaybackState,
} from "./types.ts";

/** Maximum sensible playback offset / duration (7 days in seconds). */
const MAX_PLAYBACK_SECONDS = 7 * 24 * 60 * 60;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function emptyPlaybackState(): PlaybackState {
  return {
    positions: {},
    played: [],
    queue: [],
    updatedAt: 0,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= PLAYBACK_MAX_ID_LENGTH &&
    !FORBIDDEN_KEYS.has(value);
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

function normalizeSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const clamped = Math.min(value, MAX_PLAYBACK_SECONDS);
  return Math.round(clamped * 10) / 10;
}

function normalizeDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(Math.min(value, MAX_PLAYBACK_SECONDS) * 10) / 10;
}

function normalizeRate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.max(PLAYBACK_MIN_RATE, Math.min(PLAYBACK_MAX_RATE, value));
  return Math.round(clamped * 100) / 100;
}

function boundPositions(
  positions: Record<string, PlaybackPosition>,
): Record<string, PlaybackPosition> {
  const entries = Object.entries(positions);
  if (entries.length > PLAYBACK_MAX_POSITIONS) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt || a[0].localeCompare(b[0]));
    entries.length = PLAYBACK_MAX_POSITIONS;
  }
  const out: Record<string, PlaybackPosition> = {};
  for (const [id, pos] of entries) {
    out[id] = pos.duration !== undefined
      ? { time: pos.time, duration: pos.duration, updatedAt: pos.updatedAt }
      : { time: pos.time, updatedAt: pos.updatedAt };
  }
  return out;
}

function dedupeBoundedIds(ids: readonly string[], limit: number, keepTail: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (keepTail) {
    // Walk from the end so duplicate occurrences keep their latest position, then cap to tail.
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]!;
      if (!isValidId(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= limit) break;
    }
    out.reverse();
    return out;
  }
  for (const id of ids) {
    if (!isValidId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Validated partial playback state update parsed from untrusted HTTP input.
 * Every field is optional so partial updates never wipe fields omitted by a client.
 */
export interface PlaybackStatePatch {
  positions?: Record<string, PlaybackPosition>;
  played?: string[];
  queue?: string[];
  queueUpdatedAt?: number;
  playbackRate?: number;
  voiceBoost?: boolean;
  trimSilence?: boolean;
  updatedAt?: number;
}

/**
 * Parse and validate an untrusted JSON value into a bounded `PlaybackStatePatch`.
 * Returns `null` when the payload is not a plain JSON object (or contains invalid top-level types).
 */
export function parsePlaybackStatePatch(
  raw: unknown,
  nowMs: number = Date.now(),
): PlaybackStatePatch | null {
  if (!isPlainRecord(raw)) return null;

  // Accept either top-level fields or `{ state: { ... } }` envelope.
  const hasTopLevelField = "positions" in raw ||
    "played" in raw ||
    "queue" in raw ||
    "queueUpdatedAt" in raw ||
    "playbackRate" in raw ||
    "voiceBoost" in raw ||
    "trimSilence" in raw ||
    "updatedAt" in raw;
  const source = !hasTopLevelField && isPlainRecord(raw.state) ? raw.state : raw;

  const patch: PlaybackStatePatch = {};

  if ("updatedAt" in source && source.updatedAt !== undefined) {
    if (typeof source.updatedAt !== "number" || !Number.isFinite(source.updatedAt)) {
      return null;
    }
    patch.updatedAt = normalizeTimestamp(source.updatedAt, nowMs);
  }

  if ("positions" in source && source.positions !== undefined) {
    if (!isPlainRecord(source.positions)) return null;
    const cleaned: Record<string, PlaybackPosition> = {};
    for (const [epId, entry] of Object.entries(source.positions)) {
      if (!isValidId(epId) || !isPlainRecord(entry)) continue;
      // Accept canonical `time`, or fallback `position` if an older client sends it.
      const time = normalizeSeconds(entry.time ?? entry.position);
      if (time === null) continue;
      const duration = normalizeDuration(entry.duration);
      const updatedAt = normalizeTimestamp(entry.updatedAt, patch.updatedAt ?? nowMs);
      cleaned[epId] = duration !== undefined ? { time, duration, updatedAt } : { time, updatedAt };
    }
    patch.positions = boundPositions(cleaned);
  }

  if ("played" in source && source.played !== undefined) {
    if (!Array.isArray(source.played)) return null;
    const ids = source.played.filter(isValidId);
    patch.played = dedupeBoundedIds(ids, PLAYBACK_MAX_PLAYED, true);
  }

  if ("queue" in source && source.queue !== undefined) {
    if (!Array.isArray(source.queue)) return null;
    const ids = source.queue.filter(isValidId);
    patch.queue = dedupeBoundedIds(ids, PLAYBACK_MAX_QUEUE, false);
  }

  if ("queueUpdatedAt" in source && source.queueUpdatedAt !== undefined) {
    if (typeof source.queueUpdatedAt !== "number" || !Number.isFinite(source.queueUpdatedAt)) {
      return null;
    }
    patch.queueUpdatedAt = normalizeTimestamp(source.queueUpdatedAt, 0);
  }

  if ("playbackRate" in source && source.playbackRate !== undefined) {
    const rate = normalizeRate(source.playbackRate);
    if (rate === undefined) return null;
    patch.playbackRate = rate;
  }

  if ("voiceBoost" in source && source.voiceBoost !== undefined) {
    if (typeof source.voiceBoost !== "boolean") return null;
    patch.voiceBoost = source.voiceBoost;
  }

  if ("trimSilence" in source && source.trimSilence !== undefined) {
    if (typeof source.trimSilence !== "boolean") return null;
    patch.trimSilence = source.trimSilence;
  }

  return patch;
}

/**
 * Sanitize and enforce all size/count bounds on a full `PlaybackState` before persistence.
 */
export function sanitizePlaybackState(
  input: PlaybackState,
  nowMs: number = Date.now(),
): PlaybackState {
  const updatedAt = normalizeTimestamp(input.updatedAt, nowMs);
  const rawPositions: Record<string, PlaybackPosition> = {};
  if (input.positions && typeof input.positions === "object") {
    for (const [epId, entry] of Object.entries(input.positions)) {
      if (!isValidId(epId) || !entry || typeof entry !== "object") continue;
      const time = normalizeSeconds(entry.time);
      if (time === null) continue;
      const duration = normalizeDuration(entry.duration);
      const entryUpdatedAt = normalizeTimestamp(entry.updatedAt, updatedAt);
      rawPositions[epId] = duration !== undefined
        ? { time, duration, updatedAt: entryUpdatedAt }
        : { time, updatedAt: entryUpdatedAt };
    }
  }
  const played = Array.isArray(input.played)
    ? dedupeBoundedIds(input.played.filter(isValidId), PLAYBACK_MAX_PLAYED, true)
    : [];
  const queue = Array.isArray(input.queue)
    ? dedupeBoundedIds(input.queue.filter(isValidId), PLAYBACK_MAX_QUEUE, false)
    : [];
  const playbackRate = normalizeRate(input.playbackRate);
  const queueUpdatedAt = typeof input.queueUpdatedAt === "number" &&
      Number.isFinite(input.queueUpdatedAt) &&
      input.queueUpdatedAt >= 0
    ? Math.trunc(input.queueUpdatedAt)
    : undefined;

  return {
    positions: boundPositions(rawPositions),
    played,
    queue,
    ...(queueUpdatedAt !== undefined ? { queueUpdatedAt } : {}),
    ...(playbackRate !== undefined ? { playbackRate } : {}),
    ...(typeof input.voiceBoost === "boolean" ? { voiceBoost: input.voiceBoost } : {}),
    ...(typeof input.trimSilence === "boolean" ? { trimSilence: input.trimSilence } : {}),
    updatedAt,
  };
}

/**
 * Conflict-free merge of an existing persisted `PlaybackState` with an incoming patch.
 *
 * Merge rules:
 * - `positions`: per-episode newest-`updatedAt` wins (ties favour incoming). Bounded to 200 newest.
 * - `played`: set union preserving order, capped at 500 most recent.
 * - `queue`: last-write-wins using `queueUpdatedAt` (falling back to `updatedAt`), capped at 200.
 * - `playbackRate`, `voiceBoost`, `trimSilence`: LWW using `updatedAt` (existing kept if strictly newer).
 */
export function mergePlaybackStates(
  existing: PlaybackState | null,
  incoming: PlaybackStatePatch,
  nowMs: number = Date.now(),
): PlaybackState {
  const base = existing ? sanitizePlaybackState(existing, nowMs) : emptyPlaybackState();
  const incomingUpdatedAt = incoming.updatedAt !== undefined
    ? normalizeTimestamp(incoming.updatedAt, nowMs)
    : nowMs;

  // 1. Positions: per-episode newest updatedAt wins (ties go to incoming).
  const mergedPositions: Record<string, PlaybackPosition> = { ...base.positions };
  if (incoming.positions) {
    for (const [epId, incPos] of Object.entries(incoming.positions)) {
      if (!isValidId(epId)) continue;
      const curPos = mergedPositions[epId];
      if (!curPos || incPos.updatedAt >= curPos.updatedAt) {
        const duration = incPos.duration ?? curPos?.duration;
        mergedPositions[epId] = duration !== undefined
          ? { time: incPos.time, duration, updatedAt: incPos.updatedAt }
          : { time: incPos.time, updatedAt: incPos.updatedAt };
      }
    }
  }

  // 2. Played: conflict-free set union, keeping the 500 most recent.
  const mergedPlayed = incoming.played
    ? dedupeBoundedIds([...base.played, ...incoming.played], PLAYBACK_MAX_PLAYED, true)
    : base.played;

  // 3. Queue: LWW by queueUpdatedAt (or top-level updatedAt when queueUpdatedAt is absent).
  let mergedQueue = base.queue;
  let mergedQueueUpdatedAt = base.queueUpdatedAt;
  if (incoming.queue !== undefined) {
    const baseQueueTs = base.queueUpdatedAt ?? base.updatedAt;
    const incQueueTs = incoming.queueUpdatedAt ?? incomingUpdatedAt;
    if (!existing || incQueueTs >= baseQueueTs) {
      mergedQueue = dedupeBoundedIds(incoming.queue, PLAYBACK_MAX_QUEUE, false);
      mergedQueueUpdatedAt = incQueueTs;
    }
  }

  // 4. Scalar preferences: LWW by updatedAt; adopt incoming if existing had no value yet.
  const incomingIsNewerOrEqual = !existing || incomingUpdatedAt >= base.updatedAt;
  const playbackRate = incoming.playbackRate !== undefined &&
      (incomingIsNewerOrEqual || base.playbackRate === undefined)
    ? normalizeRate(incoming.playbackRate)
    : base.playbackRate;
  const voiceBoost = incoming.voiceBoost !== undefined &&
      (incomingIsNewerOrEqual || base.voiceBoost === undefined)
    ? incoming.voiceBoost
    : base.voiceBoost;
  const trimSilence = incoming.trimSilence !== undefined &&
      (incomingIsNewerOrEqual || base.trimSilence === undefined)
    ? incoming.trimSilence
    : base.trimSilence;

  let maxPositionTs = 0;
  for (const pos of Object.values(mergedPositions)) {
    if (pos.updatedAt > maxPositionTs) maxPositionTs = pos.updatedAt;
  }

  const mergedUpdatedAt = Math.max(
    base.updatedAt,
    incomingUpdatedAt,
    mergedQueueUpdatedAt ?? 0,
    maxPositionTs,
  );

  return sanitizePlaybackState(
    {
      positions: mergedPositions,
      played: mergedPlayed,
      queue: mergedQueue,
      ...(mergedQueueUpdatedAt !== undefined ? { queueUpdatedAt: mergedQueueUpdatedAt } : {}),
      ...(playbackRate !== undefined ? { playbackRate } : {}),
      ...(voiceBoost !== undefined ? { voiceBoost } : {}),
      ...(trimSilence !== undefined ? { trimSilence } : {}),
      updatedAt: mergedUpdatedAt,
    },
    nowMs,
  );
}

// ---------------------------------------------------------------------------
// WebVTT parsing & active-cue helpers (shared semantics with listen.js)
// ---------------------------------------------------------------------------

export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

const VTT_TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;

/** Parse a WebVTT timestamp (`HH:MM:SS.mmm` or `MM:SS.mmm`) into seconds, or `null`. */
export function parseVttTimestamp(raw: string): number | null {
  const match = VTT_TIMESTAMP_RE.exec(raw.trim());
  if (!match) return null;
  const hours = match[1] !== undefined ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millisStr = (match[4] ?? "0").padEnd(3, "0");
  const millis = Number(millisStr);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(millis) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function decodeVttEntities(text: string): string {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * Parse a WebVTT document into ordered timed cues with optional `<v Speaker>` voice labels.
 * Strips markup tags and decodes entities to plain text so callers can safely render via textContent.
 */
export function parseWebVtt(raw: string): TranscriptCue[] {
  if (!raw || typeof raw !== "string") return [];
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues: TranscriptCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd());
    const firstNonEmpty = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
    if (!firstNonEmpty) continue;
    if (
      firstNonEmpty.startsWith("WEBVTT") ||
      firstNonEmpty.startsWith("NOTE") ||
      firstNonEmpty.startsWith("STYLE") ||
      firstNonEmpty.startsWith("REGION")
    ) {
      continue;
    }

    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const timingLine = lines[timingIndex]!;
    const arrowIndex = timingLine.indexOf("-->");
    const startRaw = timingLine.slice(0, arrowIndex).trim();
    const endPart = timingLine.slice(arrowIndex + 3).trim();
    const endRaw = endPart.split(/\s+/)[0] ?? "";

    const start = parseVttTimestamp(startRaw);
    const end = parseVttTimestamp(endRaw);
    if (start === null || end === null || end < start) continue;

    const rawBody = lines.slice(timingIndex + 1).join("\n").trim();
    if (!rawBody) continue;

    let speaker: string | undefined;
    let body = rawBody;
    const voiceMatch = /^<v(?:\.[^>\s]+)*\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/i.exec(body);
    if (voiceMatch) {
      speaker = decodeVttEntities(voiceMatch[1]!.trim()) || undefined;
      body = voiceMatch[2]!;
    }
    const cleanText = decodeVttEntities(body.replace(/<[^>]+>/g, ""))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!cleanText) continue;

    cues.push(speaker ? { start, end, text: cleanText, speaker } : { start, end, text: cleanText });
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/**
 * Find the active cue index for `currentTime` in an ascending list of `TranscriptCue`s.
 * Returns `-1` when no cue is active (empty list, negative time, before first cue, or past last cue).
 */
export function findActiveCueIndex(cues: readonly TranscriptCue[], currentTime: number): number {
  if (cues.length === 0 || !Number.isFinite(currentTime) || currentTime < 0) return -1;

  // Direct hit: prefer the latest cue whose [start - 0.05, end) covers currentTime.
  let hit = -1;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    if (currentTime >= cue.start - 0.05 && currentTime < cue.end) {
      hit = i;
    } else if (cue.start - 0.05 > currentTime) {
      break;
    }
  }
  if (hit !== -1) return hit;

  // Bridge short silent gaps between cues so highlight stays steady while playing.
  const first = cues[0]!;
  const last = cues[cues.length - 1]!;
  if (currentTime >= first.start && currentTime <= last.end) {
    let prev = -1;
    for (let i = 0; i < cues.length; i++) {
      if (cues[i]!.start <= currentTime) prev = i;
      else break;
    }
    return prev;
  }

  return -1;
}
