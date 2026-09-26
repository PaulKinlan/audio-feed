/**
 * Local harness for the regenerate button (audio-feed-8oz), for a driven browser.
 *
 * Serves the REAL app (admin console, feeds, /audio) over in-memory stores seeded
 * with one approved subscriber whose episodes were made by older prompts. The
 * synthesizer is a stub: no Gemini key, no spend. It blocks on a gate until
 * `release()` is called, so a driver can look at the feed WHILE the new audio is
 * being made and show the old audio is still what is served.
 *
 * Deliberately NOT part of the gate: fixed admin token, localhost only.
 *
 *   deno run --allow-all --unstable-kv scripts/regenerate-harness.ts [port]
 *
 * Run standalone, the gate is released after 3 s so it can be clicked by hand.
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { PROMPT_VERSION } from "../src/tts/prompt_version.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import type { Synthesizer } from "../src/worker/synthesis.ts";
import type { Episode } from "../src/types.ts";

export const HARNESS_ADMIN_TOKEN = "harness-admin";
export const HARNESS_FEED_TOKEN = "harness-feed-token";
export const OLD_KEY = "audio/sub-1/direct/ep-old.wav";

function wav(fill: number, bytes = 4800): Uint8Array {
  const raw = new Uint8Array(44 + bytes).fill(fill);
  raw.set([0x52, 0x49, 0x46, 0x46], 0);
  raw.set([0x57, 0x41, 0x56, 0x45], 8);
  raw.set([0x64, 0x61, 0x74, 0x61], 36);
  return raw;
}

export async function startRegenerateHarness(port = 8133, autoReleaseMs?: number) {
  const base = `http://localhost:${port}`;
  const stores = memoryStores();
  const now = "2026-09-20T09:00:00.000Z";

  await stores.metadata.putUser({
    id: "sub-1",
    email: "listener@example.com",
    displayName: "Listener",
    status: "approved",
    isAdmin: false,
    createdAt: now,
    feedToken: HARNESS_FEED_TOKEN,
  });
  await stores.metadata.putSource({
    id: "src-1",
    userId: "sub-1",
    title: "Example Blog",
    feedUrl: "https://example.com/feed.xml",
    modes: ["direct"],
    voices: {},
    createdAt: now,
  });

  const episode = (id: string, title: string, over: Partial<Episode>): Episode => ({
    id,
    userId: "sub-1",
    sourceId: "src-1",
    sourceTitle: "Example Blog",
    articleId: `art-${id}`,
    mode: "direct",
    status: "ready",
    title,
    audioKey: `audio/sub-1/direct/${id}.wav`,
    byteLength: 4844,
    durationSeconds: 1,
    contentType: "audio/wav",
    createdAt: now,
    readyAt: "2026-09-20T09:05:00.000Z",
    ...over,
  });
  const seeded: Episode[] = [
    episode("ep-old", "Made with the old prompts", { promptVersion: "0ld0ld0ld0ld" }),
    episode("ep-current", "Made with the current prompts", {
      promptVersion: PROMPT_VERSION,
      createdAt: "2026-09-19T09:00:00.000Z",
    }),
  ];
  for (const ep of seeded) {
    await stores.metadata.putArticle({
      id: ep.articleId,
      userId: "sub-1",
      sourceId: "src-1",
      url: `https://example.com/${ep.id}`,
      title: ep.title,
      content: "Article body kept for re-synthesis.",
      ingestedAt: now,
    });
    await stores.blobs.put(ep.audioKey!, wav(ep.id === "ep-old" ? 1 : 2), {
      contentType: "audio/wav",
    });
    await stores.metadata.putEpisode(ep);
  }

  let release: () => void = () => {};
  let started: () => void = () => {};
  const synthesisStarted = new Promise<void>((resolve) => (started = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const synthesizer: Synthesizer = async () => {
    calls++;
    started();
    if (autoReleaseMs !== undefined) setTimeout(release, autoReleaseMs);
    await gate;
    const raw = wav(7);
    const audio: DecodedAudioResult = {
      rawBytes: raw,
      mimeType: "audio/wav",
      format: "wav",
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      durationSeconds: 1,
      finishReason: "STOP",
      truncated: false,
      toWav: () => raw,
    };
    return audio;
  };

  const ctx = { config: { port, publicBaseUrl: base, adminToken: HARNESS_ADMIN_TOKEN }, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx, { synthesizer }));
  const server = Deno.serve({ port, onListen: () => {} }, fetch);
  return {
    base,
    stores,
    release: () => release(),
    synthesisStarted,
    synthesizerCalls: () => calls,
    shutdown: () => server.shutdown(),
  };
}

if (import.meta.main) {
  const port = Number(Deno.args[0] ?? 8133);
  const h = await startRegenerateHarness(port, 3000);
  console.log(
    `regenerate harness: ${h.base}/admin  admin token: ${HARNESS_ADMIN_TOKEN}  ` +
      `feed: ${h.base}/feed/${HARNESS_FEED_TOKEN}/master.xml`,
  );
}
