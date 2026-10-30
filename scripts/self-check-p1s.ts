import { memoryStores, openStores } from "../src/config.ts";
import type { Stores } from "../src/config.ts";
import { makeEpisode, makeUser } from "../tests/fixtures.ts";
import { migrateLegacyAudioKeys } from "../src/storage/legacy_audio.ts";

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4]);

function wrapBlobs(blobs: Stores["blobs"], overrides: Partial<Stores["blobs"]>): Stores["blobs"] {
  return {
    get: (k, opts) => overrides.get ? overrides.get(k, opts) : blobs.get(k, opts),
    head: (k) => overrides.head ? overrides.head(k) : blobs.head(k),
    delete: (k) => overrides.delete ? overrides.delete(k) : blobs.delete(k),
    url: (k, opts) => overrides.url ? overrides.url(k, opts) : blobs.url(k, opts),
    // directUrlOrigin is REQUIRED on BlobStore, and the wrapper must state the inner store's
    // own answer rather than omit the method: null here still means "never redirects".
    directUrlOrigin: () =>
      overrides.directUrlOrigin ? overrides.directUrlOrigin() : blobs.directUrlOrigin(),
    put: (k, body, opts) => overrides.put ? overrides.put(k, body, opts) : blobs.put(k, body, opts),
    putIfAbsent: (k, body, opts) =>
      overrides.putIfAbsent
        ? overrides.putIfAbsent(k, body, opts)
        : blobs.putIfAbsent(k, body, opts),
  };
}

async function runSelfCheck() {
  console.log("=== SELF-CHECK: ALL 6 P1s + Happy Path + Idempotency + Dry-Run (Memory & KV) ===");

  for (const storeType of ["memory", "kv"] as const) {
    console.log(`\n--- STORE: ${storeType.toUpperCase()} ---`);
    const stores: Stores = storeType === "memory"
      ? memoryStores()
      : await openStores({ kvPath: ":memory:" });

    try {
      await stores.metadata.putUser(makeUser({ id: "user-test", status: "approved" }));

      // 1. Dry Run
      {
        await stores.blobs.put("dry.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });
        await stores.metadata.putEpisode(
          makeEpisode({ id: "ep-dry", userId: "user-test", mode: "direct", audioKey: "dry.mp3" }),
        );
        const res = await migrateLegacyAudioKeys(stores.metadata, { blobs: stores.blobs });
        const ep = await stores.metadata.getEpisode("user-test", "ep-dry");
        const dest = await stores.blobs.head("audio/user-test/direct/dry.mp3");
        const ok = res.dryRun && res.legacyFound === 1 && res.migrated === 0 &&
          ep?.audioKey === "dry.mp3" && dest === null;
        console.log(
          `[${storeType}] Dry-run: ${
            ok ? "PASS" : "FAIL"
          } (found=${res.legacyFound}, migrated=${res.migrated})`,
        );
        if (!ok) throw new Error("Dry-run failed");
      }

      // 2. Happy Path
      {
        await stores.blobs.put("happy.mp3", AUDIO_BYTES, { contentType: "audio/mpeg" });
        await stores.metadata.putEpisode(
          makeEpisode({
            id: "ep-happy",
            userId: "user-test",
            mode: "direct",
            audioKey: "happy.mp3",
          }),
        );
        const res = await migrateLegacyAudioKeys(stores.metadata, {
          apply: true,
          blobs: stores.blobs,
        });
        const ep = await stores.metadata.getEpisode("user-test", "ep-happy");
        const dest = await stores.blobs.get("audio/user-test/direct/happy.mp3");
        const destBytes = dest ? await new Response(dest.body).bytes() : null;
        const bytesMatch = destBytes && destBytes.length === 4 &&
          destBytes.every((b, i) => b === AUDIO_BYTES[i]);
        const ok = res.migrated >= 1 && ep?.audioKey === "audio/user-test/direct/happy.mp3" &&
          bytesMatch;
        console.log(
          `[${storeType}] Happy Path: ${
            ok ? "PASS" : "FAIL"
          } (destBytes==sourceBytes: ${bytesMatch})`,
        );
        if (!ok) throw new Error("Happy path failed");
      }

      // 3. Idempotency
      {
        const res = await migrateLegacyAudioKeys(stores.metadata, {
          apply: true,
          blobs: stores.blobs,
        });
        const ok = res.migrated === 0 && res.blobCopies === 0;
        console.log(
          `[${storeType}] Idempotency: ${
            ok ? "PASS" : "FAIL"
          } (migrated=${res.migrated}, blobCopies=${res.blobCopies})`,
        );
        if (!ok) throw new Error("Idempotency failed");
      }

      // 4. P1 repro ogd7: missing source blob
      {
        await stores.metadata.putEpisode(
          makeEpisode({
            id: "ep-ogd7",
            userId: "user-test",
            mode: "direct",
            audioKey: "missing-source.mp3",
          }),
        );
        const res = await migrateLegacyAudioKeys(stores.metadata, {
          apply: true,
          blobs: stores.blobs,
        });
        const ep = await stores.metadata.getEpisode("user-test", "ep-ogd7");
        const ok = res.refusedMissingSource === 1 && ep?.audioKey === "missing-source.mp3";
        console.log(
          `[${storeType}] ogd7 (missing source refusal): ${
            ok ? "PASS" : "FAIL"
          } (refused=${res.refusedMissingSource}, keyPreserved=${
            ep?.audioKey === "missing-source.mp3"
          })`,
        );
        if (!ok) throw new Error("ogd7 failed");
      }

      // 5. P1 repro rv3a: destination conflict
      {
        await stores.blobs.put("source-rv3a.mp3", new Uint8Array([1, 1]));
        await stores.blobs.put("audio/user-test/direct/source-rv3a.mp3", new Uint8Array([9, 9]));
        await stores.metadata.putEpisode(
          makeEpisode({
            id: "ep-rv3a",
            userId: "user-test",
            mode: "direct",
            audioKey: "source-rv3a.mp3",
          }),
        );
        const res = await migrateLegacyAudioKeys(stores.metadata, {
          apply: true,
          blobs: stores.blobs,
        });
        const ep = await stores.metadata.getEpisode("user-test", "ep-rv3a");
        const dest = await stores.blobs.get("audio/user-test/direct/source-rv3a.mp3");
        const destBytes = dest ? await new Response(dest.body).bytes() : new Uint8Array();
        const destUntouched = destBytes.length === 2 && destBytes[0] === 9;
        const ok = res.refusedConflict >= 1 && ep?.audioKey === "source-rv3a.mp3" && destUntouched;
        console.log(
          `[${storeType}] rv3a (destination conflict refusal): ${
            ok ? "PASS" : "FAIL"
          } (refused=${res.refusedConflict}, destUntouched=${destUntouched})`,
        );
        if (!ok) throw new Error("rv3a failed");
      }

      // 6. P1 repro v6an: head succeeds but get returns null (TOCTOU)
      {
        await stores.metadata.putEpisode(
          makeEpisode({ id: "ep-v6an", userId: "user-test", mode: "direct", audioKey: "v6an.mp3" }),
        );
        const toctouBlobs = wrapBlobs(stores.blobs, {
          head: (key) => Promise.resolve({ key, size: 10, contentType: "audio/mpeg" }),
          get: (key, opts) => {
            if (key === "audio/v6an.mp3" || key === "v6an.mp3") return Promise.resolve(null);
            return stores.blobs.get(key, opts);
          },
        });
        const res = await migrateLegacyAudioKeys(stores.metadata, {
          apply: true,
          blobs: toctouBlobs,
        });
        const ep = await stores.metadata.getEpisode("user-test", "ep-v6an");
        const ok = res.refusedMissingSource >= 1 && ep?.audioKey === "v6an.mp3";
        console.log(
          `[${storeType}] v6an (head-succeeds / get-null refusal): ${
            ok ? "PASS" : "FAIL"
          } (refused=${res.refusedMissingSource}, keyPreserved=${ep?.audioKey === "v6an.mp3"})`,
        );
        if (!ok) throw new Error("v6an failed");
      }

      // 7. P1 repro axq4: destination get throws
      {
        await stores.blobs.put("source-axq4.wav", new Uint8Array([1]));
        await stores.blobs.put("audio/user-test/direct/source-axq4.wav", new Uint8Array([2]));
        await stores.metadata.putEpisode(
          makeEpisode({
            id: "ep-axq4",
            userId: "user-test",
            mode: "direct",
            audioKey: "source-axq4.wav",
          }),
        );
        const throwingBlobs = wrapBlobs(stores.blobs, {
          get: (key, opts) => {
            if (key === "audio/user-test/direct/source-axq4.wav") {
              return Promise.reject(new Error("simulated S3 transport 500 error"));
            }
            return stores.blobs.get(key, opts);
          },
        });
        const res = await migrateLegacyAudioKeys(stores.metadata, {
          apply: true,
          blobs: throwingBlobs,
        });
        const ep = await stores.metadata.getEpisode("user-test", "ep-axq4");
        const dest = await stores.blobs.get("audio/user-test/direct/source-axq4.wav");
        const destBytes = dest ? await new Response(dest.body).bytes() : new Uint8Array();
        const destUntouched = destBytes.length === 1 && destBytes[0] === 2;
        const ok = res.refusedConflict >= 1 && ep?.audioKey === "source-axq4.wav" && destUntouched;
        console.log(
          `[${storeType}] axq4 (destination read error refusal): ${
            ok ? "PASS" : "FAIL"
          } (refused=${res.refusedConflict}, destUntouched=${destUntouched})`,
        );
        if (!ok) throw new Error("axq4 failed");
      }

      // 8. P1 repro qm7b: concurrent external writer races before put
      {
        await stores.blobs.put("source-qm7b.wav", new Uint8Array([1]));
        await stores.metadata.putEpisode(
          makeEpisode({
            id: "ep-qm7b",
            userId: "user-test",
            mode: "direct",
            audioKey: "source-qm7b.wav",
          }),
        );

        let concurrentWriterRan = false;
        const racingBlobs = wrapBlobs(stores.blobs, {
          putIfAbsent: async (key, body, opts) => {
            if (key === "audio/user-test/direct/source-qm7b.wav" && !concurrentWriterRan) {
              // External writer injects canonical blob with [2]
              concurrentWriterRan = true;
              await stores.blobs.put(key, new Uint8Array([2]), { contentType: "audio/wav" });
              // putIfAbsent detects existing key and returns null (412 in S3 / collision)
              return null;
            }
            return stores.blobs.putIfAbsent(key, body, opts);
          },
        });

        const res = await migrateLegacyAudioKeys(stores.metadata, {
          apply: true,
          blobs: racingBlobs,
        });
        const ep = await stores.metadata.getEpisode("user-test", "ep-qm7b");
        const dest = await stores.blobs.get("audio/user-test/direct/source-qm7b.wav");
        const destBytes = dest ? await new Response(dest.body).bytes() : new Uint8Array();
        const destUntouched = destBytes.length === 1 && destBytes[0] === 2;
        const ok = res.migrated === 0 && res.refusedConflict >= 1 &&
          ep?.audioKey === "source-qm7b.wav" && destUntouched;
        console.log(
          `[${storeType}] qm7b (concurrent writer race via putIfAbsent refusal): ${
            ok ? "PASS" : "FAIL"
          } (migrated=${res.migrated}, refused=${res.refusedConflict}, destPreserved=${destUntouched})`,
        );
        if (!ok) throw new Error("qm7b failed");
      }

      // 9. P1 repro 9731: concurrent episode update during migration
      {
        const oldEp = makeEpisode({
          id: "ep-9731",
          userId: "user-test",
          mode: "direct",
          audioKey: "legacy-9731.mp3",
          title: "original-title",
        });
        await stores.metadata.putEpisode(oldEp);
        await stores.blobs.put("legacy-9731.mp3", new Uint8Array([1]));
        const freshKey = "audio/user-test/direct/fresh-9731.mp3";
        await stores.blobs.put(freshKey, new Uint8Array([2]));

        let didConcurrentWrite = false;
        const raceBlobs = wrapBlobs(stores.blobs, {
          get: async (key, opts) => {
            if (key === "legacy-9731.mp3" && !didConcurrentWrite) {
              didConcurrentWrite = true;
              // Concurrent writer updates episode with freshKey and newer title
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
          blobs: raceBlobs,
        });
        const currentEp = await stores.metadata.getEpisode("user-test", "ep-9731");
        const ok = didConcurrentWrite &&
          res.migrated === 0 &&
          res.refusedConflict >= 1 &&
          currentEp?.audioKey === freshKey &&
          currentEp?.title === "newer-concurrent-title";
        console.log(
          `[${storeType}] 9731 (concurrent metadata update via CAS): ${
            ok ? "PASS" : "FAIL"
          } (migrated=${res.migrated}, preservedKey=${
            currentEp?.audioKey === freshKey
          }, preservedTitle=${currentEp?.title === "newer-concurrent-title"})`,
        );
        if (!ok) throw new Error("9731 failed");
      }
    } finally {
      if (storeType === "kv") {
        await stores.metadata.close();
      }
    }
  }

  console.log("\n=== ALL SELF-CHECKS COMPLETED SUCCESSFULLY ===");
}

await runSelfCheck();
