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
 * Five rows, each a different guarantee:
 *  1. N+1 rapid requests are refused, and the refusal has the SAME shape as the `/audio` one
 *     (measured against a real `/audio` 429 in the same process, not asserted from memory).
 *  2. Legitimate polling survives: 20 polls — five minutes of the player's documented 15s poll —
 *     all succeed, with the bound stated as a multiple of that cadence.
 *  3. The limiter runs before store work: a refused request performs ZERO tenant reads.
 *  4. Two consecutive driller groups, each driven PAST the page budget, both pass because the
 *     seam (`resetListenReadWindows`) reopens both read windows between them (audio-feed-chpka).
 *  5. Without that seam the SAME drill is refused across groups: the window is shared state and
 *     the bound still holds, so row 4 cannot be passing because the limiter is broken.
 *
 * Every row starts from an empty window (`resetWindows` below) rather than from "this is the
 * first row that touched these stores": at 60 page loads per window the sixty-first load of a
 * RUN is indistinguishable from a limiter defect, and which rows are affected would depend on
 * how many requests earlier rows made (audio-feed-chpka).
 *
 * Rows 1-5 take their LOOP COUNTS from the constants, which is right — they test behaviour AT the
 * bound — but it left the width of the bound itself unowned, so three more rows pin it by LITERAL
 * (audio-feed-cfogj, "the bound's width" below).
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import {
  LISTEN_PAGE_RATE,
  LISTEN_STATUS_RATE,
  resetListenReadWindows,
} from "../src/routes/listen.ts";
import { AUDIO_RATE_LIMIT } from "../src/routes/audio.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { Episode } from "../src/types.ts";
import type { MetadataStore } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const TOKEN = "token-listen-limit";

/** One client address, so every request below shares one bucket (the abuse case). */
const CLIENT_ADDR = "198.51.100.7";
const CLIENT = { remoteAddr: { hostname: CLIENT_ADDR } };

/** The player's poll cadence, quoted from `src/assets/listen.js:1057` ("a 15s poll"). */
const POLL_MS = 15_000;

/**
 * The two bounds as the code comment states them (audio-feed-cfogj).
 *
 * LITERALS on purpose: these are the only place in the suite the widths are written down, so a
 * widened `LISTEN_PAGE_RATE`/`LISTEN_STATUS_RATE` cannot move them with it. The comment above
 * `LISTEN_PAGE_RATE` in `src/routes/listen.ts` states both ("PAGE 60/5min", "STATUS 120/5min").
 */
const DOCUMENTED_PAGE_BOUND = { maxRequests: 60, windowMs: 5 * 60 * 1000 };
const DOCUMENTED_STATUS_BOUND = { maxRequests: 120, windowMs: 5 * 60 * 1000 };

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  return createApp(ctx, createHandlers(ctx));
}

/**
 * Start this row's group from an EMPTY window on both listen read rows (audio-feed-chpka).
 *
 * The windows live in the store, so without this a row inherits whatever earlier rows spent and
 * a 429 then means "the run was long" rather than "the bound works". The bounds themselves are
 * untouched: rows 4 and 5 below prove the window still fills, still refuses, and still refuses
 * across groups when this is not called.
 */
function resetWindows(stores: Stores): Promise<void> {
  return resetListenReadWindows(stores.metadata, CLIENT_ADDR);
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
  await resetWindows(stores);

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
  await resetWindows(stores);

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
  await resetWindows({ ...inner, metadata: store });

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

/**
 * Drive the page route to its bound on `CLIENT` and one request past it.
 *
 * `group` names the row-group in every message: a driller group that starts with a spent window
 * fails on its FIRST load, and the message has to say which group inherited what
 * (audio-feed-chpka).
 */
async function drivePagePastBound(
  fetch: (req: Request, info?: { remoteAddr?: { hostname: string } }) => Promise<Response>,
  group: string,
): Promise<void> {
  for (let i = 0; i < LISTEN_PAGE_RATE.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
    assertEquals(
      res.status,
      200,
      i === 0
        ? `${group}: its FIRST page load was refused, so this group started from a spent window`
        : `${group}: page load ${i + 1} must be within the bound`,
    );
    await drain(res);
  }
  const refused = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
  assertEquals(refused.status, 429, `${group}: the group must still reach the bound`);
  await drain(refused);
}

Deno.test("the reset seam reopens both read windows: two driller groups in a row each pass the budget (audio-feed-chpka)", async () => {
  const stores = memoryStores();
  await seed(stores, 1);
  const { fetch } = app(stores);

  // GROUP ONE spends BOTH windows: the page to its bound and the poll to its own.
  await resetWindows(stores);
  await drivePagePastBound(fetch, "group 1");
  for (let i = 0; i < LISTEN_STATUS_RATE.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
    assertEquals(res.status, 200, `group 1: poll ${i + 1} must be within the bound`);
    await drain(res);
  }
  const statusRefused = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
  assertEquals(statusRefused.status, 429, "group 1 must reach the poll bound as well");
  await drain(statusRefused);

  // Between the groups: both windows were full one line ago, which is the whole point — the
  // second group cannot start an empty window by itself, it needs the seam.
  await resetWindows(stores);

  // GROUP TWO exceeds the page budget exactly as group one did, and passes.
  await drivePagePastBound(fetch, "group 2");
  const reopenedPoll = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
  assertEquals(
    reopenedPoll.status,
    200,
    "the seam must reopen the POLL window too, not only the page's",
  );
  await drain(reopenedPoll);
});

Deno.test("without the seam the bound still holds across groups, so the reset cannot hide a broken limiter (audio-feed-chpka)", async () => {
  const stores = memoryStores();
  await seed(stores, 1);
  const { fetch } = app(stores);
  await resetWindows(stores);

  await drivePagePastBound(fetch, "the only group");

  // NO reset. A second group is what row 4 above would start here, and it must be refused from
  // its very first request: the window is shared state, still full, still bounded. If a future
  // change ever lets `resetListenReadWindows` clear more than the recorded history — a raised
  // bound, a widened window, a namespace that no longer matches the handler's — this is the row
  // that reddens, while row 4 would keep passing.
  const secondGroupFirstLoad = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
  assertEquals(
    secondGroupFirstLoad.status,
    429,
    "a second group with NO reset must be refused on its first page load",
  );
  const retryAfter = secondGroupFirstLoad.headers.get("retry-after");
  assert(
    retryAfter !== null && Number(retryAfter) >= 1,
    "the across-groups refusal must say when the window reopens",
  );
  await drain(secondGroupFirstLoad);

  // And the refusal is not a global latch: an address that never drilled is still served.
  const untouched = await fetch(new Request(`${BASE}/listen/${TOKEN}`), {
    remoteAddr: { hostname: "198.51.100.9" },
  });
  assertEquals(untouched.status, 200, "the exhausted window must not spill onto another address");
  await drain(untouched);
});

/**
 * The bound's width (audio-feed-cfogj) — the three rows that make each limit load-bearing on its
 * own numbers rather than on the constant under test.
 *
 * Every row above drills `LISTEN_PAGE_RATE.maxRequests` / `LISTEN_STATUS_RATE.maxRequests` times,
 * which is the correct input for a behaviour row at the bound but is also why the bound could be
 * widened with the whole suite staying green: measured on fleet/listen-ratetest, `maxRequests: 60`
 * -> `6000` left 5 passed / 0 failed, because the rows simply drilled 6000 requests. The public,
 * unauthenticated `/listen` surface would then have lost its protection by a one-word edit with
 * nothing failing, and the seam rows above would have been clearing a budget nobody enforced.
 *
 * The invariants here are the operator-facing ones: 60 page loads and 120 polls per five minutes
 * per client address; a request past either is refused with `429`, a JSON `too_many_requests` body
 * and a `retry-after` in seconds; the refused request does NO tenant work; the two bounds are
 * separate windows (a page reload does not eat the polls a player already has open); and the
 * recording seam is the ONLY way back in, because a retry with no clock moved stays refused.
 *
 * Mutants, each run by hand on this commit, each verified to have LANDED by diffing
 * `src/routes/listen.ts` before its result was believed:
 *  - `LISTEN_PAGE_RATE` widened to `{ maxRequests: 6000, windowMs: 5 * 60 * 1000 }` (the exact
 *    loosening that stayed green on the earlier branch): the documented-numbers row reddens, and
 *    so does the page row, on "the sixty-first load must be refused" — 6000 admits it.
 *  - `LISTEN_STATUS_RATE` widened to `{ maxRequests: 12000, ... }`: the documented-numbers row
 *    reddens, and so does the status row, on the poll past 120.
 *  - the `refuseListenRead` call deleted from `handleListen`: the page row reddens at load 61, and
 *    its read counter shows the load doing tenant work again.
 *  - `refuseListenRead` deleted from `handleListenStatus`: the status row reddens at poll 121.
 *  - `resetListenReadWindows` reduced to a no-op: the page row reddens on "the seam is what
 *    reopens the window", so the way back in is the seam and nothing else.
 */
Deno.test("the listen read bounds are the documented numbers, written as literals (audio-feed-cfogj)", () => {
  assertEquals(
    LISTEN_PAGE_RATE,
    DOCUMENTED_PAGE_BOUND,
    "the page bound is 60 loads per five minutes (src/routes/listen.ts: 'PAGE 60/5min')",
  );
  assertEquals(
    LISTEN_STATUS_RATE,
    DOCUMENTED_STATUS_BOUND,
    "the poll bound is 120 requests per five minutes (src/routes/listen.ts: 'STATUS 120/5min')",
  );
});

Deno.test("listen page: sixty loads are served, the sixty-first is refused and spends no tenant read (audio-feed-cfogj)", async () => {
  const inner = memoryStores();
  await seed(inner, 1);
  const { store, reads } = counting(inner.metadata);
  const stores: Stores = { ...inner, metadata: store };
  const { fetch } = app(stores);
  await resetWindows(stores);

  for (let i = 0; i < DOCUMENTED_PAGE_BOUND.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
    assertEquals(res.status, 200, `page load ${i + 1} of 60 must be within the bound`);
    await drain(res);
  }
  const readsBeforeRefusal = reads();
  assert(readsBeforeRefusal > 0, "the sixty admitted loads must have done real store work");

  const refused = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
  assertEquals(refused.status, 429, "the sixty-first load in a five-minute window must be refused");
  const retryAfter = refused.headers.get("retry-after");
  assert(
    retryAfter !== null && Number(retryAfter) >= 1,
    "the page refusal must carry a retry-after of at least one second",
  );
  const body = await refused.json();
  assertEquals(body.error, "too_many_requests", "the refusal names the machine-readable reason");
  assertEquals(
    reads(),
    readsBeforeRefusal,
    "a refused page load must not resolve a token or scan a single episode",
  );

  // The seam is the ONLY way back in. No clock moves between these two lines, so a retry that was
  // admitted here would mean the bound was advisory and the window healed itself.
  const retryWithoutSeam = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
  assertEquals(
    retryWithoutSeam.status,
    429,
    "a retry with no seam and no clock movement must still be refused",
  );
  await drain(retryWithoutSeam);
  assertEquals(reads(), readsBeforeRefusal, "and that retry spends no tenant read either");

  // Separate windows: a refused page load does not close the poll a player already has open.
  const pollWhilePageRefused = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
  assertEquals(
    pollWhilePageRefused.status,
    200,
    "the page and the poll have separate windows, so an exhausted page bound leaves polling served",
  );
  await drain(pollWhilePageRefused);

  await resetWindows(stores);
  const afterSeam = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
  assertEquals(
    afterSeam.status,
    200,
    "the reset seam is what reopens the page window, and it does",
  );
  await drain(afterSeam);
});

Deno.test("listen status: one hundred and twenty polls are served, the hundred-and-twenty-first is refused (audio-feed-cfogj)", async () => {
  const inner = memoryStores();
  await seed(inner, 2);
  const { store, reads } = counting(inner.metadata);
  const stores: Stores = { ...inner, metadata: store };
  const { fetch } = app(stores);
  await resetWindows(stores);

  for (let i = 0; i < DOCUMENTED_STATUS_BOUND.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
    assertEquals(res.status, 200, `poll ${i + 1} of 120 must be within the bound`);
    const payload = await res.json();
    assertEquals(payload.playable, 2, `poll ${i + 1} must still answer with the real panel`);
  }
  const readsBeforeRefusal = reads();
  assert(readsBeforeRefusal > 0, "the hundred and twenty polls must have done real store work");

  const refused = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
  assertEquals(
    refused.status,
    429,
    "the hundred-and-twenty-first poll in a five-minute window must be refused",
  );
  const retryAfter = refused.headers.get("retry-after");
  assert(
    retryAfter !== null && Number(retryAfter) >= 1,
    "the poll refusal must carry a retry-after of at least one second",
  );
  const body = await refused.json();
  assertEquals(body.error, "too_many_requests", "the refusal names the machine-readable reason");
  assertEquals(
    reads(),
    readsBeforeRefusal,
    "a refused poll must not resolve a token or scan a single episode",
  );

  // 120 polls spent NONE of the 60 page loads: the two namespaces are separate buckets, so a
  // player hammering its poll cannot lock the subscriber out of the page itself.
  const pageAfterPollRefusal = await fetch(new Request(`${BASE}/listen/${TOKEN}`), CLIENT);
  assertEquals(
    pageAfterPollRefusal.status,
    200,
    "the poll bound is its own window: it must not spend the page's allowance",
  );
  await drain(pageAfterPollRefusal);

  await resetWindows(stores);
  const afterSeam = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`), CLIENT);
  assertEquals(afterSeam.status, 200, "the reset seam reopens the poll window, and it does");
  await drain(afterSeam);
});
