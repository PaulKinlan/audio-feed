/**
 * Faithful local reproduction of the production CORS failure (2026-09-25).
 *
 * WHY THIS EXISTS. The bug needs three things at once, and a plain local run has
 * none of them:
 *
 *   1. a blob store that offers direct URLs, so the audio route 302s;
 *   2. those URLs on a DIFFERENT ORIGIN, so the redirect is cross-origin;
 *   3. that origin answering with NO access-control-allow-origin and a 403 to
 *      preflight — which is exactly what R2's S3 endpoint does, measured against
 *      production:
 *
 *        GET  <r2 presigned>  with Origin: <app>  -> 200, audio/wav, no CORS header
 *        OPTIONS <r2 presigned> with Origin: <app> -> 403
 *
 * `memoryStores()` returns null from url(), so locally nothing ever redirects and
 * the page works whatever the code does. A green local page was therefore never
 * evidence, which is the whole reason this file exists rather than a curl.
 *
 * So this starts TWO servers on two ports — two origins as far as a browser is
 * concerned — and wires the app's blob store to point at the other one.
 *
 *   deno run --allow-all --unstable-kv scripts/cors-repro.ts [appPort]
 *
 * The store port is appPort + 1. Load http://localhost:<appPort>/listen/repro-token.
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { audioBlobKey } from "../src/types.ts";
import type { BlobObject, BlobStore } from "../src/storage/mod.ts";

const numeric = (value: string | undefined) =>
  value && /^\d+$/.test(value) ? Number(value) : undefined;
const appPort = numeric(Deno.args.find((a) => /^\d+$/.test(a))) ?? 8140;
const storePort = appPort + 1;
const appBase = `http://localhost:${appPort}`;
const storeBase = `http://localhost:${storePort}`;

const stores = memoryStores();
const inner = stores.blobs;

/** A real (tiny) wav, so the browser can decode and play it. */
function wav(seconds: number): Uint8Array {
  const rate = 8000;
  const samples = rate * seconds;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const str = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 220) * 2000, true);
  }
  return new Uint8Array(buffer);
}

const now = new Date();

await stores.metadata.putUser({
  id: "user-1",
  email: "paul@example.com",
  displayName: "Paul Kinlan",
  status: "approved",
  isAdmin: false,
  createdAt: now.toISOString(),
  feedToken: "repro-token",
});

await stores.metadata.putSource({
  id: "stratechery",
  userId: "user-1",
  title: "Stratechery",
  feedUrl: "https://stratechery.com/feed/",
  siteUrl: "https://stratechery.com/",
  modes: ["direct", "deepdive"],
  voices: {},
  createdAt: now.toISOString(),
});

const seeds = [
  { id: "ep-1", title: "Aggregation theory and the shape of the modern platform", minutes: 23 },
  { id: "ep-2", title: "What the Background Fetch reprieve says about the platform", minutes: 41 },
];

for (const seed of seeds) {
  const key = audioBlobKey({ userId: "user-1", id: seed.id, mode: "direct" }, "wav");
  const bytes = wav(2);
  await inner.put(key, bytes, { contentType: "audio/wav" });
  await stores.metadata.putArticle({
    id: `article-${seed.id}`,
    userId: "user-1",
    sourceId: "stratechery",
    url: `https://example.com/${seed.id}`,
    title: seed.title,
    author: "Ben Thompson",
    publishedAt: now.toISOString(),
    content: "Body.",
    excerpt: "Lead.",
    ingestedAt: now.toISOString(),
  });
  await stores.metadata.putEpisode({
    id: seed.id,
    userId: "user-1",
    sourceId: "stratechery",
    sourceTitle: "Stratechery",
    articleId: `article-${seed.id}`,
    mode: "direct",
    status: "ready",
    title: seed.title,
    description: "Lead.",
    audioKey: key,
    durationSeconds: seed.minutes * 60,
    byteLength: bytes.byteLength,
    createdAt: now.toISOString(),
    readyAt: now.toISOString(),
  });
}

/**
 * The store, wrapped so `url()` answers for EVERY key with a URL on the other
 * origin. That is the production shape: R2 signs a URL for anything.
 */
const redirectingBlobs: BlobStore = {
  put: (key, body, opts) => inner.put(key, body, opts),
  head: (key) => inner.head(key),
  delete: (key) => inner.delete(key),
  get: (key, opts): Promise<BlobObject | null> => inner.get(key, opts),
  url: (key) => Promise.resolve(`${storeBase}/${key}?X-Amz-Signature=repro`),
};
stores.blobs = redirectingBlobs;

// ---------------------------------------------------------------------------
// The "object store" origin. Deliberately CORS-hostile, matching R2 exactly.
// ---------------------------------------------------------------------------
Deno.serve({ port: storePort, onListen: () => {} }, async (req) => {
  // R2's S3 endpoint answers a preflight with 403. Reproduced, because a
  // friendlier 404 here would let a browser behave differently.
  if (req.method === "OPTIONS") return new Response("preflight refused", { status: 403 });

  const key = new URL(req.url).pathname.replace(/^\//, "");
  const object = await inner.get(key);
  if (!object) return new Response("not found", { status: 404 });

  // NOTE the absence: no access-control-allow-origin, ever. That is the bug.
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.contentType,
      "content-length": String(object.size),
      "accept-ranges": "bytes",
    },
  });
});

const ctx = { config: { port: appPort, publicBaseUrl: appBase, adminToken: "repro" }, stores };
const { fetch } = createApp(ctx, createHandlers(ctx));
Deno.serve({ port: appPort }, fetch);

console.log(`cors repro app:   ${appBase}/listen/repro-token`);
console.log(`cors repro store: ${storeBase}/  (no CORS headers, OPTIONS -> 403)`);
