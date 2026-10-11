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
 * 2. Key redaction for diagnostic logging (redactSampleKey).
 * 3. Inventory scanning across MetadataStore (Memory and KV).
 *
 * Strictly no mutations or writes are performed by this module.
 *
 * Owned by: audio-feed-e6xb.
 */

import type { MetadataStore } from "./mod.ts";
import { type AudioMode, type Episode, isAudioMode } from "../types.ts";

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

/**
 * Redacts sensitive tokens or identifiers from an audio key for safe logging,
 * while preserving structure, prefix, and extension.
 */
export function redactSampleKey(rawKey: string): string {
  if (!rawKey) return "";
  const parts = rawKey.split("/");
  const file = parts.pop() || "";
  const dotIndex = file.lastIndexOf(".");
  const ext = dotIndex !== -1 ? file.slice(dotIndex) : "";
  const stem = dotIndex !== -1 ? file.slice(0, dotIndex) : file;

  const maskedStem = stem.length <= 4
    ? "*".repeat(stem.length)
    : `${stem.slice(0, 2)}${"*".repeat(Math.min(6, Math.max(2, stem.length - 4)))}${
      stem.slice(-2)
    }`;

  return [...parts, `${maskedStem}${ext}`].join("/");
}

export interface AudioInventorySample {
  episodeId: string;
  userId: string;
  mode: AudioMode;
  redactedKey: string;
}

export interface AudioInventoryResult {
  totalUsersScanned: number;
  totalEpisodesScanned: number;
  episodesWithAudioKey: number;
  canonicalCount: number;
  legacyCount: number;
  legacySamples: AudioInventorySample[];
}

/**
 * Scans the metadata store to inventory episodes with canonical vs legacy audio keys.
 * Strictly read-only: performs zero mutations against the store.
 */
export async function inventoryLegacyAudioKeys(
  metadata: MetadataStore,
  opts?: { maxSamples?: number },
): Promise<AudioInventoryResult> {
  const maxSamples = opts?.maxSamples ?? 5;
  const users = await metadata.listUsers();
  let totalEpisodesScanned = 0;
  let episodesWithAudioKey = 0;
  let canonicalCount = 0;
  let legacyCount = 0;
  const legacySamples: AudioInventorySample[] = [];

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
          if (legacySamples.length < maxSamples) {
            legacySamples.push({
              episodeId: episode.id,
              userId: episode.userId,
              mode: episode.mode,
              redactedKey: redactSampleKey(episode.audioKey),
            });
          }
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
    legacySamples,
  };
}
