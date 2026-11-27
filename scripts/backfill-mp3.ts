/**
 * Inspect and optionally transcode existing ready WAV episodes in Cloudflare D1 + R2
 * to normalized 64 kbps mono MP3 (`audio/mpeg`).
 *
 * Dry-run by default — requires `--apply` to mutate R2 or D1, and `--delete-old-wav`
 * to remove superseded `.wav` blobs after an atomic D1 CAS update succeeds.
 *
 * Usage:
 *   npx tsx scripts/backfill-mp3.ts --remote                  # dry-run report on prod D1
 *   npx tsx scripts/backfill-mp3.ts --local                   # dry-run report on local D1
 *   npx tsx scripts/backfill-mp3.ts --remote --apply --limit 5
 *   npx tsx scripts/backfill-mp3.ts --remote --apply --limit 10 --delete-old-wav
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_MP3_BITRATE_KBPS,
  encodeWavBytesToMp3,
  inspectMp3Stream,
} from "../src/storage/mp3_assembly.ts";
import { audioBlobKey, type Episode } from "../src/types.ts";

export interface BackfillCliOptions {
  dbName: string;
  bucketName: string;
  target: "local" | "remote";
  apply: boolean;
  deleteOldWav: boolean;
  limit?: number;
  bitrateKbps: number;
}

export interface WavEpisodeCandidate {
  userId: string;
  id: string;
  version: number;
  episode: Episode;
}

export interface BackfillDryRunSummary {
  count: number;
  totalWavBytes: number;
  estimatedMp3Bytes: number;
  estimatedSavingsBytes: number;
}

export function parseBackfillArgs(argv: readonly string[]): BackfillCliOptions {
  let dbName = "audio-feed";
  let bucketName = "audio-feed";
  let target: "local" | "remote" = "local";
  let apply = false;
  let deleteOldWav = false;
  let limit: number | undefined;
  let bitrateKbps = DEFAULT_MP3_BITRATE_KBPS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db" && argv[i + 1]) dbName = argv[++i]!;
    else if (arg === "--bucket" && argv[i + 1]) bucketName = argv[++i]!;
    else if (arg === "--remote") target = "remote";
    else if (arg === "--local") target = "local";
    else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--delete-old-wav") deleteOldWav = true;
    else if (arg === "--limit" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
    } else if (arg === "--bitrate" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i]!, 10);
      if (Number.isFinite(parsed) && parsed >= 32 && parsed <= 160) bitrateKbps = parsed;
    }
  }
  return { dbName, bucketName, target, apply, deleteOldWav, limit, bitrateKbps };
}

export function summarizeBackfillCandidates(
  candidates: readonly WavEpisodeCandidate[],
  bitrateKbps = DEFAULT_MP3_BITRATE_KBPS,
): BackfillDryRunSummary {
  const compressionFactor = 384 / bitrateKbps;
  let totalWavBytes = 0;
  for (const c of candidates) {
    totalWavBytes += Math.max(0, c.episode.byteLength ?? 0);
  }
  const estimatedMp3Bytes = Math.round(totalWavBytes / compressionFactor);
  return {
    count: candidates.length,
    totalWavBytes,
    estimatedMp3Bytes,
    estimatedSavingsBytes: Math.max(0, totalWavBytes - estimatedMp3Bytes),
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function runWrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 50 * 1024 * 1024,
  });
}

function queryWavEpisodes(opts: BackfillCliOptions): WavEpisodeCandidate[] {
  const limitClause = opts.limit ? ` LIMIT ${opts.limit}` : "";
  const sql =
    `SELECT user_id, id, version, data FROM episodes ` +
    `WHERE status = 'ready' AND audio_key LIKE '%.wav' ` +
    `ORDER BY created_at DESC${limitClause}`;

  const raw = runWrangler([
    "d1",
    "execute",
    opts.dbName,
    opts.target === "remote" ? "--remote" : "--local",
    "--yes",
    "--json",
    "--command",
    sql,
  ]);

  const parsed = JSON.parse(raw) as Array<{
    results?: Array<{ user_id: string; id: string; version: number; data: string }>;
  }>;
  const rows = parsed[0]?.results ?? [];
  return rows.map((row) => ({
    userId: row.user_id,
    id: row.id,
    version: Number(row.version),
    episode: JSON.parse(row.data) as Episode,
  }));
}

function main(): void {
  const opts = parseBackfillArgs(process.argv.slice(2));
  const candidates = queryWavEpisodes(opts);
  const summary = summarizeBackfillCandidates(candidates, opts.bitrateKbps);

  console.log(
    `[backfill-mp3] Found ${summary.count} ready WAV episode(s) in D1 "${opts.dbName}" (${opts.target})`,
  );
  console.log(
    `[backfill-mp3] Current WAV total: ${formatMiB(summary.totalWavBytes)} -> ` +
      `estimated ${opts.bitrateKbps} kbps MP3: ${formatMiB(summary.estimatedMp3Bytes)} ` +
      `(est. savings: ${formatMiB(summary.estimatedSavingsBytes)})`,
  );

  for (const c of candidates.slice(0, 15)) {
    console.log(
      `  - ${c.id} (${c.episode.mode}) ${formatMiB(c.episode.byteLength ?? 0)} -> ${c.episode.audioKey}`,
    );
  }
  if (candidates.length > 15) {
    console.log(`  ... and ${candidates.length - 15} more`);
  }

  if (!opts.apply) {
    console.log("[backfill-mp3] Dry-run complete (no R2 or D1 changes made). Pass --apply to transcode.");
    return;
  }

  const targetFlag = opts.target === "remote" ? "--remote" : "--local";
  const scratchDir = mkdtempSync(join(tmpdir(), "audio-feed-backfill-mp3-"));
  let converted = 0;
  let totalBefore = 0;
  let totalAfter = 0;

  try {
    for (const item of candidates) {
      const oldKey = item.episode.audioKey;
      if (!oldKey || !oldKey.endsWith(".wav")) continue;

      const wavPath = join(scratchDir, `${item.id}.wav`);
      const mp3Path = join(scratchDir, `${item.id}.mp3`);
      const sqlPath = join(scratchDir, `${item.id}.sql`);

      console.log(`[backfill-mp3] Downloading ${oldKey}...`);
      runWrangler([
        "r2",
        "object",
        "get",
        `${opts.bucketName}/${oldKey}`,
        "--file",
        wavPath,
        targetFlag,
      ]);

      const wavBytes = new Uint8Array(readFileSync(wavPath));
      const { mp3, durationSeconds } = encodeWavBytesToMp3(wavBytes, {
        bitrateKbps: opts.bitrateKbps,
      });
      const inspection = inspectMp3Stream(mp3);
      if (!inspection.valid) {
        throw new Error(`Encoded MP3 failed frame verification for episode ${item.id}`);
      }

      const mp3Hash = createHash("sha256").update(mp3).digest("hex");
      const mp3Key = audioBlobKey(item.episode, "mp3", `sha256-${mp3Hash}`);
      writeFileSync(mp3Path, mp3);

      console.log(
        `[backfill-mp3] Uploading ${mp3Key} (${formatMiB(wavBytes.byteLength)} -> ${formatMiB(mp3.byteLength)}, ` +
          `${(wavBytes.byteLength / mp3.byteLength).toFixed(2)}x)...`,
      );
      runWrangler([
        "r2",
        "object",
        "put",
        `${opts.bucketName}/${mp3Key}`,
        "--file",
        mp3Path,
        "--content-type",
        "audio/mpeg",
        targetFlag,
      ]);

      const updatedEpisode: Episode = {
        ...item.episode,
        audioKey: mp3Key,
        byteLength: mp3.byteLength,
        contentType: "audio/mpeg",
        durationSeconds,
      };
      const nextVersion = item.version + 1;
      const updateSql =
        `UPDATE episodes ` +
        `SET audio_key = ${sqlLiteral(mp3Key)}, ` +
        `version = ${nextVersion}, ` +
        `data = ${sqlLiteral(JSON.stringify(updatedEpisode))} ` +
        `WHERE user_id = ${sqlLiteral(item.userId)} ` +
        `AND id = ${sqlLiteral(item.id)} ` +
        `AND version = ${item.version};`;
      writeFileSync(sqlPath, updateSql, "utf8");

      const updateOut = runWrangler([
        "d1",
        "execute",
        opts.dbName,
        targetFlag,
        "--yes",
        "--json",
        "--file",
        sqlPath,
      ]);
      const updateRes = JSON.parse(updateOut) as Array<{ meta?: { changes?: number } }>;
      const changes = updateRes[0]?.meta?.changes ?? 0;
      if (changes !== 1) {
        console.warn(
          `[backfill-mp3] Skipped CAS commit for ${item.id} (concurrent version change; old WAV preserved).`,
        );
        continue;
      }

      if (opts.deleteOldWav && oldKey !== mp3Key) {
        runWrangler(["r2", "object", "delete", `${opts.bucketName}/${oldKey}`, targetFlag]);
      }

      converted++;
      totalBefore += wavBytes.byteLength;
      totalAfter += mp3.byteLength;
      rmSync(wavPath, { force: true });
      rmSync(mp3Path, { force: true });
      rmSync(sqlPath, { force: true });
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log(
    `[backfill-mp3] Completed ${converted}/${candidates.length} episode(s): ` +
      `${formatMiB(totalBefore)} -> ${formatMiB(totalAfter)}`,
  );
}

const isEntrypoint = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main();
}
