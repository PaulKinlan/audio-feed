/**
 * Local harness that serves a REAL /listen/:token page with one ready episode.
 *
 * Exists so the listener app can be driven in an actual browser (audio-feed-rqp).
 * A route returning 200 is not evidence a player works, and the Background Fetch
 * question in audio-feed-98i cannot be settled without a page that really
 * registers a service worker over a real origin.
 *
 * Deliberately NOT part of the gate: it serves a capability-bearing page on
 * localhost with a fixed token, which is fine for a driven browser session and
 * wrong for anything else.
 *
 *   deno run --allow-all --unstable-kv scripts/listen-harness.ts [port]
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { audioBlobKey } from "../src/types.ts";

const numeric = (value: string | undefined) =>
  value && /^\d+$/.test(value) ? Number(value) : undefined;
const port = numeric(Deno.args.find((a) => /^\d+$/.test(a))) ?? 8131;
const base = `http://localhost:${port}`;

const stores = memoryStores();
const config = { port, publicBaseUrl: base, adminToken: "harness-admin" };
const ctx = { config, stores };

const TOKEN = "harness-token";
const now = new Date();

await stores.metadata.putUser({
  id: "user-1",
  email: "paul@example.com",
  displayName: "Paul Kinlan",
  status: "approved",
  isAdmin: false,
  createdAt: now.toISOString(),
  feedToken: TOKEN,
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

await stores.metadata.putSource({
  id: "verge",
  userId: "user-1",
  title: "The Verge",
  feedUrl: "https://theverge.com/rss/index.xml",
  siteUrl: "https://theverge.com/",
  modes: ["direct"],
  voices: {},
  createdAt: now.toISOString(),
});

/** A small but REAL wav, so the browser can actually decode and play it. */
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
  // A quiet tone rather than silence, so a listener can tell playback happened.
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 220) * 2000, true);
  }
  return new Uint8Array(buffer);
}

interface Seed {
  id: string;
  title: string;
  author: string;
  sourceId: string;
  mode: "direct" | "deepdive";
  minutes: number;
  ageDays: number;
}

const seeds: Seed[] = [
  {
    id: "ep-1",
    title: "Aggregation theory and the shape of the modern platform",
    author: "Ben Thompson",
    sourceId: "stratechery",
    mode: "direct",
    minutes: 23,
    ageDays: 0,
  },
  {
    id: "ep-2",
    title: "What the Background Fetch reprieve says about the platform's promises",
    author: "Jxck",
    sourceId: "stratechery",
    mode: "deepdive",
    minutes: 41,
    ageDays: 1,
  },
  {
    id: "ep-3",
    title: "The quiet return of the personal feed reader",
    author: "Nilay Patel",
    sourceId: "verge",
    mode: "direct",
    minutes: 8,
    ageDays: 3,
  },
  {
    id: "ep-4",
    title: "Why every podcast app eventually builds the same player",
    author: "Marco Arment",
    sourceId: "verge",
    mode: "deepdive",
    minutes: 57,
    ageDays: 9,
  },
  {
    id: "ep-5",
    title: "Deno Deploy, cron, and the jobs you never see run",
    author: "Ryan Dahl",
    sourceId: "stratechery",
    mode: "direct",
    minutes: 14,
    ageDays: 21,
  },
];

for (const seed of seeds) {
  const at = new Date(now.getTime() - seed.ageDays * 86_400_000).toISOString();
  const articleId = `article-${seed.id}`;
  await stores.metadata.putArticle({
    id: articleId,
    userId: "user-1",
    sourceId: seed.sourceId,
    url: `https://example.com/${seed.id}`,
    title: seed.title,
    author: seed.author,
    publishedAt: at,
    content: "Body text for the harness.",
    excerpt: "A short lead for the harness.",
    ingestedAt: at,
  });

  const key = audioBlobKey({ userId: "user-1", id: seed.id, mode: seed.mode }, "wav");
  // Two seconds of audio regardless of the advertised duration: the page renders
  // durationSeconds from metadata, and nobody needs a 57-minute fixture.
  const bytes = wav(2);
  await stores.blobs.put(key, bytes, { contentType: "audio/wav" });

  await stores.metadata.putEpisode({
    id: seed.id,
    userId: "user-1",
    sourceId: seed.sourceId,
    sourceTitle: seed.sourceId === "verge" ? "The Verge" : "Stratechery",
    articleId,
    mode: seed.mode,
    status: "ready",
    title: seed.title,
    description: "A short lead for the harness.",
    audioKey: key,
    durationSeconds: seed.minutes * 60,
    byteLength: bytes.byteLength,
    createdAt: at,
    readyAt: at,
  });
}

const { fetch } = createApp(ctx, createHandlers(ctx));
Deno.serve({ port }, fetch);

console.log(`listen harness: ${base}/listen/${TOKEN}`);
console.log(`  episodes: ${seeds.length}`);
