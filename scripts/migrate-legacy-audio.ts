#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv
/**
 * CLI tool to migrate legacy flat audio keys to canonical keys.
 * Default is DRY-RUN mode. Pass --apply to execute mutations.
 *
 * RUNBOOK:
 *
 * 1. LOCAL EXECUTION (Dry-Run):
 *    deno task migrate-legacy-audio
 *    # Connects to default local KV, scans all users and episodes,
 *    # and prints the migration plan without mutating any blobs or records.
 *
 * 2. LOCAL EXECUTION (Apply):
 *    deno task migrate-legacy-audio --apply
 *    # Acquires single-writer migration lock, copies legacy audio blobs to
 *    # canonical locations via atomic putIfAbsent (S3 If-None-Match: *), and
 *    # updates episode metadata using atomic CAS (updateEpisodeAudioKeyIfCurrent).
 *
 * 3. REMOTE DENO DEPLOY EXECUTION:
 *    DENO_KV_ACCESS_TOKEN=<token> deno task migrate-legacy-audio --kv https://api.deno.com/databases/<db-id>/connect
 *    DENO_KV_ACCESS_TOKEN=<token> deno task migrate-legacy-audio --apply --kv https://api.deno.com/databases/<db-id>/connect
 *
 * 4. IDEMPOTENCY & RE-RUN SAFETY:
 *    - Safe to re-run at any time: episodes already holding canonical keys are skipped.
 *    - If destination blob already exists with identical bytes, metadata is repointed without duplicate copy.
 *    - If destination exists with conflicting bytes, migration refuses and preserves both.
 *    - If a concurrent writer modifies the episode during migration, CAS fails and the concurrent write wins.
 *
 * Owned by: audio-feed-nls7.
 */

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { openStores } from "../src/config.ts";
import { migrateLegacyAudioKeys } from "../src/storage/legacy_audio.ts";

const args = parseArgs(Deno.args, {
  string: ["kv"],
  boolean: ["apply", "help"],
  alias: { h: "help" },
  default: {
    apply: false,
  },
});

if (args.help) {
  console.log(`
Usage:
  deno task migrate-legacy-audio [options]

Options:
  --apply          Execute live mutations (default: dry-run)
  --kv <path|url>  KV store path or Deno Deploy remote connect URL
  -h, --help       Show this help message

Examples:
  # Dry-run against local KV
  deno task migrate-legacy-audio

  # Execute migration against local KV
  deno task migrate-legacy-audio --apply

  # Execute migration against remote Deno Deploy KV
  DENO_KV_ACCESS_TOKEN=... deno task migrate-legacy-audio --apply --kv https://api.deno.com/databases/<id>/connect
`);
  Deno.exit(0);
}

const stores = await openStores({ kvPath: args.kv });

try {
  console.log(`[migration] connected to ${stores.describe}`);
  console.log(
    `[migration] mode: ${args.apply ? "APPLY (live mutations)" : "DRY-RUN (no changes)"}`,
  );

  const result = await migrateLegacyAudioKeys(stores.metadata, {
    apply: args.apply,
    blobs: stores.blobs,
    log: (msg) => console.log(`  ${msg}`),
  });

  console.log("\n=== Migration Summary ===");
  console.log(`Mode:                    ${result.dryRun ? "DRY-RUN" : "APPLIED"}`);
  console.log(`Users scanned:           ${result.usersScanned}`);
  console.log(`Episodes scanned:        ${result.episodesScanned}`);
  console.log(`Already canonical:       ${result.skippedAlreadyCanonical}`);
  console.log(`Legacy keys found:       ${result.legacyFound}`);
  console.log(`Migrated:                ${result.migrated}`);
  console.log(`Blob copies:             ${result.blobCopies}`);
  console.log(`Refused (missing source):${result.refusedMissingSource}`);
  console.log(`Refused (conflict):      ${result.refusedConflict}`);
  console.log(`Errors:                  ${result.errors.length}`);

  if (result.plan.length > 0) {
    console.log("\nPlan / Actions:");
    for (const item of result.plan) {
      const statusNote = item.status !== "applied" && item.status !== "dry_run"
        ? ` [${item.status}: ${item.error}]`
        : "";
      console.log(
        `  - [${item.userId}] ep=${item.episodeId}: ${item.oldKey} -> ${item.newKey}${statusNote}`,
      );
    }
  }
  console.log("=========================\n");
} finally {
  await stores.metadata.close?.();
}
