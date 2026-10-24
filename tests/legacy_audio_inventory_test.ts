/**
 * Tests for legacy flat audio key inventory and transactional migration (audio-feed-e6xb, audio-feed-nls7).
 *
 * Verifies:
 * 1. isCanonicalAudioKey classification and canonicalizeAudioKey.
 * 2. Whitelist-based extension categorization and structural shape categorization.
 * 3. Inventory scanning across Memory and KV metadata stores.
 * 4. Paging and bounding over large catalogues in KV.
 * 5. Complete privacy protection (audio-feed-2qgb, audio-feed-tyxd):
 *    Strictly aggregate counts only; zero user IDs, key tokens, or arbitrary suffixes.
 * 6. Transactional migration safety (audio-feed-nls7):
 *    - Happy path: copies source bytes to canonical destination via putIfAbsent.
 *    - Missing source refusal (ogd7).
 *    - Destination-conflict refusal when bytes mismatch (rv3a).
 *    - Head-succeeds but get-null refusal / TOCTOU simulation (v6an).
 *    - Destination read failure refusal (axq4).
 *    - Concurrent external writer race via putIfAbsent refusal (qm7b).
 *    - Destination match reuse without duplicate copy.
 *    - Idempotency on Memory and KV stores.
 *    - Single-writer concurrency lock.
 * 7. Integration with server bootstrap boot-time inventory.
 */

import { assert, assertEquals } from "@std/assert";
import { memoryStores, openStores } from "../src/config.ts";
import type { Stores } from "../src/config.ts";
import {
  acquireMigrationLock,
  canonicalizeAudioKey,
  categorizeExtension,
  categorizeShape,
  clearLegacyKeyIndexCache,
  getLegacyKeyUniqueOwner,
  inventoryLegacyAudioKeys,
  isCanonicalAudioKey,
  migrateLegacyAudioKeys,
  normalizeLegacyAudioKey,
  releaseMigrationLock,
  renewMigrationLock,
} from "../src/storage/legacy_audio.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { bootstrap } from "../src/server.ts";

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function wrapBlobs(blobs: Stores["blobs"], overrides: Partial<Stores["blobs"]>): Stores["blobs"] {
  return {
    get: (k, opts) => overrides.get ? overrides.get(k, opts) : blobs.get(k, opts),
    head: (k) => overrides.head ? overrides.head(k) : blobs.head(k),
    delete: (k) => overrides.delete ? overrides.delete(k) : blobs.delete(k),
    url: (k, opts) => overrides.url ? overrides.url(k, opts) : blobs.url(k, opts),
    put: (k, body, opts) => overrides.put ? overrides.put(k, body, opts) : blobs.put(k, body, opts),
    putIfAbsent: (k, body, opts) =>
      overrides.putIfAbsent
        ? overrides.putIfAbsent(k, body, opts)
        : blobs.putIfAbsent(k, body, opts),
  };
}

// ---------------------------------------------------------------------------
// 1. Unit tests: key classification, canonicalization, extension whitelist, shape
// ---------------------------------------------------------------------------

Deno.test("isCanonicalAudioKey: identifies canonical keys and rejects legacy flat keys", () => {
  const ep = { userId: "user-1", mode: "direct" as const };

  // 4-segment canonical
  assertEquals(isCanonicalAudioKey("audio/user-1/direct/ep-1.mp3", ep), true);
  assertEquals(isCanonicalAudioKey("audio/user-1/direct/ep-1.wav", ep), true);
  assertEquals(
    isCanonicalAudioKey("audio/user-1/deepdive/ep-1.mp3", { ...ep, mode: "deepdive" }),
    true,
  );

  // 3-segment route-trimmed canonical
  assertEquals(isCanonicalAudioKey("user-1/direct/ep-1.mp3", ep), true);

  // Mismatched user or mode
  assertEquals(isCanonicalAudioKey("audio/other-user/direct/ep-1.mp3", ep), false);
  assertEquals(isCanonicalAudioKey("audio/user-1/deepdive/ep-1.mp3", ep), false);

  // Legacy flat keys
  assertEquals(isCanonicalAudioKey("legacy.mp3", ep), false);
  assertEquals(isCanonicalAudioKey("episode-1.wav", ep), false);
  assertEquals(isCanonicalAudioKey("audio/ready.wav", ep), false);
  assertEquals(isCanonicalAudioKey("audio/legacy.mp3", ep), false);

  // Invalid extensions or forbidden prefixes
  assertEquals(isCanonicalAudioKey("audio/user-1/direct/ep-1.txt", ep), false);
  assertEquals(isCanonicalAudioKey("audio-segments/user-1/direct/ep-1.mp3", ep), false);
  assertEquals(isCanonicalAudioKey("voice-samples/user-1/direct/ep-1.mp3", ep), false);
});

Deno.test("canonicalizeAudioKey: produces canonical keys idempotently", () => {
  const epDirect = makeEpisode({
    id: "ep-1",
    userId: "user-1",
    mode: "direct",
    audioKey: "legacy.mp3",
  });
  assertEquals(canonicalizeAudioKey(epDirect), "audio/user-1/direct/legacy.mp3");

  const epPrefixed = makeEpisode({
    id: "ep-2",
    userId: "user-1",
    mode: "deepdive",
    audioKey: "audio/ready.wav",
  });
  assertEquals(canonicalizeAudioKey(epPrefixed), "audio/user-1/deepdive/ready.wav");

  const epAlreadyCanonical = makeEpisode({
    id: "ep-3",
    userId: "user-1",
    mode: "direct",
    audioKey: "audio/user-1/direct/canonical.mp3",
  });
  assertEquals(canonicalizeAudioKey(epAlreadyCanonical), "audio/user-1/direct/canonical.mp3");

  const epTrimmed = makeEpisode({
    id: "ep-4",
    userId: "user-1",
    mode: "direct",
    audioKey: "user-1/direct/canonical.mp3",
  });
  assertEquals(canonicalizeAudioKey(epTrimmed), "audio/user-1/direct/canonical.mp3");
});

Deno.test("categorizeExtension: strictly whitelists safe extensions and buckets arbitrary suffixes into 'other' (audio-feed-tyxd)", () => {
  assertEquals(categorizeExtension("track.wav"), ".wav");
  assertEquals(categorizeExtension("track.mp3"), ".mp3");
  assertEquals(categorizeExtension("track.m4a"), ".m4a");
  assertEquals(categorizeExtension("track.ogg"), ".ogg");
  assertEquals(categorizeExtension("track.webm"), ".webm");

  // Hostile / user-controlled suffixes bucketed into "other" — no arbitrary strings retained
  assertEquals(categorizeExtension("track.sensitive-2026"), "other");
  assertEquals(categorizeExtension("track.leak-token"), "other");
  assertEquals(categorizeExtension("track"), "none");
});

Deno.test("categorizeShape: classifies keys into fixed coarse categories", () => {
  assertEquals(categorizeShape("legacy.wav"), "flat");
  assertEquals(categorizeShape("audio/ready.wav"), "audioPrefixed");
  assertEquals(categorizeShape("private/account/secret.mp3"), "nested");
  assertEquals(categorizeShape("audio/u/direct/ep.wav"), "nested");
});

// ---------------------------------------------------------------------------
// 2. Inventory tests on Memory store (strictly read-only)
// ---------------------------------------------------------------------------

Deno.test("inventoryLegacyAudioKeys: reports accurate counts on Memory store without mutating records", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putUser(makeUser({ id: "user-2", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "src-1", userId: "user-1" }));

  // Empty inventory
  const emptyInv = await inventoryLegacyAudioKeys(stores.metadata);
  assertEquals(emptyInv.totalUsersScanned, 2);
  assertEquals(emptyInv.totalEpisodesScanned, 0);
  assertEquals(emptyInv.legacyCount, 0);

  // Add mixed episodes
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-canonical",
      userId: "user-1",
      audioKey: "audio/user-1/direct/canonical.mp3",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-legacy-1",
      userId: "user-1",
      audioKey: "legacy-track-1.wav",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-legacy-2",
      userId: "user-2",
      audioKey: "audio/ready-2.mp3",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-pending",
      userId: "user-2",
      status: "pending",
      audioKey: undefined,
    }),
  );

  const inv = await inventoryLegacyAudioKeys(stores.metadata);
  assertEquals(inv.totalUsersScanned, 2);
  assertEquals(inv.totalEpisodesScanned, 4);
  assertEquals(inv.episodesWithAudioKey, 3);
  assertEquals(inv.canonicalCount, 1);
  assertEquals(inv.legacyCount, 2);

  assertEquals(inv.byShape.flat, 1);
  assertEquals(inv.byShape.audioPrefixed, 1);
  assertEquals(inv.byShape.nested, 0);

  assertEquals(inv.byExtension[".wav"], 1);
  assertEquals(inv.byExtension[".mp3"], 1);
  assertEquals(inv.byExtension["other"], 0);

  // Strictly read-only assertion: stored episode records must remain unchanged
  const ep1 = await stores.metadata.getEpisode("user-1", "ep-legacy-1");
  assertEquals(ep1?.audioKey, "legacy-track-1.wav", "inventory must be strictly read-only");
  const ep2 = await stores.metadata.getEpisode("user-2", "ep-legacy-2");
  assertEquals(ep2?.audioKey, "audio/ready-2.mp3", "inventory must be strictly read-only");
});

// ---------------------------------------------------------------------------
// 3. Complete leak prevention test: zero user IDs, key fragments, or arbitrary suffixes (audio-feed-tyxd)
// ---------------------------------------------------------------------------

Deno.test("inventory: zero userIds, key fragments, or arbitrary suffixes leak into output (audio-feed-2qgb, audio-feed-tyxd)", async () => {
  const stores = memoryStores();
  const SENSITIVE_USER_ID = "private-user@example.test";
  const SENSITIVE_PATH = "private/account/track.sensitive-2026";

  await stores.metadata.putUser(makeUser({ id: SENSITIVE_USER_ID, status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-secret-123",
      userId: SENSITIVE_USER_ID,
      audioKey: SENSITIVE_PATH,
    }),
  );

  const inv = await inventoryLegacyAudioKeys(stores.metadata);
  const serialized = JSON.stringify(inv);

  // Assert strictly aggregate counts
  assertEquals(inv.legacyCount, 1);
  assertEquals(inv.byShape.nested, 1);
  assertEquals(inv.byExtension.other, 1);
  assertEquals(inv.byExtension[".wav"], 0);
  assertEquals(inv.byExtension[".mp3"], 0);

  // Assert complete absence of ANY sensitive string
  assert(!serialized.includes(SENSITIVE_USER_ID), "raw userId must NOT appear anywhere in output");
  assert(!serialized.includes("private"), "'private' substring must NOT appear in output");
  assert(!serialized.includes("account"), "'account' substring must NOT appear in output");
  assert(!serialized.includes("track"), "'track' substring must NOT appear in output");
  assert(!serialized.includes("sensitive-2026"), "hostile suffix must NOT appear in output");
  assert(!serialized.includes("secret"), "'secret' token must NOT appear in output");
});

// ---------------------------------------------------------------------------
// 4. Inventory tests on KV store (paging across multiple batches)
// ---------------------------------------------------------------------------

Deno.test("inventoryLegacyAudioKeys: pages through large KV store catalogue without mutating records", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  try {
    await stores.metadata.putUser(makeUser({ id: "user-kv", status: "approved" }));

    // Seed 105 episodes across multiple pages (limit 100)
    for (let i = 0; i < 105; i++) {
      await stores.metadata.putEpisode(
        makeEpisode({
          id: `ep-${i.toString().padStart(3, "0")}`,
          userId: "user-kv",
          audioKey: i < 5 ? `legacy-${i}.mp3` : `audio/user-kv/direct/ep-${i}.mp3`,
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        }),
      );
    }

    const inv = await inventoryLegacyAudioKeys(stores.metadata);
    assertEquals(inv.totalUsersScanned, 1);
    assertEquals(inv.totalEpisodesScanned, 105);
    assertEquals(inv.canonicalCount, 100);
    assertEquals(inv.legacyCount, 5);
    assertEquals(inv.byShape.flat, 5);
    assertEquals(inv.byExtension[".mp3"], 5);

    // Strictly read-only assertion: records remain unchanged in KV
    const sampleEp = await stores.metadata.getEpisode("user-kv", "ep-000");
    assertEquals(sampleEp?.audioKey, "legacy-0.mp3", "KV store must not be mutated by inventory");
  } finally {
    await stores.metadata.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Server boot integration test
// ---------------------------------------------------------------------------

Deno.test("bootstrap: runs legacy audio key inventory at boot with zero leakage (audio-feed-tyxd)", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  const SENSITIVE_USER_ID = "boot-private-subscriber@corp.internal";
  const SENSITIVE_KEY = "internal/vault/secret-track.leak-token-999";

  await stores.metadata.putUser(makeUser({ id: SENSITIVE_USER_ID, status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-boot-legacy",
      userId: SENSITIVE_USER_ID,
      audioKey: SENSITIVE_KEY,
    }),
  );

  const booted = await bootstrap({
    port: 0,
    stores,
    isDeploy: true, // avoid background workers
  });

  try {
    assert(booted.inventory !== undefined, "booted result must expose inventory promise");
    const inv = await booted.inventory;
    assert(inv !== null);
    assertEquals(inv.totalUsersScanned, 1);
    assertEquals(inv.legacyCount, 1);
    assertEquals(inv.byShape.nested, 1);
    assertEquals(inv.byExtension.other, 1);

    const serialized = JSON.stringify(inv);
    assert(!serialized.includes(SENSITIVE_USER_ID), "boot output must NOT leak raw userId");
    assert(!serialized.includes("internal"), "boot output must NOT leak internal path");
    assert(!serialized.includes("vault"), "boot output must NOT leak vault path");
    assert(!serialized.includes("secret-track"), "boot output must NOT leak secret filename");
    assert(!serialized.includes("leak-token"), "boot output must NOT leak hostile suffix");
  } finally {
    await booted.shutdown();
  }
});

// ---------------------------------------------------------------------------
// 6. Transactional migration tests (audio-feed-nls7)
// ---------------------------------------------------------------------------

Deno.test("migrateLegacyAudioKeys: dry-run default makes NO store mutations", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("old-track.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-legacy",
      userId: "user-1",
      mode: "direct",
      audioKey: "old-track.mp3",
    }),
  );

  const dryResult = await migrateLegacyAudioKeys(stores.metadata, { blobs: stores.blobs });
  assertEquals(dryResult.dryRun, true);
  assertEquals(dryResult.legacyFound, 1);
  assertEquals(dryResult.migrated, 0);
  assertEquals(dryResult.blobCopies, 0);

  // Stored episode must NOT be mutated
  const ep = await stores.metadata.getEpisode("user-1", "ep-legacy");
  assertEquals(ep?.audioKey, "old-track.mp3");

  // Destination blob must NOT exist
  assertEquals(await stores.blobs.head("audio/user-1/direct/old-track.mp3"), null);
});

Deno.test("migrateLegacyAudioKeys: happy path copies source bytes via putIfAbsent to canonical destination (Memory)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("legacy-item.wav", AUDIO_BYTES, { contentType: "audio/wav" });
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-1",
      userId: "user-1",
      mode: "direct",
      audioKey: "legacy-item.wav",
    }),
  );

  const result = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: stores.blobs,
  });

  assertEquals(result.dryRun, false);
  assertEquals(result.legacyFound, 1);
  assertEquals(result.migrated, 1);
  assertEquals(result.blobCopies, 1);
  assertEquals(result.errors.length, 0);

  // Destination bytes must equal source bytes exactly
  const destBlob = await stores.blobs.get("audio/user-1/direct/legacy-item.wav");
  assert(destBlob !== null, "destination blob must exist");
  const destBytes = await new Response(destBlob.body).bytes();
  assertEquals(destBytes, AUDIO_BYTES, "destination bytes must equal source bytes");

  // Episode record updated in metadata store
  const ep = await stores.metadata.getEpisode("user-1", "ep-1");
  assertEquals(ep?.audioKey, "audio/user-1/direct/legacy-item.wav");

  // Old blob remains for backward compatibility
  const oldBlob = await stores.blobs.get("legacy-item.wav");
  assert(oldBlob !== null);
});

Deno.test("migrateLegacyAudioKeys: refuses to migrate when source blob is missing (audio-feed-ogd7)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-missing",
      userId: "user-1",
      audioKey: "missing.wav",
    }),
  );

  const result = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: stores.blobs,
  });

  assertEquals(result.migrated, 0, "must refuse to migrate when source blob is missing");
  assertEquals(result.refusedMissingSource, 1);
  assertEquals(result.errors.length, 1);

  // Old key preserved
  const ep = await stores.metadata.getEpisode("user-1", "ep-missing");
  assertEquals(ep?.audioKey, "missing.wav");
});

Deno.test("migrateLegacyAudioKeys: refuses to migrate when destination blob conflicts with different bytes (audio-feed-rv3a)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("old.wav", new Uint8Array([1, 1, 1]));
  await stores.blobs.put("audio/user-1/direct/old.wav", new Uint8Array([2, 2, 2]));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-conflict",
      userId: "user-1",
      mode: "direct",
      audioKey: "old.wav",
    }),
  );

  const result = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: stores.blobs,
  });

  assertEquals(result.migrated, 0, "must refuse when destination blob conflicts");
  assertEquals(result.refusedConflict, 1);
  assertEquals(result.errors.length, 1);

  // Old key preserved
  const ep = await stores.metadata.getEpisode("user-1", "ep-conflict");
  assertEquals(ep?.audioKey, "old.wav");

  // Destination bytes untouched
  const destBlob = await stores.blobs.get("audio/user-1/direct/old.wav");
  assert(destBlob !== null);
  assertEquals(await new Response(destBlob.body).bytes(), new Uint8Array([2, 2, 2]));
});

Deno.test("migrateLegacyAudioKeys: refuses migration if head() succeeds but get() returns null (TOCTOU simulation - audio-feed-v6an)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-toctou",
      userId: "user-1",
      mode: "direct",
      audioKey: "race.wav",
    }),
  );

  const toctouBlobs = wrapBlobs(stores.blobs, {
    head: (key) => Promise.resolve({ key, size: 100, contentType: "audio/wav" }),
    get: (key, opts) => {
      if (key === "audio/race.wav" || key === "race.wav") return Promise.resolve(null);
      return stores.blobs.get(key, opts);
    },
  });

  const result = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: toctouBlobs,
  });

  assertEquals(result.migrated, 0, "must refuse when get() yields null despite head()");
  assertEquals(result.refusedMissingSource, 1);
  assertEquals(result.errors.length, 1);

  // Stored episode audioKey must remain unchanged
  const ep = await stores.metadata.getEpisode("user-1", "ep-toctou");
  assertEquals(ep?.audioKey, "race.wav");
});

Deno.test("migrateLegacyAudioKeys: refuses to migrate when destination read throws (audio-feed-axq4)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("old.wav", new Uint8Array([1]));
  await stores.blobs.put("audio/user-1/direct/old.wav", new Uint8Array([2]));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-dest-throw",
      userId: "user-1",
      mode: "direct",
      audioKey: "old.wav",
    }),
  );

  const erroringBlobs = wrapBlobs(stores.blobs, {
    get: (key, opts) => {
      if (key === "audio/user-1/direct/old.wav") {
        return Promise.reject(new Error("simulated S3 500 error on destination read"));
      }
      return stores.blobs.get(key, opts);
    },
  });

  const res = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: erroringBlobs,
  });

  assertEquals(res.migrated, 0, "a read that throws is NOT absence; must refuse migration");
  assertEquals(res.refusedConflict, 1);
  assertEquals(res.errors.length, 1);
  assert(res.errors[0]?.error.includes("simulated S3 500 error"));

  // Stored episode key must remain untouched
  const ep = await stores.metadata.getEpisode("user-1", "ep-dest-throw");
  assertEquals(ep?.audioKey, "old.wav", "old key must be preserved");

  // Destination bytes must NOT be overwritten with [1]!
  const destBlob = await stores.blobs.get("audio/user-1/direct/old.wav");
  assert(destBlob !== null);
  const destBytes = await new Response(destBlob.body).bytes();
  assertEquals(destBytes, new Uint8Array([2]), "destination bytes [2] must NOT be overwritten");
});

Deno.test("migrateLegacyAudioKeys: refuses to overwrite when concurrent external writer creates destination (audio-feed-qm7b)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("source-qm7b.wav", new Uint8Array([1]));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-qm7b",
      userId: "user-1",
      mode: "direct",
      audioKey: "source-qm7b.wav",
    }),
  );

  let externalWriterRan = false;
  const racingBlobs = wrapBlobs(stores.blobs, {
    putIfAbsent: async (key, body, opts) => {
      if (key === "audio/user-1/direct/source-qm7b.wav" && !externalWriterRan) {
        externalWriterRan = true;
        await stores.blobs.put(key, new Uint8Array([2]), { contentType: "audio/wav" });
        return null; // putIfAbsent returns null because destination exists
      }
      return stores.blobs.putIfAbsent(key, body, opts);
    },
  });

  const res = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: racingBlobs,
  });

  assertEquals(res.migrated, 0, "must refuse migration when destination has conflicting bytes");
  assertEquals(res.refusedConflict, 1);
  const ep = await stores.metadata.getEpisode("user-1", "ep-qm7b");
  assertEquals(ep?.audioKey, "source-qm7b.wav", "old key must be preserved");

  const dest = await stores.blobs.get("audio/user-1/direct/source-qm7b.wav");
  assert(dest !== null);
  const destBytes = await new Response(dest.body).bytes();
  assertEquals(destBytes, new Uint8Array([2]), "external writer bytes [2] must NOT be overwritten");
});

Deno.test("migrateLegacyAudioKeys: reuses destination blob if bytes match without duplicate copy", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("old.wav", new Uint8Array([42, 43, 44]));
  await stores.blobs.put("audio/user-1/direct/old.wav", new Uint8Array([42, 43, 44]));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-matching",
      userId: "user-1",
      mode: "direct",
      audioKey: "old.wav",
    }),
  );

  const result = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: stores.blobs,
  });

  assertEquals(result.migrated, 1, "migrates when destination matches source");
  assertEquals(result.blobCopies, 0, "no duplicate blob copy needed");
  assertEquals(result.errors.length, 0);

  const ep = await stores.metadata.getEpisode("user-1", "ep-matching");
  assertEquals(ep?.audioKey, "audio/user-1/direct/old.wav");
});

Deno.test("migrateLegacyAudioKeys: happy path, conflict refusal, and idempotency on KV store", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  try {
    await stores.metadata.putUser(makeUser({ id: "user-kv", status: "approved" }));

    // Valid episode with matching blob
    await stores.blobs.put("audio/flat-1.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-flat-1",
        userId: "user-kv",
        mode: "direct",
        audioKey: "flat-1.mp3",
      }),
    );

    // Episode with missing blob
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-flat-missing",
        userId: "user-kv",
        mode: "direct",
        audioKey: "missing-in-kv.wav",
      }),
    );

    // Episode with conflicting destination
    await stores.blobs.put("audio/flat-conflict.wav", new Uint8Array([1, 2, 3]));
    await stores.blobs.put("audio/user-kv/deepdive/flat-conflict.wav", new Uint8Array([9, 9, 9]));
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-flat-conflict",
        userId: "user-kv",
        mode: "deepdive",
        audioKey: "audio/flat-conflict.wav",
      }),
    );

    // 1. Dry run
    const dry = await migrateLegacyAudioKeys(stores.metadata, { blobs: stores.blobs });
    assertEquals(dry.dryRun, true);
    assertEquals(dry.legacyFound, 3);
    assertEquals(dry.migrated, 0);
    assertEquals(dry.refusedMissingSource, 1);
    assertEquals(dry.refusedConflict, 1);

    // 2. Apply
    const applied = await migrateLegacyAudioKeys(stores.metadata, {
      apply: true,
      blobs: stores.blobs,
    });
    assertEquals(applied.dryRun, false);
    assertEquals(applied.migrated, 1);
    assertEquals(applied.blobCopies, 1);
    assertEquals(applied.refusedMissingSource, 1);
    assertEquals(applied.refusedConflict, 1);

    // Verify KV records
    const ep1 = await stores.metadata.getEpisode("user-kv", "ep-flat-1");
    assertEquals(ep1?.audioKey, "audio/user-kv/direct/flat-1.mp3");

    const epMissing = await stores.metadata.getEpisode("user-kv", "ep-flat-missing");
    assertEquals(epMissing?.audioKey, "missing-in-kv.wav", "missing source preserved");

    const epConflict = await stores.metadata.getEpisode("user-kv", "ep-flat-conflict");
    assertEquals(epConflict?.audioKey, "audio/flat-conflict.wav", "conflict preserved");

    // 3. Idempotency repeat
    const repeat = await migrateLegacyAudioKeys(stores.metadata, {
      apply: true,
      blobs: stores.blobs,
    });
    assertEquals(repeat.migrated, 0);
    assertEquals(repeat.blobCopies, 0);
    assertEquals(repeat.skippedAlreadyCanonical, 1);
  } finally {
    await stores.metadata.close();
  }
});

Deno.test("migrateLegacyAudioKeys: single-writer lock blocks concurrent migrations", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("track.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });
  await stores.metadata.putEpisode(
    makeEpisode({ id: "ep-lock", userId: "user-1", audioKey: "track.mp3" }),
  );

  // Pre-acquire lock with another holder
  const locked = await acquireMigrationLock(stores.metadata, "concurrent-holder", 600_000);
  assertEquals(locked, true);

  try {
    let threw = false;
    try {
      await migrateLegacyAudioKeys(stores.metadata, { apply: true, blobs: stores.blobs });
    } catch (err) {
      threw = true;
      assert(String(err).includes("another migration is actively in progress"));
    }
    assertEquals(threw, true, "must refuse concurrent applied migration");
  } finally {
    await releaseMigrationLock(stores.metadata, "concurrent-holder");
  }
});

Deno.test("migrateLegacyAudioKeys: concurrent episode metadata update preserves concurrent writer (audio-feed-9731)", async () => {
  for (const kind of ["memory", "kv"] as const) {
    const stores: Stores = kind === "memory"
      ? memoryStores()
      : await openStores({ kvPath: ":memory:" });

    try {
      await stores.metadata.putUser(makeUser({ id: "user-race", status: "approved" }));
      const oldEp = makeEpisode({
        id: "ep-race",
        userId: "user-race",
        mode: "direct",
        audioKey: "old-track.mp3",
        title: "original-title",
      });
      await stores.metadata.putEpisode(oldEp);
      await stores.blobs.put("old-track.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });
      const freshKey = "audio/user-race/direct/fresh.mp3";
      await stores.blobs.put(freshKey, new Uint8Array([9, 9]));

      let didConcurrentWrite = false;
      const racingBlobs = wrapBlobs(stores.blobs, {
        get: async (key, opts) => {
          if (key === "old-track.mp3" && !didConcurrentWrite) {
            didConcurrentWrite = true;
            // Concurrent writer updates episode with fresh key and new title
            await stores.metadata.putEpisode({
              ...oldEp,
              audioKey: freshKey,
              title: "newer-concurrent-title",
            });
          }
          return stores.blobs.get(key, opts);
        },
      });

      const res = await migrateLegacyAudioKeys(stores.metadata, {
        apply: true,
        blobs: racingBlobs,
      });

      assertEquals(res.migrated, 0, "must not migrate when concurrent write occurred");
      assertEquals(res.refusedConflict, 1, "must record refusal conflict");

      const current = await stores.metadata.getEpisode("user-race", "ep-race");
      assertEquals(current?.audioKey, freshKey, "concurrent writer's audioKey must win");
      assertEquals(current?.title, "newer-concurrent-title", "concurrent writer's title must win");
    } finally {
      if (kind === "kv") {
        await stores.metadata.close();
      }
    }
  }
});

Deno.test("migrateLegacyAudioKeys: reviewer repro for lock expiry and stale takeover (audio-feed-hrfn)", async () => {
  for (const kind of ["memory", "kv"] as const) {
    const stores = kind === "memory" ? memoryStores() : await openStores({ kvPath: ":memory:" });
    try {
      // Fixed timestamps, not sleeps: the lock's expiry decision is a FUNCTION OF nowMs,
      // and asserting it at chosen instants measures the lock, not the machine
      // (audio-feed-y2ex: a test that sleeps against a real lease flakes under load).
      const first = await acquireMigrationLock(stores.metadata, "first", 50, 10_000);
      const immediate = await acquireMigrationLock(stores.metadata, "second", 50, 10_005);
      const justInside = await acquireMigrationLock(stores.metadata, "second", 50, 10_049);
      const afterLease = await acquireMigrationLock(stores.metadata, "second", 50, 10_051);
      assertEquals(first, true, "first must acquire");
      assertEquals(immediate, false, "immediate second must be refused");
      assertEquals(justInside, false, "last instant inside the lease must still be refused");
      assertEquals(afterLease, true, "first instant past the lease must acquire without renewal");
    } finally {
      await stores.metadata.close?.();
    }
    // The EXACT boundary instant gets its own store: a successful takeover at the boundary
    // would install a fresh lease and mask the next instant, so it cannot share a timeline
    // with the probes above. A 50ms lease is expired at elapsed 50 — this is the instant an
    // off-by-one comparison would flip.
    {
      const stores = kind === "memory" ? memoryStores() : await openStores({ kvPath: ":memory:" });
      try {
        const first = await acquireMigrationLock(stores.metadata, "first", 50, 10_000);
        const exactBoundary = await acquireMigrationLock(stores.metadata, "second", 50, 10_050);
        assertEquals(first, true, "first must acquire (boundary probe)");
        assertEquals(exactBoundary, true, "the boundary instant itself must take over");
      } finally {
        await stores.metadata.close?.();
      }
    }
  }
});

Deno.test("migrateLegacyAudioKeys: heartbeat renewal holds lock indefinitely past original TTL (audio-feed-hrfn)", async () => {
  for (const kind of ["memory", "kv"] as const) {
    const stores = kind === "memory" ? memoryStores() : await openStores({ kvPath: ":memory:" });
    try {
      const leaseMs = 60;
      // Renewal at fixed instants across a span more than twice the original lease —
      // the same property the old 150ms real-time loop asserted, minus the sleeps
      // (audio-feed-y2ex).
      const first = await acquireMigrationLock(stores.metadata, "holder-1", leaseMs, 20_000);
      assertEquals(first, true);

      for (let i = 1; i <= 5; i++) {
        const renewed = await renewMigrationLock(
          stores.metadata,
          "holder-1",
          leaseMs,
          20_000 + i * 25,
        );
        assertEquals(renewed, true, "holder-1 must renew successfully");

        // Concurrent holder must still be refused while the heartbeat is fresh
        const secondAttempt = await acquireMigrationLock(
          stores.metadata,
          "holder-2",
          leaseMs,
          20_000 + i * 25 + 1,
        );
        assertEquals(
          secondAttempt,
          false,
          "second holder must be refused while heartbeat is fresh",
        );
      }

      // Past the ORIGINAL lease (20_000 + 60) with renewals still fresh: still held.
      const pastOriginalTtl = await acquireMigrationLock(
        stores.metadata,
        "holder-2",
        leaseMs,
        20_000 + 125,
      );
      assertEquals(
        pastOriginalTtl,
        false,
        "renewal must hold the lock past the original TTL",
      );

      // No renewal after 20_125; one instant past that heartbeat's lease: takeover.
      const stale = await acquireMigrationLock(stores.metadata, "holder-2", leaseMs, 20_125 + 61);
      assertEquals(stale, true, "lock must be acquirable once the last heartbeat's lease lapses");

      // Explicit release by the taker
      await releaseMigrationLock(stores.metadata, "holder-2");

      // holder-3 can now acquire immediately
      const thirdAcquired = await acquireMigrationLock(
        stores.metadata,
        "holder-3",
        leaseMs,
        21_000,
      );
      assertEquals(thirdAcquired, true, "next holder must acquire immediately after release");
      await releaseMigrationLock(stores.metadata, "holder-3");
    } finally {
      await stores.metadata.close?.();
    }
  }
});

/**
 * State gate for migration lock loss tests (audio-feed-raxn2, audio-feed-gm1gb).
 * Resolves when the migration's background heartbeat observes lock loss via the
 * explicit onLockLost callback in MigrationOptions.
 *
 * docs/speed.md rule 2: the 5s bound is a HANG GUARD, not the assertion - at a 10ms
 * heartbeat it is a 500x margin, and it trips only when the renewal never fires (the
 * regression this row pins); then the migration completes without aborting and the
 * `threw` assertion reddens by name.
 */
function createLockLossGate() {
  let notifyLockLossObserved!: (reason: "failed" | "threw", error?: unknown) => void;
  let observedReason: "failed" | "threw" | undefined;
  const lockLossObserved = new Promise<"failed" | "threw">((resolve) => {
    notifyLockLossObserved = (reason) => {
      if (!observedReason) observedReason = reason;
      resolve(reason);
    };
  });
  return {
    get reason() {
      return observedReason;
    },
    onLockLost: (reason: "failed" | "threw", error?: unknown) => {
      notifyLockLossObserved(reason, error);
    },
    waitForLockLoss: async (hangGuardMs = 5_000) => {
      let guard: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        lockLossObserved,
        new Promise<void>((resolve) => {
          guard = setTimeout(resolve, hangGuardMs);
        }),
      ]);
      clearTimeout(guard);
    },
  };
}

Deno.test("migrateLegacyAudioKeys: mid-run lock loss aborts migration immediately (audio-feed-hrfn)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-abort", status: "approved" }));
  await stores.blobs.put("track-1.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });
  await stores.metadata.putEpisode(
    makeEpisode({ id: "ep-abort-1", userId: "user-abort", audioKey: "track-1.mp3" }),
  );

  const gate = createLockLossGate();

  const stealingBlobs = wrapBlobs(stores.blobs, {
    get: async (k, opts) => {
      // Steal the lock while migration is reading the blob
      await stores.metadata.atomicUpdate(
        "migration_lock:legacy_audio_keys",
        () => ({
          active: true,
          lockedAt: Date.now(),
          lastHeartbeat: Date.now(),
          leaseMs: 600_000,
          holder: "rogue-stealer",
        }),
      );
      // Wait for the heartbeat to observe the lock loss (state signal), not a fixed sleep.
      await gate.waitForLockLoss();
      return stores.blobs.get(k, opts);
    },
  });

  let threw = false;
  try {
    await migrateLegacyAudioKeys(stores.metadata, {
      apply: true,
      blobs: stealingBlobs,
      leaseMs: 30,
      heartbeatIntervalMs: 10,
      onLockLost: gate.onLockLost,
    });
  } catch (err) {
    threw = true;
    assert(String(err).includes("Migration aborted") || String(err).includes("lock lost"));
  }
  // The run must fail closed when lock cannot be renewed
  assert(threw, "migration must abort when lock is lost mid-run");
  assertEquals(gate.reason, "failed", "lock loss must be observed via renewal failure");

  // Verify episode audioKey was NOT updated (failed closed)
  const ep = await stores.metadata.getEpisode("user-abort", "ep-abort-1");
  assertEquals(ep?.audioKey, "track-1.mp3", "must not mutate when lock is lost");
});

Deno.test("migrateLegacyAudioKeys: lock loss during putIfAbsent aborts before metadata CAS (audio-feed-84q9)", async () => {
  for (const kind of ["memory", "kv"] as const) {
    const stores = kind === "memory" ? memoryStores() : await openStores({ kvPath: ":memory:" });
    try {
      await stores.metadata.putUser(makeUser({ id: "user-84q9", status: "approved" }));
      await stores.metadata.putEpisode(
        makeEpisode({ id: "ep-84q9", userId: "user-84q9", audioKey: "old-84q9.mp3" }),
      );
      await stores.blobs.put("audio/old-84q9.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });

      const gate = createLockLossGate();

      const blobs = new Proxy(stores.blobs, {
        get(target, prop, receiver) {
          if (prop !== "putIfAbsent") {
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          }
          return async (key: string, body: Uint8Array, opts?: { contentType?: string }) => {
            // Steal lock while putIfAbsent is executing
            await stores.metadata.atomicUpdate(
              "migration_lock:legacy_audio_keys",
              () => ({
                active: true,
                lockedAt: Date.now(),
                lastHeartbeat: Date.now(),
                leaseMs: 600_000,
                holder: "other-holder",
              }),
            );
            // Wait for the heartbeat to observe the lock loss (state signal), not a fixed sleep.
            await gate.waitForLockLoss();
            return stores.blobs.putIfAbsent(key, body, opts);
          };
        },
      });

      let threw = false;
      try {
        await migrateLegacyAudioKeys(stores.metadata, {
          blobs,
          apply: true,
          leaseMs: 90,
          heartbeatIntervalMs: 10,
          onLockLost: gate.onLockLost,
        });
      } catch (err) {
        threw = true;
        assert(String(err).includes("Migration aborted") || String(err).includes("lock lost"));
      }

      assert(threw, "must throw and abort when lock lost during putIfAbsent");
      assertEquals(gate.reason, "failed", "lock loss must be observed via renewal failure");
      const ep = await stores.metadata.getEpisode("user-84q9", "ep-84q9");
      assertEquals(
        ep?.audioKey,
        "old-84q9.mp3",
        "metadata audioKey must NOT be updated when lock lost during copy",
      );
    } finally {
      await stores.metadata.close?.();
    }
  }
});

Deno.test("migrateLegacyAudioKeys: heartbeat renewal error marks lock lost and aborts (audio-feed-gm1gb)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-threw", status: "approved" }));
  await stores.blobs.put("track-threw.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });
  await stores.metadata.putEpisode(
    makeEpisode({ id: "ep-threw-1", userId: "user-threw", audioKey: "track-threw.mp3" }),
  );

  const gate = createLockLossGate();
  let failRenewals = false;

  // Wrap metadata store so atomicUpdate throws during heartbeat renewal
  const originalAtomicUpdate = stores.metadata.atomicUpdate.bind(stores.metadata);
  stores.metadata.atomicUpdate = (<T>(
    key: string,
    updateFn: (current: T | null) => T | null,
    leaseMs?: number,
  ) => {
    if (key === "migration_lock:legacy_audio_keys" && failRenewals) {
      return Promise.reject(new Error("simulated heartbeat renewal store error"));
    }
    return originalAtomicUpdate(key, updateFn, leaseMs);
  }) as typeof stores.metadata.atomicUpdate;

  const interceptingBlobs = wrapBlobs(stores.blobs, {
    get: async (k, opts) => {
      // Trigger renewal error while migration is reading the blob
      failRenewals = true;
      await gate.waitForLockLoss();
      return stores.blobs.get(k, opts);
    },
  });

  let threw = false;
  try {
    await migrateLegacyAudioKeys(stores.metadata, {
      apply: true,
      blobs: interceptingBlobs,
      leaseMs: 30,
      heartbeatIntervalMs: 10,
      onLockLost: gate.onLockLost,
    });
  } catch (err) {
    threw = true;
    assert(String(err).includes("Migration aborted") || String(err).includes("lock lost"));
  }

  assert(threw, "migration must abort when heartbeat renewal throws");
  assertEquals(gate.reason, "threw", "lock loss must be observed via renewal threw");

  // Verify episode was not updated
  const ep = await stores.metadata.getEpisode("user-threw", "ep-threw-1");
  assertEquals(ep?.audioKey, "track-threw.mp3", "must not mutate when heartbeat renewal threw");
});

Deno.test("getLegacyKeyUniqueOwner: invalidates and re-verifies ownership when colliding tenant episode is added after cache population (audio-feed-ni04)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "alice", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-alice",
      userId: "alice",
      mode: "direct",
      status: "ready",
      audioKey: "shared.wav",
    }),
  );

  assertEquals(normalizeLegacyAudioKey("audio/shared.wav"), "shared.wav");
  assertEquals(normalizeLegacyAudioKey("shared.wav"), "shared.wav");

  // Populate cache: Alice is initially the unique owner
  assertEquals(await getLegacyKeyUniqueOwner(stores.metadata, "shared.wav"), "alice");
  assertEquals(await getLegacyKeyUniqueOwner(stores.metadata, "audio/shared.wav"), "alice");

  // Before TTL expires, Bob writes an episode referencing the same legacy flat key
  await stores.metadata.putUser(makeUser({ id: "bob", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-bob",
      userId: "bob",
      mode: "direct",
      status: "ready",
      audioKey: "shared.wav",
    }),
  );

  // Must NOT return stale "alice" from cache — must return null (ambiguous)
  assertEquals(
    await getLegacyKeyUniqueOwner(stores.metadata, "shared.wav"),
    null,
    "newly colliding tenant episode must invalidate stale owner cache",
  );

  clearLegacyKeyIndexCache(stores.metadata);
});
