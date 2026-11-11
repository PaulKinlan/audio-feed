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
 *
 * NOTHING IN THIS FILE MAY ASSUME ITS READERS IMPORT IT. It is EXECUTED as a child
 * process, never imported by the suite that runs it, so a change here is invisible to
 * every import edge in the repo. `.fleet/coverage-contract.json` carries the declared
 * edge (this fixture -> tests/synthesis_invocation_death_test.ts); without it the host
 * gate reported a run that executed the spawner as having an unmapped changed file
 * (audio-feed-ami7x, measured on fleet/starve-abort). The line above is also this
 * contract's own proof: changing this file is what selects the suite that spawns it.
 */
import {
  DEFAULT_ESTIMATED_TURN_MS,
  DEFAULT_MARKER_WAIT_MS,
  DEFAULT_SURVIVE_PUT_START_WAIT_MS,
  ESTIMATED_TURN_MS_ENV,
  MARKER_WAIT_MS_ENV,
  STAGE_DELAY_MS_ENV,
  STAGE_WEDGE_ENV,
  SURVIVE_PUT_START_WAIT_MS_ENV,
} from "./invocation_death_window.ts";
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
  async put(_key: string, _body: Uint8Array | ReadableStream<Uint8Array>, opts?: {
    contentType?: string;
    signal?: AbortSignal;
  }): Promise<BlobInfo> {
    const delayMs = Number(Deno.env.get(STAGE_DELAY_MS_ENV) ?? "0");
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    if (Deno.env.get(STAGE_WEDGE_ENV) === "1") {
      await new Promise<never>(() => {});
    }
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

/**
 * Read one non-negative-integer millisecond knob, or exit 2 naming the variable (the shape every
 * window knob uses: a typo must be a usage error, never a silently-ignored override).
 */
function msEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(
      `child: ${name} must be a non-negative integer of milliseconds, got ${JSON.stringify(raw)}`,
    );
    Deno.exit(2);
  }
  return parsed;
}

/**
 * The child's per-turn estimate for the budget preflight (audio-feed-zpyx0). The claim loop breaks
 * WITHOUT claiming when `remaining < estimate + flushMargin`, which is how a starved host settles a
 * batch before its put - the condition the survive control's settle-first abort exists for.
 */
const estimatedTurnDurationMs = msEnv(ESTIMATED_TURN_MS_ENV, DEFAULT_ESTIMATED_TURN_MS);

const pcm = new Uint8Array(64);
const wav = pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
let lastProgressAt = Date.now();
const synth = () => {
  lastProgressAt = Date.now();
  return Promise.resolve(decodedFromWav(wav));
};

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
  estimatedTurnDurationMs,
  estimatedUploadDurationMs: 5,
  // audio-feed-ga3jd: survive mode's deadline is driven by the controlled clock
  // (declared above); hang/drain stay on the default real clock.
  ...(mode === "survive" ? { clock: surviveTime.clock } : {}),
});

const hangingBlobs = stores.blobs as HangingPutBlobStore;

if (mode === "hang") {
  // audio-feed-aqms-window: this window is a BOUND, not a latency expectation, and
  // it is CALLER-CONTROLLED. The old bare 8_000 was exactly scripts/proof-cdp.ts
  // MEASURED_STARVED_POLL_MS - one starved poll with zero headroom - so a
  // gate-loaded host expired it while the batch was merely starved on its way to
  // the upload stage and flaked the row. Now: (a) the default is 15 x that floor
  // (DEFAULT_MARKER_WAIT_MS, the repo's HANG_BOUND_MS derivation), headroom over
  // starvation that also exceeds the hang rounds' 30s batch budget; (b)
  // INVOCATION_DEATH_MARKER_WAIT_MS overrides it, so the test pins the window
  // explicitly (no ambient-env coupling) and the red-path case sets 0, which
  // skips this loop entirely and stops WITHOUT the marker deterministically.
  const markerWaitMs = msEnv(MARKER_WAIT_MS_ENV, DEFAULT_MARKER_WAIT_MS);
  const deadline = Date.now() + markerWaitMs;
  // The give-up is an EVENT first, a clock second: once THIS invocation's batch
  // settles (budget-yield or throw) the claim is released and the marker is
  // unreachable - the condition below pins claimedBy and phase - so polling the
  // rest of the window is dead time. Stop and red on the settlement instead.
  const batchOutcome = batchPromise.then(
    () => "settled",
    (err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  let settled: string | undefined;
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
    const outcome = await Promise.race([
      batchOutcome,
      new Promise<undefined>((r) => setTimeout(r, 20)),
    ]);
    if (outcome !== undefined) {
      settled = outcome;
      break;
    }
  }
  if (settled !== undefined) {
    console.error(`child: batch settled without uploading_audio (${settled})`);
  } else {
    console.error("child: never reached uploading_audio before timeout");
  }
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
  //
  // audio-feed-wjtpb: the old 20s wall-clock was a guess about machine speed that
  // flaked under VM gate load when earlier stages were starved. Now:
  // (a) DEFAULT_SURVIVE_PUT_START_WAIT_MS derives from MEASURED_STARVED_POLL_MS with
  //     the standard 15x headroom (120s);
  // (b) SURVIVE_PUT_START_WAIT_MS_ENV allows explicit caller override (e.g. 0 or 100 for tests);
  // (c) We wait on the EVENT first: if batchPromise settles before the put starts,
  //     we abort immediately because no further progress is possible;
  // (d) The deadline watchdog re-arms whenever observable stage progress occurs (phase/status changes),
  //     so slow forward progress on a starved host never trips the bound, while a genuine
  //     hang (no progress for putStartWaitMs) exits with SURVIVE-FATAL.
  const putStartWaitMs = msEnv(SURVIVE_PUT_START_WAIT_MS_ENV, DEFAULT_SURVIVE_PUT_START_WAIT_MS);

  const batchOutcome = batchPromise.then(
    () => "settled" as const,
    (err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}` as const,
  );
  let settled: string | undefined;

  let deadline = lastProgressAt + putStartWaitMs;
  // The re-arm below is only safe with a CEILING (audio-feed-g7vfw): a phase that flips on every
  // poll would re-arm forever, and a bound that can be renewed without limit is not a bound. One
  // extra window of real time covers any honest stage sequence; past it, the row reds by name.
  const hardCeiling = Date.now() + 2 * putStartWaitMs;
  let lastPhase: string | undefined;
  let lastStatus: string | undefined;

  while (hangingBlobs.started === 0) {
    if (Date.now() > deadline || Date.now() > hardCeiling) {
      console.error(
        `SURVIVE-FATAL: the put never started within ${putStartWaitMs}ms (stages starved or hung, and the re-arming watchdog's ${
          2 * putStartWaitMs
        }ms hard ceiling was reached) - aborting so the parent asserts red`,
      );
      Deno.exit(1);
    }
    const outcome = await Promise.race([
      batchOutcome,
      new Promise<undefined>((r) => setTimeout(r, 5)),
    ]);
    if (outcome !== undefined) {
      settled = outcome;
      break;
    }
    const episode = await metadata.getEpisode("user-1", "episode-1");
    if (episode?.phase !== lastPhase || episode?.status !== lastStatus) {
      lastPhase = episode?.phase;
      lastStatus = episode?.status;
      lastProgressAt = Date.now();
      deadline = lastProgressAt + putStartWaitMs;
    }
  }

  if (hangingBlobs.started === 0 && settled !== undefined) {
    // audio-feed-zpyx0: NAME THE JOB. The old message reported the batch's OUTCOME ("settled") and
    // nothing about the work it gave up on, so a reader of a gate log could see that the survive
    // control aborted but not WHICH episode was left un-uploaded - the one fact that ties the red to
    // a claim in the store, and the reason this abort exists at all. The record is read before the
    // exit, because the exit is the last thing this process does.
    const abandoned = await metadata.getEpisode("user-1", "episode-1");
    console.error(
      `SURVIVE-FATAL: batch settled before the put started (${settled}) - the job it abandoned is ` +
        `episode "episode-1" of user "user-1" (status ${abandoned?.status ?? "missing"}, phase ${
          abandoned?.phase ?? "none"
        }, claimedBy ${abandoned?.claimedBy ?? "nobody"}) - aborting so the parent asserts red`,
    );
    Deno.exit(1);
  }

  await surviveTime.advance(4_000);
  // audio-feed-g7vfw: `await batchPromise` was UNBOUNDED here, and it is the child-side half of
  // the 50-minute union-gate park. It settles only when the budget deadline this test advances
  // fires AND the abort reaches the hanging put's own promise; if the deadline timer was armed
  // after `advance()` ran, or the signal never reaches that put, nothing waker exists and the
  // child outlives the parent's `child.output()`. Bound it on the REAL clock - the controlled one
  // is exactly what failed to fire - and name the mechanism, so the parent's red is a cause
  // rather than a timeout wearing a timeout's clothes.
  const settleWithin = async <T>(
    promise: Promise<T>,
    boundMs: number,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `the batch never settled within ${boundMs}ms of the controlled clock advancing 4000ms past its deadline: the deadline timer did not fire, or its abort never reached the hanging put`,
            ),
          ),
        boundMs,
      );
    });
    try {
      return await Promise.race([promise, bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const result = await settleWithin(batchPromise, putStartWaitMs).catch(
    (err: unknown) => {
      console.error(
        `SURVIVE-FATAL: ${
          err instanceof Error ? err.message : String(err)
        } - aborting so the parent asserts red instead of parking`,
      );
      Deno.exit(1);
    },
  );
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
