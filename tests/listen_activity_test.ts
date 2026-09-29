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
import { playerData } from "./listen_client.ts";
import { renderListenPage } from "../src/routes/listen.ts";
import { createTempChromeProfile, newestChrome } from "../scripts/proof-helper.ts";
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

    const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-player-fix-proof-");
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
      await cdp("Page.navigate", { url: `file://${tempHtmlFile}` });
      await sleep(600);

      // deno-lint-ignore no-explicit-any
      const evalRes: any = await cdp("Runtime.evaluate", {
        expression: `(() => {
          return JSON.stringify({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
          });
        })()`,
      });

      const metrics = JSON.parse(evalRes.result.result.value);
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
      try {
        chrome.kill();
      } catch { /* ignore */ }
      await cleanup();
      await Deno.remove(tempHtmlFile).catch(() => {});
    }
  },
});
