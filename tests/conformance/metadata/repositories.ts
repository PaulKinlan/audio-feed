/**
 * The `repositories` facade itself: the domain list, that a view is its own object, and that a view stays narrow.
 *
 * Split out of tests/conformance/metadata.ts (audio-feed-fydf). The cases are unchanged: each one
 * was moved here verbatim from the section it already lived in.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../../fixtures.ts";

export function registerRepositoriesCases(suite: MetadataHarness) {
  const { test } = suite;

  // -- domain repositories (audio-feed-d9sl Phase 1, one implementation per domain in audio-feed-8r1e)
  //
  // Phase 1's case here pinned that every view WAS the store, which is exactly what made that split
  // behaviour-preserving. Giving a domain its own implementation had to come back and change it —
  // that was the point, so that it read as a decision rather than as drift. What replaces it:
  // the domain list, that each view is its own object, and that a view stays NARROW.

  test("exposes every domain of the store, each as its own repository", (store) => {
    const repositories = store.repositories;
    assertEquals(
      Object.keys(repositories).sort(),
      [
        "articles",
        "auth",
        "episodes",
        "notifications",
        "orphanBlobs",
        "runs",
        "segments",
        "sources",
        "usage",
        "users",
      ],
      "the domain list is the contract: adding an entity means adding a domain",
    );
    assert(
      (repositories.episodes as unknown) !== (store as unknown),
      "a domain is now its own implementation, not the store narrowed by type",
    );
    // One method the domain must have, one it must NOT expose. The second half is the collision the
    // split exists to remove: a lane editing episodes must not be able to reach the user methods
    // through its own handle and quietly keep the shared file shared.
    const spotChecks: Record<string, [own: string, foreign: string]> = {
      users: ["getUser", "getEpisode"],
      sources: ["listSources", "getUser"],
      articles: ["getArticle", "getEpisode"],
      episodes: ["getEpisode", "getArticle"],
      segments: ["listSynthesisSegments", "getEpisode"],
      orphanBlobs: ["listOrphanBlobs", "getArticle"],
      usage: ["getDownloadCounts", "getEpisode"],
      notifications: ["listOutbox", "getArticle"],
      runs: ["listRuns", "getEpisode"],
      auth: ["getSession", "getUser"],
    };
    for (const [domain, [own, foreign]] of Object.entries(spotChecks)) {
      const view = repositories[domain as keyof typeof repositories] as unknown as Record<
        string,
        unknown
      >;
      assertEquals(typeof view[own], "function", `${domain}.${own} must exist`);
      assertEquals(foreign in view, false, `${domain} must not expose ${foreign}`);
    }
  });

  test("a call through a domain view is the same call, and the same result", async (store) => {
    // One write per domain that owns one, so a view that pointed at a different store (a copy, a
    // second connection, a stale snapshot) could not pass this.
    const user = makeUser({ id: "repo-user", email: "repo@example.com" });
    assert(await store.repositories.users.insertUser(user));
    assertEquals(await store.getUser(user.id), await store.repositories.users.getUser(user.id));

    const source = makeSource({ id: "repo-source", userId: user.id });
    await store.repositories.sources.putSource(source);
    assertEquals(await store.repositories.sources.getSource(user.id, source.id), source);

    const episode = makeEpisode({ id: "repo-episode", userId: user.id, sourceId: source.id });
    await store.repositories.episodes.putEpisode(episode);
    assertEquals(await store.repositories.episodes.getEpisode(user.id, episode.id), episode);
    // The episode domain includes the recovery transitions, not just the queue.
    assertEquals(typeof store.repositories.episodes.retryEpisode, "function");
    assertEquals(typeof store.repositories.episodes.cancelRegeneration, "function");

    const article = makeArticle({ id: "repo-article", userId: user.id, sourceId: source.id });
    await store.repositories.articles.putArticle(article);
    // Field-wise, not deep-equal: the KV adapter records its own `chunkCount` on hydration
    // (audio-feed-cei), which is not part of the article the caller wrote.
    const readBack = await store.repositories.articles.getArticle(user.id, article.id);
    assertEquals(readBack?.id, article.id);
    assertEquals(readBack?.content, article.content);

    for (
      const [domain, method] of [
        ["segments", "reserveSynthesisSegment"],
        ["orphanBlobs", "recordOrphanBlob"],
        ["usage", "recordDownload"],
        ["notifications", "queueNotification"],
        ["runs", "listRuns"],
        ["auth", "getSession"],
      ] as const
    ) {
      assertEquals(
        typeof (store.repositories[domain] as unknown as Record<string, unknown>)[method],
        "function",
        `${domain}.${method} must be reachable through the facade`,
      );
    }
  });
}
