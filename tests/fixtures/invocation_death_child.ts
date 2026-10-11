/**
 * Child process for tests/synthesis_invocation_death_test.ts (audio-feed-aqms).
 *
 * One run of this script models ONE production invocation of the synthesis cron
 * tick against a SHARED file-backed KV store, so state survives the process
 * death the test inflicts on it:
 *
 *   hang  — seed (first round only), run runSynthesisBatch with a blobs.put that
 *           never settles, wait until the episode reaches phase "uploading_audio",
 *           print "MARKER:uploading" on stdout, then stay alive inside the put.
 *           The parent SIGKILLs this process mid-put: a real, uncatchable
 *           invocation death with NO terminal write — the exact shape of the
 *           reported incident.
 *   drain — run one normal batch (fast put). After three killed rounds the
 *           episode is out of claims, so this round observes the abandonment,
 *           and the script prints the final episode record as JSON.
 *
 * Timings are shrunken (lease 1500ms, budget 4000ms) but the ORDER of events is
 * production-faithful: claim -> checkpoint uploading_audio -> await put -> death
 * with the wrapper's deadline timer still in the future.
 */
import { KvMetadataStore } from "../../src/storage/kv.ts";
import type { BlobInfo, BlobObject, BlobStore } from "../../src/storage/mod.ts";
import { runSynthesisBatch } from "../../src/worker/synthesis.ts";
import { decodedFromWav, pcmToWav } from "../../src/tts/gemini.ts";
import type { AppConfig, Stores } from "../../src/config.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../fixtures.ts";

/** A blob store whose terminal upload never settles: `blobs.put` hangs forever. */
class HangingPutBlobStore implements BlobStore {
  put(): Promise<BlobInfo> {
    return new Promise<BlobInfo>(() => {});
  }
  putIfAbsent(): Promise<BlobInfo | null> {
    return new Promise<BlobInfo | null>(() => {});
  }
  async get(_key: string): Promise<BlobObject | null> {
    return Promise.resolve(null);
  }
  async head(_key: string): Promise<BlobInfo | null> {
    return Promise.resolve(null);
  }
  async delete(_key: string): Promise<void> {}
  url(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

const [kvPath, mode, roundArg] = Deno.args;
if (!kvPath || (mode !== "hang" && mode !== "drain") || !roundArg) {
  console.error("usage: invocation_death_child.ts <kvPath> <hang|drain> <round>");
  Deno.exit(2);
}
const round = Number(roundArg);

const metadata = await KvMetadataStore.open(kvPath);
const stores: Stores = {
  metadata,
  blobs: new HangingPutBlobStore(),
};
const config: AppConfig = { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "x" };
const ctx = { config, stores };

// Seed once; later rounds must NOT overwrite the claim state.
if (!(await metadata.getEpisode("user-1", "episode-1"))) {
  await metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "inbox",
      content: "First paragraph. Second paragraph. Third paragraph.",
    }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "pending",
      mode: "direct",
    }),
  );
}

const pcm = new Uint8Array(64);
const wav = pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
const synth = () => Promise.resolve(decodedFromWav(wav));

const batchPromise = runSynthesisBatch(ctx, synth, {
  owner: `invocation-death-${round}`,
  batchSize: 1,
  // Production shape, shrunken: a lease that outlives the kill, a budget whose
  // deadline timer is still seconds away when the process dies mid-put.
  leaseMs: 1_500,
  maxClaims: 3,
  maxInvocationDurationMs: 4_000,
  flushMarginMs: 500,
  estimatedTurnDurationMs: 1,
  estimatedUploadDurationMs: 5,
});

if (mode === "hang") {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const episode = await metadata.getEpisode("user-1", "episode-1");
    // Tie the marker to THIS invocation's claim: a leftover uploading_audio phase
    // from the previous dead claim must not satisfy it.
    if (
      episode?.status === "synthesizing" && episode?.phase === "uploading_audio" &&
      episode?.claimedBy === `invocation-death-${round}`
    ) {
      console.log("MARKER:uploading");
      // Stay alive inside the hung put. The parent kills us here.
      await new Promise<never>(() => {});
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  console.error("child: never reached uploading_audio before timeout");
  Deno.exit(3);
}

// drain: let the batch finish and report the final episode record.
const result = await batchPromise;
const episode = await metadata.getEpisode("user-1", "episode-1");
console.log(
  "RESULT:" + JSON.stringify({
    skipped: result.skipped,
    failed: result.failed.map((f) => f.error),
    episode: episode && {
      status: episode.status,
      phase: episode.phase,
      attempts: episode.attempts,
      error: episode.error,
    },
  }),
);
await metadata.close();
