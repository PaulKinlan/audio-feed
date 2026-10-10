/**
 * Episodes: the queue and its cursor paging, claims, completion, failure and regeneration.
 *
 * Split out of tests/conformance/metadata.ts (audio-feed-fydf). The cases are unchanged: each one
 * was moved here verbatim from the section it already lived in.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { unsynthesized } from "../../../src/types.ts";
import { makeEpisode } from "../../fixtures.ts";
import { drainPages } from "./harness.ts";
import { CLAIM } from "./harness.ts";
import { queued } from "./harness.ts";
import { published } from "./harness.ts";

export function registerEpisodesCases(suite: MetadataHarness) {
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

  test("returns copies, not live references", async (store) => {
    const episode = makeEpisode({ id: "e1", title: "Original" });
    await store.putEpisode(episode);

    const first = await store.getEpisode("user-1", "e1");
    assert(first);
    first.title = "Mutated";

    assertEquals((await store.getEpisode("user-1", "e1"))?.title, "Original");
  });

  // -- claims (audio-feed-vfs / audio-feed-kiq) ---------------------------
  //
  // These are the most important tests in this file. A memory adapter that
  // grants a claim the KV adapter would refuse lets the whole suite pass while
  // production bills twice for the same episode — the exact divergence the
  // conformance suite exists to prevent.

  test("a claim takes ownership and records the lease", async (store) => {
    await store.putEpisode(queued());

    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed, "a pending episode must be claimable");
    assertEquals(claimed.status, "synthesizing");
    assertEquals(claimed.claimedBy, "worker-a");
    assertEquals(claimed.claimedAt, CLAIM.now);
    assertEquals(claimed.attempts, 1);

    // The claim must be persisted, not just returned.
    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "synthesizing");
    assertEquals(stored?.claimedBy, "worker-a");
  });

  test("claiming an unknown episode resolves null, never throws", async (store) => {
    assertEquals(await store.claimEpisode("user-1", "ghost", CLAIM), null);
  });

  test("a live claim is refused", async (store) => {
    await store.putEpisode(queued());
    await store.claimEpisode("user-1", "e1", CLAIM);

    // One second later, inside the 60s lease.
    const second = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-b",
      now: "2026-09-20T12:00:01.000Z",
    });
    assertEquals(second, null, "a held episode must not be claimable");
    assertEquals((await store.getEpisode("user-1", "e1"))?.claimedBy, "worker-a");
  });

  test("CONCURRENT claims produce exactly one winner", async (store) => {
    // The reason this method exists: read-then-write lets both of these through,
    // and both callers then pay a paid API for the same episode.
    await store.putEpisode(queued());

    const results = await Promise.all([
      store.claimEpisode("user-1", "e1", { ...CLAIM, owner: "a" }),
      store.claimEpisode("user-1", "e1", { ...CLAIM, owner: "b" }),
      store.claimEpisode("user-1", "e1", { ...CLAIM, owner: "c" }),
    ]);

    const winners = results.filter((r) => r !== null);
    assertEquals(winners.length, 1, "exactly one worker may claim an episode");
    // And the record agrees with whoever won.
    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.claimedBy, winners[0]?.claimedBy);
    assertEquals(stored?.attempts, 1, "a lost claim must not consume an attempt");
  });

  test("an expired lease is reclaimable", async (store) => {
    await store.putEpisode(queued());
    await store.claimEpisode("user-1", "e1", CLAIM);

    // 61 seconds later: the worker that held this is presumed dead.
    const reclaimed = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-b",
      now: "2026-09-20T12:01:01.000Z",
    });
    assert(reclaimed, "an expired claim must be takeable");
    assertEquals(reclaimed.claimedBy, "worker-b");
    assertEquals(reclaimed.attempts, 2, "a reclaim counts as an attempt");
  });

  test("a synthesizing episode with no claim at all is reclaimable", async (store) => {
    // Every record written before leases existed looks like this, including any
    // episode already stranded in production. Refusing to reclaim them would
    // leave exactly the jobs audio-feed-kiq is about stuck forever.
    await store.putEpisode(queued({ status: "synthesizing" }));

    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed, "a legacy stranded episode must be recoverable");
    assertEquals(claimed.claimedBy, "worker-a");
  });

  test("terminal episodes are never claimable", async (store) => {
    for (const status of ["ready", "failed"] as const) {
      await store.putEpisode(queued({ id: status, status }));
      assertEquals(
        await store.claimEpisode("user-1", status, CLAIM),
        null,
        `a ${status} episode must not be re-claimed`,
      );
    }
  });

  test("the attempt bound abandons a poison job instead of re-billing it", async (store) => {
    await store.putEpisode(queued());

    // Three claims are allowed; each expires without a terminal write, exactly
    // as an input that kills its host would behave.
    for (let i = 1; i <= 3; i++) {
      const claimed = await store.claimEpisode("user-1", "e1", {
        ...CLAIM,
        now: `2026-09-20T12:0${i - 1}:00.000Z`,
      });
      assert(claimed, `claim ${i} should be granted`);
      assertEquals(claimed.attempts, i);
    }

    const fourth = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      now: "2026-09-20T12:10:00.000Z",
    });
    assertEquals(fourth, null, "a job out of attempts must not be claimed again");

    // Abandoned visibly, not left looping.
    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "failed");
    assert(stored?.error?.includes("attempts"), `expected a readable reason, got ${stored?.error}`);
  });

  test("abandonment preserves the last recorded cause (audio-feed-bp6r)", async (store) => {
    // The 2026-10-09 incident: nine live episodes showed only "abandoned after 3
    // attempts". When a claim managed to record a cause, abandonment must not
    // overwrite it.
    await store.putEpisode(queued());
    for (const minute of ["00", "01", "02"]) {
      const claimed = await store.claimEpisode("user-1", "e1", {
        ...CLAIM,
        now: `2026-09-20T12:${minute}:00.000Z`,
      });
      assert(claimed, `claim at 12:${minute} should be granted`);
    }
    // The last claim's worker got as far as recording the failure before dying.
    const current = await store.getEpisode("user-1", "e1");
    await store.putEpisode({
      ...current!,
      error:
        "TTS turn failed; refusing whole-episode retry: Gemini TTS request timed out after 60000ms",
    });

    const fourth = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      now: "2026-09-20T12:10:00.000Z",
    });
    assertEquals(fourth, null, "out of claims is out of claims");

    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "failed");
    assert(stored?.error?.includes("abandoned after 3 attempts"), stored?.error);
    assert(
      stored?.error?.includes("timed out after 60000ms"),
      `the recorded cause must survive abandonment, got ${stored?.error}`,
    );
  });

  test("abandonment with no recorded cause says the claims died before writing (audio-feed-bp6r)", async (store) => {
    // The other half of the incident: claims that never wrote a result. The abandoned
    // record must say THAT — it distinguishes "the provider rejected us" from "our
    // worker vanished".
    await store.putEpisode(queued());
    for (const minute of ["00", "01", "02"]) {
      assert(
        await store.claimEpisode("user-1", "e1", {
          ...CLAIM,
          now: `2026-09-20T12:${minute}:00.000Z`,
        }),
        `claim at 12:${minute} should be granted`,
      );
    }
    assertEquals(
      await store.claimEpisode("user-1", "e1", { ...CLAIM, now: "2026-09-20T12:10:00.000Z" }),
      null,
    );

    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "failed");
    assert(stored?.error?.includes("abandoned after 3 attempts"), stored?.error);
    assert(stored?.error?.includes("no claim recorded a cause"), stored?.error);
    assert(stored?.error?.includes("last claim by worker-a at"), stored?.error);
  });

  // -- completeEpisode ----------------------------------------------------

  test("the claim owner may write the terminal state", async (store) => {
    await store.putEpisode(queued());
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);

    const wrote = await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
      "worker-a",
    );
    assertEquals(wrote, true);
    assertEquals((await store.getEpisode("user-1", "e1"))?.status, "ready");
  });

  test("a superseded worker cannot overwrite the winner's result", async (store) => {
    await store.putEpisode(queued());
    const first = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(first);

    // The lease expires and worker-b takes over and finishes.
    const second = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-b",
      now: "2026-09-20T12:01:01.000Z",
    });
    assert(second);
    await store.completeEpisode(
      { ...second, status: "ready", audioKey: "winner.wav", contentType: "audio/wav" },
      "worker-b",
    );

    // worker-a now finishes its slow synthesis. It must not win.
    const late = await store.completeEpisode(
      { ...first, status: "ready", audioKey: "loser.wav", contentType: "audio/wav" },
      "worker-a",
    );
    assertEquals(late, false, "a lost claim must not write a terminal state");
    assertEquals(
      (await store.getEpisode("user-1", "e1"))?.audioKey,
      "winner.wav",
      "the superseding worker's result must survive",
    );
  });

  test("completing an episode nobody claimed is refused", async (store) => {
    await store.putEpisode(queued());
    const wrote = await store.completeEpisode(
      { ...queued(), status: "ready", audioKey: "k.wav" },
      "worker-a",
    );
    assertEquals(wrote, false, "a terminal write requires an owned claim");
    assertEquals((await store.getEpisode("user-1", "e1"))?.status, "pending");
  });

  test("a completed episode leaves the feed indexes consistent", async (store) => {
    await store.putEpisode(queued());
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);
    await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
      "worker-a",
    );

    // Claim and complete both rewrite the record; neither may duplicate it.
    const all = await store.listEpisodes({ userId: "user-1" });
    assertEquals(all.length, 1, "claim + complete must not duplicate the index entry");
    assertEquals(all[0]?.status, "ready");
  });

  // -- regeneration (audio-feed-8oz) -------------------------------------------
  //
  // Regenerating reuses the pending -> synthesizing claim path, so the lease, the
  // owner check and the approval gate apply unchanged. What it adds is that the
  // episode keeps its OLD audio, and stays publishable on it, until new audio
  // lands - including when the regeneration fails, is abandoned, or is cancelled.

  // ── queue priority (audio-feed-15e) ──────────────────────────────────────
  //
  // Pinned in the CONFORMANCE suite rather than in a worker test, because the ordering is a
  // property of the queue: if one adapter served regenerations first, the worker would look
  // correct in tests and starve new articles in production, which is the exact failure this
  // suite exists to prevent.

  test("new work is listed ahead of a backlog of regenerations, and each group stays FIFO (audio-feed-15e)", async (store) => {
    // Three OLD episodes, published then requeued: the real regenerate path, so the flag and
    // the original createdAt are set by production code rather than by this test.
    for (const day of ["01", "02", "03"]) {
      await store.putEpisode(makeEpisode({
        id: `old-${day}`,
        userId: "user-1",
        status: "ready",
        createdAt: `2026-09-${day}T00:00:00.000Z`,
      }));
      assert(await store.requeueEpisode("user-1", `old-${day}`));
    }
    // One genuinely new article, queued after all of them.
    await store.putEpisode(makeEpisode({
      id: "fresh",
      userId: "user-1",
      status: "pending",
      audioKey: undefined,
      createdAt: "2026-09-20T00:00:00.000Z",
    }));

    const ids = (await store.listPendingEpisodes({ limit: 10 })).episodes.map((e) => e.id);
    assertEquals(
      ids[0],
      "fresh",
      `the never-heard article must be first, queue was [${ids}]`,
    );
    assertEquals(
      ids,
      ["fresh", "old-01", "old-02", "old-03"],
      "regenerations follow, still oldest-first among themselves",
    );
  });

  test("regenerations are still served when there is no new work (audio-feed-15e)", async (store) => {
    for (const day of ["01", "02"]) {
      await store.putEpisode(makeEpisode({
        id: `old-${day}`,
        userId: "user-1",
        status: "ready",
        createdAt: `2026-09-${day}T00:00:00.000Z`,
      }));
      await store.requeueEpisode("user-1", `old-${day}`);
    }
    const ids = (await store.listPendingEpisodes({ limit: 10 })).episodes.map((e) => e.id);
    assertEquals(ids, ["old-01", "old-02"], "priority must not become starvation");
  });

  test("an episode holds exactly one queue pointer across a requeue and a cancel (audio-feed-15e)", async (store) => {
    await store.putEpisode(makeEpisode({
      id: "e1",
      userId: "user-1",
      status: "ready",
      createdAt: "2026-09-01T00:00:00.000Z",
    }));
    // Each transition moves the pointer between priority segments. A leak in either direction
    // is not cosmetic: two pointers means the same episode can be claimed twice in one tick
    // and billed twice, and no pointer means it never synthesises at all.
    await store.requeueEpisode("user-1", "e1");
    const queued = (await store.listPendingEpisodes({ limit: 10 })).episodes;
    assertEquals(queued.map((e) => e.id), ["e1"], "requeued: exactly one pointer");
    assertEquals(queued[0]!.regenerating, true, "and it is the regeneration that is queued");

    // Cancelling returns the episode to `ready` — it still has playable audio — so it leaves the
    // queue entirely. What must not survive is a pointer: a leftover in either priority segment
    // would have the worker claim an episode nobody asked about, and bill it.
    assert(await store.cancelRegeneration("user-1", "e1"));
    assertEquals(
      (await store.listPendingEpisodes({ limit: 10 })).episodes.map((e) => e.id),
      [],
      "a cancelled regeneration must leave no queue pointer",
    );
    assertEquals((await store.getEpisode("user-1", "e1"))?.status, "ready");
  });

  // ── retrying a failed episode (audio-feed-7s2) ───────────────────────────
  //
  // A failed episode is terminal today: the player lists playable episodes only, so the
  // subscriber sees nothing and has no way to try again. These cases pin the transition the
  // UI depends on for BOTH adapters — a retry that behaved differently between memory and KV
  // would look fine in tests and strand real episodes in production.

  test("retryEpisode re-queues a FAILED episode with a fresh claim budget (audio-feed-7s2)", async (store) => {
    await store.putEpisode(makeEpisode({
      id: "e1",
      userId: "user-1",
      status: "failed",
      error: "TTS upstream returned 503",
      attempts: 3,
      audioKey: undefined,
    }));

    const retried = await store.retryEpisode("user-1", "e1");
    assert(retried, "a failed episode must be retryable");
    assertEquals(retried.status, "pending", "it goes back into the queue");
    assertEquals(retried.error, undefined, "the old failure reason must not follow it in");
    assertEquals(retried.attempts, undefined, "a manual retry is not the next automatic attempt");
    assert(!retried.regenerating, "a failed episode has no old audio to keep playing");

    const queued = (await store.listPendingEpisodes({ limit: 10 })).episodes;
    assertEquals(queued.map((e) => e.id), ["e1"], "and it is queued exactly once");
  });

  test("retryEpisode touches nothing it should not, and stays idempotent (audio-feed-7s2)", async (store) => {
    await store.putEpisode(makeEpisode({
      id: "ready-1",
      userId: "user-1",
      status: "ready",
      audioKey: "audio/user-1/direct/ready-1.wav",
      contentType: "audio/wav",
    }));
    await store.putEpisode(makeEpisode({
      id: "pending-1",
      userId: "user-1",
      status: "pending",
      audioKey: undefined,
    }));

    // A ready episode is requeueEpisode's job, not retryEpisode's: the two transitions have
    // different preconditions and different audio semantics, and one method accepting both
    // would quietly drop the old audio out of the feed.
    assertEquals(await store.retryEpisode("user-1", "ready-1"), null);
    assertEquals((await store.getEpisode("user-1", "ready-1"))?.status, "ready");
    // Already queued: nothing to do, and no second pointer.
    assertEquals(await store.retryEpisode("user-1", "pending-1"), null);
    assertEquals((await store.listPendingEpisodes({ limit: 10 })).episodes.length, 1);
    // No such episode.
    assertEquals(await store.retryEpisode("user-1", "ghost"), null);
    // Another user's failed episode is not this user's to retry.
    await store.putEpisode(
      makeEpisode({ id: "e2", userId: "user-2", status: "failed", error: "x" }),
    );
    assertEquals(await store.retryEpisode("user-1", "e2"), null);
    assertEquals((await store.getEpisode("user-2", "e2"))?.status, "failed");
  });

  test("a retried episode survives a second failure and can be retried again (audio-feed-7s2)", async (store) => {
    await store.putEpisode(
      makeEpisode({ id: "e1", userId: "user-1", status: "failed", error: "boom" }),
    );
    assert(await store.retryEpisode("user-1", "e1"));
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed, "a retried episode must be claimable by the worker");
    assertEquals(claimed.attempts, 1, "the budget restarts rather than continuing the old one");
    await store.completeEpisode(unsynthesized(claimed, "boom again"), "worker-a");
    assertEquals((await store.getEpisode("user-1", "e1"))?.status, "failed");
    assert(await store.retryEpisode("user-1", "e1"), "and it can be retried again");
  });

  test("requeueEpisode queues a ready episode and keeps its old audio (audio-feed-8oz)", async (store) => {
    await store.putEpisode(published({ attempts: 3, promptVersion: "old-prompts" }));

    const queued = await store.requeueEpisode("user-1", "e1");
    assert(queued, "a ready episode must be requeueable");
    assertEquals(queued.status, "pending");
    assertEquals(queued.regenerating, true);
    assertEquals(queued.audioKey, "audio/user-1/direct/e1.wav", "the old audio stays");
    assertEquals(queued.id, "e1", "the episode keeps its id, and so its GUID");

    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "pending");
    assertEquals(stored?.regenerating, true);
    assertEquals(stored?.contentType, "audio/wav");

    // On the worker's queue, with a fresh claim budget: the attempts that made the
    // old audio must not count against the new synthesis.
    const pending = await store.listPendingEpisodes({ limit: 10 });
    assertEquals(pending.episodes.map((e) => e.id), ["e1"]);
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed, "a requeued episode must be claimable");
    assertEquals(claimed.attempts, 1);
    assertEquals(claimed.audioKey, "audio/user-1/direct/e1.wav");
  });

  test("requeueEpisode is idempotent and only takes ready episodes (audio-feed-8oz)", async (store) => {
    await store.putEpisode(published());
    assert(await store.requeueEpisode("user-1", "e1"));
    assertEquals(
      await store.requeueEpisode("user-1", "e1"),
      null,
      "regenerating an episode that is already queued changes nothing",
    );
    assertEquals((await store.listPendingEpisodes({ limit: 10 })).episodes.length, 1);

    // In synthesis: a requeue must not reset a live claim.
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);
    assertEquals(await store.requeueEpisode("user-1", "e1"), null);
    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "synthesizing");
    assertEquals(stored?.claimedBy, "worker-a");

    // Nothing to regenerate: no audio yet, a failure, or no episode at all.
    await store.putEpisode(queued({ id: "e2" }));
    await store.putEpisode(makeEpisode({ id: "e3", status: "failed", audioKey: undefined }));
    assertEquals(await store.requeueEpisode("user-1", "e2"), null);
    assertEquals(await store.requeueEpisode("user-1", "e3"), null);
    assertEquals(await store.requeueEpisode("user-1", "ghost"), null);
    assertEquals((await store.getEpisode("user-1", "e3"))?.status, "failed");
  });

  test("cancelRegeneration restores the ready episode on its old audio (audio-feed-8oz)", async (store) => {
    await store.putEpisode(published());
    assert(await store.requeueEpisode("user-1", "e1"));
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);

    assertEquals(await store.cancelRegeneration("user-1", "e1"), true);
    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "ready");
    assert(!stored?.regenerating, "a cancelled regeneration is no longer regenerating");
    assertEquals(stored?.audioKey, "audio/user-1/direct/e1.wav");
    assertEquals((await store.listPendingEpisodes({ limit: 10 })).episodes, []);

    // The worker that held the claim finishes late: its result must be refused.
    const late = await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "audio/user-1/direct/e1-new.wav" },
      "worker-a",
    );
    assertEquals(late, false);
    assertEquals((await store.getEpisode("user-1", "e1"))?.audioKey, "audio/user-1/direct/e1.wav");

    // A first synthesis is not a regeneration; cancelling it is refused.
    await store.putEpisode(queued({ id: "e2" }));
    assertEquals(await store.cancelRegeneration("user-1", "e2"), false);
    assertEquals((await store.getEpisode("user-1", "e2"))?.status, "pending");
  });

  test("an abandoned regeneration keeps the old audio rather than failing (audio-feed-8oz)", async (store) => {
    await store.putEpisode(published());
    assert(await store.requeueEpisode("user-1", "e1"));
    for (let i = 1; i <= 3; i++) {
      assert(
        await store.claimEpisode("user-1", "e1", {
          ...CLAIM,
          now: `2026-09-20T12:0${i - 1}:00.000Z`,
        }),
      );
    }
    const fourth = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      now: "2026-09-20T12:10:00.000Z",
    });
    assertEquals(fourth, null, "out of claims is out of claims, regeneration or not");

    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "ready", "the episode was playable before and must stay playable");
    assertEquals(stored?.audioKey, "audio/user-1/direct/e1.wav");
    assert(!stored?.regenerating);
    assert(stored?.error?.includes("attempts"), `expected a readable reason, got ${stored?.error}`);
    assertEquals((await store.listPendingEpisodes({ limit: 10 })).episodes, []);
  });

  test("orphan blobs are recorded once, listed up to a limit, and forgotten (audio-feed-8oz)", async (store) => {
    assertEquals(await store.listOrphanBlobs(10), []);
    await store.recordOrphanBlob("audio/user-1/direct/e1.wav");
    await store.recordOrphanBlob("audio/user-1/direct/e1.wav");
    await store.recordOrphanBlob("audio/user-1/direct/e2.wav");
    await store.recordOrphanBlob("audio/user-1/direct/e3.wav");

    const all = await store.listOrphanBlobs(10);
    assertEquals([...all].sort(), [
      "audio/user-1/direct/e1.wav",
      "audio/user-1/direct/e2.wav",
      "audio/user-1/direct/e3.wav",
    ]);
    assertEquals((await store.listOrphanBlobs(2)).length, 2);

    await store.forgetOrphanBlob("audio/user-1/direct/e2.wav");
    await store.forgetOrphanBlob("never-recorded");
    assertEquals((await store.listOrphanBlobs(10)).sort(), [
      "audio/user-1/direct/e1.wav",
      "audio/user-1/direct/e3.wav",
    ]);
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
