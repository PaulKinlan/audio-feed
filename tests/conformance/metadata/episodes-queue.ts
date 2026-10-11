/**
 * The episode queue and its reads: the record itself, cursor-paged scans, and the pending
 * index that tells the worker what to synthesise next.
 *
 * Split out of tests/conformance/metadata/episodes.ts (audio-feed-b75q): the cases moved verbatim
 * from the sections that already grouped them, and no case body was edited.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { makeEpisode } from "../../fixtures.ts";
import { drainPages } from "./harness.ts";

export function registerEpisodesQueueCases(suite: MetadataHarness) {
  const { test } = suite;

  // -- episodes -------------------------------------------------------------

  test("lists episodes newest first", async (store) => {
    await store.putEpisode(makeEpisode({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" }));
    await store.putEpisode(makeEpisode({ id: "new", createdAt: "2026-09-20T00:00:00.000Z" }));
    await store.putEpisode(makeEpisode({ id: "mid", createdAt: "2026-09-10T00:00:00.000Z" }));

    const ids = (await store.listEpisodes({ userId: "user-1" })).map((e) => e.id);
    assertEquals(ids, ["new", "mid", "old"]);
  });

  test("orders identical timestamps deterministically", async (store) => {
    const at = "2026-09-10T00:00:00.000Z";
    for (const id of ["b", "a", "c"]) {
      await store.putEpisode(makeEpisode({ id, createdAt: at }));
    }
    const first = (await store.listEpisodes({ userId: "user-1" })).map((e) => e.id);
    const second = (await store.listEpisodes({ userId: "user-1" })).map((e) => e.id);
    assertEquals(first, second, "repeated reads must return a stable order");
    assertEquals(new Set(first).size, 3);
  });

  test("filters by source and keeps time order across modes", async (store) => {
    // Interleaved so a mode-major index would produce the wrong order.
    await store.putEpisode(
      makeEpisode({ id: "d1", mode: "direct", createdAt: "2026-09-01T00:00:00.000Z" }),
    );
    await store.putEpisode(
      makeEpisode({ id: "dd1", mode: "deepdive", createdAt: "2026-09-02T00:00:00.000Z" }),
    );
    await store.putEpisode(
      makeEpisode({ id: "d2", mode: "direct", createdAt: "2026-09-03T00:00:00.000Z" }),
    );

    const ids = (await store.listEpisodes({ userId: "user-1", sourceId: "stratechery" }))
      .map((e) => e.id);
    assertEquals(ids, ["d2", "dd1", "d1"]);
  });

  test("filters by mode", async (store) => {
    await store.putEpisode(makeEpisode({ id: "d1", mode: "direct" }));
    await store.putEpisode(makeEpisode({ id: "dd1", mode: "deepdive" }));

    const direct = await store.listEpisodes({ userId: "user-1", mode: "direct" });
    assertEquals(direct.map((e) => e.id), ["d1"]);
  });

  test("filters by source and mode together", async (store) => {
    await store.putEpisode(makeEpisode({ id: "a", sourceId: "s1", mode: "direct" }));
    await store.putEpisode(makeEpisode({ id: "b", sourceId: "s1", mode: "deepdive" }));
    await store.putEpisode(makeEpisode({ id: "c", sourceId: "s2", mode: "direct" }));

    const got = await store.listEpisodes({ userId: "user-1", sourceId: "s1", mode: "direct" });
    assertEquals(got.map((e) => e.id), ["a"]);
  });

  test("filters by status so feeds exclude unfinished work", async (store) => {
    await store.putEpisode(makeEpisode({ id: "ready", status: "ready" }));
    await store.putEpisode(makeEpisode({ id: "pending", status: "pending", audioKey: undefined }));
    await store.putEpisode(makeEpisode({ id: "failed", status: "failed", audioKey: undefined }));

    const ready = await store.listEpisodes({ userId: "user-1", status: "ready" });
    assertEquals(ready.map((e) => e.id), ["ready"]);
  });

  test("honours the limit", async (store) => {
    for (let i = 0; i < 10; i++) {
      await store.putEpisode(
        makeEpisode({
          id: `e${i}`,
          createdAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        }),
      );
    }
    assertEquals((await store.listEpisodes({ userId: "user-1", limit: 3 })).length, 3);
  });

  test("a filtered listEpisodes returns matches sitting beyond limit index entries", async (store) => {
    // audio-feed-m04: `limit` must bound MATCHES, not entries examined. The quiet
    // source's episodes are the OLDEST, so they are last in a newest-first scan;
    // a scan that stopped after `limit` entries would return none of them.
    for (let i = 0; i < 150; i++) {
      await store.putEpisode(
        makeEpisode({
          id: `busy-${i}`,
          sourceId: "busy",
          createdAt: new Date(1760000000000 + i * 1000).toISOString(),
        }),
      );
    }
    for (let i = 0; i < 10; i++) {
      await store.putEpisode(
        makeEpisode({
          id: `quiet-${i}`,
          sourceId: "quiet",
          createdAt: new Date(1700000000000 + i * 1000).toISOString(),
        }),
      );
    }

    const got = await store.listEpisodes({ userId: "user-1", sourceId: "quiet", limit: 100 });
    assertEquals(got.length, 10, "a filtered query must still find matches past the entry horizon");
    assertEquals(new Set(got.map((e) => e.sourceId)), new Set(["quiet"]));
  });

  // -- cursor-paged scan (audio-feed-att) -----------------------------------

  /** Walk a whole scan the way `compose.ts` does, so paging bugs show up here. */

  test("pages a full scan with no omission and no repeat", async (store) => {
    for (let i = 0; i < 7; i++) {
      await store.putEpisode(
        makeEpisode({
          id: `e${i}`,
          createdAt: `2026-09-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }
    const whole = (await store.listEpisodes({ userId: "user-1", limit: Number.POSITIVE_INFINITY }))
      .map((e) => e.id);
    const { seen, pages } = await drainPages(store, { userId: "user-1" }, 2);
    assertEquals(seen, whole, "paged scan must cover exactly what the uncapped scan returns");
    assertEquals(pages, 4, "7 episodes at 2 per page is 4 pages (the last empty or partial)");
  });

  test("a short or empty page is not the end of the scan", async (store) => {
    // Two of the four are filtered out by `status`, so a page can return fewer
    // than `limit` — or none — while the scan still has rows left.
    await store.putEpisode(
      makeEpisode({ id: "r1", status: "ready", createdAt: "2026-09-01T00:00:00.000Z" }),
    );
    await store.putEpisode(
      makeEpisode({
        id: "p1",
        status: "pending",
        audioKey: undefined,
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    );
    await store.putEpisode(
      makeEpisode({ id: "r2", status: "ready", createdAt: "2026-09-03T00:00:00.000Z" }),
    );
    await store.putEpisode(
      makeEpisode({
        id: "p2",
        status: "pending",
        audioKey: undefined,
        createdAt: "2026-09-04T00:00:00.000Z",
      }),
    );

    const { seen } = await drainPages(store, { userId: "user-1", status: "ready" }, 1);
    assertEquals(seen, ["r2", "r1"]);
  });

  test("a delete behind the cursor does not skip the next episode", async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.putEpisode(
        makeEpisode({
          id: `e${i}`,
          createdAt: `2026-09-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }
    // Newest first: e4, e3, e2, e1, e0. Delete the first page's only episode,
    // i.e. one BEHIND the cursor, then finish the scan.
    const first = await store.listEpisodePage({ userId: "user-1", limit: 1 });
    assertEquals(first.episodes.map((e) => e.id), ["e4"]);
    assert(first.cursor, "expected a cursor after a full page");
    await store.deleteEpisode("user-1", "e4");

    const rest: string[] = [];
    let cursor = first.cursor;
    for (;;) {
      const page = await store.listEpisodePage({ userId: "user-1", limit: 1, cursor });
      rest.push(...page.episodes.map((e) => e.id));
      if (!page.cursor || page.cursor === cursor) break;
      cursor = page.cursor;
    }
    assertEquals(
      rest,
      ["e3", "e2", "e1", "e0"],
      "deleting a visited episode must not skip a pending one",
    );
  });

  test("never leaks episodes across users", async (store) => {
    await store.putEpisode(makeEpisode({ id: "mine", userId: "user-1" }));
    await store.putEpisode(makeEpisode({ id: "theirs", userId: "user-2" }));

    const mine = await store.listEpisodes({ userId: "user-1" });
    assertEquals(mine.map((e) => e.id), ["mine"]);
    assertEquals(await store.getEpisode("user-1", "theirs"), null);
  });

  test("overwrites an episode in place on status transition", async (store) => {
    const pending = makeEpisode({ id: "e1", status: "pending", audioKey: undefined });
    await store.putEpisode(pending);
    await store.putEpisode({ ...pending, status: "ready", audioKey: "audio/k.mp3" });

    const all = await store.listEpisodes({ userId: "user-1" });
    assertEquals(all.length, 1, "a status update must not duplicate the episode in the index");
    assertEquals(all[0]?.status, "ready");
  });

  test("deletes an episode and removes it from user and pending indexes", async (store) => {
    const ep = makeEpisode({ id: "e1", userId: "user-1", status: "pending", audioKey: undefined });
    await store.putEpisode(ep);
    assertEquals((await store.getEpisode("user-1", "e1"))?.id, "e1");
    assertEquals((await store.listEpisodes({ userId: "user-1" })).length, 1);
    assertEquals((await store.listPendingEpisodes()).episodes.length, 1);

    const deleted = await store.deleteEpisode("user-1", "e1");
    assertEquals(deleted, true);
    assertEquals(await store.getEpisode("user-1", "e1"), null);
    assertEquals((await store.listEpisodes({ userId: "user-1" })).length, 0);
    assertEquals((await store.listPendingEpisodes()).episodes.length, 0);

    // Deleting non-existent episode returns false, does not throw
    const secondDelete = await store.deleteEpisode("user-1", "e1");
    assertEquals(secondDelete, false);
  });

  test("backfillEpisodeSourceTitle backfills sourceTitle and does not resurrect absent episodes (audio-feed-hvn)", async (store) => {
    // 1. Absent episode returns false and does NOT resurrect
    const absentResult = await store.backfillEpisodeSourceTitle("user-1", "non-existent", "Title");
    assertEquals(absentResult, false);
    assertEquals(await store.getEpisode("user-1", "non-existent"), null);

    // 2. Existing episode without sourceTitle is backfilled
    const ep = makeEpisode({ id: "e-backfill", userId: "user-1", sourceTitle: undefined });
    await store.putEpisode(ep);
    assertEquals((await store.getEpisode("user-1", "e-backfill"))?.sourceTitle, undefined);

    const backfilled = await store.backfillEpisodeSourceTitle(
      "user-1",
      "e-backfill",
      "Backfilled Title",
    );
    assertEquals(backfilled, true);
    assertEquals((await store.getEpisode("user-1", "e-backfill"))?.sourceTitle, "Backfilled Title");

    // 3. Repeated call preserves existing sourceTitle
    const repeat = await store.backfillEpisodeSourceTitle(
      "user-1",
      "e-backfill",
      "Different Title",
    );
    assertEquals(repeat, true);
    assertEquals((await store.getEpisode("user-1", "e-backfill"))?.sourceTitle, "Backfilled Title");
  });

  test("updateEpisodeAudioKeyIfCurrent updates audioKey only if expectedKey matches (audio-feed-9731)", async (store) => {
    // 1. Absent episode returns false and does not resurrect
    const absentResult = await store.updateEpisodeAudioKeyIfCurrent(
      "user-1",
      "non-existent",
      "old.mp3",
      "audio/user-1/direct/new.mp3",
    );
    assertEquals(absentResult, false);
    assertEquals(await store.getEpisode("user-1", "non-existent"), null);

    // 2. Existing episode with matching expectedKey updates successfully
    const ep = makeEpisode({
      id: "e-cas",
      userId: "user-1",
      audioKey: "old.mp3",
      title: "Concurrent Title",
    });
    await store.putEpisode(ep);

    const ok = await store.updateEpisodeAudioKeyIfCurrent(
      "user-1",
      "e-cas",
      "old.mp3",
      "audio/user-1/direct/new.mp3",
    );
    assertEquals(ok, true);
    const updated = await store.getEpisode("user-1", "e-cas");
    assertEquals(updated?.audioKey, "audio/user-1/direct/new.mp3");
    assertEquals(updated?.title, "Concurrent Title", "other fields must be preserved");

    // 3. Mismatched expectedKey returns false and preserves current audioKey
    const mismatch = await store.updateEpisodeAudioKeyIfCurrent(
      "user-1",
      "e-cas",
      "old.mp3", // Already updated to audio/user-1/direct/new.mp3
      "audio/user-1/direct/newer.mp3",
    );
    assertEquals(mismatch, false);
    assertEquals(
      (await store.getEpisode("user-1", "e-cas"))?.audioKey,
      "audio/user-1/direct/new.mp3",
    );
  });

  test("returns copies, not live references", async (store) => {
    const episode = makeEpisode({ id: "e1", title: "Original" });
    await store.putEpisode(episode);

    const first = await store.getEpisode("user-1", "e1");
    assert(first);
    first.title = "Mutated";

    assertEquals((await store.getEpisode("user-1", "e1"))?.title, "Original");
  });

  // -- listPendingEpisodes (audio-feed-bbb) ----------------------------------

  test("listPendingEpisodes returns pending episodes oldest first (FIFO)", async (store) => {
    await store.putEpisode(
      makeEpisode({
        id: "mid",
        userId: "u1",
        status: "pending",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    );
    await store.putEpisode(
      makeEpisode({
        id: "newest",
        userId: "u2",
        status: "pending",
        createdAt: "2026-09-03T00:00:00.000Z",
      }),
    );
    await store.putEpisode(
      makeEpisode({
        id: "oldest",
        userId: "u1",
        status: "pending",
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    );

    const { episodes: pending } = await store.listPendingEpisodes();
    assertEquals(pending.map((e) => e.id), ["oldest", "mid", "newest"]);
  });

  test("listPendingEpisodes excludes ready, failed, and actively leased episodes", async (store) => {
    await store.putEpisode(
      makeEpisode({
        id: "p1",
        userId: "u1",
        status: "pending",
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    await store.putEpisode(
      makeEpisode({
        id: "r1",
        userId: "u1",
        status: "ready",
        createdAt: "2026-09-01T01:00:00.000Z",
      }),
    );
    await store.putEpisode(
      makeEpisode({
        id: "f1",
        userId: "u1",
        status: "failed",
        createdAt: "2026-09-01T02:00:00.000Z",
      }),
    );

    // Active claim (not expired)
    await store.putEpisode(
      makeEpisode({
        id: "active",
        userId: "u1",
        status: "synthesizing",
        claimedAt: new Date().toISOString(),
        createdAt: "2026-09-01T03:00:00.000Z",
      }),
    );

    // Stale/expired claim
    await store.putEpisode(
      makeEpisode({
        id: "expired",
        userId: "u1",
        status: "synthesizing",
        claimedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        createdAt: "2026-08-30T00:00:00.000Z",
      }),
    );

    const { episodes: queue } = await store.listPendingEpisodes({ leaseMs: 15 * 60_000 });
    assertEquals(queue.map((e) => e.id), ["expired", "p1"]);
  });

  test("listPendingEpisodes honours limit", async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.putEpisode(
        makeEpisode({
          id: `ep-${i}`,
          userId: "u1",
          status: "pending",
          createdAt: `2026-09-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }
    const { episodes: limited, cursor } = await store.listPendingEpisodes({ limit: 2 });
    assertEquals(limited.map((e) => e.id), ["ep-0", "ep-1"]);
    assert(cursor, "cursor must be returned when more items exist");

    const next = await store.listPendingEpisodes({ cursor, limit: 2 });
    assertEquals(next.episodes.map((e) => e.id), ["ep-2", "ep-3"]);
  });
}
