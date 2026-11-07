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
import {
  MAX_OFFLINE_BYTES,
  MAX_OFFLINE_EPISODES,
  OFFLINE_CACHE,
  SENSITIVE_PREFIXES,
  SHELL_CACHE,
} from "../src/routes/pwa.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createServiceWorkerHarness } from "./service_worker_harness.ts";
import type { BackgroundFetchRecordStub } from "./service_worker_harness.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { playerClient, playerData } from "./listen_client.ts";
import { assetBody, assetUrl } from "../src/routes/assets.ts";
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
  // The queued episode must not be OFFERED: there is no audio to play.
  //
  // audio-feed-7s2 deliberately changed what this page displays — an unsynthesised episode now
  // appears in the activity panel as "Queued", which is what the subscriber was missing when the
  // player showed nothing at all. So the assertion is scoped to the thing this test actually
  // guards: the episode must not enter the playable payload, where a row would hand the player an
  // audio URL that does not exist. Testing "the title appears nowhere" was always a wider claim
  // than the comment's intent, and it would now fail for a change that is an improvement.
  const playable = JSON.parse(/const EPISODES = (\[.*?\]);\n/.exec(html)?.[1] ?? "[]");
  assert(
    !playable.some((episode: { title: string }) => episode.title === "Still being made"),
    `an unsynthesised episode must not be offered for playback; playable was ${
      JSON.stringify(
        playable.map((episode: { title: string }) => episode.title),
      )
    }`,
  );
  // And it IS surfaced, as activity, which is the point of 7s2.
  const activity = playerData(html).activity ?? {};
  assert(
    (activity.inProgress ?? []).some((entry: { title: string }) =>
      entry.title === "Still being made"
    ),
    "the queued episode must be visible as in-progress work",
  );
  // The audio element and the enclosure URLs the player will fetch.
  assertStringIncludes(html, '<audio id="audio"');
  assertStringIncludes(html, `${BASE}/audio/user-1/direct/ep-ready-1.wav`);
  // Installability and the feed the subscriber can still take to a podcast app.
  assertStringIncludes(html, 'rel="manifest" href="/manifest.json"');
  assertStringIncludes(html, `href="${BASE}/feed/${TOKEN}/master.xml"`);
  // audio-feed-3xq: the client is a content-addressed asset now, so the assertion follows the link
  // the page actually renders rather than reading the page as source.
  const client = await playerClient(fetch, BASE, html);
  assertStringIncludes(client, "mediaSession");
});

Deno.test("a home-screen launch still needs no typing, and stores no capability (audio-feed-b6nr)", async () => {
  // This test used to assert the opposite: that the client wrote the feed token into
  // localStorage so a home-screen launch could restore it (see the git history — the test was
  // named "the player remembers the token so a home-screen launch needs no typing"). The
  // user-visible property is unchanged, and it is what this asserts. What changed is where it
  // comes from: the bare /listen path now resolves the session on the server and redirects, so
  // the capability never has to be at rest in storage a script can read.
  const { fetch } = await seeded();
  const html = await (await fetch(get(`/listen/${TOKEN}`))).text();
  const client = await playerClient(fetch, BASE, html);

  const player = assetBody("listen.js")!;
  assertEquals(
    player.includes('setItem("audio-feed-token"') || player.includes('getItem("audio-feed-token"'),
    false,
    "the player must neither store nor read the capability",
  );
  assertStringIncludes(
    player,
    'removeItem("audio-feed-token")',
    "it must also clear the entry that older versions left behind",
  );
  assertEquals(
    assetBody("listen-landing.js")!.includes("audio-feed-token"),
    false,
    "the landing client must not read the capability",
  );
  assertEquals(
    assetBody("home.js")!.includes("audio-feed-token"),
    false,
    "the front door must not read the capability",
  );

  // It still scopes its storage per subscriber — by the id the server hands it, which is a
  // namespace rather than a credential (a key name is as readable as a value, which is why
  // naming the capability in four keys was the same exposure as storing it once).
  assertStringIncludes(client, "function scopedKey");
  assertStringIncludes(client, "audio-feed-${kind}:${SCOPE}");
  assertStringIncludes(client, "adoptScopedKey");
  assertEquals(playerData(html).userId, "user-1");

  const landing = await (await fetch(get("/listen"))).text();
  assertStringIncludes(landing, "Open my player");
  assertStringIncludes(
    landing,
    assetUrl("listen-landing.js"),
    "landing must link the client it relies on",
  );
});

Deno.test("the bare /listen launch resolves the session server-side (audio-feed-b6nr)", async () => {
  const { fetch, stores } = await seeded();

  // No session: the landing page, exactly as before.
  const anon = await fetch(get("/listen"));
  assertEquals(anon.status, 200);

  // With a session: straight to the player, which is what the home screen used to get from
  // localStorage — minus the stored credential.
  const cookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, "user-1")}`;
  const launch = await fetch(new Request(`${BASE}/listen`, { headers: { cookie } }));
  assertEquals(launch.status, 302);
  assertEquals(launch.headers.get("location"), `/listen/${TOKEN}`);
  assertEquals(
    launch.headers.get("cache-control"),
    "no-store",
    "a redirect that depends on a session must not be cached",
  );

  // A session whose subscriber is not approved is not a way past the approval gate.
  await stores.metadata.putUser(
    makeUser({ id: "user-pending", status: "pending", feedToken: "token-pending" }),
  );
  const pendingCookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, "user-pending")}`;
  const pending = await fetch(
    new Request(`${BASE}/listen`, { headers: { cookie: pendingCookie } }),
  );
  assertEquals(pending.status, 200);
  assertStringIncludes(
    await pending.text(),
    "Open my player",
    "an unapproved subscriber must still see the landing page",
  );
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
  // A suspended or pending subscriber must not get a player for paid output — and the
  // refusal must not DISCLOSE the account state (audio-feed-se8s8, the audio-feed-7kdhb
  // precedent on /audio): a refusal that differs by moderation status tells a token
  // holder both that the token is valid and what the status is. The pending token gets
  // byte-for-byte what an unknown token gets, on the page and on the status poll alike.
  const unknownPage = await fetch(get("/listen/nonsense"));
  const unknownBody = await unknownPage.text();
  assertStringIncludes(unknownBody, "Unknown feed");
  const pendingPage = await fetch(get("/listen/token-pending"));
  assertEquals(pendingPage.status, 404);
  assertEquals(await pendingPage.text(), unknownBody);
  const unknownPoll = await fetch(get("/listen/nonsense/status"));
  const unknownPollBody = await unknownPoll.text();
  const pendingPoll = await fetch(get("/listen/token-pending/status"));
  assertEquals(pendingPoll.status, 404);
  assertEquals(await pendingPoll.text(), unknownPollBody);
});

Deno.test("retry refuses an unapproved token with the uniform 404, byte-identical to an unknown one (audio-feed-se8s8)", async () => {
  // The retry POST is the last member of the se8s8 disclosure class and had NO test
  // coverage at all. The pin row (git history) recorded the pre-change behaviour:
  // unknown token 404 {"error":"Unknown feed"}; pending and rejected tokens 403
  // {"error":"Retry unavailable (status: pending|rejected)"} — an account-state
  // oracle. The route now answers exactly what an unknown token sees.
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-pending", status: "pending", feedToken: "token-pending" }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-rejected", status: "rejected", feedToken: "token-rejected" }),
  );
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const retry = (token: string) =>
    fetch(
      new Request(`${BASE}/listen/${token}/episodes/ep-x/retry`, {
        method: "POST",
        headers: { origin: BASE },
      }),
    );

  const unknown = await retry("token-unknown");
  assertEquals(unknown.status, 404);
  const unknownBody = await unknown.text();
  assertEquals(unknownBody, '{"error":"Unknown feed"}');

  const pending = await retry("token-pending");
  assertEquals(pending.status, 404);
  assertEquals(await pending.text(), unknownBody);

  const rejected = await retry("token-rejected");
  assertEquals(rejected.status, 404);
  assertEquals(await rejected.text(), unknownBody);
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
  // The offline audio cache must survive a worker update — the CURRENT generation
  // (audio-feed-vnu4g); superseded generations of both families are swept, so the
  // filter must still exclude the live names from its own cleanup.
  assertStringIncludes(sw, "name !== SHELL_CACHE && name !== OFFLINE_CACHE");
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

Deno.test("background fetch records are resolved and cached concurrently, not one at a time (audio-feed-i6eg)", async () => {
  const harness = await swHarness();
  let inFlight = 0;
  let peak = 0;
  // The getter is the observable: it is read once per record, and the delay means a
  // serial loop finishes one record before it reads the next one's promise.
  const trackedRecord = (name: string): BackgroundFetchRecordStub => ({
    request: new Request(`${BASE}/audio/${name}`),
    get responseReady() {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          inFlight--;
          resolve(new Response(name, { status: 200 }));
        }, 5);
      });
    },
  });

  await harness.dispatch("backgroundfetchsuccess", {
    registration: {
      // More records than the batch, so the test sees both overlap and the bound.
      matchAll: () =>
        Promise.resolve([
          trackedRecord("ep-1.wav"),
          trackedRecord("ep-2.wav"),
          trackedRecord("ep-3.wav"),
          trackedRecord("ep-4.wav"),
          trackedRecord("ep-5.wav"),
          trackedRecord("ep-6.wav"),
        ]),
    },
  });

  assertEquals(harness.cachedUrls(OFFLINE_CACHE).length, 6);
  assertEquals(harness.updates.at(-1)?.title, "6 episodes ready offline");
  assert(
    peak > 1,
    "records must be awaited and cached concurrently; the notification used to wait on the sum of them",
  );
  assert(peak < 6, "six records must not all be resolved at once");
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

function navigateRequest(url: string, headers: HeadersInit = {}): Request {
  const req = new Request(url, { headers });
  Object.defineProperty(req, "mode", { value: "navigate" });
  return req;
}

Deno.test("the service worker does not cache capability-bearing or admin navigation responses (audio-feed-s3f0)", async () => {
  const { fetch: appFetch, stores } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();

  // Create admin user and sessions
  const adminUser = makeUser({
    id: "admin-user",
    isAdmin: true,
    status: "approved",
    feedToken: "admin-feed-tok",
  });
  await stores.metadata.putUser(adminUser);
  const adminCookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, adminUser.id)}`;
  const userCookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, "user-1")}`;

  const harness = createServiceWorkerHarness(swText, appFetch);

  // 1. Navigation to capability-bearing player: /listen/<token>
  const listenRes = await harness.dispatch("fetch", {
    request: navigateRequest(`${BASE}/listen/${TOKEN}`, { accept: "text/html" }),
  });
  assertEquals(listenRes.response?.status, 200);

  // 2. Navigation to admin console: /admin
  const adminRes = await harness.dispatch("fetch", {
    request: navigateRequest(`${BASE}/admin`, {
      accept: "text/html",
      cookie: adminCookie,
    }),
  });
  assertEquals(adminRes.response?.status, 200);

  // 3. Navigation to account page: /account
  const accountRes = await harness.dispatch("fetch", {
    request: navigateRequest(`${BASE}/account`, {
      accept: "text/html",
      cookie: userCookie,
    }),
  });
  assertEquals(accountRes.response?.status, 200);

  // Verify SHELL_CACHE contains NONE of these sensitive pages
  const cachedShell = harness.cachedUrls(SHELL_CACHE);
  assert(
    !cachedShell.some((url) => url.includes("/listen/")),
    `Capability player must not be stored in shell cache: ${cachedShell.join(", ")}`,
  );
  assert(
    !cachedShell.some((url) => url.includes("/admin")),
    `Admin console must not be stored in shell cache: ${cachedShell.join(", ")}`,
  );
  assert(
    !cachedShell.some((url) => url.includes("/account")),
    `Account page must not be stored in shell cache: ${cachedShell.join(", ")}`,
  );

  // 4. Non-sensitive navigation (e.g. unauthenticated home) CAN be cached
  const homeRes = await harness.dispatch("fetch", {
    request: navigateRequest(`${BASE}/`, { accept: "text/html" }),
  });
  assertEquals(homeRes.response?.status, 200);
  const updatedShell = harness.cachedUrls(SHELL_CACHE);
  assert(
    updatedShell.includes(`${BASE}/`),
    `Public home page should be cached in shell cache: ${updatedShell.join(", ")}`,
  );
});

Deno.test("every sensitive path prefix is refused caching by the service worker writer path and offline fallback serves no secrets (audio-feed-9ooyy)", async () => {
  const { fetch: appFetch } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();

  // Test 1: Service worker admission refuse gate.
  // Dispatch navigations for every prefix in SENSITIVE_PREFIXES through a harness
  // that simulates a 200 OK HTML response WITHOUT no-store (e.g. public cache-control).
  // This isolates and asserts that the SENSITIVE_PREFIXES admission check in SW
  // unconditionally refuses caching even if the server were to omit no-store.
  // NOTE: On main, /listen (without trailing slash) with 200 OK and no no-store
  // reddens because "/listen".startsWith("/listen/") was false!
  const testPaths = [
    ...SENSITIVE_PREFIXES.map((prefix) => `${BASE}${prefix}`),
    `${BASE}/admin/subscribers`,
    `${BASE}/admin/observability`,
    `${BASE}/account/profile`,
    `${BASE}/listen/${TOKEN}`,
    `${BASE}/feed/${TOKEN}`,
  ];

  for (const testUrl of testPaths) {
    const harness = createServiceWorkerHarness(
      swText,
      () =>
        Promise.resolve(
          new Response("<!doctype html><html><body>sensitive content</body></html>", {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "public, max-age=3600",
            },
          }),
        ),
    );

    const res = await harness.dispatch("fetch", {
      request: navigateRequest(testUrl, { accept: "text/html" }),
    });
    assertEquals(res.response?.status, 200);

    const cachedShell = harness.cachedUrls(SHELL_CACHE);
    assertEquals(
      cachedShell,
      [],
      `Sensitive path ${testUrl} must never be stored in shell cache through writer path: ${
        cachedShell.join(", ")
      }`,
    );
  }

  // Test 2: Offline fallback navigation serves the static generic fallback, never sensitive content
  const offlineHarness = createServiceWorkerHarness(
    swText,
    () => Promise.reject(new TypeError("Failed to fetch (offline)")),
  );

  for (const testUrl of testPaths) {
    const res = await offlineHarness.dispatch("fetch", {
      request: navigateRequest(testUrl, { accept: "text/html" }),
    });
    assertEquals(res.response?.status, 200);
    const body = await res.response?.text();
    assertStringIncludes(body ?? "", "<h1>Offline</h1>");
    assertStringIncludes(body ?? "", "Open this app once while online");
    assert(
      !body?.includes("sensitive content"),
      `Offline body must not contain sensitive content for ${testUrl}`,
    );
  }
  assertEquals(
    offlineHarness.cachedUrls(SHELL_CACHE),
    [],
    "Offline requests must not populate shell cache with sensitive routes",
  );

  // Test 3: Sign-out preserves non-sensitive shell (manifest, icon, public home) while purging OFFLINE_CACHE
  const signoutHarness = createServiceWorkerHarness(
    swText,
    (request) =>
      request.url.endsWith("/api/auth/logout")
        ? Promise.resolve(new Response(null, { status: 303, headers: { location: "/" } }))
        : appFetch(request),
  );
  signoutHarness.seedCache(
    OFFLINE_CACHE,
    `${BASE}/audio/ep-1.wav`,
    new Response("audio", { status: 200 }),
  );
  signoutHarness.seedCache(
    SHELL_CACHE,
    `${BASE}/manifest.json`,
    new Response("{}", { status: 200 }),
  );
  signoutHarness.seedCache(
    SHELL_CACHE,
    `${BASE}/icon.svg`,
    new Response("<svg/>", { status: 200 }),
  );
  signoutHarness.seedCache(
    SHELL_CACHE,
    `${BASE}/`,
    new Response("<!doctype html>home", { status: 200 }),
  );

  const signoutRes = await signoutHarness.dispatch("fetch", {
    request: postRequest("/api/auth/logout"),
  });
  assertEquals(signoutRes.response?.status, 303);
  assertEquals(
    signoutHarness.cacheNames().includes(OFFLINE_CACHE),
    false,
    "Offline audio cache must be purged on sign-out",
  );
  assertEquals(
    signoutHarness.cachedUrls(SHELL_CACHE),
    [`${BASE}/manifest.json`, `${BASE}/icon.svg`, `${BASE}/`],
    "Non-sensitive shell cache entries must survive sign-out to preserve offline installability",
  );
});

Deno.test("service worker activation purges previous shell cache versions while preserving offline audio (audio-feed-s3f0)", async () => {
  const { fetch: appFetch } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();
  const harness = createServiceWorkerHarness(swText, appFetch);

  // Seed old v1 shell cache with a sensitive URL, and offline audio cache with an episode
  harness.seedCache(
    "audio-feed-shell-v1",
    `${BASE}/admin`,
    new Response("leaked-admin-html", { status: 200 }),
  );
  harness.seedCache(
    OFFLINE_CACHE,
    `${BASE}/audio/ep-1.wav`,
    new Response("audio-bytes", { status: 200 }),
  );

  // Activate new service worker
  const outcome = await harness.dispatch("activate");
  assertEquals(outcome.waits, 1, "activate handler must extend lifetime");

  const names = harness.cacheNames();
  assert(
    !names.includes("audio-feed-shell-v1"),
    "old audio-feed-shell-v1 cache must be deleted on activation",
  );
  assert(
    names.includes(OFFLINE_CACHE),
    "offline audio cache must survive service worker activation",
  );
});

// audio-feed-vnu4g: sign-out and token rotation purge the downloaded library.
// These drive the SERVED worker through the harness — the same defect class the
// background-fetch tests fixed (audio-feed-qn5): a string assertion cannot tell a
// purge that runs from a purge that is registered and empty.
const postRequest = (path: string): Request => new Request(`${BASE}${path}`, { method: "POST" });

Deno.test("sign-out purges the offline audio cache but not the shell (audio-feed-vnu4g)", async () => {
  const { fetch: appFetch } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();
  const harness = createServiceWorkerHarness(
    swText,
    (request) =>
      request.url.endsWith("/api/auth/logout")
        ? Promise.resolve(new Response(null, { status: 303, headers: { location: "/" } }))
        : appFetch(request),
  );
  harness.seedCache(OFFLINE_CACHE, `${BASE}/audio/ep-1.wav`, new Response("one", { status: 200 }));
  harness.seedCache(OFFLINE_CACHE, `${BASE}/audio/ep-2.wav`, new Response("two", { status: 200 }));
  harness.seedCache(SHELL_CACHE, `${BASE}/manifest.json`, new Response("{}", { status: 200 }));

  // The no-script logout is a form POST; the worker passes it through and answers
  // with the server's redirect untouched.
  const outcome = await harness.dispatch("fetch", { request: postRequest("/api/auth/logout") });
  // The cache assertion against the unfixed worker is the red that names the bug —
  // the library survives sign-out.
  assertEquals(
    harness.cacheNames().includes(OFFLINE_CACHE),
    false,
    "the downloaded library must not survive sign-out",
  );
  assertEquals(
    outcome.response?.status,
    303,
    "the worker must return the server's response untouched",
  );
  assertEquals(
    harness.cachedUrls(SHELL_CACHE),
    [`${BASE}/manifest.json`],
    "the install shell (manifest, icon) is not subscriber data and must survive sign-out",
  );
});

Deno.test("a JSON sign-out (scripted fetch) also purges the offline cache (audio-feed-vnu4g)", async () => {
  const { fetch: appFetch } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();
  const harness = createServiceWorkerHarness(
    swText,
    (request) =>
      request.url.endsWith("/api/auth/logout")
        ? Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        : appFetch(request),
  );
  harness.seedCache(OFFLINE_CACHE, `${BASE}/audio/ep-1.wav`, new Response("one", { status: 200 }));

  await harness.dispatch("fetch", { request: postRequest("/api/auth/logout") });
  assertEquals(
    harness.cacheNames().includes(OFFLINE_CACHE),
    false,
    "the JSON logout must purge the same cache the form logout does",
  );
});

Deno.test("feed-token rotation purges the offline cache (audio-feed-vnu4g)", async () => {
  const { fetch: appFetch } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();
  const harness = createServiceWorkerHarness(
    swText,
    (request) =>
      request.url.endsWith("/api/account/rotate-token")
        ? Promise.resolve(new Response(JSON.stringify({ token: "new-token" }), { status: 200 }))
        : appFetch(request),
  );
  harness.seedCache(OFFLINE_CACHE, `${BASE}/audio/ep-1.wav`, new Response("one", { status: 200 }));

  await harness.dispatch("fetch", { request: postRequest("/api/account/rotate-token") });
  assertEquals(
    harness.cacheNames().includes(OFFLINE_CACHE),
    false,
    "the downloaded library must not survive a feed-token rotation",
  );
});

Deno.test("a failed sign-out purges nothing, and unrelated POSTs are never intercepted (audio-feed-vnu4g)", async () => {
  const { fetch: appFetch } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();
  const harness = createServiceWorkerHarness(
    swText,
    (request) =>
      request.method === "POST"
        ? Promise.resolve(new Response("no", { status: 500 }))
        : appFetch(request),
  );
  harness.seedCache(OFFLINE_CACHE, `${BASE}/audio/ep-1.wav`, new Response("one", { status: 200 }));

  // The server did not confirm the sign-out: the cache must stay.
  const failed = await harness.dispatch("fetch", { request: postRequest("/api/auth/logout") });
  assertEquals(failed.response?.status, 500);
  assertEquals(
    harness.cacheNames().includes(OFFLINE_CACHE),
    true,
    "a failed sign-out must not purge the library",
  );

  // Any other POST is outside the worker's purge scope: it must not respond at all.
  const unrelated = await harness.dispatch("fetch", {
    request: postRequest("/api/account/profile"),
  });
  assertEquals(
    unrelated.waits,
    0,
    "the worker must not respondWith on a POST it does not own",
  );
  assertEquals(harness.cachedUrls(OFFLINE_CACHE), [`${BASE}/audio/ep-1.wav`]);
});

Deno.test("a successful sign-in leaves a signed-in subscriber's library untouched (audio-feed-vnu4g)", async () => {
  const { fetch: appFetch } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();
  const harness = createServiceWorkerHarness(
    swText,
    (request) =>
      request.url.endsWith("/api/auth/login")
        ? Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        : appFetch(request),
  );
  harness.seedCache(OFFLINE_CACHE, `${BASE}/audio/ep-1.wav`, new Response("one", { status: 200 }));
  harness.seedCache(OFFLINE_CACHE, `${BASE}/audio/ep-2.wav`, new Response("two", { status: 200 }));

  // Sign-in is the opposite of sign-out: a CONFIRMED success (2xx) must leave the
  // library exactly as it was, and the worker must not interpose on a POST it
  // does not own.
  const outcome = await harness.dispatch("fetch", { request: postRequest("/api/auth/login") });
  assertEquals(
    outcome.waits,
    0,
    "the worker must not respondWith on a POST it does not own",
  );
  assertEquals(
    harness.cachedUrls(OFFLINE_CACHE),
    [`${BASE}/audio/ep-1.wav`, `${BASE}/audio/ep-2.wav`],
    "a signed-in subscriber's downloaded library must survive a successful sign-in",
  );
});

Deno.test("activation sweeps superseded offline-cache generations while preserving the current one (audio-feed-vnu4g)", async () => {
  const { fetch: appFetch } = await seeded();
  const swText = await (await appFetch(get("/sw.js"))).text();
  const harness = createServiceWorkerHarness(swText, appFetch);
  harness.seedCache(
    "audio-feed-offline-v0",
    `${BASE}/audio/stale.wav`,
    new Response("old-generation", { status: 200 }),
  );
  harness.seedCache(OFFLINE_CACHE, `${BASE}/audio/ep-1.wav`, new Response("one", { status: 200 }));

  await harness.dispatch("activate");
  assertEquals(
    harness.cacheNames().includes("audio-feed-offline-v0"),
    false,
    "a superseded offline generation must not survive activation forever",
  );
  assertEquals(
    harness.cachedUrls(OFFLINE_CACHE),
    [`${BASE}/audio/ep-1.wav`],
    "the current generation is the subscriber's live library and must survive",
  );
});

Deno.test(
  "offline audio cache is bounded at MAX_OFFLINE_EPISODES: background fetch evicts oldest entries and keeps newest (audio-feed-g3noh)",
  async () => {
    const harness = await swHarness();

    // Seed MAX_OFFLINE_EPISODES (20) entries into OFFLINE_CACHE with explicit x-stored-at stamps:
    // ep-1 was stored at t=1001, ep-2 at t=1002, ..., ep-20 at t=1020.
    for (let i = 1; i <= MAX_OFFLINE_EPISODES; i++) {
      harness.seedCache(
        OFFLINE_CACHE,
        `${BASE}/audio/ep-${i}.wav`,
        new Response(`payload-${i}`, {
          status: 200,
          headers: { "x-stored-at": String(1000 + i) },
        }),
      );
    }
    assertEquals(
      harness.cachedUrls(OFFLINE_CACHE).length,
      MAX_OFFLINE_EPISODES,
      `initial cache has exactly ${MAX_OFFLINE_EPISODES} entries`,
    );

    // Dispatch backgroundfetchsuccess with 5 new records (ep-21..ep-25).
    // Total inserted is now 25 entries (N = 25 > budget 20).
    const newRecords: BackgroundFetchRecordStub[] = [];
    for (let i = MAX_OFFLINE_EPISODES + 1; i <= MAX_OFFLINE_EPISODES + 5; i++) {
      newRecords.push(
        audioRecord(
          `ep-${i}.wav`,
          new Response(`payload-${i}`, { status: 200 }),
        ),
      );
    }

    const outcome = await harness.dispatch("backgroundfetchsuccess", {
      registration: { matchAll: () => Promise.resolve(newRecords) },
    });
    assertEquals(outcome.waits, 1, "handler must extend event lifetime");

    const cached = harness.cachedUrls(OFFLINE_CACHE);
    // 1. Total remaining must be capped at MAX_OFFLINE_EPISODES
    assertEquals(
      cached.length,
      MAX_OFFLINE_EPISODES,
      `cache must be bounded to ${MAX_OFFLINE_EPISODES} entries`,
    );

    // 2. The 5 oldest (ep-1..ep-5) must be gone
    for (let i = 1; i <= 5; i++) {
      assertEquals(
        cached.includes(`${BASE}/audio/ep-${i}.wav`),
        false,
        `oldest episode ep-${i}.wav must be evicted`,
      );
    }

    // 3. The newest entries (ep-6..ep-25) must survive
    for (let i = 6; i <= MAX_OFFLINE_EPISODES + 5; i++) {
      assertEquals(
        cached.includes(`${BASE}/audio/ep-${i}.wav`),
        true,
        `newer episode ep-${i}.wav must survive in cache`,
      );
    }

    // 4. A fresh read of the newest episode hits the cache and returns 200
    const readHit = await harness.dispatch("fetch", {
      request: new Request(`${BASE}/audio/ep-25.wav`),
    });
    assertEquals(readHit.response?.status, 200);
    assertEquals(await readHit.response?.text(), "payload-25");

    // 5. A read of an evicted episode misses the offline cache (and triggers network fetch or 503)
    const readMiss = await harness.dispatch("fetch", {
      request: new Request(`${BASE}/audio/ep-1.wav`),
    });
    // In harness, un-stubbed audio fetch rejects and returns 503 ("Could not load this episode's audio")
    assertEquals(readMiss.response?.status, 503);
  },
);

Deno.test(
  "offline cache eviction orders by x-stored-at timestamp, preserving newer downloads regardless of key order (audio-feed-g3noh)",
  async () => {
    const harness = await swHarness();

    // Insert 19 background records
    const initialRecords: BackgroundFetchRecordStub[] = [];
    for (let i = 1; i <= 19; i++) {
      initialRecords.push(
        audioRecord(`ep-${i}.wav`, new Response(`content-${i}`, { status: 200 })),
      );
    }
    await harness.dispatch("backgroundfetchsuccess", {
      registration: { matchAll: () => Promise.resolve(initialRecords) },
    });

    // Seed two entries: ep-oldest was stored in the past (t=100), ep-newest was stored in the future (Date.now() + 1_000_000)
    harness.seedCache(
      OFFLINE_CACHE,
      `${BASE}/audio/ep-oldest.wav`,
      new Response("old", { status: 200, headers: { "x-stored-at": "100" } }),
    );
    harness.seedCache(
      OFFLINE_CACHE,
      `${BASE}/audio/ep-newest.wav`,
      new Response("new", {
        status: 200,
        headers: { "x-stored-at": String(Date.now() + 1_000_000) },
      }),
    );

    // Total in cache is now 21 (> 20). Adding one more record via background fetch triggers eviction.
    await harness.dispatch("backgroundfetchsuccess", {
      registration: {
        matchAll: () =>
          Promise.resolve([
            audioRecord("ep-extra.wav", new Response("extra", { status: 200 })),
          ]),
      },
    });

    const urls = harness.cachedUrls(OFFLINE_CACHE);
    assertEquals(urls.length, MAX_OFFLINE_EPISODES);
    assertEquals(urls.includes(`${BASE}/audio/ep-oldest.wav`), false, "ep-oldest must be evicted");
    assertEquals(urls.includes(`${BASE}/audio/ep-newest.wav`), true, "ep-newest must survive");
    assertEquals(urls.includes(`${BASE}/audio/ep-extra.wav`), true, "ep-extra must survive");
  },
);

Deno.test(
  "offline cache eviction never touches the shell cache (audio-feed-g3noh)",
  async () => {
    const harness = await swHarness();
    harness.seedCache(SHELL_CACHE, `${BASE}/manifest.json`, new Response("{}", { status: 200 }));
    harness.seedCache(SHELL_CACHE, `${BASE}/icon.svg`, new Response("<svg/>", { status: 200 }));

    // Fill OFFLINE_CACHE past budget
    for (let i = 1; i <= MAX_OFFLINE_EPISODES + 5; i++) {
      harness.seedCache(
        OFFLINE_CACHE,
        `${BASE}/audio/ep-${i}.wav`,
        new Response(`p-${i}`, { status: 200, headers: { "x-stored-at": String(i) } }),
      );
    }

    await harness.dispatch("backgroundfetchsuccess", {
      registration: {
        matchAll: () =>
          Promise.resolve([
            audioRecord("ep-trigger.wav", new Response("trigger", { status: 200 })),
          ]),
      },
    });

    // Shell cache must be 100% untouched
    assertEquals(harness.cachedUrls(SHELL_CACHE), [
      `${BASE}/manifest.json`,
      `${BASE}/icon.svg`,
    ]);
  },
);

Deno.test(
  "the player client defines MAX_OFFLINE_EPISODES, stamps responses with x-stored-at, and bounds the cache (audio-feed-g3noh)",
  async () => {
    const client = assetBody("listen.js")!;

    assertStringIncludes(
      client,
      "const MAX_OFFLINE_BYTES = DATA.maxOfflineBytes ?? 640 * 1024 * 1024",
    );
    assertStringIncludes(client, "const MAX_OFFLINE_EPISODES = DATA.maxOfflineEpisodes ?? 20");
    assertStringIncludes(client, 'headers.set("x-stored-at", String(Date.now()))');
    assertStringIncludes(client, "async function boundOfflineAudio(");
    assertStringIncludes(client, "await boundOfflineAudio(store, episode.audioUrl)");
    assertStringIncludes(client, "async function syncSavedUI(");

    // Verify player page injects maxOfflineEpisodes: 20 and maxOfflineBytes: 671088640
    const { fetch } = await seeded();
    const pageRes = await fetch(get(`/listen/${TOKEN}`));
    const html = await pageRes.text();
    assertStringIncludes(html, '"maxOfflineBytes":671088640');
    assertStringIncludes(html, '"maxOfflineEpisodes":20');
  },
);

Deno.test(
  "client-side offline cache bounding never evicts the actively playing episode (audio-feed-g3noh)",
  async () => {
    const client = assetBody("listen.js")!;
    const entries = new Map<string, Response>();
    const fakeStore = {
      keys: () => Promise.resolve([...entries.keys()].map((u) => new Request(u))),
      match: (req: Request | string) => {
        const u = typeof req === "string" ? req : req.url;
        return Promise.resolve(entries.get(u));
      },
      delete: (req: Request | string) => {
        const u = typeof req === "string" ? req : req.url;
        entries.delete(u);
        return Promise.resolve(true);
      },
    };

    // Seed 21 entries: ep-active (t=1, oldest), ep-2 (t=2), ... ep-21 (t=21)
    const activeUrl = `${BASE}/audio/ep-active.wav`;
    entries.set(
      activeUrl,
      new Response("active", { headers: { "x-stored-at": "1" } }),
    );
    for (let i = 2; i <= 21; i++) {
      entries.set(
        `${BASE}/audio/ep-${i}.wav`,
        new Response(`p-${i}`, { headers: { "x-stored-at": String(i) } }),
      );
    }
    assertEquals(entries.size, 21);

    // Evaluate boundOfflineAudio with audio.src = activeUrl
    const boundFnSrc = client.slice(
      client.indexOf("async function boundOfflineAudio("),
      client.indexOf("async function syncSavedUI("),
    );
    const fn = new Function(
      "store",
      "protectedUrl",
      "maxBytes",
      "maxEntries",
      "audio",
      "current",
      `
      const MAX_OFFLINE_BYTES = 640 * 1024 * 1024;
      const MAX_OFFLINE_EPISODES = 20;
      ${boundFnSrc}
      return boundOfflineAudio(store, protectedUrl, maxBytes, maxEntries);
    `,
    );

    await fn(fakeStore, undefined, MAX_OFFLINE_BYTES, 20, { src: activeUrl }, null);

    // ep-active was the oldest (t=1), but because it is actively playing, it MUST NOT be evicted!
    // ep-2 (t=2) was next oldest, so it must be evicted instead.
    assertEquals(entries.size, 20, "cache must be bounded to 20");
    assertEquals(entries.has(activeUrl), true, "currently playing episode must survive eviction");
    assertEquals(
      entries.has(`${BASE}/audio/ep-2.wav`),
      false,
      "next oldest non-playing episode must be evicted",
    );
  },
);

Deno.test(
  "offline audio cache byte-triggered eviction evicts oldest entries when exceeding MAX_OFFLINE_BYTES even when under MAX_OFFLINE_EPISODES (audio-feed-cby)",
  async () => {
    const harness = await swHarness();

    // 2 entries of 400 MB each (total 800 MB > 640 MB MAX_OFFLINE_BYTES).
    // 2 entries is well under the 20-entry cap (2 < 20).
    const fourHundredMB = 400 * 1024 * 1024;
    harness.seedCache(
      OFFLINE_CACHE,
      `${BASE}/audio/ep-big-1.wav`,
      new Response("dummy-body-1", {
        status: 200,
        headers: {
          "x-stored-at": "1000",
          "content-length": String(fourHundredMB),
        },
      }),
    );

    // Dispatch backgroundfetchsuccess with second 400 MB record.
    await harness.dispatch("backgroundfetchsuccess", {
      registration: {
        matchAll: () =>
          Promise.resolve([
            audioRecord(
              "ep-big-2.wav",
              new Response("dummy-body-2", {
                status: 200,
                headers: { "content-length": String(fourHundredMB) },
              }),
            ),
          ]),
      },
    });

    const cached = harness.cachedUrls(OFFLINE_CACHE);
    // Under entry cap (1 <= 20), but eviction triggered because 800 MB > 640 MB.
    assertEquals(cached.length, 1, "cache must be bounded to 1 entry due to MAX_OFFLINE_BYTES");
    assertEquals(
      cached.includes(`${BASE}/audio/ep-big-1.wav`),
      false,
      "older 400 MB entry must be evicted",
    );
    assertEquals(
      cached.includes(`${BASE}/audio/ep-big-2.wav`),
      true,
      "newer 400 MB entry must survive",
    );
  },
);

Deno.test(
  "foregroundDownload bounds the offline audio cache after put, and removing the bounding call fails the test (audio-feed-cby)",
  async () => {
    const client = assetBody("listen.js")!;
    const entries = new Map<string, Response>();
    const fakeStore = {
      keys: () => Promise.resolve([...entries.keys()].map((u) => new Request(u))),
      match: (req: Request | string) => {
        const u = typeof req === "string" ? req : req.url;
        const res = entries.get(u);
        return Promise.resolve(res ? res.clone() : undefined);
      },
      put: (req: Request | string, res: Response) => {
        const u = typeof req === "string" ? req : req.url;
        entries.set(u, res);
        return Promise.resolve();
      },
      delete: (req: Request | string) => {
        const u = typeof req === "string" ? req : req.url;
        entries.delete(u);
        return Promise.resolve(true);
      },
    };

    // Seed 20 entries (at MAX_OFFLINE_EPISODES cap)
    for (let i = 1; i <= 20; i++) {
      entries.set(
        `${BASE}/audio/ep-${i}.wav`,
        new Response(`payload-${i}`, {
          status: 200,
          headers: {
            "x-stored-at": String(1000 + i),
            "content-length": "100",
          },
        }),
      );
    }
    assertEquals(entries.size, 20);

    // Extract stampResponse, boundOfflineAudio, and foregroundDownload from client
    const stampSrc = client.slice(
      client.indexOf("function stampResponse("),
      client.indexOf("async function boundOfflineAudio("),
    );
    const boundFnSrc = client.slice(
      client.indexOf("async function boundOfflineAudio("),
      client.indexOf("async function syncSavedUI("),
    );
    const fgFnSrc = client.slice(
      client.indexOf("async function foregroundDownload("),
      client.indexOf("async function downloadEpisode("),
    );

    const fn = new Function(
      "fetchMock",
      "setDownloadStateMock",
      "syncSavedUIMock",
      "audio",
      "current",
      `
      const MAX_OFFLINE_BYTES = 640 * 1024 * 1024;
      const MAX_OFFLINE_EPISODES = 20;
      const fetch = fetchMock;
      const setDownloadState = setDownloadStateMock;
      const syncSavedUI = syncSavedUIMock;
      ${stampSrc}
      ${boundFnSrc}
      ${fgFnSrc}
      return foregroundDownload;
    `,
    );

    const foregroundDownload = fn(
      (_url: string) =>
        Promise.resolve(
          new Response("new-payload", {
            status: 200,
            headers: { "content-length": "100" },
          }),
        ),
      () => {},
      () => Promise.resolve(),
      null,
      null,
    );

    const fakeButton = { dataset: {} };
    await foregroundDownload(
      { id: "ep-21", audioUrl: `${BASE}/audio/ep-21.wav` },
      fakeButton,
      fakeStore,
    );

    // Bounding inside foregroundDownload must enforce MAX_OFFLINE_EPISODES = 20
    assertEquals(entries.size, 20, "foregroundDownload must bound the cache to 20 entries");
    assertEquals(entries.has(`${BASE}/audio/ep-1.wav`), false, "oldest entry must be evicted");
    assertEquals(
      entries.has(`${BASE}/audio/ep-21.wav`),
      true,
      "newly downloaded entry must be saved",
    );
  },
);

Deno.test(
  "cache bounding buffers body byteLength when Content-Length is absent and never counts missing size as zero (audio-feed-cby)",
  async () => {
    const client = assetBody("listen.js")!;
    const entries = new Map<string, Response>();
    const fakeStore = {
      keys: () => Promise.resolve([...entries.keys()].map((u) => new Request(u))),
      match: (req: Request | string) => {
        const u = typeof req === "string" ? req : req.url;
        const res = entries.get(u);
        if (!res) return Promise.resolve(undefined);
        try {
          return Promise.resolve(res.clone());
        } catch {
          return Promise.resolve(res);
        }
      },
      delete: (req: Request | string) => {
        const u = typeof req === "string" ? req : req.url;
        entries.delete(u);
        return Promise.resolve(true);
      },
    };

    // Seed two entries with NO Content-Length header, but real body payloads of 600 bytes and 700 bytes.
    // Budget is set to 1000 bytes.
    // If missing Content-Length were counted as 0, total bytes would be 0 <= 1000 (no eviction).
    // By buffering clone body byteLength, total bytes = 1300 > 1000, which triggers eviction.
    const body1 = new Uint8Array(600);
    const body2 = new Uint8Array(700);
    entries.set(
      `${BASE}/audio/ep-no-cl-1.wav`,
      new Response(body1, {
        headers: { "x-stored-at": "100" },
      }),
    );
    entries.set(
      `${BASE}/audio/ep-no-cl-2.wav`,
      new Response(body2, {
        headers: { "x-stored-at": "200" },
      }),
    );
    assertEquals(entries.size, 2);

    const boundFnSrc = client.slice(
      client.indexOf("async function boundOfflineAudio("),
      client.indexOf("async function syncSavedUI("),
    );
    const fn = new Function(
      "store",
      "protectedUrls",
      "maxBytes",
      "maxEntries",
      "audio",
      "current",
      `
      const MAX_OFFLINE_BYTES = 640 * 1024 * 1024;
      const MAX_OFFLINE_EPISODES = 20;
      ${boundFnSrc}
      return boundOfflineAudio(store, protectedUrls, maxBytes, maxEntries);
    `,
    );

    // Call boundOfflineAudio with maxBytes = 1000, maxEntries = 20
    await fn(fakeStore, undefined, 1000, 20, null, null);

    assertEquals(
      entries.size,
      1,
      "missing Content-Length was buffered and not counted as zero; over-budget entry evicted",
    );
    assertEquals(
      entries.has(`${BASE}/audio/ep-no-cl-1.wav`),
      false,
      "older un-sized entry evicted",
    );
    assertEquals(entries.has(`${BASE}/audio/ep-no-cl-2.wav`), true, "newer un-sized entry kept");

    // Also verify that an entry whose size cannot even be read is NOT charged maxBytes:
    // an unmeasurable entry cannot be counted, so only IT is dropped — never the library.
    const unreadableRes = {
      headers: new Headers({ "x-stored-at": "300" }),
      clone: () => {
        throw new Error("stream unreadable");
      },
    };
    entries.set(`${BASE}/audio/ep-unreadable.wav`, unreadableRes as unknown as Response);
    // The old fallback charged maxBytes (1000) for the unreadable entry, which alone
    // exceeded the budget and evicted the counted 700 B entry with it.
    await fn(fakeStore, undefined, 1000, 20, null, null);
    assertEquals(
      entries.has(`${BASE}/audio/ep-no-cl-2.wav`),
      true,
      "ONE unmeasurable entry must not evict the counted library",
    );
    assertEquals(
      entries.has(`${BASE}/audio/ep-unreadable.wav`),
      false,
      "the unmeasurable entry is dropped itself",
    );
  },
);

Deno.test(
  "service worker background fetch protects the just-written entry even with older timestamps or future-stamped entries (audio-feed-cby)",
  async () => {
    const harness = await swHarness();

    // Fill OFFLINE_CACHE to MAX_OFFLINE_EPISODES (20) with future timestamps (e.g. t = Date.now() + 10_000_000).
    for (let i = 1; i <= MAX_OFFLINE_EPISODES; i++) {
      harness.seedCache(
        OFFLINE_CACHE,
        `${BASE}/audio/ep-future-${i}.wav`,
        new Response(`payload-${i}`, {
          status: 200,
          headers: {
            "x-stored-at": String(Date.now() + 10_000_000 + i),
            "content-length": "100",
          },
        }),
      );
    }
    assertEquals(harness.cachedUrls(OFFLINE_CACHE).length, MAX_OFFLINE_EPISODES);

    // Now background fetch stores a new record. Its write time is Date.now(), which is
    // MUCH OLDER than all the future-stamped entries in the cache!
    // Without protecting the just-written entry, it would sort oldest and be immediately evicted.
    // With explicit protection, it MUST survive, evicting one of the future-stamped entries instead.
    await harness.dispatch("backgroundfetchsuccess", {
      registration: {
        matchAll: () =>
          Promise.resolve([
            audioRecord(
              "ep-just-written.wav",
              new Response("just-written-payload", {
                status: 200,
                headers: { "content-length": "100" },
              }),
            ),
          ]),
      },
    });

    const cached = harness.cachedUrls(OFFLINE_CACHE);
    assertEquals(cached.length, MAX_OFFLINE_EPISODES);
    assertEquals(
      cached.includes(`${BASE}/audio/ep-just-written.wav`),
      true,
      "the service worker must protect the just-written entry from immediate eviction",
    );
  },
);

Deno.test(
  "ONE unmeasurable entry is dropped alone and does not evict the rest of the offline library (audio-feed-cby)",
  async () => {
    const harness = await swHarness();

    // A countable library of 10 small episodes, under both budgets.
    for (let i = 1; i <= 10; i++) {
      harness.seedCache(
        OFFLINE_CACHE,
        `${BASE}/audio/ep-lib-${i}.wav`,
        new Response(`payload-${i}`, {
          status: 200,
          headers: { "x-stored-at": String(1000 + i), "content-length": "100" },
        }),
      );
    }
    // ONE unmeasurable entry: no Content-Length and a body that cannot be buffered.
    // The old fallback charged it maxBytes — the ENTIRE 640 MiB budget — so this single
    // entry alone put the cache over budget and the bound evicted all 10 episodes.
    const unmeasurable = {
      headers: new Headers({ "x-stored-at": "9999" }), // newest stamp, but size unknown
      clone: () => {
        throw new Error("stream unreadable");
      },
    };
    harness.seedCache(
      OFFLINE_CACHE,
      `${BASE}/audio/ep-unmeasurable.wav`,
      unmeasurable as unknown as Response,
    );

    // A normal background-fetch write triggers a bound pass.
    await harness.dispatch("backgroundfetchsuccess", {
      registration: {
        matchAll: () =>
          Promise.resolve([
            audioRecord(
              "ep-new.wav",
              new Response("new-payload", {
                status: 200,
                headers: { "content-length": "100" },
              }),
            ),
          ]),
      },
    });

    const cached = harness.cachedUrls(OFFLINE_CACHE);
    assertEquals(
      cached.filter((u) => u.includes("ep-lib-")).length,
      10,
      "ONE unmeasurable entry must NOT evict the rest of the library",
    );
    assertEquals(
      cached.includes(`${BASE}/audio/ep-unmeasurable.wav`),
      false,
      "the unmeasurable entry itself is dropped (it cannot be counted)",
    );
    assertEquals(
      cached.includes(`${BASE}/audio/ep-new.wav`),
      true,
      "the newly written entry survives",
    );
  },
);

Deno.test(
  "the service worker bounds ONCE per batch, protecting EVERY URL that batch wrote (audio-feed-cby)",
  async () => {
    const harness = await swHarness();

    // Three future-stamped 300 MB entries (they sort newest; 900 MB over the 640 MB
    // budget, but no bound has run on them yet — bounding only runs on a write).
    const threeHundredMB = 300 * 1024 * 1024;
    for (let i = 1; i <= 3; i++) {
      harness.seedCache(
        OFFLINE_CACHE,
        `${BASE}/audio/ep-fut-${i}.wav`,
        new Response(`payload-${i}`, {
          status: 200,
          headers: {
            "x-stored-at": String(Date.now() + 10_000_000 + i),
            "content-length": String(threeHundredMB),
          },
        }),
      );
    }

    // One batch writes TWO 300 MB records. Per-record bounding protected only its own
    // record each pass, so the second pass (protecting only record 2) treated record 1
    // as ordinary evictable and dropped it. Bounding once after the batch protects both.
    await harness.dispatch("backgroundfetchsuccess", {
      registration: {
        matchAll: () =>
          Promise.resolve([
            audioRecord(
              "ep-batch-1.wav",
              new Response("batch-payload-1", {
                status: 200,
                headers: { "content-length": String(threeHundredMB) },
              }),
            ),
            audioRecord(
              "ep-batch-2.wav",
              new Response("batch-payload-2", {
                status: 200,
                headers: { "content-length": String(threeHundredMB) },
              }),
            ),
          ]),
      },
    });

    const cached = harness.cachedUrls(OFFLINE_CACHE);
    assertEquals(
      cached.includes(`${BASE}/audio/ep-batch-1.wav`),
      true,
      "the FIRST batch member must survive: the whole batch is protected in the single pass",
    );
    assertEquals(
      cached.includes(`${BASE}/audio/ep-batch-2.wav`),
      true,
      "the second batch member must survive",
    );
    assertEquals(
      cached.filter((u) => u.includes("ep-fut-")).length,
      0,
      "eviction comes from the future-stamped over-budget entries",
    );
  },
);

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

  const client = await playerClient(fetch, BASE, html);
  // audio-feed-3xq moved the client into an asset, and typing it changed the call spelling from
  // `backgroundFetch.fetch(` to the optional-chained `backgroundFetch?.fetch?.(`. Searching for the
  // SHAPE the code now has, in the file that now holds it. The property this test guards is the
  // ORDER, and that is unchanged.
  const registered = client.indexOf("backgroundFetch?.fetch?.(");
  const confirmed = client.indexOf("backgroundFetch?.getIds?.()");
  const promised = client.indexOf("you can close this tab");

  assert(registered > 0, "the client must attempt a background fetch");
  assert(confirmed > 0, "the client must confirm the registration exists");
  assert(promised > 0, "the client tells the subscriber the tab can be closed");
  assert(
    confirmed < promised,
    "the OS-level promise must come AFTER getIds() confirms the registration, " +
      "never on the strength of a resolved fetch() — that was the audio-feed-4xb defect",
  );

  // The fallback is the path that runs everywhere. Background Fetch is Chrome-only
  // and not Baseline, so this is the MAJORITY path and must not be a stub.
  assertStringIncludes(client, "const response = await fetch(episode.audioUrl)");
  assertStringIncludes(client, "await store.put(episode.audioUrl, stamped)");

  // And the cache confirmation is a bounded poll, not a single read: the page's
  // `progress` event fires when the RECORD settles, while the service worker
  // writes the cache independently under waitUntil. A single read returned EMPTY
  // for a download that had in fact succeeded (measured, audio-feed-98i).
  assertStringIncludes(client, "async function waitForCache(");
});

Deno.test("the player links back to the source article for read-along (audio-feed-585)", async () => {
  const { fetch } = await seeded();
  const html = await (await fetch(get(`/listen/${TOKEN}`))).text();

  // The source URL travels with the episode payload, and the page carries both affordances: a
  // per-row link built from that payload, and the dock link where he is actually listening.
  assertStringIncludes(html, "https://stratechery.com/2026/an-article/");
  assertStringIncludes(html, "articleUrl");
  assertStringIncludes(html, "Read along");
  assertStringIncludes(html, 'id="nowRead"');

  const dockLink = (html.match(/<a[^>]*id="nowRead"[^>]*>/) ?? [])[0];
  assert(dockLink, "the dock must carry a read-along link");
  assertEquals(
    dockLink.includes('rel="noopener noreferrer"'),
    true,
    "a new tab must not keep window.opener",
  );
  assertEquals(
    dockLink.includes('target="_blank"'),
    true,
    "read-along opens beside the player, not over it",
  );
});

Deno.test("a non-web article URL never becomes a linkback (audio-feed-585)", async () => {
  const { fetch, stores } = await seeded();
  // The URL comes from a feed the subscriber chose, so the page only ever sees http(s) — the same
  // floor ingest applies, enforced again at the point a link is rendered.
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "stratechery",
      url: "javascript:alert(1)",
    }),
  );
  const html = await (await fetch(get(`/listen/${TOKEN}`))).text();
  assertEquals(html.includes("javascript:"), false, "only http(s) may reach the page as a link");
});

Deno.test("listen harness: seeds 5 publishable episodes and page renders all 5 (audio-feed-py5)", async () => {
  const { createListenHarness } = await import("../scripts/listen-harness.ts");
  const h = await createListenHarness(8136);
  const res = await h.fetch(new Request(`${h.base}/listen/${h.token}`));
  assertEquals(res.status, 200);
  const html = await res.text();

  assertStringIncludes(html, '<span id="episodeCount">5 episodes</span>');
  const match =
    /<script\b[^>]*type="application\/json"[^>]*id="player-data"[^>]*>([\s\S]*?)<\/script>/.exec(
      html,
    );
  assert(match, "player-data script tag must exist");
  const data = JSON.parse(match[1]!);
  assertEquals(data.episodes.length, 5);

  // Each episode must have a valid audio URL that returns audio/wav
  for (const ep of data.episodes) {
    assert(ep.audioUrl, "each episode must have an audioUrl");
    const audioRes = await h.fetch(new Request(ep.audioUrl));
    assertEquals(audioRes.status, 200);
    assertStringIncludes(audioRes.headers.get("content-type") ?? "", "audio/wav");
  }
});

Deno.test("the player client retains download failure reasons on the episode row (audio-feed-e1d)", async () => {
  const { fetch } = await seeded();
  const html = await (await fetch(get(`/listen/${TOKEN}`))).text();
  const client = await playerClient(fetch, BASE, html);
  assertStringIncludes(client, ".ep-download-error");
  assertStringIncludes(client, "Download failed:");
});

Deno.test("the player renders i-share icon symbol in page sprite (audio-feed-zcw)", async () => {
  const { fetch } = await seeded();
  const html = await (await fetch(get(`/listen/${TOKEN}`))).text();
  assertStringIncludes(html, '<symbol id="i-share"');
});

Deno.test("the player client wires native Web Share API with clipboard fallback on episode rows (audio-feed-zcw)", async () => {
  const { fetch } = await seeded();
  const html = await (await fetch(get(`/listen/${TOKEN}`))).text();
  const client = await playerClient(fetch, BASE, html);
  assertStringIncludes(client, '"ep-share"');
  assertStringIncludes(client, 'dataset.action = "share"');
  assertStringIncludes(client, '"Share episode: "');
  assertStringIncludes(client, '"Link copied for: "');
  assertStringIncludes(client, "navigator.canShare");
  assertStringIncludes(client, "navigator.share");
  assertStringIncludes(client, "AbortError");
  assertStringIncludes(client, "navigator.clipboard.writeText");
  assertStringIncludes(client, '"Link copied to clipboard."');
  assertStringIncludes(client, "TODO(baseline/share)");
});
