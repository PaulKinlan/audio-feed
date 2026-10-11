/**
 * Read-only inventory helpers for legacy flat audio keys (audio-feed-e6xb).
 *
 * In early versions of audio-feed, episodes were written with flat audio keys
 * (e.g. "legacy.wav", "episode-1.mp3", or "audio/ready.wav") lacking user and
 * mode attribution. Canonical keys are structured as `audio/<userId>/<mode>/<filename>`
 * (or 3-segment route-trimmed `<userId>/<mode>/<filename>`).
 *
 * This module provides strictly read-only scanning and diagnostic reporting:
 * 1. Detection of canonical vs legacy audio keys (isCanonicalAudioKey).
 * 2. Whitelist-based extension and structural shape categorization.
 * 3. Inventory scanning across MetadataStore (Memory and KV).
 *
 * Privacy and safety constraints (audio-feed-2qgb, audio-feed-tyxd):
 * Produces STRICTLY AGGREGATE COUNTS ONLY. Never emits user IDs, key fragments,
 * filenames, or arbitrary suffixes into logs or CLI output.
 *
 * Strictly no mutations or writes are performed by this module.
 *
 * Owned by: audio-feed-e6xb.
 */

import type { MetadataStore } from "./mod.ts";
import { type Episode, isAudioMode } from "../types.ts";

/** Strict whitelist of recognized safe audio extensions. */
export const KNOWN_AUDIO_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".m4a",
  ".ogg",
  ".webm",
] as const;

export type KnownAudioExtension = (typeof KNOWN_AUDIO_EXTENSIONS)[number] | "other" | "none";

/**
 * Categorizes an audio key's file extension against a strict whitelist.
 * Arbitrary user-supplied suffixes (e.g. .sensitive-2026) are grouped into "other"
 * to prevent data exfiltration through operational diagnostics (audio-feed-tyxd).
 */
export function categorizeExtension(key: string): KnownAudioExtension {
  const lower = key.toLowerCase();
  for (const ext of KNOWN_AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  if (key.includes(".")) return "other";
  return "none";
}

/**
 * Categorizes the structure shape of a legacy audio key.
 */
export function categorizeShape(key: string): "flat" | "audioPrefixed" | "nested" {
  const parts = key.split("/");
  if (parts.length === 1) return "flat";
  if (parts.length === 2 && parts[0] === "audio") return "audioPrefixed";
  return "nested";
}

/**
 * Checks whether an audio key is in canonical format.
 *
 * Canonical audio keys are either:
 *   - `audio/<userId>/<mode>/<file>` (4 segments, starts with "audio/")
 *   - `<userId>/<mode>/<file>` (3 segments, route-trimmed)
 * where <mode> is a valid AudioMode ("direct" | "deepdive"), <userId> is non-empty,
 * and <file> ends in .wav or .mp3.
 *
 * When `episode` is provided, also verifies that <userId> matches episode.userId
 * and <mode> matches episode.mode.
 */
export function isCanonicalAudioKey(
  rawKey: string,
  episode?: Pick<Episode, "userId" | "mode">,
): boolean {
  if (!rawKey || typeof rawKey !== "string") return false;
  if (!/\.(wav|mp3)$/i.test(rawKey)) return false;

  const parts = rawKey.split("/");

  // 4-segment canonical key: audio/<userId>/<mode>/<filename>
  if (parts.length === 4) {
    const [prefix, userId, mode, file] = parts;
    if (prefix !== "audio" || !userId || !isAudioMode(mode) || !file) return false;
    if (episode) {
      if (userId !== episode.userId || mode !== episode.mode) return false;
    }
    return true;
  }

  // 3-segment route-trimmed canonical key: <userId>/<mode>/<filename>
  if (parts.length === 3) {
    const [userId, mode, file] = parts;
    if (!userId || !isAudioMode(mode) || !file) return false;
    if (episode) {
      if (userId !== episode.userId || mode !== episode.mode) return false;
    }
    return true;
  }

  return false;
}

export interface AudioInventoryResult {
  totalUsersScanned: number;
  totalEpisodesScanned: number;
  episodesWithAudioKey: number;
  canonicalCount: number;
  legacyCount: number;
  byShape: {
    flat: number;
    audioPrefixed: number;
    nested: number;
  };
  byExtension: Record<KnownAudioExtension, number>;
}

/**
 * Scans the metadata store to inventory episodes with canonical vs legacy audio keys.
 * Strictly read-only: performs zero mutations against the store.
 * Returns STRICTLY AGGREGATE COUNTS ONLY with zero user identifiers or key fragments.
 */
export async function inventoryLegacyAudioKeys(
  metadata: MetadataStore,
): Promise<AudioInventoryResult> {
  const users = await metadata.listUsers();
  let totalEpisodesScanned = 0;
  let episodesWithAudioKey = 0;
  let canonicalCount = 0;
  let legacyCount = 0;

  const byShape = {
    flat: 0,
    audioPrefixed: 0,
    nested: 0,
  };

  const byExtension: Record<KnownAudioExtension, number> = {
    ".wav": 0,
    ".mp3": 0,
    ".m4a": 0,
    ".ogg": 0,
    ".webm": 0,
    "other": 0,
    "none": 0,
  };

  for (const user of users) {
    let cursor: string | undefined = undefined;
    do {
      const page = await metadata.listEpisodePage({
        userId: user.id,
        cursor,
        limit: 100,
      });
      for (const episode of page.episodes) {
        totalEpisodesScanned++;
        if (!episode.audioKey) continue;
        episodesWithAudioKey++;
        if (isCanonicalAudioKey(episode.audioKey, episode)) {
          canonicalCount++;
        } else {
          legacyCount++;
          byShape[categorizeShape(episode.audioKey)]++;
          byExtension[categorizeExtension(episode.audioKey)]++;
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }

  return {
    totalUsersScanned: users.length,
    totalEpisodesScanned,
    episodesWithAudioKey,
    canonicalCount,
    legacyCount,
    byShape,
    byExtension,
  };
}
