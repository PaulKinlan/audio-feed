/**
 * Episodes repository for Cloudflare D1.
 */

import {
  abandonedClaimEvent,
  CLAIM_START_PHASE,
  claimLifecycleEvent,
  elapsedSince,
  expiredClaimEvent,
} from "../episode_events.ts";
import type { Episode } from "../../types.ts";
import {
  DEFAULT_CLAIM_LEASE_MS,
  isClaimExpired,
  isPublishable,
  oldestClaimFirst,
  preturnRefusalCap,
  preturnRefusalExhaustedError,
  unsynthesized,
  utcDayKey,
} from "../../types.ts";
import type {
  EpisodeBilling,
  EpisodeClaim,
  EpisodePage,
  EpisodePageResult,
  EpisodeQuery,
  EpisodeRepository,
  ListPendingOptions,
  ListPendingResult,
  ListSynthesizingOptions,
  ListSynthesizingResult,
  MetadataStore,
} from "../mod.ts";
import type { D1Core } from "./core.ts";
import { descendingKey } from "./core.ts";
import {
  SYNTHESIS_TOTAL_BYTES_KEY,
  SYNTHESIS_TOTAL_KEY,
  SYNTHESIS_USER_BYTES_PREFIX,
  SYNTHESIS_USER_PREFIX,
  synthesisDailyAllKey,
  synthesisDailyUserKey,
} from "./usage.ts";
import type { D1PreparedStatementLike } from "./types.ts";

interface EpisodeRow {
  data: string;
  version: number;
}

interface PendingCursor {
  regenerating: number;
  createdAt: string;
  id: string;
}

function encodePendingCursor(c: PendingCursor): string {
  return JSON.stringify([c.regenerating, c.createdAt, c.id]);
}

function decodePendingCursor(raw: string): PendingCursor | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === "number" &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string"
    ) {
      return { regenerating: parsed[0], createdAt: parsed[1], id: parsed[2] };
    }
  } catch {
    // ignore malformed cursor
  }
  return null;
}

async function casUpdateEpisode(
  core: D1Core,
  episode: Episode,
  expectedVersion: number,
  billing?: EpisodeBilling,
): Promise<boolean> {
  const nextVersion = expectedVersion + 1;
  const sortKey = descendingKey(episode.createdAt, episode.id);
  const updateStmt = core.db.prepare(
    `UPDATE episodes
     SET source_id = ?,
         mode = ?,
         status = ?,
         regenerating = ?,
         created_at = ?,
         sort_key = ?,
         claimed_at = ?,
         claimed_by = ?,
         audio_key = ?,
         version = ?,
         data = ?
     WHERE user_id = ? AND id = ? AND version = ?`,
  ).bind(
    episode.sourceId,
    episode.mode,
    episode.status,
    episode.regenerating ? 1 : 0,
    episode.createdAt,
    sortKey,
    episode.claimedAt ?? null,
    episode.claimedBy ?? null,
    episode.audioKey ?? null,
    nextVersion,
    JSON.stringify(episode),
    episode.userId,
    episode.id,
    expectedVersion,
  );

  if (!billing || episode.status !== "ready") {
    const res = await updateStmt.run();
    return (res.meta.changes ?? 0) === 1;
  }

  // Atomic terminal billing: guarded by version = nextVersion inside ONE D1 batch transaction.
  const day = utcDayKey(billing.at ?? new Date());
  const billingUpsert = (key: string, delta: number): D1PreparedStatementLike =>
    core.db.prepare(
      `INSERT INTO usage_counters (key, value)
       SELECT ?, ?
       WHERE EXISTS (
         SELECT 1 FROM episodes WHERE user_id = ? AND id = ? AND version = ?
       )
       ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
    ).bind(key, delta, episode.userId, episode.id, nextVersion);

  const results = await core.db.batch([
    updateStmt,
    billingUpsert(SYNTHESIS_TOTAL_KEY, 1),
    billingUpsert(SYNTHESIS_TOTAL_BYTES_KEY, billing.byteLength),
    billingUpsert(`${SYNTHESIS_USER_PREFIX}${episode.userId}`, 1),
    billingUpsert(`${SYNTHESIS_USER_BYTES_PREFIX}${episode.userId}`, billing.byteLength),
    billingUpsert(synthesisDailyUserKey(episode.userId, day), 1),
    billingUpsert(synthesisDailyAllKey(day), 1),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export function createD1EpisodesRepository(
  core: D1Core,
  host: () => MetadataStore,
): EpisodeRepository {
  return {
    async putEpisode(episode: Episode): Promise<void> {
      await core.upsertEpisodeStatement(episode).run();
    },

    async getEpisode(userId: string, id: string): Promise<Episode | null> {
      const row = await core.db.prepare(
        `SELECT data FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(userId, id).first<{ data: string }>();
      return row ? (JSON.parse(row.data) as Episode) : null;
    },

    async deleteEpisode(userId: string, id: string): Promise<boolean> {
      const res = await core.db.prepare(
        `DELETE FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(userId, id).run();
      return (res.meta.changes ?? 0) > 0;
    },

    async backfillEpisodeSourceTitle(
      userId: string,
      id: string,
      sourceTitle: string,
    ): Promise<boolean> {
      for (let attempt = 0; attempt < 2; attempt++) {
        const row = await core.db.prepare(
          `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
        ).bind(userId, id).first<EpisodeRow>();
        if (!row) return false;
        const found = JSON.parse(row.data) as Episode;
        if (found.sourceTitle) return true;
        const updated: Episode = { ...found, sourceTitle };
        if (await casUpdateEpisode(core, updated, row.version)) return true;
      }
      return false;
    },

    async updateEpisodeAudioKeyIfCurrent(
      userId: string,
      id: string,
      expectedKey: string,
      newKey: string,
    ): Promise<boolean> {
      for (let attempt = 0; attempt < 2; attempt++) {
        const row = await core.db.prepare(
          `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
        ).bind(userId, id).first<EpisodeRow>();
        if (!row) return false;
        const found = JSON.parse(row.data) as Episode;
        if (found.audioKey !== expectedKey) return false;
        const updated: Episode = { ...found, audioKey: newKey };
        if (await casUpdateEpisode(core, updated, row.version)) return true;
      }
      return false;
    },

    async listEpisodes(query: EpisodeQuery): Promise<Episode[]> {
      const limit = query.limit ?? 50;
      if (!Number.isFinite(limit)) return (await host().listEpisodePage(query)).episodes;

      const out: Episode[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await host().listEpisodePage({ ...query, limit, cursor });
        out.push(...page.episodes);
        if (out.length >= limit || !page.cursor || page.cursor === cursor) break;
        cursor = page.cursor;
      }
      return out.slice(0, limit);
    },

    async listEpisodePage(query: EpisodePage): Promise<EpisodePageResult> {
      const limit = query.limit ?? 50;
      const useSourceMode = Boolean(query.sourceId && query.mode);
      const clauses: string[] = ["user_id = ?"];
      const params: unknown[] = [query.userId];

      if (useSourceMode) {
        clauses.push("source_id = ?", "mode = ?");
        params.push(query.sourceId, query.mode);
      }
      if (query.cursor) {
        clauses.push("sort_key > ?");
        params.push(query.cursor);
      }

      const finiteLimit = Number.isFinite(limit);
      const sql = finiteLimit
        ? `SELECT sort_key, data FROM episodes WHERE ${
          clauses.join(" AND ")
        } ORDER BY sort_key ASC LIMIT ?`
        : `SELECT sort_key, data FROM episodes WHERE ${
          clauses.join(" AND ")
        } ORDER BY sort_key ASC`;
      if (finiteLimit) params.push(limit + 1);

      const res = await core.db.prepare(sql).bind(...params).all<
        { sort_key: string; data: string }
      >();

      const hasMore = finiteLimit && res.results.length > limit;
      const scanned = hasMore ? res.results.slice(0, limit) : res.results;
      const nextCursor = hasMore && scanned.length > 0
        ? scanned[scanned.length - 1]!.sort_key
        : undefined;

      const episodes: Episode[] = [];
      for (const row of scanned) {
        const episode = JSON.parse(row.data) as Episode;
        if (query.sourceId && episode.sourceId !== query.sourceId) continue;
        if (query.mode && episode.mode !== query.mode) continue;
        if (query.status && episode.status !== query.status) continue;
        if (query.publishable && !isPublishable(episode)) continue;
        episodes.push(episode);
      }

      return { episodes, cursor: nextCursor };
    },

    async listPendingEpisodes(
      opts: ListPendingOptions = {},
    ): Promise<ListPendingResult> {
      const limit = opts.limit ?? 50;
      const nowMs = opts.nowMs ?? Date.now();
      const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
      const finiteLimit = Number.isFinite(limit);

      const clauses: string[] = ["status = 'pending'"];
      const params: unknown[] = [];

      if (opts.cursor) {
        const decoded = decodePendingCursor(opts.cursor);
        if (decoded) {
          clauses.push(
            `(regenerating > ? OR (regenerating = ? AND (created_at > ? OR (created_at = ? AND id > ?))))`,
          );
          params.push(
            decoded.regenerating,
            decoded.regenerating,
            decoded.createdAt,
            decoded.createdAt,
            decoded.id,
          );
        }
      }

      const sql = finiteLimit
        ? `SELECT regenerating, created_at, id, data FROM episodes
           WHERE ${clauses.join(" AND ")}
           ORDER BY regenerating ASC, created_at ASC, id ASC
           LIMIT ?`
        : `SELECT regenerating, created_at, id, data FROM episodes
           WHERE ${clauses.join(" AND ")}
           ORDER BY regenerating ASC, created_at ASC, id ASC`;
      if (finiteLimit) params.push(limit + 1);

      const res = await core.db.prepare(sql).bind(...params).all<{
        regenerating: number;
        created_at: string;
        id: string;
        data: string;
      }>();

      const hasMore = finiteLimit && res.results.length > limit;
      const pageRows = hasMore ? res.results.slice(0, limit) : res.results;
      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor = hasMore && lastRow
        ? encodePendingCursor({
          regenerating: Number(lastRow.regenerating),
          createdAt: lastRow.created_at,
          id: lastRow.id,
        })
        : undefined;

      const episodes: Episode[] = pageRows.map((r) => JSON.parse(r.data) as Episode);

      let mergedExpired = false;
      if (!opts.cursor && (!finiteLimit || episodes.length < limit)) {
        const synthRes = await core.db.prepare(
          `SELECT data FROM episodes WHERE status = 'synthesizing'`,
        ).all<{ data: string }>();
        for (const row of synthRes.results) {
          const ep = JSON.parse(row.data) as Episode;
          if (ep.status === "synthesizing" && isClaimExpired(ep, nowMs, leaseMs)) {
            episodes.push(ep);
            mergedExpired = true;
          }
        }
        if (mergedExpired) {
          episodes.sort((a, b) => {
            const ap = a.regenerating ? 1 : 0;
            const bp = b.regenerating ? 1 : 0;
            if (ap !== bp) return ap - bp;
            const timeDiff = a.createdAt.localeCompare(b.createdAt);
            return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
          });
        }
      }

      return {
        episodes: finiteLimit ? episodes.slice(0, limit) : episodes,
        cursor: nextCursor,
      };
    },

    async listSynthesizingEpisodes(
      opts: ListSynthesizingOptions = {},
    ): Promise<ListSynthesizingResult> {
      const limit = opts.limit ?? 50;
      const res = await core.db.prepare(
        `SELECT data FROM episodes WHERE status = 'synthesizing'`,
      ).all<{ data: string }>();

      const episodes = res.results
        .map((r) => JSON.parse(r.data) as Episode)
        .filter((ep) => ep.status === "synthesizing");

      episodes.sort(oldestClaimFirst);
      return {
        episodes: Number.isFinite(limit) ? episodes.slice(0, limit) : episodes,
        capped: Number.isFinite(limit) && episodes.length > limit,
      };
    },

    async claimEpisode(
      userId: string,
      episodeId: string,
      claim: EpisodeClaim,
    ): Promise<Episode | null> {
      const row = await core.db.prepare(
        `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(userId, episodeId).first<EpisodeRow>();
      if (!row) return null;
      const found = JSON.parse(row.data) as Episode;

      const nowMs = Date.parse(claim.now);
      const isExpired = found.status === "synthesizing" &&
        isClaimExpired(found, nowMs, claim.leaseMs);
      const claimable = found.status === "pending" || isExpired;
      if (!claimable) return null;

      const attempts = (found.attempts ?? 0) + 1;
      const prior = typeof found.error === "string" && found.error.length > 0 ? found.error : null;

      const expiredPhase = found.phase ?? "claimed";
      const expiredHeartbeat = found.lastHeartbeat ?? found.claimedAt ?? "unknown";
      const expiredAttempt = Math.max(1, found.attempts ?? 1);
      const expiredProvenance = found.claimedAt
        ? `by ${found.claimedBy ?? "unknown"} at ${found.claimedAt}`
        : "no claim details";
      const expiredMsg =
        `claim ${expiredAttempt} (${expiredProvenance}) lease expired without terminal write in phase "${expiredPhase}" (last heartbeat ${expiredHeartbeat}); worker state unknown (stopped, evicted, or running)`;
      const accumulatedError = isExpired
        ? (prior && prior.includes(expiredMsg)
          ? prior
          : (prior ? `${prior}; ${expiredMsg}` : expiredMsg))
        : prior;

      const priorRefusals = found.refusals ?? 0;
      const refusalCap = preturnRefusalCap(claim.maxClaims);
      if (priorRefusals >= refusalCap) {
        const refusalReason = preturnRefusalExhaustedError(priorRefusals, refusalCap);
        const refusedOut: Episode = {
          ...unsynthesized(found, refusalReason),
          claimedAt: undefined,
          claimedBy: undefined,
          phase: found.phase,
          lastHeartbeat: found.lastHeartbeat,
        };
        const wroteRefusal = await casUpdateEpisode(core, refusedOut, row.version);
        if (wroteRefusal) {
          await host().appendLog(
            claimLifecycleEvent(refusedOut, {
              phase: refusedOut.phase ?? "claimed",
              attempt: Math.max(1, refusedOut.attempts ?? 1),
              severity: "error",
              reason: refusalReason,
              context: { claimOutcome: "failed", refusals: priorRefusals, refusalCap },
            }),
          );
        }
        return null;
      }

      if (attempts > claim.maxClaims) {
        const abandonedReason = accumulatedError
          ? `abandoned after ${claim.maxClaims} attempts; reason: claim lease expired without terminal write in phase "${expiredPhase}"; history: [${accumulatedError}]`
          : `abandoned after ${claim.maxClaims} attempts; reason: claim lease expired without terminal write in phase "${expiredPhase}" (${expiredProvenance}); worker state unknown (stopped, evicted, or running)`;

        const abandoned: Episode = {
          ...unsynthesized(found, abandonedReason),
          claimedAt: undefined,
          claimedBy: undefined,
          phase: found.phase,
          lastHeartbeat: found.lastHeartbeat,
        };
        const wroteAbandoned = await casUpdateEpisode(core, abandoned, row.version);
        if (wroteAbandoned) {
          await host().appendLog(
            abandonedClaimEvent(abandoned, {
              phase: expiredPhase,
              attempt: expiredAttempt,
              reason: expiredMsg,
              ...(found.claimedAt && !Number.isNaN(Date.parse(found.claimedAt))
                ? {
                  expiredAt: new Date(Date.parse(found.claimedAt) + claim.leaseMs).toISOString(),
                }
                : {}),
              lastHeartbeat: expiredHeartbeat,
              provenance: expiredProvenance,
              maxClaims: claim.maxClaims,
            }),
          );
        }
        return null;
      }

      const claimed: Episode = {
        ...found,
        status: "synthesizing",
        claimedAt: claim.now,
        claimedBy: claim.owner,
        lastHeartbeat: claim.now,
        phase: "claimed",
        attempts,
        error: accumulatedError ?? undefined,
      };
      const ok = await casUpdateEpisode(core, claimed, row.version);
      if (ok) {
        if (isExpired) {
          await host().appendLog(
            expiredClaimEvent(found, {
              phase: expiredPhase,
              attempt: expiredAttempt,
              reason: expiredMsg,
              ...(found.claimedAt && !Number.isNaN(Date.parse(found.claimedAt))
                ? {
                  expiredAt: new Date(Date.parse(found.claimedAt) + claim.leaseMs).toISOString(),
                }
                : {}),
              lastHeartbeat: expiredHeartbeat,
              provenance: expiredProvenance,
              maxClaims: claim.maxClaims,
            }),
          );
        }
        await host().appendLog(
          claimLifecycleEvent(claimed, {
            phase: CLAIM_START_PHASE,
            attempt: attempts,
            context: { owner: claim.owner, leaseMs: claim.leaseMs, maxClaims: claim.maxClaims },
            time: claim.now,
          }),
        );
      }
      return ok ? claimed : null;
    },

    async touchEpisodeClaim(
      userId: string,
      episodeId: string,
      owner: string,
      update: {
        phase?: string;
        now?: string;
        scriptTurns?: Array<{ speaker: string; text: string }>;
        bytesAttempted?: number;
      },
    ): Promise<boolean> {
      const row = await core.db.prepare(
        `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(userId, episodeId).first<EpisodeRow>();
      if (!row) return false;
      const current = JSON.parse(row.data) as Episode;
      if (current.status !== "synthesizing" || current.claimedBy !== owner) return false;

      const madeScriptProgress = update.scriptTurns &&
        update.scriptTurns.length > 0 &&
        (!current.scriptTurns || current.scriptTurns.length === 0);
      const updated: Episode = {
        ...current,
        lastHeartbeat: update.now ?? new Date().toISOString(),
        phase: update.phase ?? current.phase,
        scriptTurns: update.scriptTurns ?? current.scriptTurns,
        bytesAttempted: update.bytesAttempted ?? current.bytesAttempted,
        ...(madeScriptProgress ? { attempts: 0, refusals: 0 } : {}),
      };
      const wrote = await casUpdateEpisode(core, updated, row.version);
      if (wrote && update.phase && update.phase !== current.phase) {
        await host().appendLog(
          claimLifecycleEvent(updated, {
            phase: update.phase,
            attempt: Math.max(1, updated.attempts ?? 1),
            time: updated.lastHeartbeat,
          }),
        );
      }
      return wrote;
    },

    async yieldEpisodeClaim(
      userId: string,
      episodeId: string,
      owner: string,
      update?: {
        phase?: string;
        now?: string;
        advanceAttempts?: boolean;
        incrementRefusals?: boolean;
        uploadRetry?: number;
        incrementUploadRetry?: boolean;
      },
    ): Promise<boolean> {
      const row = await core.db.prepare(
        `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(userId, episodeId).first<EpisodeRow>();
      if (!row) return false;
      const current = JSON.parse(row.data) as Episode;
      if (current.status !== "synthesizing" || current.claimedBy !== owner) return false;

      const advanceAttempts = update?.advanceAttempts ?? false;
      const incrementRefusals = update?.incrementRefusals ?? false;
      const yielded: Episode = {
        ...current,
        status: "pending",
        claimedAt: undefined,
        claimedBy: undefined,
        phase: update?.phase ?? current.phase,
        lastHeartbeat: update?.now ?? new Date().toISOString(),
        attempts: incrementRefusals
          ? Math.max(0, (current.attempts ?? 1) - 1)
          : advanceAttempts
          ? (current.attempts ?? 0)
          : 0,
        refusals: incrementRefusals
          ? (current.refusals ?? 0) + 1
          : advanceAttempts
          ? current.refusals
          : 0,
        uploadRetry: update?.uploadRetry !== undefined
          ? update.uploadRetry
          : update?.incrementUploadRetry
          ? (current.uploadRetry ?? 0) + 1
          : current.uploadRetry,
      };
      return await casUpdateEpisode(core, yielded, row.version);
    },

    async completeEpisode(
      episode: Episode,
      owner: string,
      billing?: EpisodeBilling,
    ): Promise<boolean> {
      const row = await core.db.prepare(
        `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(episode.userId, episode.id).first<EpisodeRow>();
      if (!row) return false;
      const current = JSON.parse(row.data) as Episode;

      if (
        current.status === "ready" &&
        current.audioKey === episode.audioKey &&
        current.claimedBy === owner
      ) {
        return true;
      }
      if (current.status !== "synthesizing" || current.claimedBy !== owner) {
        return false;
      }

      const isGenuineRestore = episode.status === "ready" &&
        Boolean(episode.error) &&
        Boolean(current.audioKey) &&
        current.audioKey === episode.audioKey;

      if (
        episode.status === "ready" &&
        !isGenuineRestore &&
        (!billing ||
          typeof billing.byteLength !== "number" ||
          !Number.isFinite(billing.byteLength) ||
          !Number.isInteger(billing.byteLength) ||
          billing.byteLength < 0)
      ) {
        throw new TypeError(
          `completeEpisode requires a valid billing payload ({ byteLength: non-negative integer }) when completing with status "ready" (audio-feed-9gqs, audio-feed-do6b, audio-feed-pr5v)`,
        );
      }

      const wrote = await casUpdateEpisode(
        core,
        { ...episode, claimedBy: owner },
        row.version,
        billing,
      );
      if (wrote) {
        await host().appendLog(
          claimLifecycleEvent(episode, {
            phase: episode.phase ?? CLAIM_START_PHASE,
            attempt: Math.max(1, episode.attempts ?? 1),
            durationMs: elapsedSince(current.claimedAt),
            ...(episode.status === "failed"
              ? {
                reason: episode.error ?? "synthesis failed without a recorded error",
                severity: "error" as const,
              }
              : {}),
          }),
        );
      }
      return wrote;
    },

    async retryEpisode(userId: string, id: string): Promise<Episode | null> {
      const row = await core.db.prepare(
        `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(userId, id).first<EpisodeRow>();
      if (!row) return null;
      const found = JSON.parse(row.data) as Episode;

      const isFailed = found.status === "failed";
      const isStaleSynthesizing = found.status === "synthesizing" && (
        isClaimExpired(found, Date.now()) ||
        (Date.now() - Date.parse(found.lastHeartbeat ?? found.claimedAt ?? "") >= 2 * 60_000)
      );
      if (!isFailed && !isStaleSynthesizing) return null;

      const queued: Episode = {
        ...found,
        status: "pending",
        attempts: undefined,
        refusals: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
        error: undefined,
        phase: undefined,
        lastHeartbeat: undefined,
        scriptTurns: isStaleSynthesizing ? found.scriptTurns : undefined,
        uploadRetry: undefined,
        regenerating: isStaleSynthesizing ? found.regenerating : undefined,
      };
      return (await casUpdateEpisode(core, queued, row.version)) ? queued : null;
    },

    async requeueEpisode(userId: string, id: string): Promise<Episode | null> {
      const row = await core.db.prepare(
        `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(userId, id).first<EpisodeRow>();
      if (!row) return null;
      const found = JSON.parse(row.data) as Episode;
      if (found.status !== "ready" || !isPublishable(found)) return null;

      const queued: Episode = {
        ...found,
        status: "pending",
        regenerating: true,
        attempts: undefined,
        refusals: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
        error: undefined,
        phase: undefined,
        lastHeartbeat: undefined,
        scriptTurns: undefined,
        uploadRetry: undefined,
      };
      return (await casUpdateEpisode(core, queued, row.version)) ? queued : null;
    },

    async cancelRegeneration(userId: string, id: string): Promise<boolean> {
      const row = await core.db.prepare(
        `SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`,
      ).bind(userId, id).first<EpisodeRow>();
      if (!row) return false;
      const found = JSON.parse(row.data) as Episode;
      if (
        !found.regenerating || (found.status !== "pending" && found.status !== "synthesizing")
      ) {
        return false;
      }
      return await casUpdateEpisode(core, {
        ...found,
        status: "ready",
        regenerating: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
        phase: "ready",
        lastHeartbeat: undefined,
        scriptTurns: undefined,
      }, row.version);
    },
  };
}
