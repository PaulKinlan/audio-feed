/**
 * Router + app wiring, driven through the real fetch handler.
 *
 * No port is bound: `createApp().fetch` is the same function `Deno.serve` gets,
 * so these assertions are on production dispatch, not a test double.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp, createRouter } from "../src/app.ts";
import { memoryStores } from "../src/config.ts";
import { collect } from "../src/storage/mod.ts";
import { isSafeBlobKey } from "../src/routes/audio.ts";
import { json } from "../src/http.ts";
import { bytes, makeEpisode, makeUser } from "./fixtures.ts";
import type { AppConfig } from "../src/config.ts";

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "https://audio.example.com",
};

function app(handlers = {}) {
  const stores = memoryStores();
  const { fetch } = createApp({ config, stores }, handlers);
  return { fetch, stores };
}

const get = (path: string, init?: RequestInit) =>
  new Request(`https://audio.example.com${path}`, init);

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

Deno.test("health reports the selected storage backends", async () => {
  const { fetch } = app();
  const res = await fetch(get("/health"));

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertStringIncludes(body.storage, "memory");
});

Deno.test("unknown paths are 404 with a stable error shape", async () => {
  const { fetch } = app();
  const res = await fetch(get("/nope"));

  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "not_found");
});

Deno.test("a known path with the wrong method is 405, not 404", async () => {
  const { fetch } = app();
  const res = await fetch(get("/health", { method: "DELETE" }));

  assertEquals(res.status, 405);
  assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
  assertStringIncludes((await res.json()).detail, "GET");
});

Deno.test("HEAD is served by the GET handler", async () => {
  const { fetch } = app();
  const res = await fetch(get("/health", { method: "HEAD" }));

  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("a handler that throws becomes a 500, not a dropped connection", async () => {
  const { fetch } = app({
    ingest: () => {
      throw new Error("boom");
    },
  });

  const res = await fetch(get("/api/ingest", { method: "POST" }));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "internal_error");
});

// ---------------------------------------------------------------------------
// Lane seams
// ---------------------------------------------------------------------------

Deno.test("unwired lane features return 501 rather than 404", async () => {
  const { fetch } = app();

  for (
    const req of [
      get("/feed/tok/master.xml"),
      get("/feed/tok/stratechery/direct.xml"),
      get("/api/ingest", { method: "POST" }),
      get("/api/admin/users/u1/approve", { method: "POST" }),
    ]
  ) {
    const res = await fetch(req);
    assertEquals(res.status, 501, `${req.method} ${new URL(req.url).pathname}`);
    assertEquals((await res.json()).error, "not_implemented");
  }
});

Deno.test("a lane handler receives its path params", async () => {
  const seen: Record<string, string | undefined> = {};
  const { fetch } = app({
    sourceFeed: ({ params }: { params: Record<string, string | undefined> }) => {
      Object.assign(seen, params);
      return json({ ok: true });
    },
  });

  const res = await fetch(get("/feed/tok123/stratechery/deepdive.xml"));
  assertEquals(res.status, 200);
  assertEquals(seen.token, "tok123");
  assertEquals(seen.sourceId, "stratechery");
  assertEquals(seen.mode, "deepdive");
});

Deno.test("feed routes do not shadow each other", () => {
  const router = createRouter();
  const paths = router.list().map((r) => `${r.method} ${r.pathname}`);

  // `/feed/:token/master.xml` must be registered before the 3-segment pattern,
  // or a master feed request is captured by the per-source route.
  const master = paths.indexOf("GET /feed/:token/master.xml");
  const source = paths.indexOf("GET /feed/:token/:sourceId/:mode.xml");
  assert(master >= 0 && source >= 0);
  assert(master < source, "master feed route must be matched first");
});

// ---------------------------------------------------------------------------
// Audio route
// ---------------------------------------------------------------------------

Deno.test("audio: serves a whole object and advertises range support", async () => {
  const { fetch, stores } = app();
  await stores.blobs.put("audio/u1/direct/e1.mp3", bytes(1000), { contentType: "audio/mpeg" });

  const res = await fetch(get("/audio/audio/u1/direct/e1.mp3"));

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "audio/mpeg");
  assertEquals(res.headers.get("content-length"), "1000");
  assertEquals(res.headers.get("accept-ranges"), "bytes");
  assertEquals((await collect(res.body!)).byteLength, 1000);
});

Deno.test("audio: GET skips head() and resolves canonical audio/ key in one get() call (audio-feed-1rx)", async () => {
  const { fetch, stores } = app();
  await stores.blobs.put("audio/u1/direct/e1.mp3", bytes(1000), { contentType: "audio/mpeg" });

  let headCalls = 0;
  let getCalls = 0;
  const originalHead = stores.blobs.head.bind(stores.blobs);
  const originalGet = stores.blobs.get.bind(stores.blobs);

  stores.blobs.head = (key) => {
    headCalls++;
    return originalHead(key);
  };
  stores.blobs.get = (key, opts) => {
    getCalls++;
    return originalGet(key, opts);
  };

  // 1. GET canonical route /audio/u1/direct/e1.mp3
  const getRes = await fetch(get("/audio/u1/direct/e1.mp3"));
  assertEquals(getRes.status, 200);
  await getRes.body?.cancel();

  // Exactly 0 head() calls, 1 get() call
  assertEquals(headCalls, 0, "GET must skip head() entirely");
  assertEquals(getCalls, 1, "Canonical key must resolve in exactly 1 get() call");

  // 2. HEAD canonical route /audio/u1/direct/e1.mp3
  headCalls = 0;
  getCalls = 0;
  const headRes = await fetch(get("/audio/u1/direct/e1.mp3", { method: "HEAD" }));
  assertEquals(headRes.status, 200);
  await headRes.body?.cancel();

  // Exactly 1 head() call, 0 get() calls
  assertEquals(headCalls, 1, "HEAD must resolve in exactly 1 head() call");
  assertEquals(getCalls, 0, "HEAD must not call get()");
});

Deno.test("audio: direct-URL store redirects 302 on GET without calling get() (audio-feed-vnb)", async () => {
  const { fetch, stores } = app();
  let getCalls = 0;
  stores.blobs.get = () => {
    getCalls++;
    throw new Error("get() must not be called when store provides direct URLs");
  };
  stores.blobs.url = (key) => Promise.resolve(`https://cdn.example.com/${key}`);

  const res = await fetch(get("/audio/u1/direct/e1.mp3"));
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "https://cdn.example.com/audio/u1/direct/e1.mp3");
  assertEquals(getCalls, 0, "direct URL must bypass get() completely");
});

Deno.test("audio: HEAD returns metadata with no body", async () => {
  const { fetch, stores } = app();
  await stores.blobs.put("k.mp3", bytes(512), { contentType: "audio/mpeg" });

  const res = await fetch(get("/audio/k.mp3", { method: "HEAD" }));

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-length"), "512");
  assertEquals(res.headers.get("accept-ranges"), "bytes");
  await res.body?.cancel();
});

Deno.test("audio: a Range request gets 206 with the right slice and headers", async () => {
  const { fetch, stores } = app();
  const payload = bytes(1000);
  await stores.blobs.put("k.mp3", payload, { contentType: "audio/mpeg" });

  const res = await fetch(get("/audio/k.mp3", { headers: { range: "bytes=100-199" } }));

  assertEquals(res.status, 206);
  assertEquals(res.headers.get("content-range"), "bytes 100-199/1000");
  assertEquals(res.headers.get("content-length"), "100");
  assertEquals(await collect(res.body!), payload.subarray(100, 200));
});

Deno.test("audio: a suffix Range works (clients resume with these)", async () => {
  const { fetch, stores } = app();
  const payload = bytes(1000);
  await stores.blobs.put("k.mp3", payload, { contentType: "audio/mpeg" });

  const res = await fetch(get("/audio/k.mp3", { headers: { range: "bytes=-100" } }));

  assertEquals(res.status, 206);
  assertEquals(res.headers.get("content-range"), "bytes 900-999/1000");
  assertEquals(await collect(res.body!), payload.subarray(900));
});

Deno.test("audio: an unsatisfiable Range is 416 with content-range", async () => {
  const { fetch, stores } = app();
  await stores.blobs.put("k.mp3", bytes(100), { contentType: "audio/mpeg" });

  const res = await fetch(get("/audio/k.mp3", { headers: { range: "bytes=500-600" } }));

  assertEquals(res.status, 416);
  assertEquals(res.headers.get("content-range"), "bytes */100");
  await res.body?.cancel();
});

Deno.test("audio: a malformed Range is ignored, not fatal", async () => {
  const { fetch, stores } = app();
  await stores.blobs.put("k.mp3", bytes(100), { contentType: "audio/mpeg" });

  const res = await fetch(get("/audio/k.mp3", { headers: { range: "bytes=abc" } }));

  assertEquals(res.status, 200, "an unparseable Range falls back to the full object");
  await res.body?.cancel();
});

Deno.test("audio: a missing object is 404", async () => {
  const { fetch } = app();
  const res = await fetch(get("/audio/missing.mp3"));
  assertEquals(res.status, 404);
});

Deno.test("audio: multi-segment keys survive the router", async () => {
  const { fetch, stores } = app();
  const episode = makeEpisode();
  await stores.blobs.put(episode.audioKey!, bytes(10), { contentType: "audio/mpeg" });

  const res = await fetch(get(`/audio/${episode.audioKey}`));
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("audio: path traversal in a key is refused", () => {
  // Guard the predicate directly — URL normalisation hides some of these before
  // they reach the router, and the predicate is what other lanes will reuse.
  for (const key of ["../secret", "a/../../secret", "/etc/passwd", "a//b", "a/./b", "a\\b", ""]) {
    assertEquals(isSafeBlobKey(key), false, `expected ${JSON.stringify(key)} to be rejected`);
  }
  assertEquals(isSafeBlobKey("audio/u1/direct/e1.mp3"), true);
});

// ---------------------------------------------------------------------------
// Episode listing
// ---------------------------------------------------------------------------

Deno.test("episodes: requires a known user", async () => {
  const { fetch } = app();
  assertEquals((await fetch(get("/api/episodes"))).status, 404);
  assertEquals((await fetch(get("/api/episodes?userId=ghost"))).status, 404);
});

Deno.test("episodes: returns the user's episodes newest first", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(makeUser());
  await stores.metadata.putEpisode(
    makeEpisode({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({ id: "new", createdAt: "2026-09-20T00:00:00.000Z" }),
  );

  const res = await fetch(get("/api/episodes?userId=user-1"));
  assertEquals(res.status, 200);

  const { episodes } = await res.json();
  assertEquals(episodes.map((e: { id: string }) => e.id), ["new", "old"]);
});

Deno.test("episodes: rejects an unknown mode instead of silently ignoring it", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(makeUser());

  const res = await fetch(get("/api/episodes?userId=user-1&mode=whistling"));
  assertEquals(res.status, 404);
});

Deno.test("episodes: never returns another user's episodes", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(makeUser());
  await stores.metadata.putEpisode(makeEpisode({ id: "mine", userId: "user-1" }));
  await stores.metadata.putEpisode(makeEpisode({ id: "theirs", userId: "user-2" }));

  const { episodes } = await (await fetch(get("/api/episodes?userId=user-1"))).json();
  assertEquals(episodes.map((e: { id: string }) => e.id), ["mine"]);
});
