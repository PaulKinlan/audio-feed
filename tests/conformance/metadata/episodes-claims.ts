/**
 * Claims and leases: exactly one worker may hold an episode, the lease expires if it dies,
 * and completion is the claim's other half.
 *
 * Split out of tests/conformance/metadata/episodes.ts (audio-feed-b75q): the cases moved verbatim
 * from the sections that already grouped them, and no case body was edited.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { unsynthesized } from "../../../src/types.ts";
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
    assert(stored?.error?.includes("lease expired without terminal write"), stored?.error);
    assert(!stored?.error?.includes("died"), "must not assert death when only lease expired");
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
    assert(stored?.error?.includes("lease expired without terminal write"), stored?.error);
    assert(!stored?.error?.includes("died"), "must not assert death when only lease expired");
    assert(stored?.error?.includes("worker-a"), stored?.error);
    assert(stored?.error?.includes("worker-b"), stored?.error);
    assert(stored?.error?.includes("worker-c"), stored?.error);
  });

  test("live heartbeat near lease expiry is reported as lease expiry, not worker death (audio-feed-kd5r)", async (store) => {
    await store.putEpisode(queued());

    // Claim at 14:00:00Z with 15-minute lease (900000ms)
    const claim1 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-live",
      now: "2026-10-11T14:00:00.000Z",
    });
    assert(claim1);

    // Active heartbeat 1 second before lease expiry at 14:14:59Z
    const touched = await store.touchEpisodeClaim("user-1", "e1", "worker-live", {
      phase: "synthesizing_segment_2_of_4",
      now: "2026-10-11T14:14:59.000Z",
    });
    assertEquals(touched, true, "live worker successfully heartbeats before expiry");

    // At 14:15:00Z, lease expires and another worker claims
    const claim2 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-other",
      now: "2026-10-11T14:15:00.000Z",
    });
    assert(claim2);
    assertEquals(claim2.attempts, 2);

    // Assert recorded cause reports observed facts: lease expiry, last heartbeat, last phase
    // MUST NOT assert death
    const err = claim2.error ?? "";
    assert(err.includes("lease expired without terminal write"), err);
    assert(err.includes('phase "synthesizing_segment_2_of_4"'), err);
    assert(err.includes("last heartbeat 2026-10-11T14:14:59.000Z"), err);
    assert(err.includes("worker state unknown"), err);
    assert(!err.includes("died"), "must not assert worker death for active heartbeat");
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
      { byteLength: 500 },
    );
    assertEquals(
      await store.touchEpisodeClaim("user-1", "e1", "worker-a", { phase: "post-finish" }),
      false,
    );
  });

  test("yieldEpisodeClaim transitions synthesizing claim back to pending with attempts 0 (audio-feed-vqu4)", async (store) => {
    await store.putEpisode(queued());

    // Non-synthesizing / non-owner rejects yield
    assertEquals(
      await store.yieldEpisodeClaim("user-1", "e1", "worker-a"),
      false,
    );

    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);
    assertEquals(claimed.attempts, 1);

    // Another worker cannot yield
    assertEquals(
      await store.yieldEpisodeClaim("user-1", "e1", "worker-impostor"),
      false,
    );

    // Owner yields cleanly with updated phase
    const ok = await store.yieldEpisodeClaim("user-1", "e1", CLAIM.owner, {
      phase: "synthesized_2_of_6",
      now: "2026-10-11T16:00:00.000Z",
    });
    assertEquals(ok, true);

    const yielded = await store.getEpisode("user-1", "e1");
    assert(yielded);
    assertEquals(yielded.status, "pending");
    assertEquals(yielded.claimedAt, undefined);
    assertEquals(yielded.claimedBy, undefined);
    assertEquals(yielded.phase, "synthesized_2_of_6");
    assertEquals(yielded.lastHeartbeat, "2026-10-11T16:00:00.000Z");
    assertEquals(
      yielded.attempts,
      0,
      "clean yield resets attempts so multi-tick progression never trips poison limit",
    );

    // Can be immediately re-claimed by the next tick/worker
    const reclaimed = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-next-tick",
      now: "2026-10-11T16:02:00.000Z",
    });
    assert(reclaimed);
    assertEquals(reclaimed.status, "synthesizing");
    assertEquals(reclaimed.claimedBy, "worker-next-tick");
    assertEquals(reclaimed.attempts, 1);
  });

  test("yieldEpisodeClaim persists uploadRetry counter and preserves across claims (audio-feed-lqd6)", async (store) => {
    await store.putEpisode(queued());

    const claimed1 = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed1);
    assertEquals(claimed1.uploadRetry, undefined);

    // Yield with explicit uploadRetry: 1
    const ok1 = await store.yieldEpisodeClaim("user-1", "e1", CLAIM.owner, {
      phase: "upload_retry",
      uploadRetry: 1,
      now: "2026-10-11T16:00:00.000Z",
    });
    assertEquals(ok1, true);

    const ep1 = await store.getEpisode("user-1", "e1");
    assert(ep1);
    assertEquals(ep1.status, "pending");
    assertEquals(ep1.uploadRetry, 1);
    assertEquals(ep1.attempts, 0, "upload_retry resets attempts to 0");

    // Reclaim preserves uploadRetry counter
    const claimed2 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-tick-2",
      now: "2026-10-11T16:02:00.000Z",
    });
    assert(claimed2);
    assertEquals(claimed2.status, "synthesizing");
    assertEquals(claimed2.uploadRetry, 1);
    assertEquals(claimed2.attempts, 1);

    // Yield with incrementUploadRetry: true
    const ok2 = await store.yieldEpisodeClaim("user-1", "e1", "worker-tick-2", {
      phase: "upload_retry",
      incrementUploadRetry: true,
      now: "2026-10-11T16:04:00.000Z",
    });
    assertEquals(ok2, true);

    const ep2 = await store.getEpisode("user-1", "e1");
    assert(ep2);
    assertEquals(ep2.uploadRetry, 2);

    // Reclaim again, complete as failed
    const claimed3 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-tick-3",
      now: "2026-10-11T16:06:00.000Z",
    });
    assert(claimed3);
    assertEquals(claimed3.uploadRetry, 2);

    await store.completeEpisode(
      { ...claimed3, status: "failed", error: "terminal failure test" },
      "worker-tick-3",
    );
    const failedEp = await store.getEpisode("user-1", "e1");
    assert(failedEp);
    assertEquals(failedEp.status, "failed");
    assertEquals(failedEp.uploadRetry, 2);

    // retryEpisode clears uploadRetry for a fresh start
    const retried = await store.retryEpisode("user-1", "e1");
    assert(retried);
    assertEquals(retried.status, "pending");
    assertEquals(retried.uploadRetry, undefined);

    const epAfterRetry = await store.getEpisode("user-1", "e1");
    assert(epAfterRetry);
    assertEquals(epAfterRetry.uploadRetry, undefined);

    // completeEpisode ready, then requeueEpisode clears uploadRetry (audio-feed-lqd6)
    const claimed4 = await store.claimEpisode("user-1", "e1", {
      ...CLAIM,
      owner: "worker-tick-4",
      now: "2026-10-11T16:10:00.000Z",
    });
    assert(claimed4);
    await store.completeEpisode(
      {
        ...claimed4,
        status: "ready",
        audioKey: "audio/test.wav",
        contentType: "audio/wav",
        uploadRetry: 2,
      },
      "worker-tick-4",
      { byteLength: 100 },
    );
    const requeued = await store.requeueEpisode("user-1", "e1");
    assert(requeued);
    assertEquals(requeued.status, "pending");
    assertEquals(requeued.uploadRetry, undefined);

    const epAfterRequeue = await store.getEpisode("user-1", "e1");
    assert(epAfterRequeue);
    assertEquals(epAfterRequeue.uploadRetry, undefined);
  });

  // -- completeEpisode ----------------------------------------------------

  test("the claim owner may write the terminal state", async (store) => {
    await store.putEpisode(queued());
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);

    const wrote = await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
      "worker-a",
      { byteLength: 500 },
    );
    assertEquals(wrote, true);
    assertEquals((await store.getEpisode("user-1", "e1"))?.status, "ready");

    // Idempotent retry with same audioKey succeeds (audio-feed-siv1)
    const idempotent = await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
      "worker-a",
      { byteLength: 500 },
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
      { byteLength: 500 },
    );

    // worker-a now finishes its slow synthesis. It must not win.
    const late = await store.completeEpisode(
      { ...first, status: "ready", audioKey: "loser.wav", contentType: "audio/wav" },
      "worker-a",
      { byteLength: 500 },
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
      { byteLength: 500 },
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
      { byteLength: 500 },
    );

    // Claim and complete both rewrite the record; neither may duplicate it.
    const all = await store.listEpisodes({ userId: "user-1" });
    assertEquals(all.length, 1, "claim + complete must not duplicate the index entry");
    assertEquals(all[0]?.status, "ready");
  });

  test("completeEpisode with status ready requires billing payload (audio-feed-9gqs)", async (store) => {
    await store.putEpisode(queued());
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);

    let threw = false;
    try {
      // @ts-expect-error missing billing payload must be refused by type and runtime
      await store.completeEpisode(
        { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
        "worker-a",
      );
    } catch (err) {
      threw = true;
      assert(err instanceof TypeError);
    }
    assertEquals(threw, true, "ready transition without billing must throw TypeError");
    assertEquals((await store.getEpisode("user-1", "e1"))?.status, "synthesizing");
  });

  test("completeEpisode with status ready validates billing byteLength as a non-negative integer (audio-feed-do6b)", async (store) => {
    await store.putEpisode(queued());
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);

    const invalidByteLengths = [
      Number.NaN,
      -5000,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      12.5,
    ];
    for (const invalid of invalidByteLengths) {
      let threw = false;
      try {
        await store.completeEpisode(
          { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
          "worker-a",
          { byteLength: invalid },
        );
      } catch (err) {
        threw = true;
        assert(err instanceof TypeError, `byteLength ${invalid} must throw TypeError`);
      }
      assertEquals(threw, true, `byteLength ${invalid} must be rejected`);
      assertEquals((await store.getEpisode("user-1", "e1"))?.status, "synthesizing");
    }

    const today = new Date().toISOString().slice(0, 10);
    const counts = await store.getSynthesisCounts(today);
    assertEquals(counts.total, 0, "rejected completions must not increment synthesis count");
    assertEquals(counts.totalBytes, 0, "rejected completions must not corrupt total bytes");
  });

  test("completeEpisode ready+error carve-out verifies durable audioKey and refuses unbilled new audio (audio-feed-pr5v)", async (store) => {
    await store.putEpisode(queued());
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);

    // 1. Caller attaches error string but supplies a NEW audioKey without billing: must throw TypeError
    let threw = false;
    try {
      // @ts-expect-error unbilled ready must be refused by type and runtime
      await store.completeEpisode(
        {
          ...claimed,
          status: "ready",
          audioKey: "brand-new-unbilled.wav",
          contentType: "audio/wav",
          error: "i-claim-restore",
        },
        "worker-a",
      );
    } catch (err) {
      threw = true;
      assert(err instanceof TypeError);
    }
    assertEquals(
      threw,
      true,
      "ready transition with new audioKey must require billing even if error is set",
    );
    assertEquals((await store.getEpisode("user-1", "e1"))?.status, "synthesizing");

    // 2. Genuine restore: episode was ready with existing audioKey, requeued/regenerating, then fails synthesis.
    // Completing with the SAME existing audioKey and error is allowed without billing.
    await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "existing-audio.wav", contentType: "audio/wav" },
      "worker-a",
      { byteLength: 500 },
    );
    const requeued = await store.requeueEpisode("user-1", "e1");
    assert(requeued);
    const regenClaim = await store.claimEpisode("user-1", "e1", { ...CLAIM, owner: "worker-b" });
    assert(regenClaim);
    assertEquals(regenClaim.audioKey, "existing-audio.wav");

    const today = new Date().toISOString().slice(0, 10);
    const countBeforeRestore = await store.getDailySynthesisCount(today);

    const restoredPayload = unsynthesized(regenClaim, "synthesis failed, restoring old audio");
    assertEquals(restoredPayload.status, "ready");
    assertEquals(restoredPayload.audioKey, "existing-audio.wav");

    const restored = await store.completeEpisode(
      restoredPayload,
      "worker-b",
    );
    assertEquals(
      restored,
      true,
      "genuine restore of durable audioKey must succeed without billing",
    );
    const epAfterRestore = await store.getEpisode("user-1", "e1");
    assertEquals(epAfterRestore?.status, "ready");
    assertEquals(epAfterRestore?.audioKey, "existing-audio.wav");
    assertEquals(epAfterRestore?.error, "synthesis failed, restoring old audio");

    const countAfterRestore = await store.getDailySynthesisCount(today);
    assertEquals(
      countAfterRestore,
      countBeforeRestore,
      "restore must not charge or increment daily synthesis count",
    );
  });

  test("completeEpisode with status ready atomically updates spend and replay does not double charge (audio-feed-thrs, audio-feed-a7i9)", async (store) => {
    await store.putEpisode(queued());
    const claimed = await store.claimEpisode("user-1", "e1", CLAIM);
    assert(claimed);

    const today = new Date().toISOString().slice(0, 10);
    const initialCount = await store.getDailySynthesisCount(today);
    assertEquals(initialCount, 0, "initial daily count zero");

    // 1. Ready transition atomically increments spend
    const wrote = await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
      "worker-a",
      { byteLength: 500 },
    );
    assertEquals(wrote, true);
    assertEquals((await store.getEpisode("user-1", "e1"))?.status, "ready");

    const countAfter = await store.getDailySynthesisCount(today);
    assertEquals(countAfter, 1, "daily count incremented on ready transition");

    // 2. Idempotent replay succeeds but NEVER double-charges (audio-feed-mkkb)
    const idempotent = await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "e1.wav", contentType: "audio/wav" },
      "worker-a",
      { byteLength: 500 },
    );
    assertEquals(idempotent, true);

    const countAfterReplay = await store.getDailySynthesisCount(today);
    assertEquals(countAfterReplay, 1, "replay must not double charge");
  });
}
