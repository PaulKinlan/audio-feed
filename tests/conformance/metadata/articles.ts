/**
 * Articles: ingestion, the URL dedupe index, and byte-safe chunking on hydration.
 *
 * Split out of tests/conformance/metadata.ts (audio-feed-fydf). The cases are unchanged: each one
 * was moved here verbatim from the section it already lived in.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { makeArticle, makeEpisode } from "../../fixtures.ts";

export function registerArticlesCases(suite: MetadataHarness) {
  const { test } = suite;

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

  test("deleteArticle: removes article and its URL index (audio-feed-cei)", async (store) => {
    const url = "https://example.com/to-delete";
    const article = makeArticle({ id: "a-del", userId: "user-1", url, content: "Delete me" });
    await store.putArticle(article);
    assertEquals((await store.getArticle("user-1", "a-del"))?.id, "a-del");
    assertEquals((await store.findArticleByUrl("user-1", url))?.id, "a-del");

    await store.deleteArticle("user-1", "a-del");
    assertEquals(await store.getArticle("user-1", "a-del"), null);
    assertEquals(await store.findArticleByUrl("user-1", url), null);
  });
}
