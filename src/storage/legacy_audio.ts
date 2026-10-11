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

import type { BlobInfo, BlobStore, MetadataStore } from "./mod.ts";
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
  status: "applied" | "dry_run" | "refused_missing_source" | "refused_conflict";
  blobCopied?: boolean;
  error?: string;
}

export interface MigrationResult {
  dryRun: boolean;
  usersScanned: number;
  episodesScanned: number;
  legacyFound: number;
  migrated: number;
  skippedAlreadyCanonical: number;
  blobCopies: number;
  refusedMissingSource: number;
  refusedConflict: number;
  plan: MigrationPlanItem[];
  errors: Array<{ episodeId: string; userId: string; error: string }>;
}

export interface MigrationOptions {
  /**
   * Whether to actually apply changes. Default: false (dry-run).
   */
  apply?: boolean;
  /**
   * BlobStore: required when apply=true (unless allowMissingBlobs=true).
   * Used to verify source blob existence, verify destination conflicts, and copy blobs.
   */
  blobs?: BlobStore;
  /**
   * Allow metadata renames even when BlobStore is omitted or source blobs are missing.
   * Default: false (strict blob presence and integrity required).
   */
  allowMissingBlobs?: boolean;
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
 * Stream comparison helper: streams two bodies chunk by chunk to verify exact byte equality
 * without assuming identical chunk boundaries.
 */
async function compareStreams(
  s1: ReadableStream<Uint8Array>,
  s2: ReadableStream<Uint8Array>,
): Promise<boolean> {
  const r1 = s1.getReader();
  const r2 = s2.getReader();
  try {
    let buf1: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let buf2: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let done1 = false;
    let done2 = false;

    while (!done1 || !done2 || buf1.length > 0 || buf2.length > 0) {
      if (buf1.length === 0 && !done1) {
        const res = await r1.read();
        if (res.done) done1 = true;
        else buf1 = res.value;
      }
      if (buf2.length === 0 && !done2) {
        const res = await r2.read();
        if (res.done) done2 = true;
        else buf2 = res.value;
      }

      if (buf1.length === 0 && buf2.length === 0) {
        if (done1 && done2) return true;
        if (done1 !== done2) return false;
      }

      const take = Math.min(buf1.length, buf2.length);
      if (take === 0) {
        if (done1 !== done2) return false;
        continue;
      }

      for (let i = 0; i < take; i++) {
        if (buf1[i] !== buf2[i]) return false;
      }

      buf1 = buf1.subarray(take);
      buf2 = buf2.subarray(take);
    }

    return true;
  } finally {
    r1.releaseLock();
    r2.releaseLock();
  }
}

/**
 * Rewrites legacy flat audioKeys to canonical keys in the metadata store.
 * Idempotent, safe, and defaults to dry-run (no mutations without apply: true).
 * Validates that source blobs exist and destination blobs do not conflict.
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
  let refusedMissingSource = 0;
  let refusedConflict = 0;
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

        // 1. Blob presence and conflict validation
        let sourceKey: string | null = null;
        let sourceInfo: BlobInfo | null = null;
        let destInfo: BlobInfo | null = null;
        let needCopy = false;

        if (opts?.blobs) {
          const candidates = oldKey.startsWith("audio/") ? [oldKey] : [`audio/${oldKey}`, oldKey];
          for (const c of candidates) {
            const h = await opts.blobs.head(c);
            if (h) {
              sourceKey = c;
              sourceInfo = h;
              break;
            }
          }
          destInfo = await opts.blobs.head(newKey);

          // If source blob is missing and allowMissingBlobs is false, refuse!
          if (!sourceInfo && !opts?.allowMissingBlobs) {
            refusedMissingSource++;
            const error = `Source blob not found for legacy key "${oldKey}" in storage`;
            errors.push({ episodeId: episode.id, userId: episode.userId, error });
            log?.(`Refusing migration for episode ${episode.id}: ${error}`);
            plan.push({
              episodeId: episode.id,
              userId: episode.userId,
              oldKey,
              newKey,
              status: "refused_missing_source",
              error,
            });
            continue;
          }

          // If destination blob already exists, verify it matches source
          if (destInfo) {
            if (sourceInfo) {
              if (destInfo.size !== sourceInfo.size) {
                refusedConflict++;
                const error =
                  `Conflicting destination blob already exists at "${newKey}" with different size (${destInfo.size} != ${sourceInfo.size})`;
                errors.push({ episodeId: episode.id, userId: episode.userId, error });
                log?.(`Refusing migration for episode ${episode.id}: ${error}`);
                plan.push({
                  episodeId: episode.id,
                  userId: episode.userId,
                  oldKey,
                  newKey,
                  status: "refused_conflict",
                  error,
                });
                continue;
              }
              const [sourceObj, destObj] = await Promise.all([
                opts.blobs.get(sourceKey!),
                opts.blobs.get(newKey),
              ]);
              if (!sourceObj || !destObj) {
                refusedConflict++;
                const error = `Failed to read blobs during conflict verification for "${newKey}"`;
                errors.push({ episodeId: episode.id, userId: episode.userId, error });
                plan.push({
                  episodeId: episode.id,
                  userId: episode.userId,
                  oldKey,
                  newKey,
                  status: "refused_conflict",
                  error,
                });
                continue;
              }
              const matches = await compareStreams(sourceObj.body, destObj.body);
              if (!matches) {
                refusedConflict++;
                const error =
                  `Conflicting destination blob already exists at "${newKey}" with different content`;
                errors.push({ episodeId: episode.id, userId: episode.userId, error });
                log?.(`Refusing migration for episode ${episode.id}: ${error}`);
                plan.push({
                  episodeId: episode.id,
                  userId: episode.userId,
                  oldKey,
                  newKey,
                  status: "refused_conflict",
                  error,
                });
                continue;
              }
            }
          } else if (sourceInfo) {
            needCopy = true;
          }
        } else if (apply && !opts?.allowMissingBlobs) {
          throw new Error(
            "BlobStore is required to safely apply audio key migrations (pass blobs or explicit allowMissingBlobs: true)",
          );
        }

        const planItem: MigrationPlanItem = {
          episodeId: episode.id,
          userId: episode.userId,
          oldKey,
          newKey,
          status: apply ? "applied" : "dry_run",
        };

        if (apply) {
          try {
            // Copy source blob to canonical key if destination is not yet populated
            if (opts?.blobs && needCopy && sourceKey) {
              const sourceObj = await opts.blobs.get(sourceKey);
              if (sourceObj) {
                await opts.blobs.put(newKey, sourceObj.body, {
                  contentType: sourceObj.contentType,
                });
                blobCopies++;
                planItem.blobCopied = true;
                log?.(`Copied blob from ${sourceKey} to ${newKey}`);
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
            planItem.error = errorMsg;
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
    refusedMissingSource,
    refusedConflict,
    plan,
    errors,
  };
}
