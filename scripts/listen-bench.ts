/**
 * listen-bench — `/listen/:token` against a real KV store seeded with ~200 episodes.
 *
 * Why a script and not a test: the acceptance asks for a NUMBER a person can compare before and
 * after, and the number has to describe the production read path (KvMetadataStore), not a
 * memory-store fixture. The store is `:memory:` so the bench is hermetic; the code path, the
 * index scans and the batched reads are the real ones.
 *
 *   deno run --allow-read --allow-env --unstable-kv scripts/listen-bench.ts [episodes] [iterations]
 *
 * Prints one JSON line per run: per-page-load index entries considered, listEpisodePage calls,
 * wall-clock min/median/mean, and the Server-Timing the response carried.
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { MemoryBlobStore } from "../src/storage/memory.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { Episode } from "../src/types.ts";
import type { EpisodePage, EpisodePageResult } from "../src/storage/mod.ts";

const EPISODES = Number(Deno.args[0] ?? 200);
const ITERATIONS = Number(Deno.args[1] ?? 5);
const TOKEN = "token-bench";
const CONFIG: AppConfig = {
  port: 8000,
  publicBaseUrl: "http://127.0.0.1:8787",
  adminToken: "admin-bench",
};

const ready = Math.round(EPISODES * 0.75);
const pending = Math.round(EPISODES * 0.15);
const synthesizing = Math.round(EPISODES * 0.05);
const failed = Math.max(EPISODES - ready - pending - synthesizing, 0);

function minutesAgo(minutes: number): string {
  return new Date(Date.parse("2026-09-20T12:00:00.000Z") - minutes * 60_000).toISOString();
}

async function seed(metadata: KvMetadataStore): Promise<void> {
  await metadata.putUser(makeUser({ id: "user-bench", feedToken: TOKEN }));
  await metadata.putSource(makeSource({ id: "src-bench", userId: "user-bench" }));
  const statuses: Episode["status"][] = [
    ...Array.from({ length: ready }, () => "ready" as const),
    ...Array.from({ length: pending }, () => "pending" as const),
    ...Array.from({ length: synthesizing }, () => "synthesizing" as const),
    ...Array.from({ length: failed }, () => "failed" as const),
  ];
  let minute = 0;
  for (const [index, status] of statuses.entries()) {
    const id = `ep-${index}`;
    const articleId = `art-${index}`;
    await metadata.putArticle(
      makeArticle({ id: articleId, userId: "user-bench", sourceId: "src-bench" }),
    );
    await metadata.putEpisode(makeEpisode({
      id,
      userId: "user-bench",
      sourceId: "src-bench",
      articleId,
      status,
      createdAt: minutesAgo(minute++),
      readyAt: status === "ready" ? minutesAgo(minute) : undefined,
      audioKey: status === "ready" ? `audio/user-bench/direct/${id}.mp3` : undefined,
    }));
  }
}

const metadata = await KvMetadataStore.open(":memory:");
await seed(metadata);

// The same counting instrument the acceptance test uses: what does ONE page load ask the store for?
const counts = { listEpisodePage: 0, entries: 0 };
const counting = new Proxy(metadata, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    if (prop === "listEpisodePage") {
      return (query: EpisodePage): Promise<EpisodePageResult> => {
        counts.listEpisodePage += 1;
        return value.call(target, query).then((page: EpisodePageResult) => {
          counts.entries += page.episodes.length;
          return page;
        });
      };
    }
    return value.bind(target);
  },
}) as KvMetadataStore;

const stores: Stores = {
  metadata: counting,
  blobs: new MemoryBlobStore(),
  describe: "metadata=kv(memory) blobs=memory",
};
const ctx = { config: CONFIG, stores };
const { fetch } = createApp(ctx, createHandlers(ctx));

const wall: number[] = [];
let lastTiming: string | null = null;
for (let i = 0; i < ITERATIONS; i++) {
  const start = performance.now();
  const response = await fetch(new Request(`${CONFIG.publicBaseUrl}/listen/${TOKEN}`));
  const elapsed = performance.now() - start;
  await response.text();
  if (response.status !== 200) {
    throw new Error(
      `bench page load failed: ${response.status} ct=${response.headers.get("content-type")} loc=${
        response.headers.get("location")
      }`,
    );
  }
  lastTiming = response.headers.get("server-timing");
  wall.push(elapsed);
}

wall.sort((a, b) => a - b);
const median = wall[Math.floor(wall.length / 2)] ?? 0;
const mean = wall.reduce((sum, ms) => sum + ms, 0) / wall.length;
console.log(JSON.stringify({
  event: "listen.bench",
  episodes: EPISODES,
  iterations: ITERATIONS,
  ready,
  pending,
  synthesizing,
  failed,
  perPageLoad: {
    listEpisodePage: counts.listEpisodePage / ITERATIONS,
    indexEntries: counts.entries / ITERATIONS,
  },
  wallMs: {
    min: Number((wall[0] ?? 0).toFixed(2)),
    median: Number(median.toFixed(2)),
    mean: Number(mean.toFixed(2)),
  },
  serverTiming: lastTiming,
}));
