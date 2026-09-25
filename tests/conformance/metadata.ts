/**
 * Conformance suite for `MetadataStore`.
 *
 * Every adapter must pass this identically. If an adapter needs a carve-out,
 * the interface is wrong — fix the interface, do not weaken the suite.
 *
 * Owned by: audio-feed-0h8.
 */

import { assert, assertEquals } from "@std/assert";
import type { EpisodeQuery, MetadataStore, RunRecord } from "../../src/storage/mod.ts";
import { RUN_HISTORY_LIMIT } from "../../src/storage/mod.ts";
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

  test("insertArticleIfAbsent: inserts when absent, refuses duplicates atomically (audio-feed-33m)", async (store) => {
    const article1 = makeArticle({ id: "a1", userId: "user-1", url: "https://example.com/item" });
    const article2 = makeArticle({ id: "a2", userId: "user-1", url: "https://example.com/item" });

    // First insert succeeds
    assertEquals(await store.insertArticleIfAbsent(article1), true);
    assertEquals((await store.getArticle("user-1", "a1"))?.url, "https://example.com/item");
    assertEquals((await store.findArticleByUrl("user-1", "https://example.com/item"))?.id, "a1");

    // Second insert with same URL for same user returns false without overwriting
    assertEquals(await store.insertArticleIfAbsent(article2), false);
    assertEquals(await store.getArticle("user-1", "a2"), null);
    assertEquals((await store.findArticleByUrl("user-1", "https://example.com/item"))?.id, "a1");

    // Same URL for a different user succeeds
    const user2Article = makeArticle({
      id: "a3",
      userId: "user-2",
      url: "https://example.com/item",
    });
    assertEquals(await store.insertArticleIfAbsent(user2Article), true);
    assertEquals((await store.findArticleByUrl("user-2", "https://example.com/item"))?.id, "a3");
  });

  test("insertArticleWithEpisodeIfAbsent: writes the pair together or not at all (audio-feed-2th)", async (store) => {
    const url = "https://example.com/pair";
    const article = makeArticle({ id: "a1", userId: "user-1", url });
    const episode = makeEpisode({ id: "e1", userId: "user-1", articleId: "a1", status: "pending" });

    assertEquals(await store.insertArticleWithEpisodeIfAbsent(article, episode), true);
    assertEquals((await store.getArticle("user-1", "a1"))?.id, "a1");
    assertEquals((await store.getEpisode("user-1", "e1"))?.articleId, "a1");
    assertEquals((await store.findArticleByUrl("user-1", url))?.id, "a1");
    // Queued, not merely stored: the worker finds it through the pending index, so
    // an article+episode pair that skipped the indexes would never be synthesised.
    assert((await store.listPendingEpisodes()).episodes.some((e) => e.id === "e1"));

    // A URL already in the store refuses the write and leaves NO trace of the
    // second episode either — the half-pair is the tombstone this primitive exists
    // to prevent, so a refused insert must be invisible in both directions.
    const dup = makeArticle({ id: "a2", userId: "user-1", url });
    const dupEpisode = makeEpisode({
      id: "e2",
      userId: "user-1",
      articleId: "a2",
      status: "pending",
    });
    assertEquals(await store.insertArticleWithEpisodeIfAbsent(dup, dupEpisode), false);
    assertEquals(await store.getArticle("user-1", "a2"), null);
    assertEquals(await store.getEpisode("user-1", "e2"), null);
    assertEquals((await store.findArticleByUrl("user-1", url))?.id, "a1");
    assert(!(await store.listPendingEpisodes()).episodes.some((e) => e.id === "e2"));

    // Another user's ingest of the same URL is its own pair.
    const other = makeArticle({ id: "a3", userId: "user-2", url });
    const otherEpisode = makeEpisode({
      id: "e3",
      userId: "user-2",
      articleId: "a3",
      status: "pending",
    });
    assertEquals(await store.insertArticleWithEpisodeIfAbsent(other, otherEpisode), true);
    assertEquals((await store.getEpisode("user-2", "e3"))?.id, "e3");
  });

  test("putArticleWithEpisode: writes the pair, and a re-send is a second pair (audio-feed-d8q)", async (store) => {
    const url = "https://example.com/sent-to-audio";
    const article = makeArticle({ id: "a1", userId: "user-1", url });
    const episode = makeEpisode({ id: "e1", userId: "user-1", articleId: "a1", status: "pending" });

    await store.putArticleWithEpisode(article, episode);
    assertEquals((await store.getArticle("user-1", "a1"))?.url, url);
    assertEquals((await store.getEpisode("user-1", "e1"))?.articleId, "a1");
    assert((await store.listPendingEpisodes()).episodes.some((e) => e.id === "e1"));

    // NO dedupe here, on purpose: sending the same URL to the inbox twice is a request
    // for a second episode, not a duplicate to drop. The newest write owns the URL, and
    // the earlier pair stays whole — its episode still exists and still plays.
    const again = makeArticle({ id: "a2", userId: "user-1", url });
    const againEpisode = makeEpisode({
      id: "e2",
      userId: "user-1",
      articleId: "a2",
      status: "pending",
    });
    await store.putArticleWithEpisode(again, againEpisode);
    assertEquals((await store.findArticleByUrl("user-1", url))?.id, "a2");
    assertEquals((await store.getArticle("user-1", "a1"))?.id, "a1");
    assertEquals((await store.getEpisode("user-1", "e1"))?.id, "e1");
    assertEquals((await store.getEpisode("user-1", "e2"))?.articleId, "a2");
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
  async function drainPages(
    store: MetadataStore,
    query: Omit<EpisodeQuery, "limit">,
    limit: number,
  ) {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await store.listEpisodePage({ ...query, limit, cursor });
      seen.push(...page.episodes.map((e) => e.id));
      pages++;
      if (!page.cursor || page.cursor === cursor) break;
      cursor = page.cursor;
      assert(pages < 50, "paging did not terminate");
    }
    return { seen, pages };
  }

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

  // -- operational stats (audio-feed-ndc) -----------------------------------
  //
  // These live in the CONFORMANCE suite, not in a memory-only test, because the
  // two adapters implement them by completely different means: memory uses a
  // number and a Map, KV uses atomic `.sum()` on KvU64 and a descending key
  // space with a prune. Two implementations of one contract is exactly the case
  // this file exists for, and a memory-only test would pass while the adapter
  // that actually runs in production diverged.

  const run = (over: Partial<RunRecord> = {}): RunRecord => ({
    id: "run-1",
    kind: "feed-poll",
    trigger: "cron",
    startedAt: "2026-09-25T10:00:00.000Z",
    durationMs: 120,
    polled: 3,
    queued: 2,
    failed: 0,
    ...over,
  });

  test("an empty store reports no downloads", async (store) => {
    // The dashboard renders this before anything has ever been requested, so
    // "no data" has to be a value rather than an absence to reason about.
    assertEquals(await store.getDownloadCounts(), { total: 0, perUser: [] });
  });

  test("recordDownload counts per user and in total", async (store) => {
    await store.recordDownload("user-a");
    await store.recordDownload("user-a");
    await store.recordDownload("user-b");

    const counts = await store.getDownloadCounts();
    assertEquals(counts.total, 3);
    // Descending by count, so the dashboard's "top subscribers" needs no sort.
    assertEquals(counts.perUser, [
      { userId: "user-a", count: 2 },
      { userId: "user-b", count: 1 },
    ]);
  });

  test("an unattributable download counts toward the total only", async (store) => {
    // A legacy flat blob key carries no user (audio-feed-3hb), so the route
    // passes null rather than inventing an owner. Counting it against some user
    // would be worse than not attributing it: the per-user figure is the one an
    // operator would act on.
    await store.recordDownload(null);
    await store.recordDownload("user-a");

    const counts = await store.getDownloadCounts();
    assertEquals(counts.total, 2, "an unattributed request is still a request");
    assertEquals(counts.perUser, [{ userId: "user-a", count: 1 }]);
  });

  test("a user with no downloads does not appear in the breakdown", async (store) => {
    await store.putUser(makeUser({ id: "quiet" }));
    await store.recordDownload("loud");

    const counts = await store.getDownloadCounts();
    assertEquals(counts.perUser.map((d) => d.userId), ["loud"]);
  });

  test("an empty store reports no runs", async (store) => {
    assertEquals(await store.listRuns(), []);
  });

  test("a run round-trips every field", async (store) => {
    const record = run({ id: "r1", kind: "synthesis", trigger: "manual", ready: 4, deferred: 1 });
    await store.recordRun(record);

    const [stored] = await store.listRuns();
    assert(stored, "the run must be readable back");
    assertEquals(stored, record);
  });

  test("a FAILED run is recorded, not dropped", async (store) => {
    // The whole point of the history: a run that threw is the one an operator
    // needs to see. If failures were skipped the dashboard would be at its least
    // informative exactly when something is wrong.
    await store.recordRun(run({ id: "boom", error: "feed fetch timed out" }));

    const [stored] = await store.listRuns();
    assertEquals(stored?.error, "feed fetch timed out");
  });

  test("runs come back newest first", async (store) => {
    await store.recordRun(run({ id: "old", startedAt: "2026-09-25T09:00:00.000Z" }));
    await store.recordRun(run({ id: "new", startedAt: "2026-09-25T11:00:00.000Z" }));
    await store.recordRun(run({ id: "mid", startedAt: "2026-09-25T10:00:00.000Z" }));

    assertEquals((await store.listRuns()).map((r) => r.id), ["new", "mid", "old"]);
  });

  test("listRuns honours a limit", async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.recordRun(run({ id: `r${i}`, startedAt: `2026-09-25T1${i}:00:00.000Z` }));
    }
    assertEquals((await store.listRuns(2)).map((r) => r.id), ["r4", "r3"]);
  });

  test("history is bounded ON WRITE, and keeps the newest", async (store) => {
    // Bounded on write rather than on read is the audio-feed-att lesson: an
    // unbounded history reads cheaply today and is a multi-megabyte scan a year
    // in. Writing past the limit and then asking for MORE than the limit is what
    // distinguishes "pruned" from "merely not returned".
    const total = RUN_HISTORY_LIMIT + 10;
    for (let i = 0; i < total; i++) {
      await store.recordRun(
        run({ id: `r${String(i).padStart(3, "0")}`, startedAt: isoAt(i) }),
      );
    }

    const all = await store.listRuns(total);
    assertEquals(all.length, RUN_HISTORY_LIMIT, "anything past the limit must be pruned");
    // The newest survive, not the first written.
    assertEquals(all[0]?.id, `r${String(total - 1).padStart(3, "0")}`);
    assertEquals(all.at(-1)?.id, `r${String(total - RUN_HISTORY_LIMIT).padStart(3, "0")}`);
  });

  test("a busy job cannot evict a quiet one's history (audio-feed-ct1)", async (store) => {
    // The synthesis cron records a run every 2 minutes, idle or not, and the
    // feed poll one every 15. Under one shared cap the busy job pushed the quiet
    // one out entirely, and a poller that had only stopped read as one that
    // never ran. Each job keeps its own newest RUN_HISTORY_LIMIT.
    await store.recordRun(run({ id: "poll", kind: "feed-poll", startedAt: isoAt(0) }));
    const busy = RUN_HISTORY_LIMIT + 10;
    for (let i = 1; i <= busy; i++) {
      await store.recordRun(
        run({ id: `s${String(i).padStart(3, "0")}`, kind: "synthesis", startedAt: isoAt(i) }),
      );
    }

    const all = await store.listRuns(1_000);
    assertEquals(
      all.filter((r) => r.kind === "feed-poll").map((r) => r.id),
      ["poll"],
      "the quiet job keeps its history",
    );
    assertEquals(
      all.filter((r) => r.kind === "synthesis").length,
      RUN_HISTORY_LIMIT,
      "the busy job is still bounded, on its own",
    );
    assertEquals(all[0]?.id, `s${String(busy).padStart(3, "0")}`, "still newest first");
    assertEquals(all.at(-1)?.id, "poll");
    assertEquals(
      (await store.listRuns()).length,
      RUN_HISTORY_LIMIT + 1,
      "the default returns every job's history, not one shared window",
    );
  });

  test("a same-millisecond tie breaks the same way on every adapter (audio-feed-ct1)", async (store) => {
    // Merging two jobs' histories makes a tie reachable: both crons can start in
    // the same millisecond. The two adapters used to break it in opposite
    // directions. The lower id comes first, everywhere.
    const at = "2026-09-25T10:00:00.000Z";
    await store.recordRun(run({ id: "b", kind: "synthesis", startedAt: at }));
    await store.recordRun(run({ id: "a", kind: "feed-poll", startedAt: at }));
    await store.recordRun(run({ id: "c", kind: "synthesis", startedAt: at }));

    assertEquals((await store.listRuns()).map((r) => r.id), ["a", "b", "c"]);
  });

  test("a run of idle ticks is kept as one row, the latest (audio-feed-0ob)", async (store) => {
    // The synthesis cron ticks every 2 minutes and nearly always finds nothing
    // to do. An idle tick replaces its job's newest row when that row is an
    // older idle tick, so the history does not grow and needs no prune.
    const idle = (id: string, i: number) =>
      run({ id, kind: "synthesis", startedAt: isoAt(i), idle: true });
    await store.recordRun(run({ id: "work", kind: "synthesis", startedAt: isoAt(0), ready: 2 }));
    await store.recordRun(idle("i1", 1));
    await store.recordRun(idle("i2", 2));
    await store.recordRun(idle("i3", 3));

    assertEquals((await store.listRuns()).map((r) => r.id), ["i3", "work"]);
  });

  test("an idle tick replaces only an OLDER idle row of the SAME job (audio-feed-0ob)", async (store) => {
    await store.recordRun(
      run({ id: "s-idle", kind: "synthesis", startedAt: isoAt(1), idle: true }),
    );
    // Another job's idle tick is its own row.
    await store.recordRun(
      run({ id: "p-idle", kind: "feed-poll", startedAt: isoAt(2), idle: true }),
    );
    // A tick that did work is always kept, and ends the idle run before it.
    await store.recordRun(run({ id: "s-work", kind: "synthesis", startedAt: isoAt(3), ready: 1 }));
    await store.recordRun(
      run({ id: "s-idle-2", kind: "synthesis", startedAt: isoAt(4), idle: true }),
    );
    // Recorded late: an older idle tick never replaces a newer one.
    await store.recordRun(
      run({ id: "s-late", kind: "synthesis", startedAt: isoAt(0), idle: true }),
    );

    assertEquals(
      (await store.listRuns()).map((r) => r.id),
      ["s-idle-2", "s-work", "p-idle", "s-idle", "s-late"],
    );
  });
}

/** Distinct, ordered timestamps for history tests. */
function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 8, 25, 0, 0, 0) + index * 60_000).toISOString();
}
