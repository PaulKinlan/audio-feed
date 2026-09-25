/**
 * Listener app + PWA surface tests (audio-feed-4xb).
 *
 * Two things these are careful about:
 *  1. the page is TOKEN-FRONTED, so an unknown or unapproved token must reach
 *     neither the episode list nor the audio URLs — the token is the only
 *     credential, which makes it the only thing to get wrong;
 *  2. the page can only be verified as working in a browser (a service worker and
 *     offline playback do not exist in a unit test), so these cover what a route
 *     test legitimately can and the report says plainly what was driven in Chrome
 *     instead.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { OFFLINE_CACHE } from "../src/routes/pwa.ts";
import { createServiceWorkerHarness } from "./service_worker_harness.ts";
import type { BackgroundFetchRecordStub } from "./service_worker_harness.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const TOKEN = "token-user-1";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

/** One approved subscriber with two ready episodes and one queued. */
async function seeded(overrides: { token?: string } = {}) {
  const stores: Stores = memoryStores();
  const token = overrides.token ?? TOKEN;
  await stores.metadata.putUser(
    makeUser({ id: "user-1", displayName: "Paul", status: "approved", feedToken: token }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "stratechery", userId: "user-1", title: "Stratechery" }),
  );
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "stratechery",
      author: "Ben Thompson",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-ready-1",
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-1",
      status: "ready",
      title: "The Aggregation Theory of Everything",
      audioKey: "ep-ready-1.wav",
      byteLength: 1024,
      durationSeconds: 1875,
      contentType: "audio/wav",
      mode: "direct",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-ready-2",
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-1",
      status: "ready",
      title: "Deep dive: who captures the value?",
      audioKey: "ep-ready-2.wav",
      mode: "deepdive",
    }),
  );
  // Not publishable: it must not appear, because there is no audio to play.
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-pending-1",
      userId: "user-1",
      sourceId: "stratechery",
      status: "pending",
      title: "Still being made",
      audioKey: undefined,
    }),
  );
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores, ctx };
}

const get = (path: string) => new Request(`${BASE}${path}`);

Deno.test("the player renders the subscriber's ready episodes (audio-feed-4xb)", async () => {
  const { fetch } = await seeded();
  const res = await fetch(get(`/listen/${TOKEN}`));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  // A capability-bearing page must never be cached by anything shared.
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");

  const html = await res.text();
  assertStringIncludes(html, "Paul");
  assertStringIncludes(html, "The Aggregation Theory of Everything");
  assertStringIncludes(html, "Deep dive: who captures the value?");
  assertStringIncludes(html, "Ben Thompson");
  assertStringIncludes(html, "Stratechery");
  // The queued episode must not be offered: there is no audio to play.
  assertEquals(
    html.includes("Still being made"),
    false,
    "an unsynthesised episode must not be listed",
  );
  // The audio element and the enclosure URLs the player will fetch.
  assertStringIncludes(html, '<audio id="audio"');
  assertStringIncludes(html, `${BASE}/audio/ep-ready-1.wav`);
  // Installability and the feed the subscriber can still take to a podcast app.
  assertStringIncludes(html, 'rel="manifest" href="/manifest.json"');
  assertStringIncludes(html, `href="${BASE}/feed/${TOKEN}/master.xml"`);
  assertStringIncludes(html, "mediaSession");
});

Deno.test("the player remembers the token so a home-screen launch needs no typing", async () => {
  const { fetch } = await seeded();
  const html = await (await fetch(get(`/listen/${TOKEN}`))).text();
  assertStringIncludes(html, 'localStorage.setItem("audio-feed-token"');
  // …and /listen restores it client-side, since a server cannot read localStorage.
  const landing = await (await fetch(get("/listen"))).text();
  assertStringIncludes(landing, 'localStorage.getItem("audio-feed-token")');
  assertStringIncludes(landing, 'location.replace("/listen/"');
  assertStringIncludes(landing, "Open my player");
});

Deno.test("the token is the only credential, and it is checked", async () => {
  const { fetch, stores } = await seeded();
  assertEquals((await fetch(get("/listen/nonsense"))).status, 404);

  await stores.metadata.putUser(
    makeUser({
      id: "pending-1",
      email: "p@example.com",
      status: "pending",
      feedToken: "token-pending",
    }),
  );
  // A suspended or pending subscriber must not get a player for paid output.
  assertEquals((await fetch(get("/listen/token-pending"))).status, 403);
});

Deno.test("a hostile token cannot break out of the page's script (audio-feed-4xb)", async () => {
  // Feed tokens are minted base36, but the page embeds whatever token resolved, so
  // the escape must hold for a token that is markup.
  //
  // No "/" in the payload, deliberately: a token containing one cannot match
  // /listen/:token at all (the segment separator is not part of the token), so a
  // slash-bearing payload is refused by ROUTING and would never reach the page's
  // script — testing it would prove nothing about the escape.
  const hostile = 'tok<script>alert(1)</script><img src=x onerror="alert(1)">';
  const { fetch } = await seeded({ token: hostile });
  const res = await fetch(get(`/listen/${encodeURIComponent(hostile)}`));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertEquals(/<script>alert\(1\)/.test(html), false, "the payload must not appear as markup");
  assertStringIncludes(html, "\\u003cscript\\u003e");
  // No tag may have been injected either.
  assertEquals(/<img[^>]*onerror/.test(html), false);
});

Deno.test("the manifest is installable metadata (audio-feed-4xb)", async () => {
  const { fetch } = await seeded();
  const res = await fetch(get("/manifest.json"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "application/manifest+json");
  const manifest = await res.json();
  assertEquals(manifest.name, "Audio Feed");
  assertEquals(manifest.short_name, "AudioFeed");
  assertEquals(manifest.display, "standalone");
  assertEquals(manifest.start_url, "/listen");
  assertEquals(manifest.theme_color, "#18181b");
  assertEquals(manifest.background_color, "#09090b");
  // Installability needs at least one icon of at least 144px; an SVG with
  // sizes "any" satisfies that and keeps the repo free of binary assets.
  assert(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  assert(manifest.icons.every((icon: { sizes: string }) => icon.sizes === "any"));
});

Deno.test("the service worker caches audio first and pages network-first (audio-feed-4xb)", async () => {
  const { fetch } = await seeded();
  const res = await fetch(get("/sw.js"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/javascript");
  // no-cache so a deploy's new worker is actually fetched; scope explicit.
  assertEquals(res.headers.get("cache-control"), "no-cache");
  assertEquals(res.headers.get("service-worker-allowed"), "/");

  const sw = await res.text();
  // The cache name must be the one the player writes downloads into, or a
  // "downloaded" episode would not be found offline.
  assertStringIncludes(sw, JSON.stringify(OFFLINE_CACHE));
  assertStringIncludes(sw, 'addEventListener("install"');
  assertStringIncludes(sw, 'addEventListener("activate"');
  assertStringIncludes(sw, 'addEventListener("fetch"');
  assertStringIncludes(sw, 'url.pathname.startsWith("/audio/")');
  assertStringIncludes(sw, 'request.mode === "navigate"');
  // The three Background Fetch lifecycle handlers are NOT pinned by string presence
  // here any more: they are driven below, against the script that is actually served
  // (audio-feed-qn5). A string check cannot tell a working handler from an empty one.
  // The offline audio cache must survive a worker update.
  assertStringIncludes(sw, 'name.startsWith("audio-feed-shell-") && name !== SHELL_CACHE');
});

// ---------------------------------------------------------------------------
// Background Fetch lifecycle, driven rather than grepped (audio-feed-qn5)
// ---------------------------------------------------------------------------

/** The served worker, run against stubs. Fresh per test: the harness keeps state. */
const swHarness = async () => {
  const { fetch } = await seeded();
  const sw = await (await fetch(get("/sw.js"))).text();
  return createServiceWorkerHarness(sw);
};

const audioRecord = (name: string, response: Response): BackgroundFetchRecordStub => ({
  request: new Request(`${BASE}/audio/${name}`),
  responseReady: Promise.resolve(response),
});

Deno.test("a completed background fetch caches every finished episode offline (audio-feed-qn5)", async () => {
  const harness = await swHarness();
  const outcome = await harness.dispatch("backgroundfetchsuccess", {
    registration: {
      matchAll: () =>
        Promise.resolve([
          audioRecord("ep-1.wav", new Response("one", { status: 200 })),
          audioRecord("ep-2.wav", new Response("two", { status: 200 })),
        ]),
    },
  });

  assertEquals(outcome.waits, 1, "the handler must extend the event's lifetime");
  assertEquals(harness.cachedUrls(OFFLINE_CACHE), [
    `${BASE}/audio/ep-1.wav`,
    `${BASE}/audio/ep-2.wav`,
  ]);
  // The OS notification is the only surface left once the tab is closed.
  assertEquals(harness.updates.at(-1)?.title, "2 episodes ready offline");
});

Deno.test("a partly-failed background fetch caches only the records that finished (audio-feed-qn5)", async () => {
  const harness = await swHarness();
  await harness.dispatch("backgroundfetchsuccess", {
    registration: {
      matchAll: () =>
        Promise.resolve([
          audioRecord("ep-1.wav", new Response("one", { status: 200 })),
          audioRecord("ep-2.wav", new Response("truncated", { status: 500 })),
        ]),
    },
  });

  // The player's whole "is it downloaded?" test is the URL's presence in this cache, so
  // a half-written episode must not be indistinguishable from a complete one.
  assertEquals(harness.cachedUrls(OFFLINE_CACHE), [`${BASE}/audio/ep-1.wav`]);
  assertEquals(
    harness.updates.at(-1)?.title,
    "Episode ready offline",
    "the notification must report what was stored, not how many records were considered",
  );
});

Deno.test("a failed background fetch caches nothing and says how to retry (audio-feed-qn5)", async () => {
  const harness = await swHarness();
  const outcome = await harness.dispatch("backgroundfetchfail", {
    registration: {
      // CACHEABLE on purpose: a handler that cached these would fail this test.
      matchAll: () => Promise.resolve([audioRecord("ep-1.wav", new Response("one"))]),
    },
  });

  assertEquals(outcome.waits, 1, "the handler must extend the event's lifetime");
  assertEquals(harness.cachedUrls(OFFLINE_CACHE), []);
  assertStringIncludes(String(harness.updates.at(-1)?.title), "Download failed");
});

Deno.test("tapping the download notification focuses the open player instead of opening a second copy (audio-feed-qn5)", async () => {
  const harness = await swHarness();
  let focused = 0;
  harness.openClients = [{
    url: `${BASE}/listen/${TOKEN}`,
    focus: () => {
      focused++;
      return Promise.resolve();
    },
  }];

  const withPlayer = await harness.dispatch("backgroundfetchclick");
  assertEquals(withPlayer.waits, 1);
  assertEquals(focused, 1, "an already-open listener must be focused");
  assertEquals(
    harness.opened,
    [],
    "an open player must not be duplicated: two copies means two <audio> elements",
  );

  // Nothing open: the notification is the way back into the player.
  harness.openClients = [];
  await harness.dispatch("backgroundfetchclick");
  assertEquals(harness.opened, ["/listen"]);
});

Deno.test("the icon is served as SVG (audio-feed-4xb)", async () => {
  const { fetch } = await seeded();
  const res = await fetch(get("/icon.svg"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "image/svg+xml");
  const svg = await res.text();
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, 'viewBox="0 0 512 512"');
  assertStringIncludes(svg, "</svg>");
});

Deno.test("the download promises a background fetch only after confirming one (audio-feed-rqp)", async () => {
  // WHAT THIS TEST REPLACES, and why the reversal is not a weakening.
  //
  // Its ancestor asserted the page started NO background fetch at all, because
  // audio-feed-4xb measured the API as non-functional: fetch() resolved, getIds()
  // stayed empty, no event fired. Driven against a real origin the API works end
  // to end; audio-feed-98i carries the correction.
  //
  // An earlier version of this comment blamed headless Chrome for that original
  // finding. RETRACTED: that reading came from about:blank, and headless Chrome
  // 152 on the app's own origin has a service worker and completes a background
  // fetch. What actually makes a working API look broken is measured and narrower
  // — getIds() is empty BOTH when nothing registered and when a fetch has already
  // finished, and only the first fetch per origin is permitted (audio-feed-zlf),
  // so a refused second attempt resolves and then never lists. Either one alone
  // reproduces 4xb's symptom exactly.
  //
  // The DEFECT 4xb identified was real and is still guarded: the page promised
  // "you can close this tab" on the strength of a resolved fetch() alone. A
  // resolved fetch() is not evidence a registration exists. So the promise is now
  // ordered AFTER the confirmation, and that ordering is what this test pins.
  //
  // These are source-position assertions and they are the seam, not the evidence:
  // a string in a page cannot prove a download completes. The behaviour was driven
  // in a browser, and that is recorded on the bead.
  const { fetch } = await seeded();
  const html = await (await fetch(get(`/listen/${TOKEN}`))).text();

  const registered = html.indexOf("backgroundFetch.fetch(");
  const confirmed = html.indexOf("backgroundFetch.getIds()");
  const promised = html.indexOf("you can close this tab");

  assert(registered > 0, "the page must attempt a background fetch");
  assert(confirmed > 0, "the page must confirm the registration exists");
  assert(promised > 0, "the page tells the subscriber the tab can be closed");
  assert(
    confirmed < promised,
    "the OS-level promise must come AFTER getIds() confirms the registration, " +
      "never on the strength of a resolved fetch() — that was the audio-feed-4xb defect",
  );

  // The fallback is the path that runs everywhere. Background Fetch is Chrome-only
  // and not Baseline, so this is the MAJORITY path and must not be a stub.
  assertStringIncludes(html, "const response = await fetch(episode.audioUrl)");
  assertStringIncludes(html, "await store.put(episode.audioUrl, response)");

  // And the cache confirmation is a bounded poll, not a single read: the page's
  // `progress` event fires when the RECORD settles, while the service worker
  // writes the cache independently under waitUntil. A single read returned EMPTY
  // for a download that had in fact succeeded (measured, audio-feed-98i).
  assertStringIncludes(html, "async function waitForCache(");
});
