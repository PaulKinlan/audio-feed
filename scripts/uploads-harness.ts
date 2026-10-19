/**
 * Local harness for the uploads browser acceptance proof (audio-feed-d82rv).
 *
 * Same shape as scripts/account-harness.ts - the REAL app on memory stores,
 * seeded with an approved admin, an approved reader and an unapproved invitee,
 * feed and article fetches stubbed so nothing touches the network - PLUS the
 * one thing account-harness deliberately does not have: a running synthesis
 * worker. Without it an upload queues an episode that stays pending forever
 * (src/server.ts only starts the in-memory worker outside deploy AND when a
 * synthesizer was passed in), which is exactly what stalled the first harness
 * (fleet/flake-a1-d82rv): every row timed out waiting for ready.
 *
 * THE SYNTHESIZER IS A DETERMINISTIC STUB, NOT GEMINI. server.ts:143 defaults
 * to the env-derived real Gemini client, which would spend money on every run;
 * this harness injects a stub that returns fixed WAV bytes and a fixed duration
 * for any article. An episode that reaches READY here proves the pipeline
 * (upload -> extraction -> queue -> worker -> stored audio -> ready), NOT the
 * voice. Any evidence printed from a run of this harness must say so.
 *
 * OBSERVABILITY HOOK (harness-only, not an app route): the stub appends one
 * JSON line per job to the narration log - episodeId, articleId, title,
 * textBytes and the first 2,000 chars of the exact text it was asked to speak.
 * The proof reads that file to assert each fixture's distinctive sentence
 * REACHED narration (and, for html, that the <script> body did not). The path
 * is printed on stdout as `NARRATION_LOG path=...` before READY; override with
 * D82RV_NARRATION_LOG.
 *
 *   deno run --allow-all --unstable-kv scripts/uploads-harness.ts [port]
 */
import { resolveHarnessPort } from "./harness-port.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { startSynthesisWorker } from "../src/worker/synthesis.ts";
import type { Synthesizer } from "../src/worker/synthesis.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";

const port = resolveHarnessPort(
  Deno.args,
  Deno.env.get("ACCOUNT_HARNESS_PORT"),
);
const stores = memoryStores();
const config = { port, adminToken: "harness-admin" };
const ctx = { config, stores };
const store = stores.metadata;

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Weekly</title>
<link>https://example.com</link><item><title>A post worth hearing</title>
<link>https://example.com/post</link><pubDate>Fri, 25 Sep 2026 06:00:00 +0000</pubDate>
</item></channel></rss>`;

async function person(
  email: string,
  displayName: string,
  isAdmin: boolean,
  approve: boolean,
  feedToken?: string,
) {
  let user = await createUser(store, { email, displayName, isAdmin });
  if (approve) {
    user = await approveUser(store, user.id, "harness");
  }
  if (feedToken) {
    user.feedToken = feedToken;
    await store.putUser(user);
  }
  return user;
}

// Creation order matches account-harness.ts: the proof signs in as users[0],
// which must be the approved admin.
await person("paul@example.com", "Paul Kinlan", true, true, "feedtokenpaul0000000000000000001");
await person("rita@example.com", "Rita Reader", false, true, "feedtokenrita0000000000000000002");
await person("sam@example.com", "Sam Newcomer", false, false, "feedtokensam00000000000000000003");

// No episodes are seeded on purpose: account-harness seeds one PENDING episode,
// and with a worker running here that episode would be claimed and turned ready
// mid-run, polluting the proof's fresh-episode detection with a row no upload
// produced.

/** The exact artefact the stub hands back for every job: fixed bytes, fixed duration. */
function stubAudio(): DecodedAudioResult {
  const raw = new Uint8Array(524);
  raw.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  raw.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  raw.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  return {
    rawBytes: raw,
    mimeType: "audio/wav",
    format: "wav",
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    durationSeconds: 2,
    finishReason: "STOP",
    truncated: false,
    toWav: () => raw,
  };
}

const narrationLogPath = Deno.env.get("D82RV_NARRATION_LOG") ??
  (await Deno.makeTempFile({ prefix: "audiofeed-d82rv-narration-", suffix: ".jsonl" }));

/** Records what it was asked to speak, then returns the fixed stub artefact. */
const stubSynthesizer: Synthesizer = async ({ episode, article }) => {
  const line = JSON.stringify({
    episodeId: episode.id,
    articleId: article.id,
    title: article.title,
    textBytes: new TextEncoder().encode(article.content).byteLength,
    textHead: article.content.slice(0, 2000),
    at: new Date().toISOString(),
  });
  await Deno.writeTextFile(narrationLogPath, line + "\n", { append: true });
  return stubAudio();
};

const handlers = createHandlers(ctx, {
  feedTransport: () =>
    Promise.resolve(new Response(RSS, { headers: { "content-type": "application/rss+xml" } })),
  fetchArticle: (url) =>
    Promise.resolve({
      url,
      title: "An article sent from the account page",
      author: "Harness",
      publishedAt: "2026-09-26T06:00:00.000Z",
      lead: "Lead.",
      body: "Body text.",
    }),
});
const { fetch } = createApp(ctx, handlers);

// The worker account-harness lacks. A short interval so a proof row waits
// seconds, not the 15s production default, for its upload to be claimed.
const workerAbort = new AbortController();
startSynthesisWorker(ctx, stubSynthesizer, {
  signal: workerAbort.signal,
  intervalMs: 1_000,
  batchSize: 5,
  onTick: (result) => {
    if (result.ready.length || result.failed.length || result.deferred.length) {
      console.log(
        `[uploads-harness] synthesis: ${result.ready.length} ready, ${result.failed.length} failed, ` +
          `${result.deferred.length} deferred (of ${result.considered})`,
      );
    }
  },
});

Deno.serve(
  {
    port,
    hostname: "localhost",
    onListen: ({ port: assignedPort }) => {
      console.log(`NARRATION_LOG path=${narrationLogPath}`);
      console.log(`SYNTHESIZER stub (fixed 524-byte WAV, fixed 2s duration; NOT Gemini)`);
      console.log(`READY port=${assignedPort} base=http://localhost:${assignedPort}`);
      console.log(`uploads harness: http://localhost:${assignedPort}/  admin token: harness-admin`);
    },
  },
  fetch,
);
