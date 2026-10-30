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
 * Timings are shrunken (lease 1500ms; budget 4000ms in the survive control, 30000ms
 * in the hang rounds - a deliberately widened kill window, see the batch options)
 * but the ORDER of events is production-faithful: claim -> checkpoint
 * uploading_audio -> await put -> death with the wrapper's deadline timer still in
 * the future.
 */
import { KvMetadataStore } from "../../src/storage/kv.ts";
import type { BlobInfo, BlobObject, BlobStore } from "../../src/storage/mod.ts";
import { runSynthesisBatch } from "../../src/worker/synthesis.ts";
import { controlledInvocationClock } from "./invocation_clock.ts";
import { decodedFromWav, pcmToWav } from "../../src/tts/gemini.ts";
import type { AppConfig, Stores } from "../../src/config.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../fixtures.ts";

/** A blob store whose terminal upload never settles: `blobs.put` hangs forever. */
class HangingPutBlobStore implements BlobStore {
  started = 0;
  settled = 0;
  aborted = 0;
  /** True when a put() was entered AFTER its signal was already aborted (audio-feed-ga3jd
   * order probe: with the controlled clock the deadline must land MID-put, so this must
   * stay false for the survive control - a true here would mean the deadline fired first
   * and the counters alone could not tell the two orders apart). */
  startedAfterAbort = 0;
  /** Monotonic ms of each put start and settlement, for the budget assertions. */
  putStartedAt: number[] = [];
  putSettledAt: number[] = [];
  put(_key: string, _body: Uint8Array | ReadableStream<Uint8Array>, opts?: {
    contentType?: string;
    signal?: AbortSignal;
  }): Promise<BlobInfo> {
    this.started++;
    if (opts?.signal?.aborted) this.startedAfterAbort++;
    this.putStartedAt.push(performance.now());
    return new Promise<BlobInfo>((_, reject) => {
      // Never settles on its own: an upload that outlasts everything. Since
      // audio-feed-aqms the worker threads the budget signal into the put, so
      // an ABORT is observable here - that is the by-construction bound.
      opts?.signal?.addEventListener(
        "abort",
        () => {
          this.aborted++;
          reject(opts.signal?.reason ?? new Error("put aborted"));
        },
        { once: true },
      );
    });
  }
  putIfAbsent(
    _key: string,
    _body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string; signal?: AbortSignal },
  ): Promise<BlobInfo | null> {
    return this.put(_key, _body, opts) as Promise<BlobInfo | null>;
  }
  get(_key: string): Promise<BlobObject | null> {
    return Promise.resolve(null);
  }
  head(_key: string): Promise<BlobInfo | null> {
    return Promise.resolve(null);
  }
  delete(_key: string): Promise<void> {
    return Promise.resolve();
  }
  url(): Promise<string | null> {
    return Promise.resolve(null);
  }
  /** Never redirects off-origin: url() always resolves to null (see BlobStore.directUrlOrigin). */
  directUrlOrigin(): string | null {
    return null;
  }
}

const [kvPath, mode, roundArg] = Deno.args;

// Survive control only (audio-feed-ga3jd): the batch's deadline runs on the
// repo's ONE controlled clock (tests/fixtures/invocation_clock.ts, per
// docs/speed.md rule 1) so the deadline fires when THIS row decides - after the
// put is observably started - instead of 3500ms of real time during which a
// loaded host's earlier stages eat the whole budget and the tick yields before
// the put stage. Hang/drain rounds keep the real clock: their 30s bound is
// parent-side kill headroom, not a raced deadline.
const surviveTime = controlledInvocationClock();
if (!kvPath || (mode !== "hang" && mode !== "drain" && mode !== "survive") || !roundArg) {
  console.error("usage: invocation_death_child.ts <kvPath> <hang|survive|drain> <round>");
  Deno.exit(2);
}
const round = Number(roundArg);

const metadata = await KvMetadataStore.open(kvPath);
const stores: Stores = {
  metadata,
  blobs: new HangingPutBlobStore(),
  describe: "invocation-death-repro",
};
const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "https://audio.example.com",
  adminToken: "x",
};
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
  // audio-feed-y2ex: the budget is MODE-DEPENDENT, and the hang rounds' 30s is a
  // deliberately WIDENED bound, not a tight one. The hang rounds' real coupling is
  // PARENT-SIDE: the parent SIGKILLs at the marker, and if the parent stalls past the
  // child's deadline the child budget-yields BEFORE the kill and the abandonment
  // assertion misreads. Order cannot be asserted across a SIGKILL, so the window
  // widens (~30s marker-to-kill allowance) while the property stays exactly what it
  // was: death mid-put, no terminal write. The SURVIVE control keeps 4s because its
  // whole point is the deadline FIRING. Do not tighten the 30s back - it is not a
  // measurement, it is headroom against a loaded box.
  leaseMs: 1_500,
  maxClaims: 3,
  maxInvocationDurationMs: mode === "hang" ? 30_000 : 4_000,
  flushMarginMs: 500,
  estimatedTurnDurationMs: 1,
  estimatedUploadDurationMs: 5,
  // audio-feed-ga3jd: survive mode's deadline is driven by the controlled clock
  // (declared above); hang/drain stay on the default real clock.
  ...(mode === "survive" ? { clock: surviveTime.clock } : {}),
});

const hangingBlobs = stores.blobs as HangingPutBlobStore;

if (mode === "hang") {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const episode = await metadata.getEpisode("user-1", "episode-1");
    // Tie the marker to THIS invocation's claim: a leftover uploading_audio phase
    // from the previous dead claim must not satisfy it. Require the put to have
    // STARTED as well, so the parent's kill is provably mid-put rather than in the
    // gap between the phase checkpoint and the upload.
    if (
      episode?.status === "synthesizing" && episode?.phase === "uploading_audio" &&
      episode?.claimedBy === `invocation-death-${round}` && hangingBlobs.started >= 1
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

if (mode === "survive") {
  // The CONTROL: same hanging put, but this invocation is NOT killed. The wrapper's
  // own deadline timer must fire while the put is still pending - the invocation
  // awaits the put past its budget-derived deadline - and converts it to a clean
  // budget-yield: the claim is released non-terminally and resumably. This is the
  // second assertion of the repro: it separates "the put outlasted the budget
  // mid-await" (what happens here) from "the test harness merely interrupted
  // something" (what the hang rounds do on purpose).
  //
  // The deadline is on the controlled clock (audio-feed-ga3jd): wait until the put
  // is OBSERVABLY started (an order fact, not a race), then advance past the
  // 4000-500=3500ms deadline so the abort lands mid-put on any host speed.
  const putStartDeadline = Date.now() + 20_000;
  while (hangingBlobs.started === 0) {
    if (Date.now() > putStartDeadline) {
      console.error(
        `SURVIVE-FATAL: the put never started within 20s (stages starved) - aborting so the parent asserts red`,
      );
      Deno.exit(1);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await surviveTime.advance(4_000);
  const result = await batchPromise;
  const episode = await metadata.getEpisode("user-1", "episode-1");
  console.log(
    "SURVIVE:" + JSON.stringify({
      yielded: result.yielded,
      failed: result.failed.map((f) => f.error),
      putStarted: hangingBlobs.started,
      putSettled: hangingBlobs.settled,
      putAborted: hangingBlobs.aborted,
      putStartedBeforeDeadline: hangingBlobs.startedAfterAbort === 0,
      putStartedAt: hangingBlobs.putStartedAt[0] ?? null,
      episode: episode && {
        status: episode.status,
        phase: episode.phase,
        attempts: episode.attempts,
      },
    }),
  );
  await metadata.close();
  Deno.exit(0);
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
