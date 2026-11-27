/**
 * Import a Deno KV migration snapshot into Cloudflare D1 (local or --remote)
 * via `wrangler d1 execute`, and verify 1:1 row-count parity afterwards.
 *
 * Usage:
 *   npx tsx scripts/import-d1.ts --in ./var/deno-kv-export.json --local
 *   npx tsx scripts/import-d1.ts --in ./var/deno-kv-export.json --remote
 *   npx tsx scripts/import-d1.ts --in ./var/deno-kv-export.json --dry-run
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunkSqlStatements,
  expectedCounts,
  type MigrationSnapshot,
  snapshotToSqlStatements,
  type VerificationCounts,
} from "./migration-schema.ts";

interface CliOpts {
  input: string;
  dbName: string;
  target: "local" | "remote";
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  let input = "./var/deno-kv-export.json";
  let dbName = "audio-feed";
  let target: "local" | "remote" = "local";
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--in" && argv[i + 1]) input = argv[++i]!;
    else if (arg === "--db" && argv[i + 1]) dbName = argv[++i]!;
    else if (arg === "--remote") target = "remote";
    else if (arg === "--local") target = "local";
    else if (arg === "--dry-run") dryRun = true;
  }
  return { input, dbName, target, dryRun };
}

function runWranglerD1(
  dbName: string,
  target: "local" | "remote",
  extraArgs: string[],
): string {
  const args = [
    "wrangler",
    "d1",
    "execute",
    dbName,
    target === "remote" ? "--remote" : "--local",
    "--yes",
    ...extraArgs,
  ];
  return execFileSync("npx", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 20 * 1024 * 1024,
  });
}

function queryRemoteCount(dbName: string, target: "local" | "remote", table: string): number {
  const out = runWranglerD1(dbName, target, [
    "--json",
    "--command",
    `SELECT COUNT(*) AS cnt FROM ${table}`,
  ]);
  const parsed = JSON.parse(out) as Array<{ results?: Array<{ cnt?: number }> }>;
  return Number(parsed[0]?.results?.[0]?.cnt ?? 0);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = readFileSync(opts.input, "utf8");
  const snapshot = JSON.parse(raw) as MigrationSnapshot;

  if (snapshot.version !== 1) {
    throw new Error(`Unsupported snapshot version: ${String(snapshot.version)}`);
  }

  const statements = snapshotToSqlStatements(snapshot);
  const chunks = chunkSqlStatements(statements);

  console.log(
    `[import-d1] Loaded snapshot from ${opts.input} (exported ${snapshot.exportedAt})`,
  );
  console.log(
    `[import-d1] Prepared ${statements.length} SQL statements in ${chunks.length} batch file(s) for D1 "${opts.dbName}" (${opts.target})`,
  );

  if (opts.dryRun) {
    console.log("[import-d1] --dry-run set: skipping execution.");
    console.log("[import-d1] Expected counts:", expectedCounts(snapshot));
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "audio-feed-d1-import-"));
  try {
    for (let i = 0; i < chunks.length; i++) {
      const file = join(workDir, `batch-${String(i + 1).padStart(4, "0")}.sql`);
      writeFileSync(file, chunks[i]!, "utf8");
      console.log(`[import-d1] Executing batch ${i + 1}/${chunks.length}...`);
      runWranglerD1(opts.dbName, opts.target, ["--file", file]);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log("[import-d1] Verifying row counts in D1...");
  const expected = expectedCounts(snapshot);
  const tableMap: Record<keyof VerificationCounts, string> = {
    users: "users",
    approvalLog: "approval_log",
    sources: "sources",
    articles: "articles",
    episodes: "episodes",
    synthesisSegments: "synthesis_segments",
    orphanBlobs: "orphan_blobs",
    usageCounters: "usage_counters",
    outboxNotifications: "outbox_notifications",
    runs: "runs",
    logs: "logs",
    logOnceMarkers: "log_once_markers",
  };

  const mismatches: string[] = [];
  for (const [field, table] of Object.entries(tableMap) as [keyof VerificationCounts, string][]) {
    const actual = queryRemoteCount(opts.dbName, opts.target, table);
    const exp = expected[field];
    const mark = actual === exp ? "OK" : "MISMATCH";
    console.log(`  ${field.padEnd(22)} expected=${exp} actual=${actual} [${mark}]`);
    if (actual !== exp) {
      mismatches.push(`${field}: expected ${exp}, got ${actual}`);
    }
  }

  if (mismatches.length > 0) {
    console.error(`\n[import-d1] VERIFICATION FAILED:\n  - ${mismatches.join("\n  - ")}`);
    process.exit(1);
  }

  console.log("\n[import-d1] All table counts match 100%!");
  if (snapshot.archivedDenoPasskeys.length > 0) {
    const affectedUserIds = new Set(snapshot.archivedDenoPasskeys.map((p) => p.userId));
    console.log("\n[import-d1] Passkey re-enrolment checklist for https://audiofeed.app:");
    for (const user of snapshot.users) {
      if (affectedUserIds.has(user.id)) {
        const role = user.isAdmin
          ? `ADMIN (issue recovery link: POST /api/admin/users/${user.id}/setup-link with x-admin-token)`
          : "subscriber (issue 7-day setup link in /admin)";
        console.log(`  - ${user.email} (${user.id}) — ${role}`);
      }
    }
  }
}

main();
