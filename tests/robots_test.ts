/**
 * robots.txt (audio-feed-0mv).
 *
 * The private routes are token-fronted, so this is not the access control — it
 * is about not inviting crawlers to spend KV reads on capability URLs, and about
 * keeping a subscriber's token out of a search result. Pinned verbatim because
 * a reordered or weakened file still "returns 200".
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig } from "../src/config.ts";

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "https://audio.example.com",
  adminToken: "admin-secret",
};

Deno.test("GET /robots.txt disallows admin and api without blocking capability routes /feed/ and /listen/ (audio-feed-0mv, audio-feed-nnek, audio-feed-qk63, audio-feed-nyih)", async () => {
  const stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const res = await fetch(new Request("https://audio.example.com/robots.txt"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/plain");

  const body = await res.text();
  const expected = [
    "User-agent: *",
    "Disallow: /admin",
    "Disallow: /api/",
    "Allow: /",
    "Allow: /assets/",
  ];
  assertEquals(
    body.trim().split("\n"),
    expected,
    "robots.txt must be exactly the agreed rules, in order",
  );
  // robots.txt must NOT block /feed/ or /listen/ so compliant crawlers can fetch the endpoint and read X-Robots-Tag: noindex
  assertEquals(
    /^Disallow: \/feed/m.test(body),
    false,
    "robots.txt must not block /feed/ so noindex is reachable",
  );
  assertEquals(
    /^Disallow: \/listen/m.test(body),
    false,
    "robots.txt must not block /listen/ so noindex is reachable",
  );
  // A bare Disallow: / would deindex the whole site; the file must never grow one.
  assertEquals(/^Disallow: \/$/m.test(body), false, "the public site must stay crawlable");
});

Deno.test("feed capability responses carry X-Robots-Tag: noindex and Cache-Control: private, no-store (audio-feed-nnek, audio-feed-qk63)", async () => {
  const stores = memoryStores();
  const user = makeUser({
    id: "user-1",
    displayName: "Paul",
    status: "approved",
    feedToken: "token-feed-1",
  });
  await stores.metadata.putUser(user);
  await stores.metadata.putSource(
    makeSource({ id: "src-1", userId: user.id, title: "Source 1" }),
  );
  await stores.metadata.putArticle(
    makeArticle({ id: "art-1", userId: user.id, sourceId: "src-1" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-1",
      userId: user.id,
      sourceId: "src-1",
      articleId: "art-1",
      status: "ready",
      audioKey: "audio/user-1/direct/ep-1.wav",
    }),
  );

  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  // 1. Master feed: GET /feed/:token/master.xml
  const masterRes = await fetch(
    new Request(`https://audio.example.com/feed/${user.feedToken}/master.xml`),
  );
  assertEquals(masterRes.status, 200);
  assertEquals(masterRes.headers.get("x-robots-tag"), "noindex");
  assertStringIncludes(masterRes.headers.get("cache-control") ?? "", "no-store");
  await masterRes.body?.cancel();

  // 2. Per-source feed: GET /feed/:token/:sourceId/:mode.xml
  const sourceRes = await fetch(
    new Request(`https://audio.example.com/feed/${user.feedToken}/src-1/direct.xml`),
  );
  assertEquals(sourceRes.status, 200);
  assertEquals(sourceRes.headers.get("x-robots-tag"), "noindex");
  assertStringIncludes(sourceRes.headers.get("cache-control") ?? "", "no-store");
  await sourceRes.body?.cancel();
});

Deno.test("player and capability-bearing HTML pages carry X-Robots-Tag: noindex and meta robots (audio-feed-nnek)", async () => {
  const stores = memoryStores();
  const user = makeUser({
    id: "user-1",
    displayName: "Paul",
    isAdmin: true,
    status: "approved",
    feedToken: "token-player-1",
  });
  await stores.metadata.putUser(user);
  const session = await createSession(stores.metadata, user.id);
  const cookie = `${SESSION_COOKIE}=${session}`;

  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  // 1. Player page: GET /listen/:token
  const playerRes = await fetch(
    new Request(`https://audio.example.com/listen/${user.feedToken}`),
  );
  assertEquals(playerRes.status, 200);
  assertEquals(playerRes.headers.get("x-robots-tag"), "noindex");
  assertStringIncludes(playerRes.headers.get("cache-control") ?? "", "no-store");
  const playerHtml = await playerRes.text();
  assert(
    playerHtml.includes('<meta name="robots" content="noindex">'),
    "Player page must include meta robots noindex in head",
  );

  // 2. Player status poll: GET /listen/:token/status
  const statusRes = await fetch(
    new Request(`https://audio.example.com/listen/${user.feedToken}/status`),
  );
  assertEquals(statusRes.status, 200);
  assertEquals(statusRes.headers.get("x-robots-tag"), "noindex");
  assertStringIncludes(statusRes.headers.get("cache-control") ?? "", "no-store");
  await statusRes.body?.cancel();

  // 3. Account page: GET /account
  const accountRes = await fetch(
    new Request("https://audio.example.com/account", { headers: { cookie } }),
  );
  assertEquals(accountRes.status, 200);
  assertEquals(accountRes.headers.get("x-robots-tag"), "noindex");
  assertStringIncludes(accountRes.headers.get("cache-control") ?? "", "no-store");
  const accountHtml = await accountRes.text();
  assert(
    accountHtml.includes('<meta name="robots" content="noindex">'),
    "Account page must include meta robots noindex in head",
  );

  // 4. Admin page: GET /admin
  const adminRes = await fetch(
    new Request("https://audio.example.com/admin", { headers: { cookie } }),
  );
  assertEquals(adminRes.status, 200);
  assertEquals(adminRes.headers.get("x-robots-tag"), "noindex");
  assertStringIncludes(adminRes.headers.get("cache-control") ?? "", "no-store");
  const adminHtml = await adminRes.text();
  assert(
    adminHtml.includes('<meta name="robots" content="noindex, nofollow">'),
    "Admin page must include meta robots noindex, nofollow in head",
  );
});
