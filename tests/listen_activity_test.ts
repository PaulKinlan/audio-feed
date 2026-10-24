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
import { SlidingWindowRateLimiter, UNADDRESSED_CLIENT_KEY } from "../src/auth/rate_limit.ts";
import {
  LISTEN_RETRY_ADDR_RATE,
  LISTEN_RETRY_ADDR_WINDOW,
  LISTEN_RETRY_TOKEN_RATE,
  LISTEN_RETRY_TOKEN_WINDOW,
  retryCeilingRow,
} from "../src/routes/listen.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { playerData } from "./listen_client.ts";
import { applyRetryCeiling, LISTEN_RETRY_CEILING, renderListenPage } from "../src/routes/listen.ts";
import {
  createTempChromeProfile,
  killChromeAndWait,
  newestChrome,
  removeDirWhenQuiet,
  waitForChromeProfileUnused,
} from "../scripts/proof-helper.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const TOKEN = "token-activity";

async function seeded(configOverride: Partial<typeof config> = {}) {
  // Overrides let a test serve the app on a DIFFERENT origin than the file-level default:
  // `publicBaseUrl: undefined` makes resolveOrigin derive the origin from the request, which
  // is what a browser test on 127.0.0.1 needs for the same-origin wall to accept it.
  const testConfig = { ...config, ...configOverride };
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

  const ctx = { config: testConfig, stores };
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
  const data = playerData(html);
  const playable = data.episodes ?? [];
  assert(
    playable.some((episode: { id: string }) => episode.id === "ep-ready"),
    "the player must still offer the old audio",
  );
  const activity = data.activity ?? {};
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

// The retry POST is same-origin walled (audio-feed-8jzgl): the player's fetch POST always
// carries Origin, so every legitimate call in this file sends it.
const ORIGIN = { origin: BASE };

Deno.test("POST retry re-queues the caller's failed episode and it reappears as in-progress (audio-feed-7s2)", async () => {
  const { stores, fetch, req } = await seeded();
  const res = await fetch(req(`/listen/${TOKEN}/episodes/ep-failed/retry`, {
    method: "POST",
    headers: ORIGIN,
  }));
  assertEquals(res.status, 202, `retry must be accepted; got ${res.status}`);
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-failed"))?.status, "pending");

  const body = await (await fetch(req(`/listen/${TOKEN}/status`))).json();
  assertEquals(body.failed.length, 0, "it leaves the failed list");
  assert(body.inProgress.some((e: { id: string }) => e.id === "ep-failed"), "and shows as queued");
});

Deno.test("retry cannot touch another subscriber, a playable episode, or an unknown token (audio-feed-7s2)", async () => {
  const { stores, fetch, req } = await seeded();
  assertEquals(
    (await fetch(req(`/listen/${TOKEN}/episodes/ep-other-failed/retry`, {
      method: "POST",
      headers: ORIGIN,
    }))).status,
    404,
    "an episode the caller does not own must not be retryable, and must not confirm it exists",
  );
  assertEquals((await stores.metadata.getEpisode("user-2", "ep-other-failed"))?.status, "failed");

  assertEquals(
    (await fetch(req(`/listen/${TOKEN}/episodes/ep-ready/retry`, {
      method: "POST",
      headers: ORIGIN,
    }))).status,
    409,
    "a playable episode is a requeue, not a retry — different transition, different method",
  );
  assertEquals(
    (await fetch(req(`/listen/no-such-token/episodes/ep-failed/retry`, {
      method: "POST",
      headers: ORIGIN,
    }))).status,
    404,
  );
});

Deno.test("retry refuses cross-origin and origin-less POSTs, and touches nothing (audio-feed-8jzgl)", async () => {
  const { stores, fetch, req } = await seeded();
  // A cross-site page that has learned a pasted feed URL — the whole credential — must not
  // be able to fire retries from the subscriber's browser.
  const evil = await fetch(req(`/listen/${TOKEN}/episodes/ep-failed/retry`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  }));
  assertEquals(evil.status, 403);
  // A non-browser client (curl on a leaked URL) sends no Origin at all: refused too. The
  // wall is not what stops a scripted hammer — the rate windows and the ceiling are — but
  // it keeps the browser context honest.
  const bare = await fetch(req(`/listen/${TOKEN}/episodes/ep-failed/retry`, { method: "POST" }));
  assertEquals(bare.status, 403);

  // Neither attempt consumed the retry: the episode is still failed and still retryable
  // by the page itself.
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-failed"))?.status, "failed");
  const ok = await fetch(req(`/listen/${TOKEN}/episodes/ep-failed/retry`, {
    method: "POST",
    headers: ORIGIN,
  }));
  assertEquals(ok.status, 202);
});

Deno.test("retry is rate-limited per feed token and client address (audio-feed-8jzgl)", async () => {
  const { fetch, req } = await seeded();
  // The first attempt requeues; the rest meet 409 (the episode is no longer failed) but
  // still count: the window bounds how often the endpoint is hit at all, not how often it
  // succeeds. LISTEN_RETRY_ADDR_RATE allows 10 per (token, address) window.
  let last: Response | undefined;
  for (let i = 0; i < 11; i++) {
    last = await fetch(req(`/listen/${TOKEN}/episodes/ep-failed/retry`, {
      method: "POST",
      headers: ORIGIN,
    }));
  }
  assertEquals(last?.status, 429, "the 11th hit on a 10-per-window bound must be refused");
  assert(Number(last?.headers.get("retry-after")) > 0, "a rate refusal says when to come back");

  // Per token AND address, not global: another subscriber's token from the same address
  // has its own window and its own failed episode.
  const other = await fetch(req("/listen/token-other/episodes/ep-other-failed/retry", {
    method: "POST",
    headers: ORIGIN,
  }));
  assertEquals(other.status, 202, "one subscriber's exhausted window must not throttle another");
});

Deno.test("retry is rate-limited per feed token even from fresh addresses (audio-feed-8jzgl)", async () => {
  const { fetch, req } = await seeded();
  // A rotated-address hammer on ONE leaked token: every (token, address) window above is
  // fresh by construction, but the per-token window is shared, so the 31st hit is refused
  // wherever it came from. This is the bound that survives address rotation.
  let last: Response | undefined;
  for (let i = 0; i < 31; i++) {
    last = await fetch(
      req(`/listen/${TOKEN}/episodes/ep-failed/retry`, {
        method: "POST",
        headers: ORIGIN,
      }),
      { remoteAddr: { hostname: `203.0.113.${i}` } },
    );
  }
  assertEquals(last?.status, 429);
  assert(Number(last?.headers.get("retry-after")) > 0, "a rate refusal says when to come back");
});

Deno.test("retry has a lifetime ceiling per episode that no retry resets (audio-feed-8jzgl)", async () => {
  const { stores, fetch, req } = await seeded();
  for (let i = 0; i < LISTEN_RETRY_CEILING; i++) {
    const res = await fetch(req(`/listen/${TOKEN}/episodes/ep-failed/retry`, {
      method: "POST",
      headers: ORIGIN,
    }));
    assertEquals(res.status, 202, `subscriber retry ${i + 1} must queue; got ${res.status}`);
    // The worker fails again: the subscriber may legitimately try once more.
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
  }

  const refused = await fetch(req(`/listen/${TOKEN}/episodes/ep-failed/retry`, {
    method: "POST",
    headers: ORIGIN,
  }));
  assertEquals(refused.status, 429);
  const body = await refused.json();
  assertEquals(body.error, "Retry limit reached for this episode.");
  assertEquals(body.reason, "retry_ceiling", "the UI keys on the machine-readable reason");
  assertEquals(
    refused.headers.get("retry-after"),
    null,
    "a lifetime ceiling has no reset time, so it must not pretend to",
  );

  // Without operator reset: the episode was rewritten to failed again above (which resets
  // the episode row's own state) and the ceiling still holds — the counter lives outside
  // the episode record, in its own durable store row.
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-failed"))?.status, "failed");

  // The rate windows sit above legitimate use, so the refusals here are the ceiling's:
  // 6 hits against a 10-per-window bound.
});

Deno.test("failed episodes are always included in activity panel regardless of window paging (audio-feed-6y9)", async () => {
  const { stores, fetch, req } = await seeded();
  // Plant an older failed episode with a timestamp older than other episodes
  const oldDate = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-ancient-fail",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-1",
    title: "Ancient Failed Episode",
    status: "failed",
    error: "Ancient LLM error",
    createdAt: oldDate,
  }));

  const res = await fetch(req(`/listen/${TOKEN}/status`));
  assertEquals(res.status, 200);
  const body = await res.json();
  const failedIds = body.failed.map((e: { id: string }) => e.id);
  assert(
    failedIds.includes("ep-ancient-fail"),
    "failed episode must always be included in activity panel",
  );
  const ancient = body.failed.find((e: { id: string }) => e.id === "ep-ancient-fail");
  assertEquals(ancient.error, "Ancient LLM error");
});

Deno.test("reprocessed or superseded failed episodes are filtered from activity (audio-feed-cls)", async () => {
  const { stores, fetch, req } = await seeded();

  // 1. Stale failure (failed@08:00, ready@08:10): live episode is strictly newer, so failure is superseded
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-old-fail-playable-one",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-1",
    title: "The playable one",
    mode: "direct",
    status: "failed",
    error: "Stale failure before successful retry",
    createdAt: "2026-09-10T08:00:00.000Z",
  }));

  // 2. Fresh failure (failed@08:20, ready@08:10): failure is newer than live episode (e.g. failed re-narrate), must stay visible (F1)
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-fresh-fail-playable-one",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-1",
    title: "The playable one",
    mode: "direct",
    status: "failed",
    error: "Fresh failure after previous success",
    createdAt: "2026-09-10T08:20:00.000Z",
  }));

  // 3. Different mode failure (deepdive failed@08:00 alongside direct ready@08:10): must stay visible (F2)
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-deepdive-fail",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-1",
    title: "The playable one",
    mode: "deepdive",
    status: "failed",
    error: "Deep dive failure",
    createdAt: "2026-09-10T08:00:00.000Z",
  }));

  // 4. Re-ingested/re-sent article with a newly minted articleId and same URL (J1):
  // Matching URL, source, mode, and newer createdAt -> must supersede older failure despite distinct articleIds
  await stores.metadata.putArticle(makeArticle({
    id: "art-fail-1",
    userId: "user-1",
    sourceId: "src-a",
    url: "https://example.com/reingested-post",
    title: "Re-ingested Article Title",
  }));
  await stores.metadata.putArticle(makeArticle({
    id: "art-ready-2",
    userId: "user-1",
    sourceId: "src-a",
    url: "https://example.com/reingested-post",
    title: "Re-ingested Article Title",
  }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-old-fail-reingested",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-fail-1",
    title: "Re-ingested Article Title",
    mode: "direct",
    status: "failed",
    error: "Failed during first ingest",
    createdAt: "2026-09-10T08:00:00.000Z",
  }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-ready-reingested",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-ready-2", // newly minted articleId!
    title: "Re-ingested Article Title",
    mode: "direct",
    status: "ready",
    createdAt: "2026-09-10T08:30:00.000Z",
  }));

  // 5. Recurring title with different article URLs (J2):
  // "Weekly Roundup" with edition=1 vs edition=2 must NOT supersede (failure stays visible)
  await stores.metadata.putArticle(makeArticle({
    id: "art-weekly-1",
    userId: "user-1",
    sourceId: "src-a",
    url: "https://example.com/weekly?edition=1",
    title: "Weekly Roundup",
  }));
  await stores.metadata.putArticle(makeArticle({
    id: "art-weekly-2",
    userId: "user-1",
    sourceId: "src-a",
    url: "https://example.com/weekly?edition=2",
    title: "Weekly Roundup",
  }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-weekly-fail",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-weekly-1",
    title: "Weekly Roundup",
    mode: "direct",
    status: "failed",
    error: "Weekly edition 1 failed",
    createdAt: "2026-09-10T08:00:00.000Z",
  }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-weekly-ready",
    userId: "user-1",
    sourceId: "src-a",
    articleId: "art-weekly-2",
    title: "Weekly Roundup",
    mode: "direct",
    status: "ready",
    createdAt: "2026-09-10T08:30:00.000Z",
  }));

  const res = await fetch(req(`/listen/${TOKEN}/status`));
  assertEquals(res.status, 200);
  const body = await res.json();
  const failedIds = body.failed.map((e: { id: string }) => e.id);
  // ep-failed (title "The one that failed") is STILL failed, so it must be present
  assert(failedIds.includes("ep-failed"), "unresolved failure must be included");
  // ep-old-fail-playable-one is older than ep-ready, so it must be filtered
  assert(
    !failedIds.includes("ep-old-fail-playable-one"),
    "stale failure older than playable episode must be filtered from activity",
  );
  // ep-fresh-fail-playable-one is newer than ep-ready, so it must remain visible
  assert(
    failedIds.includes("ep-fresh-fail-playable-one"),
    "fresh failure newer than playable episode must remain visible",
  );
  // ep-deepdive-fail has a different mode, so it must remain visible
  assert(
    failedIds.includes("ep-deepdive-fail"),
    "different mode failure must remain visible",
  );
  // ep-old-fail-reingested has different articleId but same URL/source/mode and older createdAt -> filtered (J1)
  assert(
    !failedIds.includes("ep-old-fail-reingested"),
    "re-ingested article with new articleId must supersede older failure via same URL (J1)",
  );
  // ep-weekly-fail has same title and source, but different article URL -> must stay visible (J2)
  assert(
    failedIds.includes("ep-weekly-fail"),
    "recurring title with different article URL must remain visible (J2)",
  );
});

Deno.test("the ceiling verdict describes the run the store applied, never a lost attempt (audio-feed-dqjf2)", () => {
  // A KV CAS re-run: the caller's increment saw count 4 and lost the commit to a writer
  // who moved the row to the ceiling. The callback runs AGAIN against 5 — and the SECOND
  // run's verdict is the only one that may classify the request. Before the mutation was
  // per-run pure, a stale `admitted` from the lost attempt waved the caller into
  // retryEpisode, which answered 404 instead of the honest 429 retry_ceiling.
  const lost = applyRetryCeiling(4);
  assertEquals(lost, { next: 5, admitted: true, exhausted: false });
  const committed = applyRetryCeiling(5);
  assertEquals(committed, { next: LISTEN_RETRY_CEILING, admitted: false, exhausted: true });
  assert(
    committed.exhausted && !committed.admitted,
    "the re-run against the exhausted counter must refuse, not admit",
  );
  // The no-row-yet and refused write-backs keep the counter an integer: the refusal
  // writes the count back unchanged so `committed` stays a verdict about the write.
  assertEquals(applyRetryCeiling(null), { next: 1, admitted: true, exhausted: false });
  assertEquals(applyRetryCeiling(LISTEN_RETRY_CEILING).next, LISTEN_RETRY_CEILING);
});

Deno.test({
  name:
    "the retry button's labels are driven by real 429 bodies: rate refusal vs spent ceiling vs queued (audio-feed-8jzgl, audio-feed-rvy5n)",
  // The ceiling-vs-rate distinction was first pinned by asserting listen.js SOURCE text,
  // which listen_client.ts explicitly warns against: source assertions prove nothing about
  // behaviour. This drives the real page in headless Chrome against the real app — three
  // clicks, three rendered labels, and the episode state checked each time — so the UI
  // contract is proven, not paraphrased. The two refusal ANSWERS are pinned at app level
  // first and then injected into the page as one-shot fetch stubs (audio-feed-flr6y): the
  // original row raced a live round trip against its own 10s poll and failed on slow hosts
  // while the mapping was intact. Nothing is weakened: the server's exact 429 bodies are
  // still asserted (in-process, above), the labels are still read from the real DOM of the
  // real page, and the accepted retry still goes over the real wire.
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const { stores, fetch: appFetch } = await seeded({
      // The browser will be served on 127.0.0.1:<ephemeral>, so the origin the wall compares
      // against must be DERIVED from the request, not the file-level https://audio.example.com.
      publicBaseUrl: undefined,
      port: 0,
    });

    // The SAME limiter rows the handler addresses, driven through the public API so the
    // rate window is genuinely full rather than faked.
    const addrLimiter = new SlidingWindowRateLimiter(
      LISTEN_RETRY_ADDR_RATE,
      stores.metadata,
      LISTEN_RETRY_ADDR_WINDOW,
    );
    const tokenLimiter = new SlidingWindowRateLimiter(
      LISTEN_RETRY_TOKEN_RATE,
      stores.metadata,
      LISTEN_RETRY_TOKEN_WINDOW,
    );
    const clientIp = "127.0.0.1"; // what Deno.serve reports for a local Chrome
    for (let i = 0; i < LISTEN_RETRY_ADDR_RATE.maxRequests; i++) {
      await addrLimiter.check(`${TOKEN}:${clientIp}`);
    }

    const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, appFetch);
    const port = (server.addr as Deno.NetAddr).port;

    // PIN THE SERVER BODIES IN-PROCESS, BEFORE THE BROWSER RUNS (audio-feed-flr6y). This row
    // used to make the BROWSER produce each 429 by racing a real round trip against the test's
    // own 10s label poll — on a degraded host the poll expired first and the row failed while
    // the product property it protects was intact (measured 2026-10-23: the union gate lost
    // 22m to this row in the 6x Chrome-degradation signature, and the same file passed 18/18
    // in 7s on a healthy browser). The two layers the row must prove are now pinned separately,
    // and neither races wall-clock: HERE the endpoint answers a genuinely-full rate window and
    // a genuinely-spent ceiling through the app's own handler and the exact bodies are asserted
    // (this remains the only coverage of the server's 429 shapes); IN THE PAGE those same
    // measured bodies are injected as one-shot fetch stubs so the real button drives the real
    // mapping code with no round trip to lose. The stub is removed before the accepted-retry
    // click, which still exercises the real wire end to end.
    //
    // The in-process POSTs have NO socket address, so extractClientIp puts them in the
    // "direct" bucket — a DIFFERENT row from the browser's 127.0.0.1 window filled above.
    // Fill that bucket too, or the first in-process POST would be ADMITTED (and consume a
    // ceiling unit on the way to a 202). The in-process POSTs target the SERVED loopback
    // origin: the host wall admits loopback even with no PUBLIC_BASE_URL (this is how the
    // browser is served too), while the file-level https://audio.example.com host would be
    // refused 500 server_misconfigured with the allow-list unset.
    const postRetryInProcess = () =>
      appFetch(
        new Request(`http://127.0.0.1:${port}/listen/${TOKEN}/episodes/ep-failed/retry`, {
          method: "POST",
          headers: { origin: `http://127.0.0.1:${port}` },
        }),
      );
    for (let i = 0; i < LISTEN_RETRY_ADDR_RATE.maxRequests; i++) {
      await addrLimiter.check(`${TOKEN}:${UNADDRESSED_CLIENT_KEY}`);
    }
    const rateRes = await postRetryInProcess();
    assertEquals(rateRes.status, 429, "a full addr window must refuse the retry with 429");
    const rateBody = await rateRes.json();
    assertEquals(
      rateBody,
      { error: "Too many retries; try again later." },
      "the rate refusal's exact body: reason ABSENT, so the client must read it as temporary",
    );

    // Reopen the windows BEFORE the ceiling POST: the handler checks the rate window first,
    // so a still-full window would answer the rate body and this step would never reach the
    // ceiling verdict. The browser's bucket is reopened here too — nothing else touches it
    // until the accepted retry at the end (the two refusal clicks are stubbed).
    await addrLimiter.reset(`${TOKEN}:${clientIp}`);
    await addrLimiter.reset(`${TOKEN}:${UNADDRESSED_CLIENT_KEY}`);
    await tokenLimiter.reset(TOKEN);

    // Set the ceiling DIRECTLY to its limit via the same CAS primitive the handler's
    // recordEpisodeRetry uses, then take the ceiling refusal's exact body. Note the rate POST
    // above never reached the ceiling at all: handleListenRetry checks the rate window FIRST
    // and answers 429 there (src/routes/listen.ts:936), so no ceiling unit was spent on the way
    // to that refusal — the atomicUpdate below is the only ceiling state this POST sees. The
    // refused POST below consumes nothing either — the verdict writes the row back unchanged
    // (audio-feed-dqjf2).
    await stores.metadata.atomicUpdate<number>(
      retryCeilingRow("user-1", "ep-failed"),
      () => LISTEN_RETRY_CEILING,
    );
    const ceilingRes = await postRetryInProcess();
    assertEquals(ceilingRes.status, 429, "a spent ceiling must refuse the retry with 429");
    const ceilingBody = await ceilingRes.json();
    assertEquals(
      ceilingBody,
      { error: "Retry limit reached for this episode.", reason: "retry_ceiling" },
      "the ceiling refusal's exact body: reason names the ceiling",
    );

    const scratchTmp = await Deno.makeTempDir({ prefix: "rvy5n-scratch-" });
    const { profileDir, cleanup } = await createTempChromeProfile(
      "audiofeed-retry-labels-",
      scratchTmp,
    );
    const chrome = new Deno.Command(newestChrome(), {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let devtoolsPort = "";
    for (let i = 0; i < 50 && !devtoolsPort; i++) {
      await sleep(100);
      devtoolsPort = (await Deno.readTextFile(`${profileDir}/DevToolsActivePort`).catch(() => ""))
        .split("\n")[0]!;
    }

    /**
     * Typed against the slice of the CDP reply these helpers read, not `any`: the repo lint
     * rejects explicit any on the whole-tree run even where a file-scoped check passed
     * (audio-feed-rvy5n's own gate taught that lesson).
     */
    interface CdpReply {
      result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
    }
    const evalValue = async (
      cdp: (m: string, p?: Record<string, unknown>) => Promise<CdpReply>,
      expression: string,
    ): Promise<unknown> => {
      const r = await cdp("Runtime.evaluate", { expression, returnByValue: true });
      if (r.result?.exceptionDetails) {
        throw new Error(`page error: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`);
      }
      return r.result?.result?.value;
    };

    // EVERY wait below polls a FUNCTIONAL signal with a generous bound instead of sleeping a
    // fixed number of milliseconds (audio-feed-flr6y): the old row's sleep(800) plus a 10s
    // "label changed from prev" poll raced page-load and host latency, and lost on a slow
    // host (the union gate's 22m failure). A slow host may only add iterations to these
    // polls — never change their outcome.
    try {
      const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
      // deno-lint-ignore no-explicit-any
      const page = targets.find((t: any) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      const pending = new Map<number, (v: CdpReply) => void>();
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      });
      const cdp = (method: string, params: Record<string, unknown> = {}): Promise<CdpReply> => {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve) => pending.set(id, resolve));
      };

      await cdp("Page.enable");
      await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/listen/${TOKEN}` });
      // The button is the row's entry point; poll for it instead of sleeping a fixed 800ms,
      // which a slow host can outlive (audio-feed-flr6y).
      let buttonReady = false;
      for (let i = 0; i < 100 && !buttonReady; i++) {
        await sleep(100);
        buttonReady = Boolean(
          await evalValue(cdp, `document.querySelector('.act-retry') !== null`),
        );
      }
      assert(buttonReady, ".act-retry never appeared within 10s of navigation");

      // Inject the two refusal answers into the page as ONE-SHOT fetch stubs (audio-feed-flr6y):
      // each armed click consumes exactly one body — the SAME bodies the server was just caught
      // answering — so the mapping runs in the real page with no network round trip to race.
      // The stub passes everything else through and counts its hits, so if the page ever stops
      // calling fetch for retries the hit assertion below reddens by name instead of the row
      // passing silently on an unused stub.
      await cdp("Runtime.evaluate", {
        expression: `(() => {
          window.__origFetch = window.fetch;
          window.__retryStubHits = 0;
          window.__injectedRetryBody = null;
          window.fetch = (url, opts) => {
            if (window.__injectedRetryBody !== null && String(url).includes("/retry")) {
              const body = window.__injectedRetryBody;
              window.__injectedRetryBody = null;
              window.__retryStubHits++;
              return Promise.resolve(new Response(body, {
                status: 429,
                headers: { "content-type": "application/json" },
              }));
            }
            return window.__origFetch(url, opts);
          };
          return "installed";
        })()`,
        returnByValue: true,
      });
      const injectRetryBody = (body: unknown) =>
        cdp("Runtime.evaluate", {
          expression: `window.__injectedRetryBody = ${JSON.stringify(JSON.stringify(body))};`,
          returnByValue: true,
        });

      // Click until the stub's hit counter PROVES this click's fetch ran (the one-shot body
      // was consumed), then wait for the EXPECTED label — the injected body determines the
      // label, so "changed from prev" polling is unnecessary and was the race. Re-clicking
      // is safe: a handlerless button (page JS still loading on a slow host) ignores clicks,
      // and the one-shot body makes a consumed click idempotent.
      const clickUntilStubConsumes = async (expectedHits: number): Promise<void> => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          await evalValue(cdp, `document.querySelector('.act-retry')?.click()`);
          for (let i = 0; i < 10; i++) {
            await sleep(100);
            if (Number(await evalValue(cdp, `window.__retryStubHits`)) >= expectedHits) return;
          }
          if (Date.now() > deadline) {
            throw new Error(`retry stub never consumed click ${expectedHits} within 10s`);
          }
        }
      };
      const waitForRetryLabel = async (expected: string): Promise<void> => {
        for (let i = 0; i < 100; i++) {
          const label = await evalValue(
            cdp,
            `document.querySelector('.act-retry')?.textContent ?? null`,
          );
          if (label === expected) return;
          await sleep(100);
        }
        throw new Error(
          `retry label never became ${JSON.stringify(expected)}; last was ${
            JSON.stringify(
              await evalValue(cdp, `document.querySelector('.act-retry')?.textContent ?? null`),
            )
          }`,
        );
      };

      // 1. Rate-refused: the server's measured refusal body must read as temporary.
      await injectRetryBody(rateBody);
      await clickUntilStubConsumes(1);
      await waitForRetryLabel("Slow down — try again soon");
      assertEquals(
        (await stores.metadata.getEpisode("user-1", "ep-failed"))?.status,
        "failed",
        "a rate-refused retry must not queue anything",
      );

      // 2. Ceiling-spent: the server's measured ceiling body must read as permanent.
      await injectRetryBody(ceilingBody);
      await clickUntilStubConsumes(2);
      await waitForRetryLabel("Retry limit reached");
      assertEquals(
        (await stores.metadata.getEpisode("user-1", "ep-failed"))?.status,
        "failed",
        "a ceiling-refused retry must not queue anything",
      );

      // Both refusals were consumed from the stub, one per click: a count below 2 means a
      // click bypassed the injection (a renamed endpoint or a changed handler), and the row
      // must fail loudly rather than pass on an answer nobody injected.
      const stubHits = Number(
        (await cdp("Runtime.evaluate", {
          expression: "window.__retryStubHits",
          returnByValue: true,
        })).result?.result?.value,
      );
      assertEquals(stubHits, 2, "both refusal clicks must have been driven by the injected bodies");

      // Remove the stub: the accepted retry below goes over the REAL wire.
      await cdp("Runtime.evaluate", {
        expression: "window.fetch = window.__origFetch;",
        returnByValue: true,
      });

      // 3. Un-spent: clear the ceiling row and the SAME button queues for real. Here the
      // CONTRACT is the episode's state, not the label: a 202 is followed by
      // refreshActivity(), which re-renders the activity section and replaces the button
      // before any poll could read "Queued" — the accepted retry's visible result is the
      // episode leaving the failed list.
      await stores.metadata.atomicUpdate<number>(retryCeilingRow("user-1", "ep-failed"), () => 0);
      await cdp("Runtime.evaluate", {
        expression: `document.querySelector('.act-retry')?.click()`,
      });
      let status: string | undefined;
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        status = (await stores.metadata.getEpisode("user-1", "ep-failed"))?.status;
        if (status === "pending") break;
      }
      assertEquals(
        status,
        "pending",
        "the accepted retry must have requeued the episode",
      );

      ws.close();
    } finally {
      await server.shutdown();
      await killChromeAndWait(chrome);
      await cleanup();
      assert(
        await removeDirWhenQuiet(scratchTmp),
        "the scratch root must be gone after teardown (audio-feed-wj8o2)",
      );
      assert(
        await waitForChromeProfileUnused(profileDir),
        "no process may still reference the row's profile once teardown has finished (audio-feed-wj8o2)",
      );
    }
  },
});

Deno.test("listen.js and listen.css define Dismiss All button for multi-failure activity (audio-feed-j8o)", async () => {
  const js = await Deno.readTextFile(new URL("../src/assets/listen.js", import.meta.url));
  const css = await Deno.readTextFile(new URL("../src/assets/listen.css", import.meta.url));

  assertStringIncludes(js, "act-dismiss-all");
  assertStringIncludes(js, "Dismiss all (");
  assertStringIncludes(js, "activityHint.replaceChildren");
  assertStringIncludes(css, ".act-dismiss-all {");
});

Deno.test("listen HTML template does not leak raw JS comment syntax (audio-feed-cls)", async () => {
  const { fetch, req } = await seeded();
  const res = await fetch(req(`/listen/${TOKEN}`));
  const html = await res.text();
  assert(!html.includes("// audio-feed-3xq"), "stray JS comment must not be rendered in HTML");
});

Deno.test({
  name:
    "player page mobile layout: zero horizontal blowout at 390px with long activity titles/errors (audio-feed-cls)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const html = renderListenPage({
      nonce: "test-nonce",
      userId: "user-1",
      token: "test-token",
      subscriber: "Paul",
      feedUrl: "https://example.com/feed.xml",
      episodes: [
        {
          id: "ep-1",
          title:
            "Extremely Long Article Title That Could Potentially Wrap Across Many Lines And Test Mobile Boundaries",
          audioUrl: "https://example.com/audio/ep-1.wav",
          date: new Date().toISOString(),
          durationSeconds: 120,
        },
      ],
      offlineEnabled: true,
      activity: {
        inProgress: [
          {
            id: "act-1",
            title:
              "Very Long In Progress Episode Title That Needs Adequate Ellipsis Or Word Wrapping Without Blowing Out Horizontal Width",
            state: "generating",
          },
        ],
        failed: [
          {
            id: "act-2",
            title:
              "Very Long Failed Episode Title That Also Has A Super Long Error String Below It",
            state: "failed",
            error:
              "Google Generative AI Error: 429 Resource has been exhausted (e.g. check quota) - please check your plan and billing details at console.cloud.google.com/billing and try again later after exponential backoff.",
          },
        ],
        playable: 1,
      },
    });

    const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" });
    await Deno.writeTextFile(tempHtmlFile, html);

    // audio-feed-oyf3g: the scratch root is HANDED TO THE HELPER, not put in the environment.
    // createTempChromeProfile sweeps its root BEFORE it allocates (audio-feed-h62q: the sweep is
    // age-and-signature based, not prefix-scoped), so it still needs a sandbox here or it would reclaim every
    // abandoned profile on the VM. Passing the root keeps that protection while removing the coupling the old
    // redirect created: under `deno test --parallel` a process-global TMPDIR captured other modules' temp dirs
    // into this sandbox and deleted them with it. The profile's whole life is still contained, because the
    // profile itself - not the environment - lives here.
    const scratchTmp = await Deno.makeTempDir({ prefix: "w5f1-scratch-" });

    const { profileDir, cleanup } = await createTempChromeProfile(
      "audiofeed-player-fix-proof-",
      scratchTmp,
    );
    const chrome = new Deno.Command(newestChrome(), {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let port = "";
    for (let i = 0; i < 50 && !port; i++) {
      await sleep(100);
      port = (await Deno.readTextFile(`${profileDir}/DevToolsActivePort`).catch(() => "")).split(
        "\n",
      )[0]!;
    }

    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      // deno-lint-ignore no-explicit-any
      const page = targets.find((t: any) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      // deno-lint-ignore no-explicit-any
      const pending = new Map<number, (v: any) => void>();
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      });
      const cdp = (method: string, params: Record<string, unknown> = {}) => {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve) => pending.set(id, resolve));
      };

      await cdp("Page.enable");
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      });
      // The readiness guard's contract (rev-audiofeed5egu4 finding): a document is ready
      // ONLY if it IS the navigated target - identity by href AND the marker the rendered
      // page sets - complete, and laid out. Anything else - the pre-navigation about:blank,
      // an error page or a blank-only response that happens to sit AT the target URL, a
      // torn-down context - is NOT READY and the loop WAITS. The old predicate
      // (readyState+width only) accepted about:blank under this row's 390px emulation, so an
      // uncommitted navigation let the loop exit on the wrong document and the assertions
      // falsely accused the product of a layout blowout.
      const targetUrl = `file://${tempHtmlFile}`;
      interface ReadDocument {
        href: string;
        readyState: string;
        hasListenPage: boolean;
        scrollWidth: number;
        clientWidth: number;
        hasOverflow: boolean;
      }
      const urlIsTarget = (href: string): boolean => {
        try {
          return href === targetUrl || decodeURIComponent(href) === targetUrl;
        } catch {
          return href === targetUrl;
        }
      };
      // audio-feed-hqtfo (measured on this VM): while a navigation to a server that never
      // sends a first byte is in flight, Runtime.evaluate does NOT answer either - an
      // unawaited probe would hang the whole wait. Every probe races its own deadline and a
      // probe that does not answer in time is "not ready", never a hang.
      const PROBE_DEADLINE_MS = 1_000;
      const readDocument = async (): Promise<ReadDocument | undefined> => {
        // deno-lint-ignore no-explicit-any
        const probe: any = await Promise.race([
          cdp("Runtime.evaluate", {
            expression: `(() => JSON.stringify({
            href: location.href,
            readyState: document.readyState,
            hasListenPage: Boolean(document.getElementById("main")) &&
              Boolean(document.getElementById("episodes")),
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
          }))()`,
          }),
          sleep(PROBE_DEADLINE_MS).then(() => undefined),
        ]);
        // Two ways raw is absent, both "not ready yet", never a layout verdict: an evaluate
        // that lands in a context torn down by the navigation returns an exception
        // (audio-feed-5egu4), and a probe that missed its deadline returns undefined above
        // (audio-feed-hqtfo).
        const raw = probe?.result?.result?.value;
        if (typeof raw !== "string") return undefined;
        try {
          return JSON.parse(raw) as ReadDocument;
        } catch {
          return undefined;
        }
      };
      const isTargetReady = (d: ReadDocument | undefined): boolean =>
        d !== undefined && urlIsTarget(d.href) && d.hasListenPage &&
        d.readyState === "complete" && d.scrollWidth > 0;

      // The ONE way this row waits for a document. It THROWS a named failure instead of
      // returning whatever is on screen, which is what makes a target that genuinely never
      // loads (a 500, a blank-only server, a navigation that never commits) a red that says
      // what happened rather than a hang or a layout verdict about the wrong page.
      const waitForTargetDocument = async (
        attempts: number,
        delayMs: number,
      ): Promise<ReadDocument> => {
        let lastSeen = "unreadable (no evaluate returned a document)";
        for (let i = 0; i < attempts; i++) {
          const candidate = await readDocument();
          if (candidate !== undefined && isTargetReady(candidate)) return candidate;
          if (candidate !== undefined) {
            lastSeen = `${candidate.href} (readyState ${candidate.readyState})`;
          }
          await sleep(delayMs);
        }
        throw new Error(
          `audio-feed-5egu4 readiness guard: ${targetUrl} did not become the ready target ` +
            `document after ${attempts} probe(s), last document seen: ${lastSeen} - refusing ` +
            `to assert a layout verdict about a page that is not the navigated target`,
        );
      };

      // THE REVIEWER'S OWN MEASURED DOCUMENT, pinned as a predicate case - no timing, no
      // browser state: their probe reported url=about:blank, readyState=complete,
      // scrollWidth=980, clientWidth=980 and the old predicate accepted it. It must never
      // count as ready again.
      assertEquals(
        isTargetReady({
          href: "about:blank",
          readyState: "complete",
          hasListenPage: false,
          scrollWidth: 980,
          clientWidth: 980,
          hasOverflow: false,
        }),
        false,
        "the readiness guard must reject the reviewer's measured document " +
          "(about:blank, readyState complete, 980px wide) - accepting it is what turned an " +
          "uncommitted navigation into a confident layout verdict about the wrong page",
      );
      // And the shape href-identity alone cannot catch: the RIGHT url, complete, laid out -
      // but not our page (a failed load renders the browser's own error page AT that url; a
      // blank-only response looks the same). Only the marker the rendered page sets tells
      // them apart, which is why readiness requires it.
      assertEquals(
        isTargetReady({
          href: targetUrl,
          readyState: "complete",
          hasListenPage: false,
          scrollWidth: 390,
          clientWidth: 390,
          hasOverflow: false,
        }),
        false,
        "a document at the target URL without the player's marker (#main + #episodes) " +
          "must not count as ready - an error page is 390px wide and would pass every " +
          "layout assertion while proving nothing about the page",
      );
      // And the IDENTITY condition ISOLATED, so it cannot be deleted in silence
      // (audio-feed-s4p5s, the reviewer's finding on this row): the marker is PRESENT, the
      // document is complete and laid out at 390px - and it is still not the navigated
      // target. Every other case here fails identity AND the marker together (the real
      // about:blank carries no #main/#episodes), which is why removing urlIsTarget left the
      // row green; this is the one input that pins the identity check on its own.
      assertEquals(
        isTargetReady({
          href: "about:blank",
          readyState: "complete",
          hasListenPage: true,
          scrollWidth: 390,
          clientWidth: 390,
          hasOverflow: false,
        }),
        false,
        "a complete, 390px document that carries the player's marker but is NOT the " +
          "navigated target must not count as ready - this case isolates the identity " +
          "check from the marker check instead of relying on them to fail together",
      );

      // AND THE SECOND HALF OF THE (a) PROOF, IN THE REAL BROWSER: before Page.navigate the
      // only document in this target IS about:blank by construction, so the guard must
      // classify it NOT READY; the old predicate accepted it (complete + 980px wide under
      // the emulation), which let the loop exit on the wrong document and assert a layout
      // lie about the real page.
      const preNavigation = await readDocument();
      assertEquals(
        preNavigation?.href,
        "about:blank",
        "pre-navigation document must be about:blank",
      );
      assertEquals(
        isTargetReady(preNavigation),
        false,
        "the readiness guard must reject the pre-navigation about:blank document " +
          "- accepting it would assert a layout verdict about the wrong page",
      );

      // AND THE OTHER HALF OF THE CONTRACT: the guard REDDENS BY NAME when the target never
      // becomes the document on screen. Proved against the real reader and the real
      // predicate, with no timing deciding the outcome: about:blank can never satisfy target
      // identity, so this wait MUST throw at any host speed - the 5x1ms attempts only bound
      // how long the negative probe takes, they cannot make it pass or fail. A regression that
      // accepts a non-target document makes the wait RETURN, and the assertion below then
      // reddens by name instead of silently arming the false layout verdict this row exists
      // to prevent. (Coord's suggested mutation - point the target at a 500 or a blank-only
      // server - exercises this same throw with more moving parts; the property under test is
      // the throw, and about:blank is the one wrong document the browser guarantees exists.)
      const rejection = await waitForTargetDocument(5, 1).then(
        () => "NO ERROR - the guard accepted a document that is not the target",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      assertStringIncludes(
        rejection,
        "audio-feed-5egu4 readiness guard",
        `waiting for the target must redden BY NAME when the document never becomes it, got: ${rejection}`,
      );
      assertStringIncludes(
        rejection,
        targetUrl,
        `the readiness failure must name the document it was waiting for, got: ${rejection}`,
      );
      assertStringIncludes(
        rejection,
        "about:blank",
        `the readiness failure must name the document it actually saw, got: ${rejection}`,
      );

      // (b) THE SECOND FAILURE SHAPE, IN THE REAL BROWSER. Identity by href alone still accepts
      // a page that FAILED TO LOAD: Chrome renders its own error page AT the target URL, and a
      // blank-only response sits there too - both are 390px wide, so both would sail through
      // the layout assertions while proving nothing about the player. That is why readiness also
      // requires the marker the rendered page sets (#main + #episodes). Proved here by serving a
      // marker-less page at the SAME URL and requiring the wait to throw by name.
      await Deno.writeTextFile(
        tempHtmlFile,
        "<!doctype html><html><body><p>a page that failed to load looks like this</p></body></html>",
      );
      await cdp("Page.navigate", { url: targetUrl });
      let wrongContent: ReadDocument | undefined;
      for (let i = 0; i < 100 && wrongContent === undefined; i++) {
        const candidate = await readDocument();
        if (
          candidate !== undefined && urlIsTarget(candidate.href) &&
          candidate.readyState === "complete"
        ) {
          wrongContent = candidate;
        } else {
          await sleep(50);
        }
      }
      assert(
        wrongContent,
        `the marker-less page never loaded at ${targetUrl}, so this proof would be testing ` +
          `identity instead of the marker - the browser has to SHOW us a wrong page at the ` +
          `right URL for the marker check to be worth anything`,
      );
      assertEquals(
        wrongContent.hasListenPage,
        false,
        "the page served at the target URL in this proof must NOT carry the player's marker",
      );
      const wrongContentRejection = await waitForTargetDocument(5, 1).then(
        () => "NO ERROR - the guard accepted a page at the target URL that is not the player",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      assertStringIncludes(
        wrongContentRejection,
        "audio-feed-5egu4 readiness guard",
        `a target that loads the wrong page must redden BY NAME, got: ${wrongContentRejection}`,
      );

      // Back to the real page for the layout assertions this row exists for.
      await Deno.writeTextFile(tempHtmlFile, html);
      await cdp("Page.navigate", { url: targetUrl });

      await cdp("Page.navigate", { url: targetUrl });
      // audio-feed-5egu4: readiness is POLLED, never slept, and the poll exits only on the
      // navigated target. Bounded by a documented ceiling (100 x 50ms = 5s, the same guard
      // family as the DevToolsActivePort poll above): a loaded host consumes poll cycles and
      // the guard names itself on trip - it cannot turn slowness into a layout verdict.
      const metrics = await waitForTargetDocument(100, 50);
      assertEquals(
        metrics.scrollWidth,
        390,
        `scrollWidth must be 390px, got ${metrics.scrollWidth}`,
      );
      assertEquals(
        metrics.clientWidth,
        390,
        `clientWidth must be 390px, got ${metrics.clientWidth}`,
      );
      assertEquals(
        metrics.hasOverflow,
        false,
        "390px mobile viewport must have zero horizontal overflow",
      );

      ws.close();
    } finally {
      await killChromeAndWait(chrome);
      await cleanup();
      assert(
        await removeDirWhenQuiet(scratchTmp),
        "the scratch root must be gone after teardown: a dying browser's children must not recreate it (audio-feed-wj8o2)",
      );
      assert(
        await waitForChromeProfileUnused(profileDir),
        "no process may still reference the row's profile once teardown has finished (audio-feed-wj8o2)",
      );
      await Deno.remove(tempHtmlFile).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "player page readiness: a navigation whose server never answers fails BY NAME, bounded, with no hung Page.navigate (audio-feed-hqtfo)",
  // audio-feed-hqtfo (rev-audiofeed5egu4's coverage finding): the existing negative proofs keep a
  // real browser on about:blank or load marker-less content at an already RESPONDING file://
  // target - neither reproduces an HTTP server that accepts the navigation and never sends a
  // response byte. This row serves exactly that: a handler that holds /player open until the
  // client goes away. The property under test is that the whole navigation-and-readiness
  // operation is BOUNDED and that no-response is a NAMED failure, not a hang.
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    // The handler MUST resolve when the client disconnects (req.signal aborts) or the row's
    // own teardown would hang inside server.shutdown() - the hold is on the RESPONSE, not on
    // the process.
    let handlerEntered = 0;
    const neverAnswer = (req: Request) => {
      handlerEntered++;
      return new Promise<Response>((resolve) => {
        req.signal.addEventListener(
          "abort",
          () => resolve(new Response("client gone", { status: 500 })),
          { once: true },
        );
      });
    };
    const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, neverAnswer);
    const port = (server.addr as Deno.NetAddr).port;
    const hungUrl = `http://127.0.0.1:${port}/player`;

    const scratchTmp = await Deno.makeTempDir({ prefix: "hqtfo-scratch-" });
    const { profileDir, cleanup } = await createTempChromeProfile(
      "audiofeed-hqtfo-proof-",
      scratchTmp,
    );
    const chrome = new Deno.Command(newestChrome(), {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let debugPort = "";
    for (let i = 0; i < 50 && !debugPort; i++) {
      await sleep(100);
      debugPort = (await Deno.readTextFile(`${profileDir}/DevToolsActivePort`).catch(() => ""))
        .split("\n")[0]!;
    }

    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      // deno-lint-ignore no-explicit-any
      const page = targets.find((t: any) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      // deno-lint-ignore no-explicit-any
      const pending = new Map<number, (v: any) => void>();
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      });
      const cdp = (method: string, params: Record<string, unknown> = {}) => {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve) => pending.set(id, resolve));
      };

      await cdp("Page.enable");

      // The SAME readiness contract as the mobile layout row (audio-feed-5egu4), pointed at a
      // URL whose server never answers: a document is ready only if it IS the navigated target
      // (identity by href AND the player's marker), complete, and laid out.
      interface ReadDocument {
        href: string;
        readyState: string;
        hasListenPage: boolean;
        scrollWidth: number;
        clientWidth: number;
      }
      const urlIsTarget = (href: string): boolean => {
        try {
          return href === hungUrl || decodeURIComponent(href) === hungUrl;
        } catch {
          return href === hungUrl;
        }
      };
      // audio-feed-hqtfo (measured on this VM): while a navigation to a server that never
      // sends a first byte is in flight, Runtime.evaluate does NOT answer either - so every
      // probe races its own deadline and a probe that does not answer in time is "not ready",
      // never a hang. With the 1s deadline the 8x(1s+100ms) loop concludes in ~9s worst case
      // against a hung navigation and ~1s against an answering one.
      const PROBE_DEADLINE_MS = 1_000;
      const readDocument = async (): Promise<ReadDocument | undefined> => {
        // deno-lint-ignore no-explicit-any
        const probe: any = await Promise.race([
          cdp("Runtime.evaluate", {
            expression: `(() => JSON.stringify({
            href: location.href,
            readyState: document.readyState,
            hasListenPage: Boolean(document.getElementById("main")) &&
              Boolean(document.getElementById("episodes")),
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth
          }))()`,
          }),
          sleep(PROBE_DEADLINE_MS).then(() => undefined),
        ]);
        const raw = probe?.result?.result?.value;
        if (typeof raw !== "string") return undefined;
        try {
          return JSON.parse(raw) as ReadDocument;
        } catch {
          return undefined;
        }
      };
      const isTargetReady = (d: ReadDocument | undefined): boolean =>
        d !== undefined && urlIsTarget(d.href) && d.hasListenPage &&
        d.readyState === "complete" && d.scrollWidth > 0;
      const waitForTargetDocument = async (
        attempts: number,
        delayMs: number,
      ): Promise<ReadDocument> => {
        let lastSeen = "unreadable (no evaluate returned a document)";
        for (let i = 0; i < attempts; i++) {
          const candidate = await readDocument();
          if (candidate !== undefined && isTargetReady(candidate)) return candidate;
          if (candidate !== undefined) {
            lastSeen = `${candidate.href} (readyState ${candidate.readyState})`;
          }
          await sleep(delayMs);
        }
        throw new Error(
          `audio-feed-hqtfo readiness guard: ${hungUrl} did not become the ready target ` +
            `document after ${attempts} probe(s), last document seen: ${lastSeen} - a server ` +
            `that never answers is a bounded named failure, never a hang`,
        );
      };

      // Navigate WITHOUT awaiting. Measured on this VM (the row's own probe, 2026-10-24):
      // Page.navigate to a server that never sends a first byte does NOT resolve - the CDP
      // promise hangs with the load for as long as the browser holds it. So "no hung
      // Page.navigate" cannot mean "await it"; it means the row's bounded operation must
      // conclude while the navigate is still pending, and the pending promise is discarded
      // with the socket at teardown. (Do not pin "navigate never resolves" as an assertion:
      // that is Chrome's behaviour, not this repo's contract.)
      const navPromise = cdp("Page.navigate", { url: hungUrl });
      void navPromise; // resolved or not, the row below decides - it must not block on this

      // The navigation must have REACHED the never-answering server (state-gated on the
      // handler firing, not slept): without this the row would pass vacuously on a connection
      // error instead of on a held response.
      for (let i = 0; i < 50 && handlerEntered === 0; i++) await sleep(100);
      assertEquals(
        handlerEntered,
        1,
        "the navigation must have REACHED the never-answering server - without this the row " +
          "would pass vacuously on a connection error instead of on a held response",
      );

      // The readiness wait must FAIL BY NAME while the response is still held: the document on
      // screen stays about:blank (identity can never match), so this throw is decided by the
      // predicate, not by timing - the 8 probes only bound how long the negative proof takes.
      // The outer 30s race is the rule-2 hang guard against a REGRESSION (a wait that never
      // throws); the loop's worst case against the hung navigation is ~9s (8 x (1s probe
      // deadline + 100ms)), so the guard is over 3x the worst case.
      const rejection = await Promise.race([
        waitForTargetDocument(8, 100).then(
          () => "NO ERROR - the guard accepted a document that is not the target",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        sleep(30_000).then(() =>
          "audio-feed-hqtfo hang guard: the readiness wait did not conclude within 30s against " +
          "a server that never answers (loop worst case ~9s with the 1s probe deadline)"
        ),
      ]);
      assertStringIncludes(
        rejection,
        "audio-feed-hqtfo readiness guard",
        `a never-answering navigation must redden BY NAME, got: ${rejection}`,
      );
      assertStringIncludes(
        rejection,
        hungUrl,
        `the readiness failure must name the URL it was waiting for, got: ${rejection}`,
      );
      assertStringIncludes(
        rejection,
        "last document seen:",
        `the readiness failure must name the document it actually saw (measured: all probes ` +
          `time out during a hung navigation, so "unreadable" is the honest observation), ` +
          `got: ${rejection}`,
      );

      ws.close();
    } finally {
      // Kill the browser FIRST: its disconnect aborts the held handler (req.signal), which is
      // what lets server.shutdown() complete instead of hanging on the held connection.
      await killChromeAndWait(chrome);
      await server.shutdown();
      await cleanup();
      assert(
        await removeDirWhenQuiet(scratchTmp),
        "the scratch root must be gone after teardown: a dying browser's children must not recreate it (audio-feed-wj8o2)",
      );
      assert(
        await waitForChromeProfileUnused(profileDir),
        "no process may still reference the row's profile once teardown has finished (audio-feed-wj8o2)",
      );
    }
  },
});
