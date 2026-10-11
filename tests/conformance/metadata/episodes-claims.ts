/**
 * Claims and leases: exactly one worker may hold an episode, the lease expires if it dies,
 * and completion is the claim's other half.
 *
 * Split out of tests/conformance/metadata/episodes.ts (audio-feed-b75q): the cases moved verbatim
 * from the sections that already grouped them, and no case body was edited.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { CLAIM } from "./harness.ts";
import { queued } from "./harness.ts";

export function registerEpisodesClaimsCases(suite: MetadataHarness) {
  const { test } = suite;

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
    assert(stored?.error?.includes("died before terminal write"), stored?.error);
    assert(stored?.error?.includes("worker-a"), stored?.error);
  });

  test("abandonment records worker execution phase and last heartbeat (audio-feed-siv1)", async (store) => {
    await store.putEpisode(queued());

    // Attempt 1: gets as far as synthesizing segment 1 before dying
    const c1 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      now: "2026-09-20T12:00:00.000Z",
    });
    assert(c1);
    await store.touchEpisodeClaim("user-1", "e1", "worker-a", {
      phase: "synthesizing_segment_1_of_4",
      now: "2026-09-20T12:00:15.000Z",
    });

    // Attempt 2: lease expires, second worker advances to segment 2 before dying
    const c2 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-b",
      now: "2026-09-20T12:15:00.000Z",
    });
    assert(c2);
    await store.touchEpisodeClaim("user-1", "e1", "worker-b", {
      phase: "synthesizing_segment_2_of_4",
      now: "2026-09-20T12:15:30.000Z",
    });

    // Attempt 3: lease expires, third worker gets to uploading_audio before dying
    const c3 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-c",
      now: "2026-09-20T12:30:00.000Z",
    });
    assert(c3);
    await store.touchEpisodeClaim("user-1", "e1", "worker-c", {
      phase: "uploading_audio",
      now: "2026-09-20T12:30:45.000Z",
    });

    // 4th claim: out of attempts, abandoned
    const c4 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      now: "2026-09-20T12:45:00.000Z",
    });
    assertEquals(c4, null);

    const stored = await store.getEpisode("user-1", "e1");
    assertEquals(stored?.status, "failed");
    assertEquals(stored?.phase, "uploading_audio");
    assert(stored?.error?.includes("abandoned after 3 attempts"), stored?.error);
    assert(stored?.error?.includes('in phase "uploading_audio"'), stored?.error);
    assert(stored?.error?.includes("synthesizing_segment_1_of_4"), stored?.error);
    assert(stored?.error?.includes("synthesizing_segment_2_of_4"), stored?.error);
    assert(stored?.error?.includes("worker-a"), stored?.error);
    assert(stored?.error?.includes("worker-b"), stored?.error);
    assert(stored?.error?.includes("worker-c"), stored?.error);
  });

  test("touchEpisodeClaim rejects non-owner or non-synthesizing caller (audio-feed-siv1)", async (store) => {
    await store.putEpisode(queued());

    // Pending: cannot touch
    assertEquals(
      await store.touchEpisodeClaim("user-1", "e1", "worker-a", { phase: "reading" }),
      false,
    );

    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);

    // Wrong owner
    assertEquals(
      await store.touchEpisodeClaim("user-1", "e1", "worker-other", { phase: "reading" }),
      false,
    );

    // Right owner
    assertEquals(
      await store.touchEpisodeClaim("user-1", "e1", "worker-a", {
        phase: "reading",
        now: "2026-09-20T12:00:05.000Z",
      }),
      true,
    );
    const updated = await store.getEpisode("user-1", "e1");
    assertEquals(updated?.phase, "reading");
    assertEquals(updated?.lastHeartbeat, "2026-09-20T12:00:05.000Z");

    // Complete it: now terminal, cannot touch
    await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
      "worker-a",
    );
    assertEquals(
      await store.touchEpisodeClaim("user-1", "e1", "worker-a", { phase: "post-finish" }),
      false,
    );
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

    // Idempotent retry with same audioKey succeeds (audio-feed-siv1)
    const idempotent = await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
      "worker-a",
    );
    assertEquals(idempotent, true);
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
}
