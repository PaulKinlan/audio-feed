/**
 * audio-feed-l11jx — the `/listen/*` capability GETs are rate-limited BEFORE store work.
 *
 * The defect this pins: `/audio/:key` bounds its unauthenticated caller (audio-feed-k21s0) and
 * the retry POST bounds its paid mutation (audio-feed-8jzgl), but the two capability GETs a
 * subscriber's page and its status poll use had no bound at all. Both are cheap to send and
 * expensive to answer — one page load is a paged episode traversal (up to 300 scanned, 100 rows)
 * plus batched article reads, and the status poll runs the same window. A caller holding, or
 * guessing, a token could therefore spend those reads at whatever rate it liked.
 *
 * Three rows, each a different guarantee:
 *  1. N+1 rapid requests are refused, and the refusal has the SAME shape as the `/audio` one
 *     (measured against a real `/audio` 429 in the same process, not asserted from memory).
 *  2. Legitimate polling survives: 20 polls — five minutes of the player's documented 15s poll —
 *     all succeed, with the bound stated as a multiple of that cadence.
 *  3. The limiter runs before store work: a refused request performs ZERO tenant reads.
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { LISTEN_PAGE_RATE, LISTEN_STATUS_RATE } from "../src/routes/listen.ts";
import { AUDIO_RATE_LIMIT } from "../src/routes/audio.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { Episode } from "../src/types.ts";
import type { MetadataStore } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const TOKEN = "token-listen-limit";

/** One client address, so every request below shares one bucket (the abuse case). */
const CLIENT = { remoteAddr: { hostname: "198.51.100.7" } };

/** The player's poll cadence, quoted from `src/assets/listen.js:1057` ("a 15s poll"). */
const POLL_MS = 15_000;

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  return createApp(ctx, createHandlers(ctx));
}

async function seed(stores: Stores, count: number): Promise<void> {
  await stores.metadata.putUser(makeUser({ id: "user-1", feedToken: TOKEN }));
  await stores.metadata.putSource(makeSource({ id: "src-a", userId: "user-1" }));
  for (let i = 0; i < count; i++) {
    const id = `ep-${i}`;
    await stores.metadata.putArticle(
      makeArticle({ id: `art-${id}`, userId: "user-1", sourceId: "src-a", title: `Article ${id}` }),
    );
    await stores.metadata.putEpisode(makeEpisode({
      id,
      userId: "user-1",
      sourceId: "src-a",
      articleId: `art-${id}`,
      title: `Article ${id}`,
      status: "ready" as Episode["status"],
      audioKey: `audio/user-1/direct/${id}.mp3`,
    }));
  }
}

/**
 * Counts the TENANT reads a route asks the store for — the work a refusal must not spend.
 * The limiter's own `atomicUpdate` row is deliberately not counted: it is the bound, not the
 * work being bounded.
 */
function counting(store: MetadataStore): { store: MetadataStore; reads: () => number } {
  let tenantReads = 0;
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      switch (prop) {
        case "getUserByFeedToken":
        case "listEpisodePage":
        case "listSources":
        case "listEpisodes":
        case "getArticles":
        case "getArticle":
        case "getEpisode":
          return (...args: unknown[]) => {
            tenantReads += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        default:
          return value.bind(target);
      }
    },
  });
  return { store: wrapped, reads: () => tenantReads };
}

/** Drain a response so a body is not left unread between iterations. */
async function drain(res: Response): Promise<void> {
  await res.text();
}

Deno.test("listen page: rapid requests are refused with the /audio refusal shape (audio-feed-l11jx)", async () => {
  const stores = memoryStores();
  await seed(stores, 1);
  const { fetch } = app(stores);

  // Requests up to the bound are served: the point is that they are NOT 429.
  for (let i = 0; i < LISTEN_PAGE_RATE.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
    assertEquals(res.status, 200, `request ${i + 1} must be within the bound`);
    await drain(res);
  }

  const refused = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
  assertEquals(refused.status, 429, "a request past the bound must be refused");
  const retryAfter = refused.headers.get("retry-after");
  assert(
    retryAfter !== null && Number(retryAfter) >= 1,
    "429 must carry a retry-after of at least one second",
  );
  const contentType = refused.headers.get("content-type") ?? "";
  assert(contentType.startsWith("application/json"), `429 must be JSON, got "${contentType}"`);
  const body = await refused.json();
  assertEquals(body.error, "too_many_requests");

  // The SAME shape as the /audio route's refusal (audio-feed-k21s0), driven here rather than
  // remembered: exhaust the audio bucket on the same address and compare the two answers.
  let audioRefused: Response | null = null;
  for (let i = 0; i <= AUDIO_RATE_LIMIT.maxRequests && !audioRefused; i++) {
    const res = await fetch(
      new Request(`${BASE}/audio/user-1/direct/ep-0.mp3`),
      CLIENT,
    );
    if (res.status === 429) audioRefused = res;
    else await drain(res);
  }
  assert(audioRefused !== null, "the /audio bound must also refuse on this address");
  const audioBody = await audioRefused.json();
  assertEquals(
    Object.keys(body).sort(),
    Object.keys(audioBody).sort(),
    "the listen refusal body must have the same keys as the /audio refusal",
  );
  assertEquals(body.error, audioBody.error, "the same machine-readable error code");
  assert(
    (audioRefused.headers.get("content-type") ?? "").startsWith("application/json"),
    "the /audio refusal is JSON too",
  );

  // A different client address has its own bucket: the bound is per client, not global.
  const other = await fetch(new Request(`${BASE}/listen/${TOKEN}`), {
    remoteAddr: { hostname: "198.51.100.8" },
  });
  assertEquals(other.status, 200, "a different address must not share the exhausted bucket");
  await drain(other);
});

Deno.test("listen status: legitimate polling survives, with the bound stated in poll cadences (audio-feed-l11jx)", async () => {
  const stores = memoryStores();
  await seed(stores, 2);
  const { fetch } = app(stores);

  // Five minutes of the player's poll. `src/assets/listen.js:1057` names the cadence ("so a 15s
  // poll is not a 15s metronome"); a subscriber watching a synthesis finish pays exactly this.
  const pollsPerWindow = LISTEN_PAGE_RATE.windowMs / POLL_MS;
  assert(
    LISTEN_STATUS_RATE.maxRequests >= 5 * pollsPerWindow,
    `one client's 15s poll over a window costs ${pollsPerWindow} requests; the bound ` +
      `(${LISTEN_STATUS_RATE.maxRequests}) must leave at least 4x headroom`,
  );

  for (let i = 0; i < pollsPerWindow; i++) {
    const res = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
    assertEquals(res.status, 200, `poll ${i + 1} of a normal 15s cadence must succeed`);
    const body = await res.json();
    assert(Array.isArray(body.inProgress), "a status payload carries the activity panel");
    assertEquals(body.playable, 2);
  }
});

Deno.test("the listen limiter runs BEFORE store work: a refused request spends zero tenant reads (audio-feed-l11jx)", async () => {
  const inner = memoryStores();
  await seed(inner, 2);
  const { store, reads } = counting(inner.metadata);
  const { fetch } = app({ ...inner, metadata: store });

  // Exhaust both read buckets through the real routes.
  for (let i = 0; i < LISTEN_PAGE_RATE.maxRequests; i++) {
    await drain(await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT));
  }
  for (let i = 0; i < LISTEN_STATUS_RATE.maxRequests; i++) {
    await drain(await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT));
  }
  const beforeRefusal = reads();
  assert(beforeRefusal > 0, "the admitted requests above must have done real store work");

  const refusedPage = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
  assertEquals(refusedPage.status, 429);
  await drain(refusedPage);
  assertEquals(
    reads(),
    beforeRefusal,
    "a refused page request must not resolve a token or scan a single episode",
  );

  const refusedStatus = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
  assertEquals(refusedStatus.status, 429);
  await drain(refusedStatus);
  assertEquals(
    reads(),
    beforeRefusal,
    "a refused poll must not resolve a token or scan a single episode",
  );

  // And a garbage token counts too: refusing only well-formed tokens would leave probing free.
  const refusedGarbage = await fetch(new Request(`${BASE}/listen/aaaaaaaaaaaaaaaaaaaa`), CLIENT);
  assertEquals(refusedGarbage.status, 429);
  await drain(refusedGarbage);
  assertEquals(reads(), beforeRefusal, "a refused probe costs no store read either");
});
