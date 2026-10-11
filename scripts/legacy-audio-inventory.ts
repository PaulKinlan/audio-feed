#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv
/**
 * CLI script to inventory legacy flat audio keys in the database.
 * Run with: deno task inventory
 *
 * Owned by: audio-feed-e6xb.
 */
import { openStores } from "../src/config.ts";
import { inventoryLegacyAudioKeys } from "../src/storage/legacy_audio.ts";

const stores = await openStores();
console.log(`[inventory] connected to ${stores.describe}`);
const result = await inventoryLegacyAudioKeys(stores.metadata);

console.log("\n=== Legacy Audio Key Inventory ===");
console.log(`Users scanned:           ${result.totalUsersScanned}`);
console.log(`Episodes scanned:        ${result.totalEpisodesScanned}`);
console.log(`Episodes with audioKey:  ${result.episodesWithAudioKey}`);
console.log(`Canonical keys:          ${result.canonicalCount}`);
console.log(`Legacy flat keys:        ${result.legacyCount}`);

if (result.legacySamples.length > 0) {
  console.log("\nSample legacy keys (redacted):");
  for (const sample of result.legacySamples) {
    console.log(`  - user=${sample.userId} episode=${sample.episodeId} key=${sample.redactedKey}`);
  }
}
console.log("==================================\n");
