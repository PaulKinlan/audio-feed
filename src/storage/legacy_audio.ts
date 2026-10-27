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
  /**
   * Callback fired when the background heartbeat observes lock loss
   * (either renewal returned false or renewal threw). Allows callers/tests
   * to observe the lockLost state transition directly without scraping log strings (audio-feed-gm1gb).
   */
  onLockLost?: (reason: "failed" | "threw", error?: unknown) => void;
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
 * `nowMs` lets tests drive the expiry logic with fixed timestamps instead of sleeping real
 * milliseconds against a real lease — a test that sleeps measures the machine, not the
 * lock (audio-feed-y2ex).
 */
export async function acquireMigrationLock(
  metadata: MetadataStore,
  holder: string,
  leaseMs = 600_000,
  nowMs?: number,
): Promise<boolean> {
  const now = nowMs ?? Date.now();
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
 * `nowMs` for the same reason as acquireMigrationLock: fixed-time tests, not sleeps.
 */
export async function renewMigrationLock(
  metadata: MetadataStore,
  holder: string,
  leaseMs = 600_000,
  nowMs?: number,
): Promise<boolean> {
  const now = nowMs ?? Date.now();
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
          opts?.onLockLost?.("failed");
          log?.(`[migration] ERROR: lock renewal failed for holder ${lockHolder}; lock lost`);
        }
      } catch (err) {
        lockLost = true;
        opts?.onLockLost?.("threw", err);
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
              clearLegacyKeyIndexCache(metadata);
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

interface KeyOwnerEntry {
  userId: string;
  episodeId: string;
  count: number;
}

interface LegacyKeyIndex {
  expiresAt: number;
  generation: number;
  owners: Map<string, KeyOwnerEntry>;
}

const legacyKeyIndexCache = new WeakMap<MetadataStore, LegacyKeyIndex>();
const metadataMutationGenerations = new WeakMap<MetadataStore, number>();
const hookedMetadataStores = new WeakSet<MetadataStore>();
const INDEX_TTL_MS = 60_000;

function bumpMetadataGeneration(metadata: MetadataStore): void {
  const next = (metadataMutationGenerations.get(metadata) ?? 0) + 1;
  metadataMutationGenerations.set(metadata, next);
  legacyKeyIndexCache.delete(metadata);
}

function ensureMetadataInvalidationHooks(metadata: MetadataStore): void {
  if (hookedMetadataStores.has(metadata)) return;
  hookedMetadataStores.add(metadata);

  const mutatingMethods = [
    "putUser",
    "deleteUser",
    "putEpisode",
    "completeEpisode",
    "updateEpisodeAudioKeyIfCurrent",
    "claimEpisode",
    "releaseEpisodeClaim",
    "atomicUpdate",
  ] as const;

  const target = metadata as unknown as Record<string, unknown>;
  for (const method of mutatingMethods) {
    const orig = target[method];
    if (typeof orig !== "function") continue;
    target[method] = function (...args: unknown[]) {
      bumpMetadataGeneration(metadata);
      const result = (orig as (...a: unknown[]) => unknown).apply(this, args);
      if (result && typeof (result as Promise<unknown>).finally === "function") {
        return (result as Promise<unknown>).finally(() => {
          bumpMetadataGeneration(metadata);
        });
      }
      return result;
    };
  }
}

/** Normalizes a legacy audio key by removing any leading 'audio/' prefix. */
export function normalizeLegacyAudioKey(key: string): string {
  return key.startsWith("audio/") ? key.slice(6) : key;
}

async function buildLegacyKeyIndex(
  metadata: MetadataStore,
  now: number,
): Promise<LegacyKeyIndex> {
  const startGen = metadataMutationGenerations.get(metadata) ?? 0;
  const owners = new Map<string, KeyOwnerEntry>();
  const seenEpisodes = new Set<string>();
  const users = await metadata.listUsers();

  for (const user of users) {
    let cursor: string | undefined = undefined;
    do {
      const page = await metadata.listEpisodePage({
        userId: user.id,
        cursor,
        limit: 100,
      });
      for (const ep of page.episodes) {
        const epKey = `${user.id}:${ep.id}`;
        if (seenEpisodes.has(epKey)) continue;
        seenEpisodes.add(epKey);

        if (!ep.audioKey || isCanonicalAudioKey(ep.audioKey, ep)) {
          continue;
        }
        const k = normalizeLegacyAudioKey(ep.audioKey);
        const existing = owners.get(k);
        if (!existing) {
          owners.set(k, { userId: user.id, episodeId: ep.id, count: 1 });
        } else {
          existing.count++;
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }

  const endGen = metadataMutationGenerations.get(metadata) ?? 0;
  const index: LegacyKeyIndex = {
    expiresAt: now + INDEX_TTL_MS,
    generation: endGen,
    owners,
  };
  if (startGen === endGen) {
    legacyKeyIndexCache.set(metadata, index);
  }
  return index;
}

/**
 * Targeted re-verification of a cached unique owner (audio-feed-y63gb): ONE
 * getEpisode read instead of a full index rebuild. The owner must still exist
 * and still point at the same normalized legacy key - a moved, migrated or
 * deleted key disagrees and falls back to the full rebuild.
 */
async function cachedLegacyKeyOwnershipHolds(
  metadata: MetadataStore,
  entry: KeyOwnerEntry,
  normKey: string,
): Promise<boolean> {
  const ep = await metadata.getEpisode(entry.userId, entry.episodeId);
  return !!ep?.audioKey && normalizeLegacyAudioKey(ep.audioKey) === normKey;
}

/**
 * Returns the unique owner user ID of a legacy flat audio key, or null if the key
 * is ambiguous (referenced by zero or multiple episodes globally) (audio-feed-65lf, audio-feed-ni04).
 *
 * Uses a bounded, in-memory cache per MetadataStore instance, invalidated immediately
 * on any of the EIGHT HOOKED MUTATION METHODS (see ensureMetadataInvalidationHooks:
 * putUser, deleteUser, putEpisode, completeEpisode, updateEpisodeAudioKeyIfCurrent,
 * claimEpisode, releaseEpisodeClaim, atomicUpdate) made THROUGH THIS INSTANCE, and
 * re-verified before authorizing a positive owner (audio-feed-y63gb: one targeted
 * getEpisode) so moved/migrated/deleted keys disagree and fall back to a full rebuild.
 * Mutations through methods OUTSIDE that list do not invalidate the cache; the
 * targeted re-verify, the TTL, and the forcing escapes below are what bound that gap
 * (audio-feed-uk1xn: name the hooks, do not overclaim the invalidation scope).
 *
 * BOUNDED WINDOW, EXPLICIT (audio-feed-uhmzv): the invalidation hooks and the generation
 * counter are PER INSTANCE (WeakMap/WeakSet keyed on the handle). A colliding episode added
 * through a DIFFERENT MetadataStore handle over the same underlying store (another instance,
 * e.g. another Deno Deploy isolate) is not visible to this handle's cache until INDEX_TTL_MS
 * expires or the caller forces the store via options.bypassCache / clearLegacyKeyIndexCache.
 * The TTL-expiry half of that sentence has NO ROW: testing a real 60s expiry needs a real
 * sleep, which docs/speed.md rule 1 forbids - untested by design (audio-feed-uk1xn); the
 * forcing escapes ARE tested.
 * Within that window this handle can still authorize the cached owner for a key that has just
 * become ambiguous elsewhere; callers that need the ambiguity IMMEDIATELY across handles must
 * pass bypassCache. The same-handle property (audio-feed-ni04) is unaffected: additions
 * through this handle invalidate immediately.
 */
export async function getLegacyKeyUniqueOwner(
  metadata: MetadataStore,
  key: string,
  options?: { bypassCache?: boolean },
): Promise<string | null> {
  if (isCanonicalAudioKey(key)) return null;
  ensureMetadataInvalidationHooks(metadata);
  const normKey = normalizeLegacyAudioKey(key);
  const now = Date.now();
  const currentGen = metadataMutationGenerations.get(metadata) ?? 0;
  let cached = legacyKeyIndexCache.get(metadata);

  if (
    !cached ||
    now >= cached.expiresAt ||
    cached.generation !== currentGen ||
    options?.bypassCache
  ) {
    cached = await buildLegacyKeyIndex(metadata, now);
  } else {
    const cachedEntry = cached.owners.get(normKey);
    // audio-feed-y63gb: re-verify a cached UNIQUE owner with one targeted
    // getEpisode read instead of rebuilding the whole index - count===1 is
    // the NORMAL case (the one line 905 returns an owner for), so the old
    // unconditional rebuild made the 60s cache dead for exactly the
    // population it serves: every playback of a legacy-keyed episode paid a
    // full listUsers + paginated-episodes scan. The targeted read keeps the
    // audio-feed-ni04 property that the authorized owner still exists and
    // still points at this key; a disagreement (or no cached entry at all)
    // falls back to the full rebuild. Ambiguous cached entries (count > 1)
    // keep serving from cache and still yield null on the return path below.
    const needsRebuild = cachedEntry
      ? cachedEntry.count === 1 &&
        !(await cachedLegacyKeyOwnershipHolds(metadata, cachedEntry, normKey))
      : true;
    if (needsRebuild) {
      cached = await buildLegacyKeyIndex(metadata, now);
    }
  }

  const entry = cached.owners.get(normKey);
  return entry && entry.count === 1 ? entry.userId : null;
}

/** Invalidate cached legacy key index for test isolation. */
export function clearLegacyKeyIndexCache(metadata?: MetadataStore): void {
  if (metadata) {
    bumpMetadataGeneration(metadata);
  }
}
