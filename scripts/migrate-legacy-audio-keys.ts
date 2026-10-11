#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv
/**
 * CLI script to migrate legacy flat audio keys to canonical keys.
 * Default is DRY-RUN mode. Pass --apply to execute mutations.
 *
 * Usage:
 *   deno run -A --unstable-kv scripts/migrate-legacy-audio-keys.ts           # Dry-run
 *   deno run -A --unstable-kv scripts/migrate-legacy-audio-keys.ts --apply   # Apply changes
 *
 * Owned by: audio-feed-e6xb.
 */
import { openStores } from "../src/config.ts";
import { migrateLegacyAudioKeys } from "../src/storage/legacy_audio.ts";

const apply = Deno.args.includes("--apply");
const stores = await openStores();

console.log(`[migration] connected to ${stores.describe}`);
console.log(`[migration] mode: ${apply ? "APPLY (live mutations)" : "DRY-RUN (no changes)"}`);

const result = await migrateLegacyAudioKeys(stores.metadata, {
  apply,
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
