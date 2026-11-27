/**
 * End-to-end round-trip verification of the Deno KV -> Cloudflare D1 migration pipeline.
 *
 * Seeds EVERY entity type into a real Deno KV store, runs `exportDenoKv`, imports the
 * snapshot into a real SQLite-backed `D1MetadataStore` (twice, proving idempotency),
 * verifies row counts, and reads every domain back through `D1MetadataStore`.
 */

import { assert, assertEquals } from "@std/assert";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import { exportDenoKv } from "../scripts/export-deno-kv.ts";
import { importSnapshotDirect, verifySnapshotInD1 } from "../scripts/migration-schema.ts";
import { createTestD1 } from "./sqlite_d1.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

Deno.test("migration: Deno KV -> Cloudflare D1 preserves 100% of data across all 11 domains and archives deno.net passkeys", async () => {
  const kv = await Deno.openKv(":memory:");
  const kvStore = new KvMetadataStore(kv, { ownsConnection: false });
  const d1 = createTestD1();
  const d1Store = new D1MetadataStore(d1);

  try {
    // 1. Users + approval log
    const admin = makeUser({
      id: "usr-admin",
      email: "Paul@Example.com",
      displayName: "Paul",
      status: "approved",
      isAdmin: true,
      feedToken: "tok_admin_secret_123",
      voice: "Aoede",
      dailyEpisodeBudget: 100,
    });
    const sub = makeUser({
      id: "usr-sub",
      email: "reader@example.com",
      displayName: "Reader",
      status: "approved",
      isAdmin: false,
      feedToken: "tok_reader_secret_456",
    });
    await kvStore.insertUser(admin);
    await kvStore.recordApproval(sub, {
      userId: sub.id,
      action: "approved",
      adminId: admin.id,
      at: "2026-10-01T12:00:00.000Z",
      reason: "invited",
    });

    // 2. Old deno.net passkey (should be archived, NOT imported into D1)
    await kvStore.putCredential({
      id: "cred-deno-old",
      userId: admin.id,
      publicKey: "AQIDBA==",
      counter: 7,
      name: "MacBook deno.net",
      createdAt: "2026-10-01T12:05:00.000Z",
    });

    // 3. Sources
    const src1 = makeSource({
      id: "src-1",
      userId: admin.id,
      title: "Stratechery",
      feedUrl: "https://stratechery.com/feed/",
      modes: ["direct", "deepdive"],
    });
    await kvStore.putSource(src1);

    // 4. Articles (normal + huge 500,000-char chunked article) + episodes
    const hugeContent = "The quick brown fox jumps over the lazy dog. ".repeat(12_000).slice(
      0,
      500_000,
    );
    const art1 = makeArticle({
      id: "art-small",
      userId: admin.id,
      sourceId: src1.id,
      url: "https://stratechery.com/post-1",
      title: "Post 1",
      content: "Short article content ready for narration.",
    });
    const ep1 = makeEpisode({
      id: "ep-ready",
      userId: admin.id,
      sourceId: src1.id,
      articleId: art1.id,
      status: "ready",
      audioKey: "audio/usr-admin/ep-ready.wav",
      byteLength: 1_234_567,
      durationSeconds: 312,
      createdAt: "2026-10-10T10:00:00.000Z",
    });
    await kvStore.insertArticleWithEpisodeIfAbsent(art1, ep1);

    const artHuge = makeArticle({
      id: "art-huge",
      userId: admin.id,
      sourceId: src1.id,
      url: "https://stratechery.com/post-huge",
      title: "Huge Post",
      content: hugeContent,
    });
    const epPending = makeEpisode({
      id: "ep-pending",
      userId: admin.id,
      sourceId: src1.id,
      articleId: artHuge.id,
      status: "pending",
      createdAt: "2026-10-11T10:00:00.000Z",
    });
    await kvStore.insertArticleWithEpisodeIfAbsent(artHuge, epPending);

    // 5. Synthesis segments + orphan blobs
    const epClaimed = makeEpisode({
      id: "ep-synth",
      userId: sub.id,
      sourceId: "inbox",
      articleId: "art-small",
      status: "synthesizing",
      claimedBy: "worker-1",
      claimedAt: "2026-10-12T00:00:00.000Z",
      createdAt: "2026-10-12T00:00:00.000Z",
    });
    await kvStore.putEpisode(epClaimed);
    await kvStore.reserveSynthesisSegment(
      sub.id,
      epClaimed.id,
      {
        textHash: "hash1",
        text: "Hello segment",
        promptVersion: "v1",
        voice: "Charon",
        audioKey: "",
        byteLength: 0,
        owner: "worker-1",
        claimAt: "2026-10-12T00:00:00.000Z",
        createdAt: "2026-10-12T00:00:01.000Z",
        finalized: false,
      },
      Date.parse("2026-10-12T00:00:02.000Z"),
      600_000,
    );
    await kvStore.recordOrphanBlob("audio/old/orphan-1.wav");

    // 6. Usage counters
    await kvStore.recordDownload(admin.id);
    await kvStore.recordDownload(admin.id);
    await kvStore.recordSynthesis(admin.id, 1_234_567, new Date("2026-10-10T10:00:00.000Z"));

    // 7. Outbox notifications + runs + logs
    await kvStore.queueNotification({
      id: "notif-1",
      userId: admin.id,
      episodeId: ep1.id,
      status: "ready",
      title: ep1.title,
      playerUrl: "https://audiofeed.app/listen/tok",
      createdAt: "2026-10-10T10:01:00.000Z",
    });
    await kvStore.recordRun({
      id: "run-1",
      kind: "feed-poll",
      trigger: "cron",
      startedAt: "2026-10-12T01:00:00.000Z",
      durationMs: 420,
      polled: 3,
      queued: 1,
      failed: 0,
    });
    const log1 = await kvStore.appendLog({
      time: "2026-10-01T00:00:00.000Z",
      severity: "info",
      type: "test.old",
      message: "old log",
      process: "app",
    });
    assert(log1 !== null);
    await kvStore.pruneLogs(new Date("2026-10-02T00:00:00.000Z"));
    const log2 = await kvStore.appendLog({
      time: "2026-10-12T01:00:00.000Z",
      severity: "info",
      type: "test.current",
      message: "current log",
      process: "app",
    });
    assert(log2 !== null);
    const onceRes = await kvStore.appendLogOnce(
      {
        time: "2026-10-12T02:00:00.000Z",
        severity: "warn",
        type: "synthesis.invocation.overdue",
        message: "overdue check",
        process: "app",
      },
      "inv-123",
      log2.seq,
    );
    assertEquals(onceRes, "written");

    // --- Export from Deno KV ---
    const snapshot = await exportDenoKv(kv, "test-memory-kv");
    assertEquals(snapshot.unknownPrefixes, {}, "no KV prefixes should go unrecognized");
    assertEquals(snapshot.archivedDenoPasskeys.length, 1);
    assertEquals(snapshot.archivedDenoPasskeys[0]?.credentialId, "cred-deno-old");

    // --- Import into Cloudflare D1 (twice, verifying idempotency) ---
    await importSnapshotDirect(d1, snapshot);
    await importSnapshotDirect(d1, snapshot);

    const verification = await verifySnapshotInD1(d1, snapshot);
    assert(verification.ok, `Verification mismatches: ${verification.mismatches.join(", ")}`);

    // --- Verify every domain via D1MetadataStore ---
    const gotAdmin = await d1Store.getUserByFeedToken("tok_admin_secret_123");
    assertEquals(gotAdmin?.id, admin.id);
    assertEquals(gotAdmin?.voice, "Aoede");
    assertEquals(gotAdmin?.dailyEpisodeBudget, 100);
    assertEquals((await d1Store.getUserByEmail("paul@example.com"))?.id, admin.id);
    assertEquals((await d1Store.listApprovalLog()).length, 1);

    // Passkeys intentionally excluded (users re-enrol on audiofeed.app)
    assertEquals(await d1Store.listCredentials(admin.id), []);

    // Sources
    assertEquals((await d1Store.listSources(admin.id)).map((s) => s.id), ["src-1"]);

    // Articles (including 500k-char re-chunked article + URL dedupe)
    const gotHuge = await d1Store.getArticle(admin.id, "art-huge");
    assertEquals(gotHuge?.content.length, 500_000);
    assertEquals(gotHuge?.content, hugeContent);
    assertEquals((await d1Store.findArticleByUrl(admin.id, "https://stratechery.com/post-1"))?.id, "art-small");

    // Episodes & R2 audioKey preserved
    const gotReady = await d1Store.getEpisode(admin.id, "ep-ready");
    assertEquals(gotReady?.audioKey, "audio/usr-admin/ep-ready.wav");
    assertEquals(gotReady?.byteLength, 1_234_567);
    assertEquals(
      (await d1Store.listPendingEpisodes({ nowMs: Date.parse("2026-10-12T00:01:00.000Z") }))
        .episodes.map((e) => e.id),
      ["ep-pending"],
    );
    // And after the old claim's lease expires, the migrated synthesizing episode is recovered too:
    assertEquals(
      (await d1Store.listPendingEpisodes()).episodes.map((e) => e.id),
      ["ep-pending", "ep-synth"],
    );

    // Segments & orphan blobs
    assertEquals((await d1Store.listSynthesisSegments(sub.id, epClaimed.id)).length, 1);
    assertEquals(await d1Store.listOrphanBlobs(10), ["audio/old/orphan-1.wav"]);

    // Usage counters
    const downloads = await d1Store.getDownloadCounts();
    assertEquals(downloads.total, 2);
    const synth = await d1Store.getSynthesisCounts("2026-10-10");
    assertEquals(synth.total, 1);
    assertEquals(synth.totalBytes, 1_234_567);
    assertEquals(await d1Store.getDailySynthesisCount("2026-10-10"), 1);

    // Outbox, runs, logs + watermark preserved
    assertEquals((await d1Store.listOutbox()).map((n) => n.id), ["notif-1"]);
    assertEquals((await d1Store.listRuns()).map((r) => r.id), ["run-1"]);
    const bounds = await d1Store.logBounds();
    assertEquals(bounds.oldestSeq, 2);
    assertEquals(bounds.newestSeq, 3);
    assertEquals((await d1Store.listLogs()).length, 2);
  } finally {
    kv.close();
    d1.close();
  }
});
