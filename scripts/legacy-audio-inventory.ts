#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv
/**
 * CLI script to inventory legacy flat audio keys in the database.
 * Run with: deno task inventory
 *
 * Produces strictly aggregate counts only (audio-feed-tyxd).
 *
 * Owned by: audio-feed-e6xb.
 */
import { openStores } from "../src/config.ts";
import { inventoryLegacyAudioKeys, type KnownAudioExtension } from "../src/storage/legacy_audio.ts";

const stores = await openStores();
console.log(`[inventory] connected to ${stores.describe}`);
const result = await inventoryLegacyAudioKeys(stores.metadata);

console.log("\n=== Legacy Audio Key Inventory ===");
console.log(`Users scanned:           ${result.totalUsersScanned}`);
console.log(`Episodes scanned:        ${result.totalEpisodesScanned}`);
console.log(`Episodes with audioKey:  ${result.episodesWithAudioKey}`);
console.log(`Canonical keys:          ${result.canonicalCount}`);
console.log(`Legacy flat keys:        ${result.legacyCount}`);

if (result.legacyCount > 0) {
  console.log("\nLegacy Keys by Shape:");
  console.log(`  - flat (single-segment): ${result.byShape.flat}`);
  console.log(`  - audio-prefixed:        ${result.byShape.audioPrefixed}`);
  console.log(`  - nested:                ${result.byShape.nested}`);

  console.log("\nLegacy Keys by Extension (strict whitelist):");
  for (
    const [ext, count] of Object.entries(result.byExtension) as [KnownAudioExtension, number][]
  ) {
    if (count > 0) {
      console.log(`  - ${ext}: ${count}`);
    }
  }
}
console.log("==================================\n");
