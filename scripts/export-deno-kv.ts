/**
 * Export 100% of audio-feed data from Deno KV (local or remote Deno Deploy KV)
 * into a portable JSON snapshot for Cloudflare D1 import.
 *
 * Usage (remote Deno Deploy KV):
 *   DENO_KV_ACCESS_TOKEN=<token> deno run \
 *     --allow-net --allow-env --allow-read --allow-write --unstable-kv \
 *     scripts/export-deno-kv.ts \
 *     --kv https://api.deno.com/databases/<database-id>/connect \
 *     --out ./var/deno-kv-export.json
 *
 * Usage (local KV file):
 *   deno run --allow-read --allow-write --unstable-kv \
 *     scripts/export-deno-kv.ts --kv ./local.kv --out ./var/deno-kv-export.json
 */

import type {
  ApprovalRecord,
  Article,
  Episode,
  OutboxNotification,
  PasskeyCredential,
  Source,
  SynthesisSegmentRecord,
  User,
} from "../src/types.ts";
import type { LogRecord, RunRecord } from "../src/storage/mod.ts";
import {
  DOWNLOAD_TOTAL_KEY,
  DOWNLOAD_USER_PREFIX,
  SYNTHESIS_TOTAL_BYTES_KEY,
  SYNTHESIS_TOTAL_KEY,
  SYNTHESIS_USER_BYTES_PREFIX,
  SYNTHESIS_USER_PREFIX,
  synthesisDailyAllKey,
  synthesisDailyUserKey,
} from "../src/storage/d1/usage.ts";
import { type MigrationSnapshot, passkeyArchiveSummary } from "./migration-schema.ts";

function kvU64ToNumber(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "bigint") return Number(val);
  if (val && typeof val === "object" && "value" in val) {
    const inner = (val as { value: unknown }).value;
    if (typeof inner === "bigint" || typeof inner === "number") return Number(inner);
  }
  return 0;
}

export async function exportDenoKv(
  kv: Deno.Kv,
  sourceLabel = "deno-kv",
): Promise<MigrationSnapshot> {
  const users: User[] = [];
  const approvalLog: ApprovalRecord[] = [];
  const sources: Source[] = [];
  const rawArticles: Article[] = [];
  const articleChunks = new Map<string, Map<number, string>>();
  const articleUrls: Array<{ userId: string; url: string; articleId: string }> = [];
  const episodes: Episode[] = [];
  const synthesisSegments: MigrationSnapshot["synthesisSegments"] = [];
  const orphanBlobs: string[] = [];
  const usageCounters: Record<string, number> = {};
  const outboxNotifications: OutboxNotification[] = [];
  const runs: RunRecord[] = [];
  const logs: LogRecord[] = [];
  let newestSeq = 0;
  let watermark = 0;
  const logOnceMarkers: Array<{ key: string; seq: number }> = [];
  const archivedDenoPasskeys: MigrationSnapshot["archivedDenoPasskeys"] = [];
  const unknownPrefixes: Record<string, number> = {};

  // Known derived/ephemeral prefixes that are rebuilt automatically or intentionally skipped:
  const IGNORED_DERIVED_OR_EPHEMERAL = new Set([
    "user_by_email",
    "user_by_feed_token",
    "episode_by_user",
    "episode_by_source",
    "pending_episodes",
    "synthesizing_episodes",
    "outbox_pending",
    "outbox_dedupe",
    "passkey_by_user",
    "session",
    "setup_link",
    "auth_challenge",
    "atomic",
    "migration",
    "legacy_audio_migration_lock",
  ]);

  for await (const entry of kv.list({ prefix: [] })) {
    const prefix = String(entry.key[0] ?? "");
    const value = entry.value;

    switch (prefix) {
      case "user":
        if (value) users.push(value as User);
        break;
      case "approval_log":
        if (value) approvalLog.push(value as ApprovalRecord);
        break;
      case "source":
        if (value) sources.push(value as Source);
        break;
      case "article":
        if (value) rawArticles.push(value as Article);
        break;
      case "article_chunk": {
        const userId = String(entry.key[1] ?? "");
        const articleId = String(entry.key[2] ?? "");
        const idx = Number(entry.key[3]);
        if (typeof value === "string" && Number.isInteger(idx)) {
          const mapKey = `${userId}\0${articleId}`;
          let chunks = articleChunks.get(mapKey);
          if (!chunks) {
            chunks = new Map();
            articleChunks.set(mapKey, chunks);
          }
          chunks.set(idx, value);
        }
        break;
      }
      case "article_by_url": {
        const userId = String(entry.key[1] ?? "");
        const url = String(entry.key[2] ?? "");
        if (typeof value === "string") {
          articleUrls.push({ userId, url, articleId: value });
        }
        break;
      }
      case "episode":
        if (value) episodes.push(value as Episode);
        break;
      case "synthesis-segment": {
        const userId = String(entry.key[1] ?? "");
        const episodeId = String(entry.key[2] ?? "");
        if (value && userId && episodeId) {
          synthesisSegments.push({
            userId,
            episodeId,
            record: value as SynthesisSegmentRecord,
          });
        }
        break;
      }
      case "orphan_blob": {
        const blobKey = entry.key[1];
        if (typeof blobKey === "string") orphanBlobs.push(blobKey);
        break;
      }
      case "download_total":
        usageCounters[DOWNLOAD_TOTAL_KEY] = kvU64ToNumber(value);
        break;
      case "download_by_user": {
        const userId = String(entry.key[1] ?? "");
        if (userId) usageCounters[`${DOWNLOAD_USER_PREFIX}${userId}`] = kvU64ToNumber(value);
        break;
      }
      case "synthesis_total":
        usageCounters[SYNTHESIS_TOTAL_KEY] = kvU64ToNumber(value);
        break;
      case "synthesis_total_bytes":
        usageCounters[SYNTHESIS_TOTAL_BYTES_KEY] = kvU64ToNumber(value);
        break;
      case "synthesis_by_user": {
        const userId = String(entry.key[1] ?? "");
        if (userId) usageCounters[`${SYNTHESIS_USER_PREFIX}${userId}`] = kvU64ToNumber(value);
        break;
      }
      case "synthesis_bytes_by_user": {
        const userId = String(entry.key[1] ?? "");
        if (userId) usageCounters[`${SYNTHESIS_USER_BYTES_PREFIX}${userId}`] = kvU64ToNumber(value);
        break;
      }
      case "synthesis_daily": {
        const userId = String(entry.key[1] ?? "");
        const day = String(entry.key[2] ?? "");
        if (userId && day) usageCounters[synthesisDailyUserKey(userId, day)] = kvU64ToNumber(value);
        break;
      }
      case "synthesis_daily_all": {
        const day = String(entry.key[1] ?? "");
        if (day) usageCounters[synthesisDailyAllKey(day)] = kvU64ToNumber(value);
        break;
      }
      case "outbox":
        if (value) outboxNotifications.push(value as OutboxNotification);
        break;
      case "run":
        if (value) runs.push(value as RunRecord);
        break;
      case "log":
        if (value) logs.push(value as LogRecord);
        break;
      case "log_seq":
        if (typeof value === "number") newestSeq = value;
        break;
      case "log_watermark":
        if (typeof value === "number") watermark = value;
        break;
      case "log_once": {
        const markerKey = String(entry.key[1] ?? "");
        if (markerKey && typeof value === "number") {
          logOnceMarkers.push({ key: markerKey, seq: value });
        }
        break;
      }
      case "passkey":
        if (value) {
          archivedDenoPasskeys.push(passkeyArchiveSummary(value as PasskeyCredential));
        }
        break;
      default:
        if (!IGNORED_DERIVED_OR_EPHEMERAL.has(prefix)) {
          unknownPrefixes[prefix] = (unknownPrefixes[prefix] ?? 0) + 1;
        }
        break;
    }
  }

  // Reassemble chunked articles back into full content
  const articles: Article[] = [];
  for (const art of rawArticles) {
    if (art.chunkCount && art.chunkCount > 0) {
      const chunks = articleChunks.get(`${art.userId}\0${art.id}`);
      if (!chunks || chunks.size !== art.chunkCount) {
        throw new Error(
          `Corrupt chunked article in Deno KV: ${art.id} (expected ${art.chunkCount} chunks, found ${
            chunks?.size ?? 0
          })`,
        );
      }
      const parts: string[] = [];
      for (let i = 0; i < art.chunkCount; i++) {
        const piece = chunks.get(i);
        if (typeof piece !== "string") {
          throw new Error(`Missing chunk ${i} for article ${art.id}`);
        }
        parts.push(piece);
      }
      articles.push({ ...art, content: parts.join(""), chunkCount: 0 });
    } else {
      articles.push(art);
    }
  }

  // Ensure newestSeq covers all exported logs
  for (const log of logs) {
    if (log.seq > newestSeq) newestSeq = log.seq;
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: sourceLabel,
    users,
    approvalLog,
    sources,
    articles,
    articleUrls,
    episodes,
    synthesisSegments,
    orphanBlobs,
    usageCounters,
    outboxNotifications,
    runs,
    logs,
    logMeta: { newestSeq, watermark },
    logOnceMarkers,
    archivedDenoPasskeys,
    unknownPrefixes,
  };
}

function parseCliArgs(args: string[]): { kv?: string; out: string } {
  let kv: string | undefined;
  let out = "./var/deno-kv-export.json";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--kv" && args[i + 1]) {
      kv = args[++i];
    } else if (arg === "--out" && args[i + 1]) {
      out = args[++i]!;
    }
  }
  return { kv, out };
}

if (import.meta.main) {
  const { kv: kvPath, out } = parseCliArgs(Deno.args);
  if (kvPath?.startsWith("https://") && !Deno.env.get("DENO_KV_ACCESS_TOKEN")) {
    console.error(
      "Error: DENO_KV_ACCESS_TOKEN environment variable is required to connect to remote Deno Deploy KV.",
    );
    Deno.exit(1);
  }

  console.log(`[export-deno-kv] opening KV: ${kvPath ?? "(default local)"}`);
  const kv = await Deno.openKv(kvPath);
  try {
    const snapshot = await exportDenoKv(kv, kvPath ?? "local-default");
    const outDir = out.includes("/") ? out.slice(0, out.lastIndexOf("/")) : ".";
    await Deno.mkdir(outDir, { recursive: true });
    await Deno.writeTextFile(out, JSON.stringify(snapshot, null, 2));

    const byStatus = snapshot.episodes.reduce<Record<string, number>>((acc, ep) => {
      acc[ep.status] = (acc[ep.status] ?? 0) + 1;
      return acc;
    }, {});

    console.log(`\n[export-deno-kv] Export complete → ${out}`);
    console.log(`  Users:               ${snapshot.users.length}`);
    console.log(`  Approval log:        ${snapshot.approvalLog.length}`);
    console.log(`  Sources:             ${snapshot.sources.length}`);
    console.log(`  Articles:            ${snapshot.articles.length}`);
    console.log(
      `  Episodes:            ${snapshot.episodes.length} (${JSON.stringify(byStatus)})`,
    );
    console.log(`  Synthesis segments:  ${snapshot.synthesisSegments.length}`);
    console.log(`  Orphan blobs:        ${snapshot.orphanBlobs.length}`);
    console.log(`  Usage counters:      ${Object.keys(snapshot.usageCounters).length}`);
    console.log(`  Outbox notifications:${snapshot.outboxNotifications.length}`);
    console.log(`  Run records:         ${snapshot.runs.length}`);
    console.log(
      `  Logs:                ${snapshot.logs.length} (seq=${snapshot.logMeta.newestSeq}, watermark=${snapshot.logMeta.watermark})`,
    );
    console.log(
      `  Archived passkeys:   ${snapshot.archivedDenoPasskeys.length} (bound to deno.net; users will re-enrol on audiofeed.app)`,
    );
    if (Object.keys(snapshot.unknownPrefixes).length > 0) {
      console.warn(
        `  WARNING — Unknown KV prefixes encountered: ${JSON.stringify(snapshot.unknownPrefixes)}`,
      );
    }
  } finally {
    kv.close();
  }
}
