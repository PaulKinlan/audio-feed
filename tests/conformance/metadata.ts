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
import { makeArticle, makeEpisode, makeSource, makeUser } from "../fixtures.ts";

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

  // -- sources --------------------------------------------------------------

  test("scopes sources to their user", async (store) => {
    await store.putSource(makeSource({ id: "s1", userId: "user-1" }));
    await store.putSource(makeSource({ id: "s1", userId: "user-2", title: "Other" }));

    assertEquals((await store.getSource("user-1", "s1"))?.title, "Stratechery");
    assertEquals((await store.getSource("user-2", "s1"))?.title, "Other");
    assertEquals((await store.listSources("user-1")).length, 1);
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
}
