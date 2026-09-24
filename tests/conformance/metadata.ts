/**
 * Conformance suite for `MetadataStore`.
 *
 * Every adapter must pass this identically. If an adapter needs a carve-out,
 * the interface is wrong — fix the interface, do not weaken the suite.
 *
 * Owned by: audio-feed-0h8.
 */

import { assert, assertEquals } from "@std/assert";
import type { MetadataStore } from "../../src/storage/mod.ts";
import type { Episode } from "../../src/types.ts";
import { makeApproval, makeArticle, makeEpisode, makeSource, makeUser } from "../fixtures.ts";

export interface MetadataSuiteOptions {
  name: string;
  /** Fresh, empty store per test. */
  create: () => Promise<MetadataStore> | MetadataStore;
}

export function runMetadataConformance({ name, create }: MetadataSuiteOptions) {
  const test = (label: string, fn: (store: MetadataStore) => Promise<void>) => {
    Deno.test(`${name}: ${label}`, async () => {
      const store = await create();
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    });
  };

  // -- users ----------------------------------------------------------------

  test("round-trips a user", async (store) => {
    const user = makeUser();
    await store.putUser(user);
    assertEquals(await store.getUser(user.id), user);
  });

  test("returns null for an unknown user", async (store) => {
    assertEquals(await store.getUser("nope"), null);
  });

  test("looks a user up by email, case-insensitively", async (store) => {
    const user = makeUser({ email: "Paul@Example.COM" });
    await store.putUser(user);
    assertEquals((await store.getUserByEmail("paul@example.com"))?.id, user.id);
    assertEquals((await store.getUserByEmail("PAUL@EXAMPLE.COM"))?.id, user.id);
  });

  test("does not leave a stale email index after an address change", async (store) => {
    const user = makeUser({ email: "old@example.com" });
    await store.putUser(user);
    await store.putUser({ ...user, email: "new@example.com" });

    assertEquals(await store.getUserByEmail("old@example.com"), null);
    assertEquals((await store.getUserByEmail("new@example.com"))?.id, user.id);
  });

  test("preserves the approval gate fields verbatim", async (store) => {
    const pending = makeUser({ id: "u-pending", status: "pending" });
    await store.putUser(pending);
    assertEquals((await store.getUser("u-pending"))?.status, "pending");
  });

  // -- the audio-feed-ruw regression --------------------------------------
  //
  // Two modules used to write `["user", id]` with different shapes, so each
  // silently dropped the other's fields. These assert on EVERY field of the
  // canonical record, because the bug was not a crash — it was a field quietly
  // becoming `undefined`, and `isAdmin: undefined` is a privilege escalation
  // while `status: undefined` is unauthorized spend.

  test("round-trips every canonical user field, losing none", async (store) => {
    const user = makeUser({
      id: "u-full",
      email: "full@example.com",
      displayName: "Full Record",
      status: "approved",
      isAdmin: true,
      feedToken: "tok-full",
      voice: "Kore",
      feeds: ["stratechery", "inbox"],
      decidedAt: "2026-09-02T00:00:00.000Z",
      decidedBy: "admin-1",
      reason: "vouched for",
    });
    await store.putUser(user);

    const read = await store.getUser("u-full");
    assertEquals(read, user, "a round-trip must preserve the record exactly");
    // Spelled out so a future partial write fails loudly on the specific field.
    assertEquals(read?.isAdmin, true);
    assertEquals(read?.displayName, "Full Record");
    assertEquals(read?.feedToken, "tok-full");
    assertEquals(read?.feeds, ["stratechery", "inbox"]);
    assertEquals(read?.reason, "vouched for");
  });

  test("an update preserves fields the caller did not mention", async (store) => {
    const user = makeUser({ id: "u1", isAdmin: true, voice: "Kore", feeds: ["a"] });
    await store.putUser(user);
    // A status change through a spread — the shape every caller uses.
    await store.putUser({ ...user, status: "suspended" });

    const read = await store.getUser("u1");
    assertEquals(read?.status, "suspended");
    assertEquals(read?.isAdmin, true, "admin flag must survive a status change");
    assertEquals(read?.voice, "Kore");
    assertEquals(read?.feeds, ["a"]);
  });

  test("carries all four user statuses, including rejected", async (store) => {
    // `rejected` was absent from one of the two old unions, so a rejected user
    // was unrepresentable through half the codebase.
    for (const status of ["pending", "approved", "rejected", "suspended"] as const) {
      await store.putUser(makeUser({ id: `u-${status}`, status }));
      assertEquals((await store.getUser(`u-${status}`))?.status, status);
    }
  });

  // -- insertUser ---------------------------------------------------------

  test("insertUser writes a new user and reports success", async (store) => {
    assertEquals(await store.insertUser(makeUser({ id: "u1" })), true);
    assertEquals((await store.getUser("u1"))?.id, "u1");
  });

  test("insertUser refuses a duplicate email without throwing", async (store) => {
    await store.insertUser(makeUser({ id: "u1", email: "dup@example.com", feedToken: "t1" }));
    const second = await store.insertUser(
      makeUser({ id: "u2", email: "dup@example.com", feedToken: "t2" }),
    );

    assertEquals(second, false);
    assertEquals(await store.getUser("u2"), null, "a refused insert must not persist");
  });

  test("insertUser refuses a duplicate feed token", async (store) => {
    // Two users sharing a capability would let one read the other's feed.
    await store.insertUser(makeUser({ id: "u1", email: "a@example.com", feedToken: "same" }));
    const second = await store.insertUser(
      makeUser({ id: "u2", email: "b@example.com", feedToken: "same" }),
    );

    assertEquals(second, false);
    assertEquals(await store.getUser("u2"), null);
  });

  test("insertUser refuses a duplicate id", async (store) => {
    await store.insertUser(makeUser({ id: "u1", email: "a@example.com", feedToken: "t1" }));
    const second = await store.insertUser(
      makeUser({ id: "u1", email: "b@example.com", feedToken: "t2", displayName: "Impostor" }),
    );

    assertEquals(second, false);
    assertEquals(
      (await store.getUser("u1"))?.displayName,
      "Paul",
      "a refused insert must not overwrite the existing record",
    );
  });

  test("concurrent inserts of one email produce exactly one winner", async (store) => {
    // The reason insertUser exists: read-then-write lets both of these through.
    const results = await Promise.all([
      store.insertUser(makeUser({ id: "a", email: "race@example.com", feedToken: "ta" })),
      store.insertUser(makeUser({ id: "b", email: "race@example.com", feedToken: "tb" })),
      store.insertUser(makeUser({ id: "c", email: "race@example.com", feedToken: "tc" })),
    ]);

    assertEquals(results.filter(Boolean).length, 1, "exactly one insert may win");
    assertEquals((await store.listUsers()).length, 1);
  });

  // -- feed tokens --------------------------------------------------------

  test("resolves a user by feed token", async (store) => {
    const user = makeUser({ id: "u1", feedToken: "secret-token" });
    await store.putUser(user);
    assertEquals((await store.getUserByFeedToken("secret-token"))?.id, "u1");
  });

  test("an unknown, empty, or malformed feed token resolves null, never throws", async (store) => {
    await store.putUser(makeUser({ id: "u1", feedToken: "real" }));
    // Empty is the interesting one: an empty Deno KV key part throws, and a feed
    // route must answer 404 rather than 500.
    for (const token of ["", "nope", "REAL", "real ", "../real"]) {
      assertEquals(
        await store.getUserByFeedToken(token),
        null,
        `expected null for ${JSON.stringify(token)}`,
      );
    }
  });

  test("a rotated feed token revokes the old one", async (store) => {
    const user = makeUser({ id: "u1", feedToken: "old" });
    await store.putUser(user);
    await store.putUser({ ...user, feedToken: "new" });

    assertEquals(
      await store.getUserByFeedToken("old"),
      null,
      "a rotated token that still resolves has not been revoked",
    );
    assertEquals((await store.getUserByFeedToken("new"))?.id, "u1");
  });

  // -- approval ledger ----------------------------------------------------

  test("recordApproval writes the user and the ledger entry together", async (store) => {
    const user = makeUser({ id: "u1", status: "pending" });
    await store.putUser(user);

    const approved = { ...user, status: "approved" as const, decidedBy: "admin-1" };
    await store.recordApproval(approved, makeApproval({ userId: "u1", action: "approved" }));

    assertEquals((await store.getUser("u1"))?.status, "approved");
    const log = await store.listApprovalLog();
    assertEquals(log.length, 1);
    assertEquals(log[0]?.action, "approved");
    assertEquals(log[0]?.adminId, "admin-1");
  });

  test("the approval ledger is ordered oldest first and keeps every decision", async (store) => {
    const user = makeUser({ id: "u1" });
    for (
      const [at, action] of [
        ["2026-09-03T00:00:00.000Z", "suspended"],
        ["2026-09-01T00:00:00.000Z", "approved"],
        ["2026-09-02T00:00:00.000Z", "rejected"],
      ] as const
    ) {
      await store.recordApproval(
        { ...user, status: action },
        makeApproval({ userId: "u1", action, at }),
      );
    }

    const log = await store.listApprovalLog();
    assertEquals(
      log.map((record) => record.action),
      ["approved", "rejected", "suspended"],
      "the ledger is an audit trail: every decision, in order",
    );
  });

  test("ledger entries for different users at the same instant both survive", async (store) => {
    const at = "2026-09-01T00:00:00.000Z";
    await store.recordApproval(
      makeUser({ id: "a", feedToken: "ta" }),
      makeApproval({ userId: "a", at }),
    );
    await store.recordApproval(
      makeUser({ id: "b", feedToken: "tb" }),
      makeApproval({ userId: "b", at }),
    );

    assertEquals(
      (await store.listApprovalLog()).length,
      2,
      "same-instant decisions must not collide",
    );
  });

  // -- sources --------------------------------------------------------------

  test("scopes sources to their user", async (store) => {
    await store.putSource(makeSource({ id: "s1", userId: "user-1" }));
    await store.putSource(makeSource({ id: "s1", userId: "user-2", title: "Other" }));

    assertEquals((await store.getSource("user-1", "s1"))?.title, "Stratechery");
    assertEquals((await store.getSource("user-2", "s1"))?.title, "Other");
    assertEquals((await store.listSources("user-1")).length, 1);
  });

  test("deletes a source", async (store) => {
    await store.putSource(makeSource({ id: "s1", userId: "user-1" }));
    assertEquals((await store.getSource("user-1", "s1"))?.id, "s1");

    await store.deleteSource("user-1", "s1");
    assertEquals(await store.getSource("user-1", "s1"), null);
    assertEquals((await store.listSources("user-1")).length, 0);

    // Deleting non-existent source does not throw
    await store.deleteSource("user-1", "s1");
  });

  // -- articles -------------------------------------------------------------

  test("finds an article by url for dedupe", async (store) => {
    const article = makeArticle();
    await store.putArticle(article);

    assertEquals((await store.findArticleByUrl(article.userId, article.url))?.id, article.id);
    assertEquals(await store.findArticleByUrl(article.userId, "https://elsewhere.test/"), null);
    // Another user's ingest of the same URL must not collide.
    assertEquals(await store.findArticleByUrl("user-2", article.url), null);
  });

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

  const CLAIM = {
    owner: "worker-a",
    now: "2026-09-20T12:00:00.000Z",
    leaseMs: 60_000,
    maxClaims: 3,
  };
  const queued = (over: Partial<Episode> = {}) =>
    makeEpisode({ id: "e1", status: "pending", audioKey: undefined, ...over });

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
}
