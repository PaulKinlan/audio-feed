/**
 * The accepted-episode-creation bound per subscriber (audio-feed-kp30l).
 *
 * WHAT THE GAP WAS: the daily synthesis counter bills inside the same atomic commit that marks an
 * episode `ready` (src/storage/kv/episodes.ts:64-74), so a paid attempt that ends `failed` is spent
 * and never counted. Nothing bounded episode CREATION either — `authorizeIngest` was an
 * approved-user check only, and `putArticleWithEpisode` is a blind write, so one token could queue
 * N episodes, each allowed `maxAttempts` 3 paid attempts, none of them chargeable to the budget.
 *
 * The first test pins the bound from the outside (N accepted, N+1 refused by name, with a
 * retry-after). The second pins the composition that made the gap real: an episode that spends all
 * three attempts and fails still consumes a creation slot while leaving the completion counter at
 * zero. Remove `refuseIngestOverCreationCap` and BOTH redden. The last three pin the relation the
 * reviewer blocked on: the cap is the subscriber's funded budget resolved from config — never a
 * hardcoded literal — so a raised deployment budget or a personal budget raises the cap with it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DEFAULT_DAILY_EPISODE_BUDGET, memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { AppContext } from "../src/app.ts";
import {
  createIngestHandler,
  createUploadHandler,
  INGEST_CREATION_BOUND,
  INGEST_CREATION_RATE,
  INGEST_CREATION_WINDOW,
} from "../src/compose/ingest.ts";
import { DEFAULT_MAX_ITEMS, runFeedPollBatch, subscribeToFeed } from "../src/ingest/feed.ts";
import { SlidingWindowRateLimiter } from "../src/auth/rate_limit.ts";
import { dailyEpisodeBudgetFor, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { utcDayKey } from "../src/types.ts";
import type { ExtractedArticle } from "../src/ingest/url.ts";
import type { RouteContext } from "../src/router.ts";
import { makeUser } from "./fixtures.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const USER_ID = "user-kp30l";

/** The ingest route handler as the router calls it: one `RouteContext`, one response. */
type IngestRoute = (c: RouteContext<AppContext>) => Promise<Response>;

/** One submission, addressed to the token that pays for it. */
function submit(url: string, token = `token-${USER_ID}`): Request {
  return new Request(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-feed-token": token },
    body: JSON.stringify({ url, mode: "direct" }),
  });
}

/** One upload submission, addressed to the token that pays for it. */
function submitUpload(
  filename = "notes.txt",
  content = "A clean document body with multiple words for upload testing.",
  token = `token-${USER_ID}`,
): Request {
  const formData = new FormData();
  formData.append("file", new File([content], filename, { type: "text/plain" }));
  formData.append("mode", "direct");
  return new Request(`${BASE}/api/upload`, {
    method: "POST",
    headers: { "x-feed-token": token },
    body: formData,
  });
}

/**
 * A fetch seam that counts its calls and returns a short article.
 *
 * Counting matters: the bound must refuse BEFORE the fetch, so a refused submission must not
 * appear here at all.
 */
function countingFetch() {
  const calls: string[] = [];
  const fetchArticle = (url: string): Promise<ExtractedArticle> => {
    calls.push(url);
    return Promise.resolve({
      url,
      title: `Article ${calls.length}`,
      author: null,
      publishedAt: null,
      lead: "A lead.",
      body: "One paragraph. Two paragraph. Three paragraph.",
    });
  };
  return { calls, fetchArticle };
}

async function setup(): Promise<{ ctx: AppContext; stores: Stores }> {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: USER_ID }));
  const ctx: AppContext = { config, stores };
  return { ctx, stores };
}

Deno.test("audio-feed-kp30l: one token is accepted up to the creation bound and the next submit is refused by name", async () => {
  const { ctx } = await setup();
  const { calls, fetchArticle } = countingFetch();
  const handler = createIngestHandler(ctx, { fetchArticle }) as IngestRoute;
  const bound = INGEST_CREATION_RATE.maxRequests;
  const call = (url: string, token?: string) => {
    const req = submit(url, token);
    return handler({ req, params: {}, url: new URL(req.url), ctx });
  };

  for (let index = 0; index < bound; index++) {
    const response = await call(`https://example.com/a-${index}`);
    assertEquals(response.status, 202, `submission ${index + 1}/${bound} must be accepted`);
  }
  assertEquals(calls.length, bound, "every accepted submission fetched exactly once");

  const refused = await call(`https://example.com/a-${bound}`);
  assertEquals(refused.status, 429, "the submission past the bound must be refused");
  assertEquals(calls.length, bound, "a refused submission must not reach the article fetch");

  const body = await refused.json() as {
    bound?: string;
    limit?: number;
    windowMs?: number;
    error?: string;
  };
  assertEquals(body.bound, INGEST_CREATION_BOUND, "the refusal names the bound that refused it");
  assertEquals(body.limit, bound);
  assertEquals(body.windowMs, INGEST_CREATION_RATE.windowMs);
  assertStringIncludes(body.error ?? "", String(bound));

  const retryAfter = Number(refused.headers.get("retry-after"));
  assert(
    Number.isFinite(retryAfter) && retryAfter > 0,
    `refusal must say when to retry (got ${refused.headers.get("retry-after")})`,
  );
  assert(
    retryAfter <= INGEST_CREATION_RATE.windowMs / 1000,
    "retry-after cannot exceed the window",
  );

  // A DIFFERENT subscriber is untouched: the bound is per account, not per deployment.
  const otherToken = "token-user-other";
  await ctx.stores.metadata.putUser(makeUser({ id: "user-other" }));
  const other = await call("https://example.com/other-1", otherToken);
  assertEquals(other.status, 202, "another subscriber's budget is its own");
});

Deno.test("audio-feed-kp30l: a paid episode that fails all three attempts consumes a creation slot but not the completion budget", async () => {
  const { ctx, stores } = await setup();
  const { fetchArticle } = countingFetch();
  const handler = createIngestHandler(ctx, { fetchArticle }) as IngestRoute;
  const bound = INGEST_CREATION_RATE.maxRequests;
  const call = (url: string) => {
    const req = submit(url);
    return handler({ req, params: {}, url: new URL(req.url), ctx });
  };

  // 1. One accepted submission, then all `maxAttempts` paid attempts fail.
  const accepted = await call("https://example.com/doomed");
  assertEquals(accepted.status, 202);
  const doomed = await accepted.json() as { episodeId: string };

  const attempts: string[] = [];
  const failing = () => {
    attempts.push("attempt");
    return Promise.reject(new Error("provider said no"));
  };
  const batch = await runSynthesisBatch(ctx, failing, {
    owner: "kp30l-worker",
    maxAttempts: 3,
    retryBaseDelayMs: 1,
  });
  assertEquals(attempts.length, 3, "the episode spent maxAttempts paid attempts");
  assertEquals(batch.failed.length, 1, "the episode ended failed, not ready");

  const episode = await stores.metadata.getEpisode(USER_ID, doomed.episodeId);
  assertEquals(episode?.status, "failed");
  // THE GAP, MEASURED: three attempts spent, and the daily counter that bounds spend never moved.
  assertEquals(
    await stores.metadata.getUserDailySynthesisCount(USER_ID, utcDayKey()),
    0,
    "a failed episode does not increment the completion counter (the gap)",
  );

  // 2. …and the creation slot it used IS charged, which is what closes the gap.
  const window = await new SlidingWindowRateLimiter(
    INGEST_CREATION_RATE,
    stores.metadata,
    INGEST_CREATION_WINDOW,
  ).peek(USER_ID);
  assertEquals(
    window.remaining,
    bound - 1,
    "the failed episode consumed one creation slot, so 50 failures cannot buy 150 free attempts",
  );

  // 3. Fill the remaining slots; the one past the bound is refused even though the daily counter
  //    still reads zero.
  for (let index = 1; index < bound; index++) {
    const response = await call(`https://example.com/fill-${index}`);
    assertEquals(response.status, 202, `fill submission ${index} is inside the bound`);
  }
  const refused = await call("https://example.com/over");
  assertEquals(refused.status, 429);
  assertEquals(await stores.metadata.getUserDailySynthesisCount(USER_ID, utcDayKey()), 0);

  // 4. Resubmitting the SAME url is its own creation, so it cannot be used to get past the bound.
  const sameUrl = await call("https://example.com/doomed");
  assertEquals(sameUrl.status, 429, "a same-URL resubmission is still a refused creation");
});

Deno.test("audio-feed-kp30l: the default creation rate is the synthesis budget constant, not a hardcoded literal", () => {
  // Compared through the budget's own resolution (dailyEpisodeBudgetFor), so the exported rate
  // cannot drift from the funded day by a literal edit — this redden instead.
  assertEquals(
    INGEST_CREATION_RATE.maxRequests,
    DEFAULT_DAILY_EPISODE_BUDGET,
    "the default cap must BE DEFAULT_DAILY_EPISODE_BUDGET, not a literal",
  );
  assertEquals(
    INGEST_CREATION_RATE.maxRequests,
    dailyEpisodeBudgetFor({}, undefined).limit,
    "the default cap must equal what the synthesis budget resolves for an unconfigured subscriber",
  );
});

Deno.test("audio-feed-kp30l: a deployment that raises the configured budget raises the creation cap with it", async () => {
  // THE REVIEWER'S FAILURE, DRIVEN: the budget is env-configurable, so a deployment can set
  // defaultDailyEpisodeBudget to any number; a literal cap would refuse submissions the budget
  // funds. Here the deployment configures 3 — the cap must be 3, not a constant.
  const configuredBudget = 3;
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: USER_ID }));
  const ctx: AppContext = {
    config: { ...config, defaultDailyEpisodeBudget: configuredBudget },
    stores,
  };
  const { fetchArticle } = countingFetch();
  const handler = createIngestHandler(ctx, { fetchArticle }) as IngestRoute;
  const call = (url: string) => {
    const req = submit(url);
    return handler({ req, params: {}, url: new URL(req.url), ctx });
  };

  for (let index = 0; index < configuredBudget; index++) {
    const response = await call(`https://example.com/raised-${index}`);
    assertEquals(
      response.status,
      202,
      `submission ${index + 1}/${configuredBudget} is inside the configured budget`,
    );
  }
  const refused = await call("https://example.com/raised-over");
  assertEquals(
    refused.status,
    429,
    "the FIRST refusal must sit at the configured budget, not at a hardcoded literal",
  );
  const body = await refused.json() as { limit?: number };
  assertEquals(
    body.limit,
    configuredBudget,
    "the refusal reports the configured budget, not a hardcoded literal",
  );
});

Deno.test("audio-feed-kp30l: a subscriber's personal budget is that subscriber's creation cap", async () => {
  // dailyEpisodeBudgetFor prefers the personal budget over the deployment default, and the spend
  // check charges exactly that number — the cap resolves the same way, because a cap pinned to
  // the deployment default would refuse a day a HIGHER personal budget funds.
  const personalBudget = 2;
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: USER_ID, dailyEpisodeBudget: personalBudget }));
  const ctx: AppContext = { config, stores };
  const { fetchArticle } = countingFetch();
  const handler = createIngestHandler(ctx, { fetchArticle }) as IngestRoute;
  const call = (url: string) => {
    const req = submit(url);
    return handler({ req, params: {}, url: new URL(req.url), ctx });
  };

  for (let index = 0; index < personalBudget; index++) {
    const response = await call(`https://example.com/personal-${index}`);
    assertEquals(response.status, 202, `submission ${index + 1} is inside the personal budget`);
  }
  const refused = await call("https://example.com/personal-over");
  assertEquals(
    refused.status,
    429,
    "the cap tracks the subscriber's own budget, not the deployment default",
  );
  const body = await refused.json() as { limit?: number };
  assertEquals(body.limit, personalBudget);
});

Deno.test("audio-feed-kp30l, audio-feed-l9l63, audio-feed-uhfis: upload requests share the creation bound and N+1 is refused with 429", async () => {
  const { ctx, stores } = await setup();
  const { fetchArticle } = countingFetch();
  const ingestHandler = createIngestHandler(ctx, { fetchArticle }) as IngestRoute;
  const uploadHandler = createUploadHandler(ctx) as IngestRoute;
  const bound = INGEST_CREATION_RATE.maxRequests;

  const callIngest = (url: string) => {
    const req = submit(url);
    return ingestHandler({ req, params: {}, url: new URL(req.url), ctx });
  };
  const callUpload = (filename: string) => {
    const req = submitUpload(filename);
    return uploadHandler({ req, params: {}, url: new URL(req.url), ctx });
  };

  // 1. Consume bound - 1 slots via ingest
  for (let index = 0; index < bound - 1; index++) {
    const response = await callIngest(`https://example.com/item-${index}`);
    assertEquals(response.status, 202, `ingest ${index + 1}/${bound} accepted`);
  }

  // 2. Slot bound is consumed via upload
  const uploadOk = await callUpload("final-slot.txt");
  assertEquals(uploadOk.status, 202, "final slot consumed via upload is accepted");

  // 3. Slot bound + 1 via upload must be refused with 429 naming the bound
  const uploadRefused = await callUpload("over-cap.txt");
  assertEquals(uploadRefused.status, 429, "upload past the creation bound is refused");

  const body = await uploadRefused.json() as {
    bound?: string;
    limit?: number;
    windowMs?: number;
    error?: string;
  };
  assertEquals(body.bound, INGEST_CREATION_BOUND, "upload refusal names the bound");
  assertEquals(body.limit, bound);
  assertEquals(body.windowMs, INGEST_CREATION_RATE.windowMs);
  assertStringIncludes(body.error ?? "", String(bound));

  const retryAfter = Number(uploadRefused.headers.get("retry-after"));
  assert(Number.isFinite(retryAfter) && retryAfter > 0, "upload refusal must have retry-after");

  // Refusal must not write an extra article or episode
  const episodes = await stores.metadata.listEpisodes({ userId: USER_ID });
  assertEquals(episodes.length, bound, "refused upload must not commit an episode row");
});

Deno.test("audio-feed-l9l63, audio-feed-uhfis, audio-feed-ukuka: subscription is capped per poll; periodic polling defers until funded allowance returns", async () => {
  const { ctx } = await setup();
  const { fetchArticle } = countingFetch();
  const ingestHandler = createIngestHandler(ctx, { fetchArticle }) as IngestRoute;
  const bound = INGEST_CREATION_RATE.maxRequests;

  const callIngest = (url: string) => {
    const req = submit(url);
    return ingestHandler({ req, params: {}, url: new URL(req.url), ctx });
  };

  // 1. Exhaust the subscriber's entire rolling 24h creation budget
  for (let index = 0; index < bound; index++) {
    const res = await callIngest(`https://example.com/fill-budget-${index}`);
    assertEquals(res.status, 202);
  }
  const refused = await callIngest("https://example.com/should-be-refused");
  assertEquals(refused.status, 429, "ingest is now completely exhausted");

  // 2. Feed subscription: feed contains 8 items.
  // Proves: (a) NOT refused by the creation limiter even though budget is 0;
  //         (b) bounded by deps.maxItems (default 5 for subscribeToFeed), queueing exactly 5.
  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Bounded Feed</title>
  ${
    Array.from({ length: 8 }, (_, i) =>
      `<item><title>Item ${i}</title><link>https://example.com/feed-item-${i}</link></item>`).join(
        "\n",
      )
  }
</channel></rss>`;

  const mockDeps = {
    transport: () =>
      Promise.resolve(
        new Response(feedXml, { headers: { "content-type": "application/rss+xml" } }),
      ),
    fetchArticle: (url: string) =>
      Promise.resolve({
        url,
        title: "Article Title",
        author: null,
        publishedAt: null,
        lead: "Lead",
        body: "Body content with several sentences for valid article.",
      }),
  };

  const { poll } = await subscribeToFeed(
    ctx,
    { userId: USER_ID, feedUrl: "https://example.com/bounded-feed.xml" },
    { ...mockDeps, maxItems: 5 },
  );

  assertEquals(poll.queued, 5, "initial poll is bounded by maxItems (5 items queued out of 8)");
  assertEquals(poll.items, 5, "processed items bounded by maxItems");

  // 3. Proves URL deduplication: re-polling the same feed inserts 0 new episodes
  const rePoll = await subscribeToFeed(
    ctx,
    { userId: USER_ID, feedUrl: "https://example.com/bounded-feed.xml" },
    { ...mockDeps, maxItems: 5 },
  );
  assertEquals(
    rePoll.poll.queued,
    0,
    "re-poll queues 0 new items because of insertArticleWithEpisodeIfAbsent deduplication",
  );
  assertEquals(rePoll.poll.skipped, 5, "all 5 previously seen items skipped");

  // 4. At zero allowance the periodic batch sees the feed, but defers all three new items.
  const pollBatch = () =>
    runFeedPollBatch(ctx, {
      ...mockDeps,
      minIntervalMs: 0,
      maxItemsPerSource: DEFAULT_MAX_ITEMS,
    });
  const deferredBatch = await pollBatch();
  assertEquals(deferredBatch.polled, 2);
  assertEquals(deferredBatch.queued, 0);
  // After the 24h window expires, those same three URLs remain undiscovered and are queued.
  await new SlidingWindowRateLimiter(
    INGEST_CREATION_RATE,
    ctx.stores.metadata,
    INGEST_CREATION_WINDOW,
  ).reset(USER_ID);
  const batchResult = await pollBatch();
  assertEquals(batchResult.polled, 2);
  assertEquals(
    batchResult.queued,
    3,
    "periodic polling queues the remaining 3 items up to DEFAULT_MAX_ITEMS",
  );
  assertEquals(DEFAULT_MAX_ITEMS, 10, "periodic poll bound is DEFAULT_MAX_ITEMS (10)");

  // 5. Running the batch poller again queues 0 new items because all 8 items are now deduped in KV
  const secondBatch = await pollBatch();
  assertEquals(secondBatch.queued, 0, "subsequent poll queues 0 items due to URL deduplication");
});
