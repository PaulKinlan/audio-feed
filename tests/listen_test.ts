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
  assertStringIncludes(sw, "backgroundfetchsuccess");
  // The offline audio cache must survive a worker update.
  assertStringIncludes(sw, 'name.startsWith("audio-feed-shell-") && name !== SHELL_CACHE');
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
