/**
 * Regeneration: re-rendering an episode the subscriber can already play, including the
 * paid-work accounting that makes a retry safe.
 *
 * Split out of tests/conformance/metadata/episodes.ts (audio-feed-b75q): the cases moved verbatim
 * from the sections that already grouped them, and no case body was edited.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { unsynthesized } from "../../../src/types.ts";
import { makeEpisode } from "../../fixtures.ts";
import { CLAIM } from "./harness.ts";
import { queued } from "./harness.ts";
import { published } from "./harness.ts";

export function registerEpisodesRegenerationCases(suite: MetadataHarness) {
  const { test } = suite;

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
      { byteLength: 500 },
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
}
