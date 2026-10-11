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
 * 2. Key and identifier redaction for diagnostic logging (redactSampleKey, hashIdentifier).
 * 3. Inventory scanning across MetadataStore (Memory and KV).
 *
 * Privacy and safety constraints (audio-feed-2qgb):
 * Samples must NEVER reveal raw user identifiers or unmasked path components.
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
 * Categorizes the structure shape of a legacy audio key.
 */
export function categorizeAudioKeyShape(
  rawKey: string,
): "flat" | "audio-prefixed" | "nested" {
  const parts = rawKey.split("/");
  if (parts.length === 1) return "flat";
  if (parts.length === 2 && parts[0] === "audio") return "audio-prefixed";
  return "nested";
}

/**
 * Generates a stable, truncated non-reversible SHA-256 hash of an identifier (e.g. userId),
 * allowing correlation across samples without exposing subscriber identities (audio-feed-2qgb).
 */
export async function hashIdentifier(id: string): Promise<string> {
  const data = new TextEncoder().encode(id);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

/**
 * Redacts an audio key for safe diagnostic logging (audio-feed-2qgb).
 * Guarantees that NO path components or filename stems are exposed in cleartext.
 * Only the public prefix ("audio", if present) and file extension (.mp3 / .wav) are preserved.
 */
export function redactSampleKey(rawKey: string): string {
  if (!rawKey) return "";
  const parts = rawKey.split("/");
  const file = parts.pop() || "";
  const dotIndex = file.lastIndexOf(".");
  const ext = dotIndex !== -1 ? file.slice(dotIndex).toLowerCase() : "";

  const maskedParts: string[] = parts.map((seg) => (seg === "audio" ? "audio" : "[path]"));
  maskedParts.push(`[token]${ext}`);
  return maskedParts.join("/");
}

export interface AudioInventorySample {
  userHash: string;
  mode: AudioMode;
  shape: "flat" | "audio-prefixed" | "nested";
  segmentCount: number;
  extension: string;
  maskedKey: string;
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
 * Anonymizes samples with non-reversible hashes and masked path tokens (audio-feed-2qgb).
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
    const userHash = await hashIdentifier(user.id);
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
            const parts = episode.audioKey.split("/");
            const file = parts[parts.length - 1] || "";
            const dotIndex = file.lastIndexOf(".");
            const ext = dotIndex !== -1 ? file.slice(dotIndex).toLowerCase() : "";

            legacySamples.push({
              userHash,
              mode: episode.mode,
              shape: categorizeAudioKeyShape(episode.audioKey),
              segmentCount: parts.length,
              extension: ext,
              maskedKey: redactSampleKey(episode.audioKey),
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
