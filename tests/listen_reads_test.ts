/**
 * audio-feed-3jb — the `/listen/*` read bound.
 *
 * The defect this pins: one player page load fired FOUR status-filtered scans (pending 100,
 * synthesizing 100, failed 20, ready 200), and in kv.ts each entry of each scan cost its own
 * serial `getEpisode` — 400-800 remote KV reads before a phone could render. The panel and the
 * rows are now two views of ONE newest-first traversal, the reads are batched, and the article
 * lookups are batched too.
 *
 * A bound nobody counts is a bound that comes back, so this suite drives the real routes through
 * a wrapping store and asserts the SHAPE of what was asked for: no status-filtered scan, no
 * per-entry route read, no per-row article await, and a page that still pages through
 * non-publishable noise to its cap (audio-feed-2w8's shape, preserved).
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { playerData } from "./listen_client.ts";
import { LISTEN_RECENT_SCAN, LISTEN_ROW_CAP } from "../src/routes/listen.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { Episode } from "../src/types.ts";
import type { EpisodePage, EpisodePageResult, MetadataStore } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const TOKEN = "token-reads";

interface Counts {
  listEpisodePage: number;
  statusFiltered: number;
  getEpisode: number;
  getArticle: number;
  getArticles: number;
  articleIds: number;
  entries: number;
}

/**
 * Counts what the ROUTE asks the store for. A Proxy, not a spread: the store's methods live on
 * its prototype, so `{...store}` would silently drop every behaviour it was meant to observe.
 */
function counting(store: MetadataStore): { store: MetadataStore; counts: Counts } {
  const counts: Counts = {
    listEpisodePage: 0,
    statusFiltered: 0,
    getEpisode: 0,
    getArticle: 0,
    getArticles: 0,
    articleIds: 0,
    entries: 0,
  };
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      switch (prop) {
        case "listEpisodePage":
          return (query: EpisodePage): Promise<EpisodePageResult> => {
            counts.listEpisodePage += 1;
            if (query.status) counts.statusFiltered += 1;
            return value.call(target, query).then((page: EpisodePageResult) => {
              counts.entries += page.episodes.length;
              return page;
            });
          };
        case "getEpisode":
          return (userId: string, id: string) => {
            counts.getEpisode += 1;
            return value.call(target, userId, id);
          };
        case "getArticle":
          return (userId: string, id: string) => {
            counts.getArticle += 1;
            return value.call(target, userId, id);
          };
        case "getArticles":
          return (userId: string, ids: string[]) => {
            counts.getArticles += 1;
            counts.articleIds += ids.length;
            return value.call(target, userId, ids);
          };
        default:
          return value.bind(target);
      }
    },
  });
  return { store: wrapped, counts };
}

/** Newest-first ordering is by createdAt, so the fixture assigns distinct, decreasing times. */
function minutesAgo(minutes: number): string {
  return new Date(Date.parse("2026-09-20T12:00:00.000Z") - minutes * 60_000).toISOString();
}

interface EpisodeSpec {
  id: string;
  status: Episode["status"];
  regenerating?: boolean;
  /** `false` makes an episode non-publishable (no audio yet), which is the noise under test. */
  audio?: boolean;
}

async function seed(stores: Stores, specs: EpisodeSpec[]): Promise<void> {
  await stores.metadata.putUser(makeUser({ id: "user-1", feedToken: TOKEN }));
  await stores.metadata.putSource(makeSource({ id: "src-a", userId: "user-1" }));
  let minute = 0;
  for (const spec of specs) {
    const articleId = `art-${spec.id}`;
    await stores.metadata.putArticle(
      makeArticle({ id: articleId, userId: "user-1", sourceId: "src-a" }),
    );
    await stores.metadata.putEpisode(makeEpisode({
      id: spec.id,
      userId: "user-1",
      sourceId: "src-a",
      articleId,
      status: spec.status,
      regenerating: spec.regenerating,
      createdAt: minutesAgo(minute++),
      readyAt: spec.status === "ready" ? minutesAgo(minute) : undefined,
      audioKey: spec.audio === false ? undefined : `audio/user-1/direct/${spec.id}.mp3`,
    }));
  }
}

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  return createApp(ctx, createHandlers(ctx));
}

Deno.test("one page load: no status fan-out, no per-entry reads, batched articles (audio-feed-3jb)", async () => {
  const inner = memoryStores();
  // 20 newest episodes pending, then 100 publishable: the four-scan shape asked for each status
  // separately, and every entry in every scan was its own remote read.
  await seed(inner, [
    ...Array.from(
      { length: 20 },
      (_, i) => ({ id: `ep-pending-${i}`, status: "pending" as const, audio: false }),
    ),
    ...Array.from({ length: 100 }, (_, i) => ({ id: `ep-ready-${i}`, status: "ready" as const })),
  ]);
  const { store, counts } = counting(inner.metadata);
  const { fetch } = app({ ...inner, metadata: store });

  const res = await fetch(new Request(`${BASE}/listen/${TOKEN}`));
  assertEquals(res.status, 200);

  assertEquals(
    counts.statusFiltered,
    0,
    "no status-filtered scan: the 4-way fan-out is the defect",
  );
  assertEquals(counts.getEpisode, 0, "no per-entry route read: kv batches inside listEpisodePage");
  assertEquals(counts.getArticle, 0, "no per-row article await: the batch read is used");
  assert(counts.getArticles >= 1, "articles are fetched in a batch");
  assertEquals(counts.articleIds, 100, "one article read per ROW, not per store call");
  assertEquals(counts.entries, 120, "both index pages are read once each");
  const data = playerData(await res.text());
  assertEquals(data.episodes?.length, 100, "every publishable episode is listed");
});

Deno.test("the rows still page past newer non-publishable noise to the cap (audio-feed-2w8 shape)", async () => {
  const inner = memoryStores();
  // 50 newest are not publishable; the 250 ready episodes behind them must still fill the page's
  // cap. This is the guarantee a single capped scan would have broken.
  await seed(inner, [
    ...Array.from({ length: 50 }, (_, i) => ({
      id: `ep-noise-${i}`,
      status: (i % 2 === 0 ? "pending" : "failed") as Episode["status"],
      audio: false,
    })),
    ...Array.from({ length: 250 }, (_, i) => ({ id: `ep-ready-${i}`, status: "ready" as const })),
  ]);
  const { store, counts } = counting(inner.metadata);
  const { fetch } = app({ ...inner, metadata: store });

  const res = await fetch(new Request(`${BASE}/listen/${TOKEN}`));
  assertEquals(res.status, 200);
  const data = playerData(await res.text());
  assertEquals(
    data.episodes?.length,
    LISTEN_ROW_CAP,
    "the publishable cap is honoured through the noise",
  );
  assertEquals(counts.statusFiltered, 0, "paging, not status fan-out");
  assertEquals(
    counts.getEpisode,
    0,
    "paging costs index pages plus batched reads, never per-entry reads",
  );
  assertEquals(counts.getArticle, 0, "article reads are batched");
  assert(counts.listEpisodePage <= 4, `bounded paging: ${counts.listEpisodePage} pages`);
  assert(
    counts.entries <= LISTEN_RECENT_SCAN,
    `the scan stays inside the window: ${counts.entries} > ${LISTEN_RECENT_SCAN}`,
  );
  const timing = res.headers.get("server-timing");
  assert(
    timing !== null && /db;dur=\d+(?:\.\d+)?, render;dur=\d+(?:\.\d+)?/.test(timing),
    `Server-Timing must be present and parseable: ${timing}`,
  );
});

Deno.test("the panel derives from the one scanned window; the status route adds no scan (audio-feed-3jb, 8oz)", async () => {
  const inner = memoryStores();
  await seed(inner, [
    { id: "ep-ready", status: "ready" },
    { id: "ep-queued", status: "pending", audio: false },
    { id: "ep-generating", status: "synthesizing", audio: false },
    { id: "ep-failed", status: "failed", audio: false },
    // A regeneration is pending but still plays its old audio (audio-feed-8oz).
    { id: "ep-regen", status: "pending", regenerating: true },
    { id: "ep-stale-failed", status: "failed", audio: false },
  ]);
  const { store, counts } = counting(inner.metadata);
  const { fetch } = app({ ...inner, metadata: store });

  const res = await fetch(new Request(`${BASE}/listen/${TOKEN}/status`));
  assertEquals(res.status, 200);
  const activity = await res.json();

  assertEquals(counts.listEpisodePage, 1, "ONE scan serves the panel");
  assertEquals(counts.statusFiltered, 0, "the panel adds no status-filtered read");
  assertEquals(activity.inProgress.length, 2, "queued + generating");
  assertEquals(activity.failed.length, 2);
  assertEquals(activity.playable, 2, "ready plus the regenerating episode still on its old audio");
  const timing = res.headers.get("server-timing");
  assert(
    timing !== null && /db;dur=\d+(?:\.\d+)?, render;dur=\d+(?:\.\d+)?/.test(timing),
    `Server-Timing must be present and parseable: ${timing}`,
  );
});
