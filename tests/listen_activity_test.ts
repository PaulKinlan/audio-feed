/**
 * audio-feed-7s2 — the player must show work in progress and work that failed.
 *
 * Found in the audio-feed-q9h audit as U2/F2: `handleListen` listed publishable episodes only, so
 * a subscriber who opened the player after subscribing to a feed saw an empty page and no signal
 * that anything was happening — and a failed episode was invisible forever, with no way to retry
 * it. The whole premise of the service is "audio arrives later"; the UI could not show "later".
 *
 * These cases pin the three things the feature needs: the page payload, a token-gated status
 * endpoint the page can poll, and a token-gated retry that can only touch the caller's episodes.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const TOKEN = "token-activity";

async function seeded() {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: TOKEN, displayName: "Paul" }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-2", status: "approved", feedToken: "token-other" }),
  );
  await stores.metadata.putSource(makeSource({ id: "src-a", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "art-1", userId: "user-1", sourceId: "src-a" }),
  );
  // One playable episode.
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-ready",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-1",
    title: "The playable one",
    status: "ready",
    audioKey: "audio/user-1/direct/ep-ready.wav",
    contentType: "audio/wav",
  }));
  // One queued and generating, one failed with a reason.
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-queued",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-1",
    title: "Still being generated",
    status: "pending",
    audioKey: undefined,
  }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-failed",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-1",
    title: "The one that failed",
    status: "failed",
    error: "TTS upstream returned 503",
    audioKey: undefined,
  }));
  // The same shapes belonging to ANOTHER user, to prove nothing leaks across tokens.
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-other-failed",
    userId: "user-2",
    sourceId: "src-a",
    articleId: "art-1",
    title: "Someone else's failure",
    status: "failed",
    error: "SECRET-OTHER-USER-DETAIL",
  }));

  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const req = (path: string, init?: RequestInit) => new Request(`${BASE}${path}`, init);
  return { stores, fetch, req };
}

Deno.test("the player page shows generating and failed episodes, not only playable ones (audio-feed-7s2)", async () => {
  const { fetch, req } = await seeded();
  const html = await (await fetch(req(`/listen/${TOKEN}`))).text();

  assertStringIncludes(html, "Still being generated");
  assertStringIncludes(html, "The one that failed");
  assertStringIncludes(html, "TTS upstream returned 503", "the failure reason must reach the page");
  // The playable list and its count are untouched (audio-feed-8oz's contract).
  assertStringIncludes(html, "The playable one");
  const count = Number(/id="episodeCount">(\d+) episode/.exec(html)?.[1]);
  assertEquals(count, 1, "the episode count still means playable episodes");
});

Deno.test("the page never carries another subscriber's episode or reason (audio-feed-7s2)", async () => {
  const { fetch, req } = await seeded();
  const html = await (await fetch(req(`/listen/${TOKEN}`))).text();
  assert(!html.includes("Someone else's failure"), "another user's title must not appear");
  assert(!html.includes("SECRET-OTHER-USER-DETAIL"), "nor their failure reason");
});

Deno.test("GET /listen/:token/status reports activity as JSON for the poll (audio-feed-7s2)", async () => {
  const { fetch, req } = await seeded();
  const res = await fetch(req(`/listen/${TOKEN}/status`));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.playable, 1);
  assertEquals(body.inProgress.map((e: { id: string }) => e.id), ["ep-queued"]);
  assertEquals(body.failed.map((e: { id: string }) => e.id), ["ep-failed"]);
  assertEquals(body.failed[0].error, "TTS upstream returned 503");
  assertEquals(
    res.headers.get("cache-control"),
    "no-store",
    "a status endpoint that a cache could answer is a status endpoint that lies",
  );
});

Deno.test("a regenerating episode stays in the playable list and is NOT doubled in activity (audio-feed-7s2, 8oz)", async () => {
  // The seam this feature could easily break: a regenerating episode is status "pending" but
  // still plays its old audio (audio-feed-8oz). If the activity panel listed it too, the
  // subscriber would see the same episode twice with contradictory states — one row offering
  // play, one saying "Queued" — and the poll would move it between them as the worker progresses.
  const { stores, fetch, req } = await seeded();
  await stores.metadata.requeueEpisode("user-1", "ep-ready");

  const body = await (await fetch(req(`/listen/${TOKEN}/status`))).json();
  assertEquals(
    body.inProgress.map((e: { id: string }) => e.id),
    ["ep-queued"],
    "the regenerating episode is playable on its old audio, so it is not 'in progress' here",
  );
  assertEquals(body.playable, 1, "and it still counts as playable");

  const html = await (await fetch(req(`/listen/${TOKEN}`))).text();
  const playable = JSON.parse(/const EPISODES = (\[.*?\]);\n/.exec(html)?.[1] ?? "[]");
  assert(
    playable.some((episode: { id: string }) => episode.id === "ep-ready"),
    "the player must still offer the old audio",
  );
  const activity = JSON.parse(/const ACTIVITY = (\{.*?\});\n/.exec(html)?.[1] ?? "{}");
  assert(
    !(activity.inProgress ?? []).some((entry: { id: string }) => entry.id === "ep-ready"),
    "and the activity panel must not list the same episode a second time",
  );
});

Deno.test("the status endpoint is token-gated and unknown tokens get nothing (audio-feed-7s2)", async () => {
  const { fetch, req } = await seeded();
  assertEquals((await fetch(req("/listen/no-such-token/status"))).status, 404);
  // user-2 has exactly one failed episode of their own. The point is not that the panel is
  // empty — it is that each token sees its OWN activity and nothing else.
  const other = await (await fetch(req("/listen/token-other/status"))).json();
  assertEquals(other.failed.map((e: { id: string }) => e.id), ["ep-other-failed"]);
  assert(
    !JSON.stringify(other).includes("ep-failed"),
    "user-1's episode must not appear in user-2's status payload",
  );
  assert(
    !JSON.stringify(other).includes("The one that failed"),
    "nor user-1's title",
  );
});

Deno.test("POST retry re-queues the caller's failed episode and it reappears as in-progress (audio-feed-7s2)", async () => {
  const { stores, fetch, req } = await seeded();
  const res = await fetch(req(`/listen/${TOKEN}/episodes/ep-failed/retry`, { method: "POST" }));
  assertEquals(res.status, 202, `retry must be accepted; got ${res.status}`);
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-failed"))?.status, "pending");

  const body = await (await fetch(req(`/listen/${TOKEN}/status`))).json();
  assertEquals(body.failed.length, 0, "it leaves the failed list");
  assert(body.inProgress.some((e: { id: string }) => e.id === "ep-failed"), "and shows as queued");
});

Deno.test("retry cannot touch another subscriber, a playable episode, or an unknown token (audio-feed-7s2)", async () => {
  const { stores, fetch, req } = await seeded();
  assertEquals(
    (await fetch(req(`/listen/${TOKEN}/episodes/ep-other-failed/retry`, { method: "POST" })))
      .status,
    404,
    "an episode the caller does not own must not be retryable, and must not confirm it exists",
  );
  assertEquals((await stores.metadata.getEpisode("user-2", "ep-other-failed"))?.status, "failed");

  assertEquals(
    (await fetch(req(`/listen/${TOKEN}/episodes/ep-ready/retry`, { method: "POST" }))).status,
    409,
    "a playable episode is a requeue, not a retry — different transition, different method",
  );
  assertEquals(
    (await fetch(req(`/listen/no-such-token/episodes/ep-failed/retry`, { method: "POST" }))).status,
    404,
  );
});
