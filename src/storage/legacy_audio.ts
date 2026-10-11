/**
 * Inventory and migration helpers for legacy flat audio keys (audio-feed-e6xb).
 *
 * In early versions of audio-feed, episodes were written with flat audio keys
 * (e.g. "legacy.wav", "episode-1.mp3", or "audio/ready.wav") lacking user and
 * mode attribution. Canonical keys are structured as `audio/<userId>/<mode>/<filename>`
 * (or 3-segment route-trimmed `<userId>/<mode>/<filename>`).
 *
 * This module provides:
 * 1. Detection of canonical vs legacy audio keys.
 * 2. Key redaction for diagnostic logging.
 * 3. Inventory scanning across MetadataStore (Memory and KV).
 * 4. Safe, idempotent migration to rewrite legacy keys to canonical format.
 *    (Default dry-run mode; explicit apply required).
 *
 * Owned by: audio-feed-e6xb.
 */

import type { BlobObject, BlobStore, MetadataStore } from "./mod.ts";
import { type AudioMode, type Episode, isAudioMode, type User } from "../types.ts";

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
 * Derives the canonical audio key for an episode.
 *
 * If the key is already 4-segment canonical, returns it unchanged.
 * If 3-segment canonical, normalizes to canonical storage format (`audio/...`).
 * If a legacy flat key, prefixes with `audio/<userId>/<mode>/<filename>`.
 */
export function canonicalizeAudioKey(episode: Episode): string {
  if (!episode.audioKey) {
    throw new Error(`Cannot canonicalize episode ${episode.id}: audioKey is missing`);
  }

  if (isCanonicalAudioKey(episode.audioKey, episode)) {
    if (episode.audioKey.startsWith("audio/")) {
      return episode.audioKey;
    }
    return `audio/${episode.audioKey}`;
  }

  // Extract the filename portion from the legacy key (stripping any legacy 'audio/' prefix)
  const parts = episode.audioKey.split("/");
  const filename = parts[parts.length - 1] || `${episode.id}.mp3`;
  return `audio/${episode.userId}/${episode.mode}/${filename}`;
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

export interface MigrationPlanItem {
  episodeId: string;
  userId: string;
  oldKey: string;
  newKey: string;
  blobCopied?: boolean;
}

export interface MigrationResult {
  dryRun: boolean;
  usersScanned: number;
  episodesScanned: number;
  legacyFound: number;
  migrated: number;
  skippedAlreadyCanonical: number;
  blobCopies: number;
  plan: MigrationPlanItem[];
  errors: Array<{ episodeId: string; userId: string; error: string }>;
}

export interface MigrationOptions {
  /**
   * Whether to actually apply changes. Default: false (dry-run).
   */
  apply?: boolean;
  /**
   * Optional BlobStore: if provided and apply=true, ensures blob content
   * is copied from legacy key to canonical key.
   */
  blobs?: BlobStore;
  /**
   * Optional userId filter to restrict migration to one user.
   */
  userId?: string;
  /**
   * Progress logging callback.
   */
  log?: (msg: string) => void;
}

/**
 * Rewrites legacy flat audioKeys to canonical keys in the metadata store.
 * Idempotent, safe, and defaults to dry-run (no mutations without apply: true).
 */
export async function migrateLegacyAudioKeys(
  metadata: MetadataStore,
  opts?: MigrationOptions,
): Promise<MigrationResult> {
  const apply = opts?.apply ?? false;
  const dryRun = !apply;
  const log = opts?.log;

  const users: User[] = opts?.userId
    ? [await metadata.getUser(opts.userId)].filter((u): u is User => Boolean(u))
    : await metadata.listUsers();

  let episodesScanned = 0;
  let legacyFound = 0;
  let migrated = 0;
  let skippedAlreadyCanonical = 0;
  let blobCopies = 0;
  const plan: MigrationPlanItem[] = [];
  const errors: Array<{ episodeId: string; userId: string; error: string }> = [];

  for (const user of users) {
    let cursor: string | undefined = undefined;
    do {
      const page = await metadata.listEpisodePage({
        userId: user.id,
        cursor,
        limit: 100,
      });
      for (const episode of page.episodes) {
        episodesScanned++;
        if (!episode.audioKey) continue;

        if (isCanonicalAudioKey(episode.audioKey, episode)) {
          skippedAlreadyCanonical++;
          continue;
        }

        legacyFound++;
        const oldKey = episode.audioKey;
        const newKey = canonicalizeAudioKey(episode);

        const planItem: MigrationPlanItem = {
          episodeId: episode.id,
          userId: episode.userId,
          oldKey,
          newKey,
        };

        if (apply) {
          try {
            // If BlobStore is provided, ensure the blob is accessible under newKey
            if (opts?.blobs) {
              const headNew = await opts.blobs.head(newKey);
              if (!headNew) {
                // Find blob at candidate legacy keys
                const candidates = oldKey.startsWith("audio/")
                  ? [oldKey]
                  : [`audio/${oldKey}`, oldKey];
                let foundBlob: BlobObject | null = null;
                for (const c of candidates) {
                  foundBlob = await opts.blobs.get(c);
                  if (foundBlob) break;
                }
                if (foundBlob) {
                  await opts.blobs.put(newKey, foundBlob.body, {
                    contentType: foundBlob.contentType,
                  });
                  blobCopies++;
                  planItem.blobCopied = true;
                  log?.(`Copied blob from legacy key to ${newKey}`);
                }
              }
            }

            // Update the episode record in metadata store
            const updated: Episode = {
              ...episode,
              audioKey: newKey,
            };
            await metadata.putEpisode(updated);
            migrated++;
            log?.(`Migrated episode ${episode.id} audioKey: ${oldKey} -> ${newKey}`);
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            errors.push({ episodeId: episode.id, userId: episode.userId, error: errorMsg });
            log?.(`Failed to migrate episode ${episode.id}: ${errorMsg}`);
          }
        }

        plan.push(planItem);
      }
      cursor = page.cursor;
    } while (cursor);
  }

  return {
    dryRun,
    usersScanned: users.length,
    episodesScanned,
    legacyFound,
    migrated,
    skippedAlreadyCanonical,
    blobCopies,
    plan,
    errors,
  };
}
