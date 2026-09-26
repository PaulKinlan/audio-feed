/**
 * Regenerate an episode, or a whole feed, after the TTS prompts change (audio-feed-8oz).
 *
 * One test per rule in the bead:
 *   - promptVersion is derived from the prompt builders + model, and stamped on synthesis;
 *   - regenerate re-synthesises from the stored article, keeps id/GUID, and the feed
 *     keeps playing the OLD audio until the new audio is ready;
 *   - the new audio gets a NEW blob key (audio is served immutable) and the old blob
 *     is deleted after the swap;
 *   - it is safe under the synthesis lease, idempotent, and behind the approval gate;
 *   - admin-gated API for one episode and for a feed (scope outdated|all, source, mode),
 *     returning the queued count; the admin UI asks before spending.
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { computePromptVersion, isOutdated, PROMPT_VERSION } from "../src/tts/prompt_version.ts";
import { formatNarrationPrompt } from "../src/tts/gemini.ts";
import { audioBlobKey, isPublishable } from "../src/types.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { runAdminScript } from "./admin_script.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { Synthesizer } from "../src/worker/synthesis.ts";
import type { Episode } from "../src/types.ts";

const BASE = "https://audio.example.com";
const TOKEN = "token-user-1";
const ADMIN = { "x-admin-token": "admin-secret" };
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

function fakeAudio(fill = 1, bytes = 480): DecodedAudioResult {
  const raw = new Uint8Array(44 + bytes).fill(fill);
  raw.set([0x52, 0x49, 0x46, 0x46], 0);
  raw.set([0x57, 0x41, 0x56, 0x45], 8);
  raw.set([0x64, 0x61, 0x74, 0x61], 36);
  return {
    rawBytes: raw,
    mimeType: "audio/wav",
    format: "wav",
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    durationSeconds: 2,
    finishReason: "STOP",
    truncated: false,
    toWav: () => raw,
  };
}

const OLD_KEY = "audio/user-1/direct/ep-1.wav";

/** One approved subscriber with a published episode made by old prompts. */
async function published(episodeOverrides: Partial<Episode> = {}, userStatus = "approved") {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({
      id: "user-1",
      status: userStatus as "approved",
      feedToken: TOKEN,
    }),
  );
  await stores.metadata.putSource(makeSource({ id: "src-a", userId: "user-1", title: "Src A" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "article-1", userId: "user-1", sourceId: "src-a" }),
  );
  await stores.blobs.put(OLD_KEY, new Uint8Array([9, 9, 9, 9]), { contentType: "audio/wav" });
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-1",
      userId: "user-1",
      sourceId: "src-a",
      articleId: "article-1",
      status: "ready",
      mode: "direct",
      audioKey: OLD_KEY,
      contentType: "audio/wav",
      byteLength: 4,
      readyAt: "2026-09-10T08:12:00.000Z",
      promptVersion: "old-prompts",
      ...episodeOverrides,
    }),
  );
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { ctx, stores, fetch };
}

const ok: Synthesizer = () => Promise.resolve(fakeAudio(2));

async function masterFeed(fetch: (r: Request) => Promise<Response>): Promise<string> {
  const res = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`));
  assertEquals(res.status, 200);
  return await res.text();
}

const post = (path: string, body?: unknown, headers: Record<string, string> = ADMIN) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// promptVersion
// ---------------------------------------------------------------------------

Deno.test("promptVersion is a short, stable hash of the prompt builders and the model (audio-feed-8oz)", () => {
  assertEquals(PROMPT_VERSION, computePromptVersion());
  assert(/^[0-9a-f]{12}$/.test(PROMPT_VERSION), `unexpected shape: ${PROMPT_VERSION}`);
  assertNotEquals(computePromptVersion({ model: "some-other-tts" }), PROMPT_VERSION);
  // A change to prompt-building code changes it without anyone bumping a constant.
  assertNotEquals(
    computePromptVersion({
      formatNarrationPrompt: (input) => `Read this calmly. ${formatNarrationPrompt(input)}`,
    }),
    PROMPT_VERSION,
  );
});

Deno.test("an episode is outdated when its promptVersion differs or is missing (audio-feed-8oz)", () => {
  const ready = makeEpisode({ status: "ready" });
  assert(isOutdated({ ...ready, promptVersion: undefined }), "made before 8oz counts as outdated");
  assert(isOutdated({ ...ready, promptVersion: "old-prompts" }));
  assert(!isOutdated({ ...ready, promptVersion: PROMPT_VERSION }));
  assert(!isOutdated({ ...ready, status: "pending", promptVersion: undefined }), "nothing to redo");
  assert(!isOutdated({ ...ready, status: "pending", regenerating: true }), "already queued");
});

Deno.test("a synthesised episode records the current promptVersion (audio-feed-8oz)", async () => {
  const { ctx, stores } = await published({ status: "pending", audioKey: undefined });
  await runSynthesisBatch(ctx, ok);
  const episode = await stores.metadata.getEpisode("user-1", "ep-1");
  assertEquals(episode?.status, "ready");
  assertEquals(episode?.promptVersion, PROMPT_VERSION);
});

// ---------------------------------------------------------------------------
// keys and publishability
// ---------------------------------------------------------------------------

Deno.test("audioBlobKey takes a revision, so regenerated audio never reuses a key (audio-feed-8oz)", () => {
  const ep = { userId: "u", id: "e", mode: "direct" as const };
  assertEquals(audioBlobKey(ep, "wav"), "audio/u/direct/e.wav");
  assertEquals(audioBlobKey(ep, "wav", "r1"), "audio/u/direct/e-r1.wav");
});

Deno.test("a regenerating episode stays publishable on its old audio (audio-feed-8oz)", () => {
  const ready = makeEpisode({ status: "ready" });
  assert(isPublishable({ ...ready, status: "pending", regenerating: true }));
  assert(isPublishable({ ...ready, status: "synthesizing", regenerating: true }));
  // Without the marker a pending episode is a first synthesis, whatever its fields say.
  assert(!isPublishable({ ...ready, status: "pending" }));
  assert(!isPublishable({ ...ready, status: "pending", regenerating: true, audioKey: undefined }));
});

// ---------------------------------------------------------------------------
// the worker
// ---------------------------------------------------------------------------

Deno.test("regenerating serves the old audio until the new audio lands, then swaps keys (audio-feed-8oz)", async () => {
  const { ctx, stores, fetch } = await published();
  assertEquals(await stores.metadata.requeueEpisode("user-1", "ep-1").then((e) => !!e), true);

  // Queued: still in the feed, on the old enclosure, same GUID.
  let xml = await masterFeed(fetch);
  assertStringIncludes(xml, `${BASE}/audio/user-1/direct/ep-1.wav`);
  assertStringIncludes(xml, `<guid isPermaLink="false">ep-1</guid>`);

  // Mid-synthesis: the feed must still serve the old bytes.
  let during = "";
  const observing: Synthesizer = async () => {
    during = await masterFeed(fetch);
    return fakeAudio(2);
  };
  const result = await runSynthesisBatch(ctx, observing);
  assertEquals(result.ready.length, 1);
  assertStringIncludes(during, `${BASE}/audio/user-1/direct/ep-1.wav`);

  const episode = await stores.metadata.getEpisode("user-1", "ep-1");
  assert(episode?.audioKey, "the swap must leave audio");
  assertEquals(episode.status, "ready");
  assert(!episode.regenerating);
  assertNotEquals(episode.audioKey, OLD_KEY, "immutable audio needs a NEW key");
  assert(episode.audioKey.startsWith("audio/user-1/direct/ep-1-"), episode.audioKey);
  assertEquals(episode.promptVersion, PROMPT_VERSION);
  assertEquals(episode.readyAt, "2026-09-10T08:12:00.000Z", "pubDate must not jump");

  xml = await masterFeed(fetch);
  assertStringIncludes(xml, `<guid isPermaLink="false">ep-1</guid>`);
  assertStringIncludes(xml, `${BASE}/${episode.audioKey}`);
  assert(!xml.includes(`${BASE}/audio/user-1/direct/ep-1.wav`), "old enclosure must be gone");

  assertEquals(await stores.blobs.head(OLD_KEY), null, "the old blob is deleted after the swap");
  assert(await stores.blobs.head(episode.audioKey), "the new blob is stored");
  const audio = await fetch(new Request(`${BASE}/${episode.audioKey}`));
  assertEquals(audio.status, 200);
  await audio.body?.cancel();
});

Deno.test("a failed regeneration keeps the episode on its old audio (audio-feed-8oz)", async () => {
  const { ctx, stores, fetch } = await published();
  await stores.metadata.requeueEpisode("user-1", "ep-1");
  const result = await runSynthesisBatch(
    ctx,
    () => Promise.reject(Object.assign(new Error("bad request"), { status: 400 })),
    { retryBaseDelayMs: 1 },
  );
  assertEquals(result.failed.length, 1);

  const episode = await stores.metadata.getEpisode("user-1", "ep-1");
  assertEquals(episode?.status, "ready");
  assertEquals(episode?.audioKey, OLD_KEY);
  assertEquals(episode?.promptVersion, "old-prompts", "still outdated, so it can be retried");
  assert(!episode?.regenerating);
  assertStringIncludes(episode?.error ?? "", "bad request");
  assert(await stores.blobs.head(OLD_KEY), "the old audio must survive a failed regeneration");
  assertStringIncludes(await masterFeed(fetch), `${BASE}/audio/user-1/direct/ep-1.wav`);
});

Deno.test("a regeneration superseded under the lease deletes only its own blob (audio-feed-8oz)", async () => {
  const { ctx, stores } = await published();
  await stores.metadata.requeueEpisode("user-1", "ep-1");

  // Worker A's synthesis outlives its lease; worker B takes the claim over and
  // finishes first. With one deterministic key, A's cleanup would delete B's audio.
  let nested = false;
  const slowA: Synthesizer = async () => {
    if (!nested) {
      nested = true;
      const b = await runSynthesisBatch(ctx, ok, { owner: "worker-b", leaseMs: 0 });
      assertEquals(b.ready.length, 1, "worker B must take over the expired claim");
    }
    return fakeAudio(3);
  };
  const a = await runSynthesisBatch(ctx, slowA, { owner: "worker-a", leaseMs: 0 });
  assertEquals(a.superseded.length, 1, "worker A must be refused by the owner check");

  const episode = await stores.metadata.getEpisode("user-1", "ep-1");
  assert(episode?.audioKey && episode.audioKey !== OLD_KEY);
  assert(await stores.blobs.head(episode.audioKey), "the winner's audio must survive");
  assertEquals(await stores.blobs.head(OLD_KEY), null);
});

Deno.test("an unapproved user's regeneration is never synthesised (audio-feed-8oz)", async () => {
  const { ctx, stores } = await published({}, "approved");
  await stores.metadata.requeueEpisode("user-1", "ep-1");
  const user = await stores.metadata.getUser("user-1");
  await stores.metadata.putUser({ ...user!, status: "suspended" });

  let calls = 0;
  const result = await runSynthesisBatch(ctx, () => {
    calls++;
    return Promise.resolve(fakeAudio());
  });
  assertEquals(calls, 0);
  assertEquals(result.deferred.length, 1);
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-1"))?.audioKey, OLD_KEY);
});

// ---------------------------------------------------------------------------
// the API
// ---------------------------------------------------------------------------

Deno.test("POST regenerate one episode queues it once and is idempotent (audio-feed-8oz)", async () => {
  const { stores, fetch } = await published();
  const path = "/api/admin/users/user-1/episodes/ep-1/regenerate";

  let res = await fetch(post(path));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).queued, 1);
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-1"))?.regenerating, true);

  res = await fetch(post(path));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).queued, 0, "already queued changes nothing");

  res = await fetch(post("/api/admin/users/user-1/episodes/ghost/regenerate"));
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("regenerate routes are admin-gated (audio-feed-8oz)", async () => {
  const { stores, fetch } = await published();
  for (
    const req of [
      post("/api/admin/users/user-1/episodes/ep-1/regenerate", undefined, {}),
      post("/api/admin/users/user-1/regenerate", { scope: "all" }, { "x-admin-token": "wrong" }),
      new Request(`${BASE}/api/admin/users/user-1/episodes`),
    ]
  ) {
    const res = await fetch(req);
    assertEquals(res.status, 401);
    await res.body?.cancel();
  }
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-1"))?.status, "ready");
});

Deno.test("regenerate is refused for an unapproved user and queues nothing (audio-feed-8oz)", async () => {
  const { stores, fetch } = await published({}, "suspended");
  for (
    const req of [
      post("/api/admin/users/user-1/episodes/ep-1/regenerate"),
      post("/api/admin/users/user-1/regenerate", { scope: "all" }),
    ]
  ) {
    const res = await fetch(req);
    assertEquals(res.status, 403);
    await res.body?.cancel();
  }
  const episode = await stores.metadata.getEpisode("user-1", "ep-1");
  assertEquals(episode?.status, "ready");
  assert(!episode?.regenerating);
});

/** Four ready episodes across two sources and both modes; two current, two outdated. */
async function mixed() {
  const setup = await published();
  const { stores } = setup;
  await stores.metadata.putSource(makeSource({ id: "src-b", userId: "user-1", title: "Src B" }));
  const add = (id: string, over: Partial<Episode>) =>
    stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-1",
        articleId: "article-1",
        status: "ready",
        audioKey: `audio/user-1/direct/${id}.wav`,
        contentType: "audio/wav",
        ...over,
      }),
    );
  // ep-1 (src-a, direct, old-prompts) comes from `published`.
  await add("ep-2", { sourceId: "src-a", mode: "deepdive", promptVersion: PROMPT_VERSION });
  await add("ep-3", { sourceId: "src-b", mode: "direct", promptVersion: undefined });
  await add("ep-4", { sourceId: "src-b", mode: "direct", promptVersion: PROMPT_VERSION });
  await add("ep-5", { sourceId: "src-b", status: "pending", audioKey: undefined });
  return setup;
}

const regenerating = async (stores: Stores) =>
  (await stores.metadata.listEpisodes({ userId: "user-1", limit: 50 }))
    .filter((e) => e.regenerating).map((e) => e.id).sort();

Deno.test("regenerate a feed defaults to outdated episodes and returns the count (audio-feed-8oz)", async () => {
  const { stores, fetch } = await mixed();
  const res = await fetch(post("/api/admin/users/user-1/regenerate", {}));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.scope, "outdated");
  assertEquals(body.queued, 2);
  assertEquals(await regenerating(stores), ["ep-1", "ep-3"]);

  // Again: nothing new to queue.
  const again = await fetch(post("/api/admin/users/user-1/regenerate", {}));
  assertEquals((await again.json()).queued, 0);
});

Deno.test("regenerate a feed with scope all, one source or one mode (audio-feed-8oz)", async () => {
  let { stores, fetch } = await mixed();
  let res = await fetch(post("/api/admin/users/user-1/regenerate", { scope: "all" }));
  assertEquals((await res.json()).queued, 4, "every ready episode, never a pending one");
  assertEquals(await regenerating(stores), ["ep-1", "ep-2", "ep-3", "ep-4"]);

  ({ stores, fetch } = await mixed());
  res = await fetch(
    post("/api/admin/users/user-1/regenerate", { scope: "all", sourceId: "src-b" }),
  );
  assertEquals((await res.json()).queued, 2);
  assertEquals(await regenerating(stores), ["ep-3", "ep-4"]);

  ({ stores, fetch } = await mixed());
  res = await fetch(post("/api/admin/users/user-1/regenerate", { scope: "all", mode: "deepdive" }));
  assertEquals((await res.json()).queued, 1);
  assertEquals(await regenerating(stores), ["ep-2"]);

  for (const bad of [{ scope: "everything" }, { mode: "podcast" }, { sourceId: 7 }]) {
    const rejected = await fetch(post("/api/admin/users/user-1/regenerate", bad));
    assertEquals(rejected.status, 400, JSON.stringify(bad));
    await rejected.body?.cancel();
  }
  const unknown = await fetch(post("/api/admin/users/ghost/regenerate", {}));
  assertEquals(unknown.status, 404);
  await unknown.body?.cancel();
});

Deno.test("GET episodes gives the console its outdated and all counts (audio-feed-8oz)", async () => {
  const { fetch } = await mixed();
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/episodes`, { headers: ADMIN }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.promptVersion, PROMPT_VERSION);
  assertEquals(body.counts, { outdated: 2, all: 4 });
  const byId = new Map(body.episodes.map((e: { id: string }) => [e.id, e]));
  assertEquals(byId.size, 5);
  assertEquals((byId.get("ep-1") as { outdated: boolean }).outdated, true);
  assertEquals((byId.get("ep-2") as { outdated: boolean }).outdated, false);
  assertEquals((byId.get("ep-5") as { status: string }).status, "pending");
});

// ---------------------------------------------------------------------------
// interactions with the rest of the product
// ---------------------------------------------------------------------------

Deno.test("removing a source keeps a regenerating episode on its old audio (audio-feed-8oz)", async () => {
  const { stores, fetch } = await published();
  await stores.metadata.requeueEpisode("user-1", "ep-1");

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-a`, {
      method: "DELETE",
      headers: ADMIN,
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.retainedEpisodes, 1, "a published episode is retained, not cancelled");
  assertEquals(body.cancelledPending, 0);

  const episode = await stores.metadata.getEpisode("user-1", "ep-1");
  assertEquals(episode?.status, "ready");
  assert(!episode?.regenerating, "the regeneration is cancelled with the source");
  assertEquals(episode?.audioKey, OLD_KEY);
  assert(await stores.blobs.head(OLD_KEY));
});

Deno.test("the player keeps listing an episode while it regenerates (audio-feed-8oz)", async () => {
  const { stores, fetch } = await published();
  await stores.metadata.requeueEpisode("user-1", "ep-1");
  const res = await fetch(new Request(`${BASE}/listen/${TOKEN}`));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "/audio/user-1/direct/ep-1.wav");
});

// ---------------------------------------------------------------------------
// the admin console
// ---------------------------------------------------------------------------

const USER = { id: "user-1", email: "sub@example.com", displayName: "Sub", status: "approved" };

async function openConsole() {
  const harness = await runAdminScript({
    storedToken: "admin-secret",
    respond: (method, path) => {
      if (method === "GET" && path === "/api/admin/users") return { users: [USER] };
      if (method === "GET" && path === "/api/admin/users/user-1/sources") {
        return { feedToken: TOKEN, sources: [] };
      }
      if (method === "GET" && path === "/api/admin/users/user-1/episodes") {
        return {
          promptVersion: "abc123abc123",
          counts: { outdated: 1, all: 2 },
          episodes: [
            { id: "ep-1", title: "Old one", mode: "direct", status: "ready", outdated: true },
            { id: "ep-2", title: "New one", mode: "direct", status: "ready", outdated: false },
          ],
        };
      }
      if (method === "POST") return { ok: true, queued: 1 };
      return null;
    },
  });
  harness.buttons(harness.byId("usersBody"), "Manage")[0]!.click();
  await harness.flush();
  return harness;
}

const regenPosts = (h: Awaited<ReturnType<typeof openConsole>>) =>
  h.requests.filter((r) => r.method === "POST" && r.path.includes("regenerate"));

Deno.test("the console shows the regenerate counts per subscriber (audio-feed-8oz)", async () => {
  const h = await openConsole();
  assertEquals(h.byId("regenOutdated").textContent, "Regenerate outdated (1)");
  assertEquals(h.byId("regenAll").textContent, "Regenerate all (2)");
  assertEquals(h.buttons(h.byId("manageEpisodesBody"), "Regenerate").length, 2);
});

Deno.test("Regenerate asks first, states the count, and Cancel spends nothing (audio-feed-8oz)", async () => {
  const h = await openConsole();

  h.setConfirmAnswer(false);
  h.byId("regenOutdated").click();
  h.buttons(h.byId("manageEpisodesBody"), "Regenerate")[0]!.click();
  await h.flush();
  assertEquals(h.confirms.length, 2);
  assertStringIncludes(h.confirms[0]!.message, "1 episode");
  assertEquals(regenPosts(h).length, 0, "Cancel must not queue TTS spend");

  h.setConfirmAnswer(true);
  h.byId("regenAll").click();
  await h.flush();
  assertStringIncludes(h.confirms[2]!.message, "2 episodes");
  h.buttons(h.byId("manageEpisodesBody"), "Regenerate")[0]!.click();
  await h.flush();
  const sent = regenPosts(h);
  assertEquals(sent.length, 2);
  assertEquals(sent[0]!.path, "/api/admin/users/user-1/regenerate");
  assertEquals(sent[0]!.body, { scope: "all" });
  assertEquals(sent[1]!.path, "/api/admin/users/user-1/episodes/ep-1/regenerate");
});
