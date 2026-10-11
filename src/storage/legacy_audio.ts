/**
 * Inventory and migration helpers for legacy flat audio keys (audio-feed-e6xb, audio-feed-nls7).
 *
 * In early versions of audio-feed, episodes were written with flat audio keys
 * (e.g. "legacy.wav", "episode-1.mp3", or "audio/ready.wav") lacking user and
 * mode attribution. Canonical keys are structured as `audio/<userId>/<mode>/<filename>`
 * (or 3-segment route-trimmed `<userId>/<mode>/<filename>`).
 *
 * This module provides:
 * 1. Detection of canonical vs legacy audio keys (isCanonicalAudioKey).
 * 2. Whitelist-based extension and structural shape categorization.
 * 3. Read-only inventory scanning across MetadataStore (Memory and KV).
 *    (Strictly aggregate counts only; zero user IDs, key fragments, or arbitrary suffixes).
 * 4. Safe, transactional migration helper (migrateLegacyAudioKeys):
 *    - Dry-run by default, explicit apply required.
 *    - Single-writer migration lock guard across isolates and processes.
 *    - Atomic conditional creation via BlobStore.putIfAbsent (backed by S3 If-None-Match: *).
 *      Eliminates TOCTOU overwrite race against concurrent canonical writers (qm7b).
 *    - Strict read hygiene: a read that THROWS is NOT absence (axq4).
 *    - Verifies source blob is non-null via get() before any repoint (ogd7, v6an).
 *    - When destination exists: compares byte content; refuses on mismatch (rv3a);
 *      repoints without duplicate copy when identical.
 *    - Idempotent and safe for single-writer execution.
 *
 * Owned by: audio-feed-e6xb, audio-feed-nls7, audio-feed-whsl.
 */

import type { BlobStore, MetadataStore } from "./mod.ts";
import { type Episode, isAudioMode, type User } from "../types.ts";

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

/**
 * Derives the canonical storage key for an episode: audio/<userId>/<mode>/<filename>.
 */
export function canonicalizeAudioKey(episode: Episode): string {
  if (!episode.audioKey) {
    throw new Error(`Cannot canonicalize episode ${episode.id}: audioKey is missing`);
  }
  if (isCanonicalAudioKey(episode.audioKey, episode)) {
    return episode.audioKey.startsWith("audio/") ? episode.audioKey : `audio/${episode.audioKey}`;
  }
  const parts = episode.audioKey.split("/");
  const filename = parts[parts.length - 1] || `${episode.id}.mp3`;
  return `audio/${episode.userId}/${episode.mode}/${filename}`;
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
  /**
   * Lock lease TTL in milliseconds (default: 600,000ms / 10min).
   */
  leaseMs?: number;
  /**
   * Heartbeat renewal interval in milliseconds (default: leaseMs / 3).
   */
  heartbeatIntervalMs?: number;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface MigrationLockRecord {
  active: boolean;
  lockedAt: number;
  lastHeartbeat: number;
  leaseMs: number;
  holder: string;
}

/**
 * Single-writer migration lock guard across isolates and processes.
 * Returns true if acquired, false if actively held by a live holder with fresh heartbeat (audio-feed-hrfn).
 */
export async function acquireMigrationLock(
  metadata: MetadataStore,
  holder: string,
  leaseMs = 600_000,
): Promise<boolean> {
  const now = Date.now();
  const res = await metadata.atomicUpdate<MigrationLockRecord>(
    "migration_lock:legacy_audio_keys",
    (current) => {
      if (current && current.active) {
        const lastBeat = current.lastHeartbeat || current.lockedAt;
        const currentLease = current.leaseMs || leaseMs;
        if (now - lastBeat < currentLease) {
          return null; // actively held with fresh heartbeat; refuse second holder
        }
      }
      return { active: true, lockedAt: now, lastHeartbeat: now, leaseMs, holder };
    },
    leaseMs,
  );
  return res.committed;
}

/**
 * Renews the migration lock heartbeat. Must be called periodically while the holder is active.
 * Returns true if renewed, false if lock was lost or taken over (audio-feed-hrfn).
 */
export async function renewMigrationLock(
  metadata: MetadataStore,
  holder: string,
  leaseMs = 600_000,
): Promise<boolean> {
  const now = Date.now();
  const res = await metadata.atomicUpdate<MigrationLockRecord>(
    "migration_lock:legacy_audio_keys",
    (current) => {
      if (current && current.active && current.holder === holder) {
        return {
          ...current,
          lastHeartbeat: now,
          leaseMs,
        };
      }
      return null; // lock lost or held by someone else
    },
    leaseMs,
  );
  return res.committed;
}

export async function releaseMigrationLock(
  metadata: MetadataStore,
  holder: string,
): Promise<void> {
  try {
    await metadata.atomicUpdate<MigrationLockRecord>(
      "migration_lock:legacy_audio_keys",
      (current) => {
        if (current && current.holder === holder) {
          return { active: false, lockedAt: 0, lastHeartbeat: 0, leaseMs: 0, holder: "" };
        }
        return null;
      },
    );
  } catch {
    // best-effort release
  }
}

/**
 * Rewrites legacy flat audioKeys to canonical keys in the metadata store.
 * Idempotent, safe, and defaults to dry-run (no mutations without apply: true).
 * Validates that source blobs exist and destination blobs do not conflict.
 * Enforces rule: a read that THROWS is NOT absence (axq4).
 * Uses putIfAbsent to prevent overwriting concurrent external writers (qm7b).
 */
export async function migrateLegacyAudioKeys(
  metadata: MetadataStore,
  opts?: MigrationOptions,
): Promise<MigrationResult> {
  const apply = opts?.apply ?? false;
  const dryRun = !apply;
  const log = opts?.log;
  const leaseMs = opts?.leaseMs ?? 600_000;
  const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? Math.max(10, Math.floor(leaseMs / 3));

  const lockHolder = `migrator-${crypto.randomUUID().slice(0, 8)}`;
  let lockLost = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;

  const assertLockHeld = () => {
    if (apply && lockLost) {
      throw new Error(
        `Migration aborted: lock lost or renewal failed mid-run for holder ${lockHolder}`,
      );
    }
  };

  if (apply) {
    const locked = await acquireMigrationLock(metadata, lockHolder, leaseMs);
    if (!locked) {
      throw new Error(
        "Cannot run migration: another migration is actively in progress or holds the lock",
      );
    }

    heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await renewMigrationLock(metadata, lockHolder, leaseMs);
        if (!renewed) {
          lockLost = true;
          log?.(`[migration] ERROR: lock renewal failed for holder ${lockHolder}; lock lost`);
        }
      } catch (err) {
        lockLost = true;
        log?.(`[migration] ERROR: lock renewal threw: ${err}`);
      }
    }, heartbeatIntervalMs);
  }

  try {
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
          assertLockHeld();
          episodesScanned++;
          if (!episode.audioKey) continue;

          if (isCanonicalAudioKey(episode.audioKey, episode)) {
            skippedAlreadyCanonical++;
            continue;
          }

          legacyFound++;
          const oldKey = episode.audioKey;
          const newKey = canonicalizeAudioKey(episode);

          // 1. Source blob validation: MUST call get() and read bytes (ogd7, v6an, axq4)
          let sourceBytes: Uint8Array | null = null;
          let sourceContentType = "audio/mpeg";
          let sourceReadError: string | null = null;

          if (opts?.blobs) {
            const candidates = oldKey.startsWith("audio/") ? [oldKey] : [`audio/${oldKey}`, oldKey];

            for (const c of candidates) {
              try {
                const obj = await opts.blobs.get(c);
                if (obj && obj.body) {
                  try {
                    sourceBytes = await new Response(obj.body).bytes();
                    if (obj.contentType) sourceContentType = obj.contentType;
                    break;
                  } catch (readErr) {
                    sourceReadError = `Failed reading body of source blob at "${c}": ${readErr}`;
                    break;
                  }
                }
              } catch (getErr) {
                // A read that THROWS is NOT absence (axq4)
                sourceReadError = `Failed fetching source blob at "${c}": ${getErr}`;
                break;
              }
            }

            if (sourceReadError) {
              refusedMissingSource++;
              const error = `Source blob read error for legacy key "${oldKey}": ${sourceReadError}`;
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

            assertLockHeld();

            if (!sourceBytes && !opts?.allowMissingBlobs) {
              refusedMissingSource++;
              const error =
                `Source blob not found for legacy key "${oldKey}" in storage (clean null on all candidates)`;
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
          } else if (apply && !opts?.allowMissingBlobs) {
            throw new Error(
              "BlobStore is required to safely apply audio key migrations (pass blobs or explicit allowMissingBlobs: true)",
            );
          }

          // 2. Dry-run inspection vs Apply
          if (!apply) {
            let destBytes: Uint8Array | null = null;
            let destReadError: string | null = null;

            if (opts?.blobs) {
              try {
                const destObj = await opts.blobs.get(newKey);
                if (destObj && destObj.body) {
                  try {
                    destBytes = await new Response(destObj.body).bytes();
                  } catch (bodyErr) {
                    destReadError =
                      `Failed reading body of destination blob at "${newKey}": ${bodyErr}`;
                  }
                }
              } catch (getDestErr) {
                destReadError = `Failed reading destination blob at "${newKey}": ${getDestErr}`;
              }

              if (destReadError) {
                refusedConflict++;
                const error = `Destination blob read error at "${newKey}": ${destReadError}`;
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

              if (destBytes && sourceBytes) {
                if (
                  destBytes.length !== sourceBytes.length || !bytesEqual(destBytes, sourceBytes)
                ) {
                  refusedConflict++;
                  const error =
                    `Conflicting destination blob already exists at "${newKey}" with different content`;
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
              }
            }

            plan.push({
              episodeId: episode.id,
              userId: episode.userId,
              oldKey,
              newKey,
              status: "dry_run",
            });
            continue;
          }

          // 3. Apply mode: Atomic conditional write (putIfAbsent) to prevent TOCTOU overwrites (qm7b)
          let blobWasCopied = false;

          assertLockHeld();

          if (opts?.blobs && sourceBytes) {
            let createdInfo = null;
            try {
              createdInfo = await opts.blobs.putIfAbsent(newKey, sourceBytes, {
                contentType: sourceContentType,
              });
            } catch (putErr) {
              // A write failure must refuse and preserve
              refusedConflict++;
              const error = `Failed conditional put at "${newKey}": ${putErr}`;
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

            // Immediately check lock after putIfAbsent before proceeding to collision check or metadata CAS (audio-feed-84q9)
            assertLockHeld();

            if (createdInfo !== null) {
              // We successfully created the canonical blob without race!
              blobCopies++;
              blobWasCopied = true;
              log?.(`Copied audio bytes to ${newKey}`);
            } else {
              // Destination already exists! (Preexisting or created concurrently by another writer - qm7b).
              // MUST read existing bytes and verify content equality before repointing.
              let destBytes: Uint8Array | null = null;
              let destReadError: string | null = null;

              try {
                const destObj = await opts.blobs.get(newKey);
                if (destObj && destObj.body) {
                  try {
                    destBytes = await new Response(destObj.body).bytes();
                  } catch (bodyErr) {
                    destReadError =
                      `Failed reading body of existing destination blob at "${newKey}": ${bodyErr}`;
                  }
                } else {
                  destReadError = `Existing destination blob at "${newKey}" returned null body`;
                }
              } catch (getDestErr) {
                // A read that THROWS is NOT absence! (axq4)
                destReadError =
                  `Failed reading existing destination blob at "${newKey}": ${getDestErr}`;
              }

              if (destReadError || !destBytes) {
                refusedConflict++;
                const error =
                  `Destination blob read error on conflict check at "${newKey}": ${destReadError}`;
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

              if (destBytes.length !== sourceBytes.length || !bytesEqual(destBytes, sourceBytes)) {
                // Bytes mismatch: REFUSE to repoint, preserving both metadata and existing destination (rv3a, qm7b).
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

              // Bytes match identically: safe to repoint without duplicate blob copy.
              log?.(`Existing destination ${newKey} has identical bytes; repointing metadata`);
            }
            assertLockHeld();
          }

          const planItem: MigrationPlanItem = {
            episodeId: episode.id,
            userId: episode.userId,
            oldKey,
            newKey,
            status: "applied",
            blobCopied: blobWasCopied,
          };

          // Guard immediately before CAS commit: must not commit metadata if lock was lost (audio-feed-84q9)
          assertLockHeld();

          try {
            const casOk = await metadata.updateEpisodeAudioKeyIfCurrent(
              episode.userId,
              episode.id,
              oldKey,
              newKey,
            );
            if (casOk) {
              migrated++;
              log?.(`Migrated episode ${episode.id} audioKey: ${oldKey} -> ${newKey}`);
            } else {
              // The episode was modified concurrently or its audioKey is no longer oldKey!
              // The concurrent writer wins; do not clobber (audio-feed-9731).
              refusedConflict++;
              const error =
                `Concurrent writer modified episode ${episode.id} (stored audioKey is no longer "${oldKey}"); skipped to preserve concurrent write`;
              errors.push({ episodeId: episode.id, userId: episode.userId, error });
              planItem.status = "refused_conflict";
              planItem.error = error;
              log?.(`Refusing migration for episode ${episode.id}: ${error}`);
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            errors.push({ episodeId: episode.id, userId: episode.userId, error: errorMsg });
            planItem.error = errorMsg;
            planItem.status = "refused_conflict";
            refusedConflict++;
            log?.(`Failed to migrate episode ${episode.id}: ${errorMsg}`);
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
  } finally {
    if (apply) {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
      }
      await releaseMigrationLock(metadata, lockHolder);
    }
  }
}
