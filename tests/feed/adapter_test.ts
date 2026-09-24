/**
 * Adapter tests (audio-feed-b0a).
 *
 * The point of this file is that every field mapping was a DECISION, so each one
 * is pinned. The two Episode types compile in isolation no matter how badly they
 * are projected, which is exactly how they diverged in the first place.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  enclosureUrl,
  toFeedEpisode,
  toFeedEpisodes,
  toFeedSource,
} from "../../src/feed/adapter.ts";
import { buildFeed } from "../../src/feed/rss.ts";
import { makeEpisode, makeSource } from "../fixtures.ts";
import type { Episode as StoredEpisode } from "../../src/types.ts";

const BASE = "https://audio.example.com";

/** A ready episode with every field the projection touches. */
const ready = (over: Partial<StoredEpisode> = {}): StoredEpisode =>
  makeEpisode({
    id: "episode-1",
    userId: "user-1",
    sourceId: "stratechery",
    mode: "direct",
    status: "ready",
    title: "The Aggregation Theory of Everything",
    description: "A spoken read.",
    audioKey: "episode-1.wav",
    byteLength: 524,
    durationSeconds: 25.3,
    contentType: "audio/wav",
    createdAt: "2026-09-01T00:00:00.000Z",
    readyAt: "2026-09-01T00:05:00.000Z",
    ...over,
  });

Deno.test("every field gap between the two Episode types is bridged deliberately", () => {
  const projected = toFeedEpisode(ready(), { publicBaseUrl: BASE });
  assert(projected, "a ready episode must project");
  assertEquals(projected.guid, "episode-1"); // id -> guid
  assertEquals(projected.kind, "direct"); // mode -> kind
  assertEquals(projected.sourceId, "stratechery");
  assertEquals(projected.sourceTitle, "Stratechery");
  assertEquals(projected.title, "The Aggregation Theory of Everything");
  assertEquals(projected.description, "A spoken read.");
  assertEquals(projected.mimeType, "audio/wav"); // contentType -> mimeType
  assertEquals(projected.durationSeconds, 25.3);
  assertEquals(projected.byteLength, 524);
});

Deno.test("mode maps to kind for both presentations", () => {
  assertEquals(toFeedEpisode(ready({ mode: "direct" }), { publicBaseUrl: BASE })?.kind, "direct");
  assertEquals(
    toFeedEpisode(ready({ mode: "deepdive" }), { publicBaseUrl: BASE })?.kind,
    "deepdive",
  );
});

Deno.test("pubDate prefers readyAt, because createdAt is when the job was queued", () => {
  // Clients sort by pubDate; a queued-then-synthesised-minutes-later episode would
  // otherwise look older than it is.
  assertEquals(
    toFeedEpisode(ready(), { publicBaseUrl: BASE })?.pubDate,
    "2026-09-01T00:05:00.000Z",
  );
  // A record with no readyAt still projects, using its creation time.
  assertEquals(
    toFeedEpisode(ready({ readyAt: undefined }), { publicBaseUrl: BASE })?.pubDate,
    "2026-09-01T00:00:00.000Z",
  );
});

Deno.test("audioKey becomes a stable proxy URL, never a store-signed URL", () => {
  // A signed URL expires (1h by default) while a podcast client polls the same
  // enclosure for months, so a signed enclosure is a feed that breaks quietly.
  const projected = toFeedEpisode(ready({ audioKey: "nested/episode-1.wav" }), {
    publicBaseUrl: BASE,
  });
  assertEquals(projected?.audioUrl, `${BASE}/audio/nested/episode-1.wav`);
  assertEquals(enclosureUrl(`${BASE}/`, "x.wav"), `${BASE}/audio/x.wav`);
  // The projection takes no store, so a signed URL cannot be introduced by accident.
  assertEquals(Object.keys(projected ?? {}).includes("signedUrl"), false);
});

Deno.test("an unfinished episode projects to null rather than an item with no enclosure", () => {
  assert(
    toFeedEpisode(ready({ status: "pending", audioKey: undefined }), { publicBaseUrl: BASE }) ===
      null,
  );
  assert(toFeedEpisode(ready({ status: "synthesizing" }), { publicBaseUrl: BASE }) === null);
  assert(
    toFeedEpisode(ready({ status: "failed", error: "boom" }), { publicBaseUrl: BASE }) === null,
  );
  // ready but with no key is still not playable.
  assert(toFeedEpisode(ready({ audioKey: undefined }), { publicBaseUrl: BASE }) === null);

  const list = toFeedEpisodes(
    [
      ready({ id: "a" }),
      ready({ id: "b", status: "pending", audioKey: undefined }),
      ready({ id: "c" }),
    ],
    { publicBaseUrl: BASE },
  );
  assertEquals(list.map((e) => e.guid), ["a", "c"]);
});

Deno.test("a missing byteLength is filled from the caller, and 0 counts as missing", () => {
  // The store knows the size of what it will serve; the adapter stays pure and
  // takes the answer instead of doing IO.
  assertEquals(
    toFeedEpisode(ready({ byteLength: 0 }), { publicBaseUrl: BASE, byteLength: 999 })?.byteLength,
    999,
  );
  assertEquals(
    toFeedEpisode(ready({ byteLength: undefined }), { publicBaseUrl: BASE, byteLength: 777 })
      ?.byteLength,
    777,
  );
  // A recorded size wins: it is what was actually stored.
  assertEquals(
    toFeedEpisode(ready({ byteLength: 524 }), { publicBaseUrl: BASE, byteLength: 999 })?.byteLength,
    524,
  );
});

Deno.test("sources project without inventing a feed URL", () => {
  const source = makeSource({
    id: "stratechery",
    userId: "user-1",
    siteUrl: "https://stratechery.com",
  });
  const projected = toFeedSource(source);
  assertEquals(projected.id, "stratechery");
  assertEquals(projected.title, source.title);
  assertEquals(projected.link, "https://stratechery.com");
  // The feed URL is built from the capability token, not stored on the source.
  assertEquals(Object.keys(projected).includes("feedUrl"), false);
});

Deno.test("projected episodes render a playable, well-formed feed item", () => {
  const projected = toFeedEpisode(ready(), { publicBaseUrl: BASE });
  assert(projected);
  const xml = buildFeed(
    {
      title: "Stratechery — Direct Read",
      selfUrl: `${BASE}/feed/token-user-1/stratechery/direct.xml`,
      link: BASE,
      description: "Direct Read audio.",
    },
    [projected],
  );
  assertStringIncludes(xml, '<guid isPermaLink="false">episode-1</guid>');
  assertStringIncludes(
    xml,
    `<enclosure url="${BASE}/audio/episode-1.wav" length="524" type="audio/wav"/>`,
  );
  assertStringIncludes(xml, "<itunes:duration>00:00:25</itunes:duration>");
  assertStringIncludes(xml, "<pubDate>Tue, 01 Sep 2026 00:05:00 +0000</pubDate>");
});
