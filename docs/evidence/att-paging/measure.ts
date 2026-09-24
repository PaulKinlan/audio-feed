/**
 * audio-feed-att measurement: peak Episode objects held in one call, before and
 * after the paging change, on the REAL KV adapter (the memory adapter slices by
 * limit and hides the read pattern — the same calibration note the bead records).
 *
 *   deno run --allow-env --allow-read --allow-write --unstable-kv \
 *     docs/evidence/att-paging/measure.ts
 */
import { openStores } from "../../../src/config.ts";
import type { Episode } from "../../../src/types.ts";

const USER = "user-1";
const SOURCE = "src-big";
const OTHER = "src-other";
const OWNED = 1500;
const NOISE = 500;
const BATCH = 100;

const stores = await openStores({ kvPath: ":memory:" });
const base = Date.parse("2026-01-01T00:00:00.000Z");
const episode = (id: string, sourceId: string, i: number): Episode => ({
  id,
  userId: USER,
  sourceId,
  articleId: `article-${i}`,
  mode: "direct",
  status: "ready",
  title: `Episode ${i}`,
  audioKey: `audio/${USER}/direct/${id}.mp3`,
  byteLength: 1024,
  durationSeconds: 300,
  contentType: "audio/mpeg",
  createdAt: new Date(base + i * 1000).toISOString(),
  readyAt: new Date(base + i * 1000).toISOString(),
});

const started = Date.now();
for (let i = 0; i < OWNED; i++) {
  await stores.metadata.putEpisode(episode(`own-${i}`, SOURCE, i));
}
for (let i = 0; i < NOISE; i++) {
  await stores.metadata.putEpisode(episode(`noise-${i}`, OTHER, i + OWNED));
}
const seededMs = Date.now() - started;

// BEFORE: what the four call sites did — one call, whole result resident.
const before = await stores.metadata.listEpisodes({
  userId: USER,
  sourceId: SOURCE,
  status: "ready",
  limit: Number.POSITIVE_INFINITY,
});
const beforeMs = Date.now() - started - seededMs;

// AFTER: what the handler does now — one batch resident at a time.
let pages = 0;
let peakBatch = 0;
let counted = 0;
let cursor: string | undefined;
const scanStarted = Date.now();
for (;;) {
  const page = await stores.metadata.listEpisodePage({
    userId: USER,
    sourceId: SOURCE,
    status: "ready",
    limit: BATCH,
    cursor,
  });
  pages++;
  peakBatch = Math.max(peakBatch, page.episodes.length);
  counted += page.episodes.length;
  if (!page.cursor || page.cursor === cursor) break;
  cursor = page.cursor;
}
const afterMs = Date.now() - scanStarted;

const bytesOf = (list: Episode[]) => new TextEncoder().encode(JSON.stringify(list)).length;

console.log(
  JSON.stringify(
    {
      store: "KvMetadataStore (:memory:)",
      userEpisodes: OWNED + NOISE,
      sourceEpisodes: OWNED,
      seedMs: seededMs,
      before: {
        callCount: 1,
        materialised: before.length,
        peakResidentBytes: bytesOf(before),
        ms: beforeMs,
      },
      after: {
        callCount: pages,
        materialised: counted,
        peakResidentBatch: peakBatch,
        peakResidentBytes: bytesOf(before.slice(0, peakBatch)),
        ms: afterMs,
      },
      coverageIdentical: counted === before.length,
    },
    null,
    2,
  ),
);

await stores.metadata.close();
