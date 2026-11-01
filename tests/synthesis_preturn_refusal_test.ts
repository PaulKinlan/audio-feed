/**
 * Tests for audio-feed-preturn (P0: episodes permanently failing with
 * "Synthesis yielded before paid turn 1 ... claim 3/3; zero durable progress across all claims").
 *
 * The loop: a claim whose pre-turn window (slow script/store work) eats most of the 90s
 * invocation budget reaches the pre-turn preflight with less than turnEstimate + flushMargin
 * remaining, and the refusal is counted as a FAILED ATTEMPT because no durable progress
 * exists. Three ticks later the episode is permanently failed without a single paid TTS turn
 * ever being attempted. The fix: a yield raised before THIS CLAIM initiated any paid turn is
 * a pure refusal — it spent nothing, so it must not consume the claims cap. Claims that DID
 * initiate paid turns and still yield with zero progress keep burning attempts exactly as
 * audio-feed-zrkn specified (pinned by the second row: the cap is NOT weakened).
 *
 * audio-feed-refcap (review fix): a pure refusal must not RESET attempts either — that
 * deleted the only abandonment bound and let a later refusal wipe earlier real spend.
 * Refusals get their own counter and cap: attempts stay monotone (row 3), the refusal
 * loop terminates failed with a distinct reason and a notification (row 4), and Paul's
 * transient still recovers on a healthy tick (row 1).
 */
import { assert, assertEquals } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { MemoryBlobStore } from "../src/storage/memory.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { decodedFromWav, GeminiTtsClient, pcmToWav } from "../src/tts/gemini.ts";
import type { DecodedAudioResult, SynthesisOptions } from "../src/tts/gemini.ts";
import { isPreturnRefusalExhaustion } from "../src/types.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { controlledInvocationClock } from "./fixtures/invocation_clock.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

function fakeAudio(durationSeconds = 10): DecodedAudioResult {
  const pcm = new Uint8Array(64);
  const wav = pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
  return {
    ...decodedFromWav(wav),
    durationSeconds,
  };
}

/**
 * The refusal cap and the refusal counter live in the STORE (`claimEpisode` checks
 * `refusals >= preturnRefusalCap`, `yieldEpisodeClaim` increments it), and production opens
 * `KvMetadataStore` (`src/config.ts` `openStores`). The rows below must therefore run against
 * BOTH adapters, constructed the way `tests/storage_test.ts` constructs them for the shared
 * conformance suite: identical rows per adapter, in-memory Deno KV for the KV one.
 *
 * audio-feed-kvref: with only the memory double registered, mutating the refusal cap in
 * `src/storage/kv/episodes.ts` to effectively infinite left every row in this file green —
 * production's refusal loop bound was pinned by nothing.
 */
interface StoresUnderTest {
  stores: Stores;
  close: () => Promise<void>;
}

const ADAPTERS: { name: string; create: () => Promise<StoresUnderTest> }[] = [
  {
    name: "MemoryMetadataStore",
    create: () => {
      const stores: Stores = memoryStores();
      return Promise.resolve({
        stores,
        close: () => stores.metadata.close(),
      });
    },
  },
  {
    name: "KvMetadataStore",
    create: async () => {
      const kv = await Deno.openKv(":memory:");
      return {
        stores: {
          metadata: new KvMetadataStore(kv, { ownsConnection: true }),
          blobs: new MemoryBlobStore(),
          describe: "metadata=kv blobs=memory",
        },
        close: async () => {
          await kv.close();
        },
      };
    },
  },
];

/** Register one row against every adapter, with a fresh store per adapter. */
function row(label: string, fn: (stores: Stores) => Promise<void>) {
  for (const adapter of ADAPTERS) {
    Deno.test(`${label} [${adapter.name}]`, async () => {
      const underTest = await adapter.create();
      try {
        await fn(underTest.stores);
      } finally {
        await underTest.close();
      }
    });
  }
}

async function setupEnv(stores: Stores) {
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "inbox",
      content: "First paragraph. Second paragraph. Third paragraph.",
    }),
  );
  await stores.metadata.putEpisode(
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

/** The synthesizer's narration input type is structural; only the fields below are read. */
type NarrationInput = Parameters<GeminiTtsClient["synthesizeNarration"]>[0];

/**
 * A client whose pre-turn stage burns `burnMs` of the invocation clock BEFORE the first
 * resume.prepare — the "slow script generation" shape. The preflight inside the real
 * wrappedResume.prepare then refuses with the exact production symptom
 * ("remaining budget ~27s < required 50s") before any paid turn.
 */
function slowPreTurnClient(time: ReturnType<typeof controlledInvocationClock>, burnMs: number) {
  return {
    async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
      await time.advance(burnMs);
      await options.resume?.prepare("segment-1", "voice-a");
      // Never reached when the preflight refuses; on a fresh budget this is the paid turn.
      return fakeAudio();
    },
  };
}

/** A healthy client: preflight passes, the paid turn "succeeds". */
function healthyClient() {
  return {
    async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
      await options.resume?.prepare("segment-1", "voice-a");
      return fakeAudio();
    },
  };
}

row(
  "audio-feed-preturn: three pre-turn refusals must not permanently fail an episode that never initiated a paid turn; a healthy fourth tick completes it",
  async (stores) => {
    await setupEnv(stores);
    const ctx = { config, stores };
    const time = controlledInvocationClock();
    const synth = createGeminiSynthesizer(ctx, {
      client: slowPreTurnClient(time, 63_000) as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const batchOpts = {
      maxInvocationDurationMs: 90_000,
      clock: time.clock,
    };

    // Ticks 1-3: each fresh 90s invocation burns 63s pre-turn, the preflight refuses at
    // ~27s remaining (< 50s required) — Paul's exact symptom, claim N/3.
    for (let tick = 1; tick <= 3; tick++) {
      const result = await runSynthesisBatch(ctx, synth, {
        owner: `worker-preturn-${tick}`,
        ...batchOpts,
      });
      assertEquals(result.yielded.length, 1, `tick ${tick} must yield, not fail`);
    }

    const afterThree = await stores.metadata.getEpisode("user-1", "episode-1");
    assert(afterThree, "episode must exist after three refusal ticks");
    assertEquals(
      afterThree.status,
      "pending",
      "a claim that never initiated a paid turn must not consume the claims cap; " +
        "three refusals must leave the episode resumable, not permanently failed",
    );
    assertEquals(
      afterThree.attempts ?? 0,
      0,
      "a pure pre-turn refusal spent nothing, so the attempt counter must stay 0",
    );
    assertEquals(
      afterThree.refusals ?? 0,
      3,
      "each pure refusal must be counted on the separate refusal counter (audio-feed-refcap)",
    );
    assert(
      !(afterThree.error ?? "").includes("zero durable progress"),
      "the episode must never reach the zero-progress terminal state: " + afterThree.error,
    );

    // Tick 4 with a healthy provider: full 90s budget, turn 1 proceeds, episode completes.
    const healthy = createGeminiSynthesizer(ctx, {
      client: healthyClient() as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const tick4 = await runSynthesisBatch(ctx, healthy, {
      owner: "worker-preturn-4",
      ...batchOpts,
    });
    assertEquals(tick4.ready.length, 1, "a healthy tick must complete the refused episode");
    const done = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(done?.status, "ready");
  },
);

row(
  "audio-feed-preturn: the cap is NOT weakened — a claim that initiated paid turns and yields with zero progress still exhausts at 3/3",
  async (stores) => {
    await setupEnv(stores);
    const ctx = { config, stores };
    const time = controlledInvocationClock();
    let call = 0;
    const spendingThenFailingClient = {
      async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
        call++;
        if (call % 2 === 1) {
          // Attempt 1 of the claim: preflight passes, the paid turn IS initiated, then the
          // provider burns 80s and fails transiently (500 → retryable, isPermanent false).
          await options.resume?.prepare("segment-1", "voice-a");
          await time.advance(80_000);
          throw Object.assign(new Error("provider exploded"), { status: 500 });
        }
        // Attempt 2 of the claim: only 10s remain; the preflight refuses before turn 1 of
        // this attempt — but the claim DID spend, so the refusal is not a pure refusal.
        await options.resume?.prepare("segment-1", "voice-a");
        return fakeAudio();
      },
    };
    const synth = createGeminiSynthesizer(ctx, {
      client: spendingThenFailingClient as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const batchOpts = {
      maxInvocationDurationMs: 90_000,
      clock: time.clock,
    };

    for (let tick = 1; tick <= 3; tick++) {
      const result = await runSynthesisBatch(ctx, synth, {
        owner: `worker-spend-${tick}`,
        ...batchOpts,
      });
      assertEquals(
        result.failed.length,
        tick === 3 ? 1 : 0,
        `tick ${tick}: real spend with zero progress must burn attempts (audio-feed-zrkn)`,
      );
    }

    const exhausted = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(exhausted?.status, "failed", "real spend with zero progress must still cap out");
    assert(
      (exhausted?.error ?? "").includes("zero durable progress across all claims"),
      "terminal reason must name the exhaustion: " + exhausted?.error,
    );
  },
);

row(
  "audio-feed-refcap: attempts are monotone — spend, spend, refuse leaves attempts at 2, not 0",
  async (stores) => {
    await setupEnv(stores);
    const ctx = { config, stores };
    const time = controlledInvocationClock();
    let call = 0;
    // Ticks 1-2 are the audio-feed-zrkn shape: the claim initiates the paid turn,
    // the provider burns 80s and 500s, the inner retry's preflight refuses — the
    // CLAIM spent, so its yield keeps the attempt it counted at claim time.
    // Tick 3 is a PURE refusal: the pre-turn stage burns the budget before the
    // preflight, zero paid turns initiated in the whole claim.
    const spendSpendRefuseClient = {
      async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
        call++;
        if (call <= 4) {
          await options.resume?.prepare("segment-1", "voice-a");
          await time.advance(80_000);
          throw Object.assign(new Error("provider exploded"), { status: 500 });
        }
        await time.advance(63_000);
        await options.resume?.prepare("segment-1", "voice-a");
        return fakeAudio();
      },
    };
    const synth = createGeminiSynthesizer(ctx, {
      client: spendSpendRefuseClient as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const batchOpts = { maxInvocationDurationMs: 90_000, clock: time.clock };

    for (let tick = 1; tick <= 2; tick++) {
      const result = await runSynthesisBatch(ctx, synth, {
        owner: `worker-mono-${tick}`,
        ...batchOpts,
      });
      assertEquals(result.yielded.length, 1, `spending tick ${tick} must yield`);
    }
    const afterSpend = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(afterSpend?.attempts ?? 0, 2, "two spending claims must stand in attempts");

    const refused = await runSynthesisBatch(ctx, synth, {
      owner: "worker-mono-3",
      ...batchOpts,
    });
    assertEquals(refused.yielded.length, 1, "the pure refusal must yield, not fail");
    const after = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(
      after?.attempts ?? 0,
      2,
      "a pure refusal must not wipe the spend history of earlier claims: " +
        "spend, spend, refuse leaves attempts at 2 (audio-feed-refcap)",
    );
    assertEquals(after?.refusals ?? 0, 1, "the pure refusal must land on the refusal counter");
    assertEquals(after?.status, "pending");
  },
);

row(
  "audio-feed-refcap: pure refusals terminate at the refusal cap — failed with the distinct reason, zero spend, notification emitted",
  async (stores) => {
    await setupEnv(stores);
    const ctx = { config, stores };
    // The refusal-exhaustion notification is asserted below, so the outbox must be on.
    (ctx.config as AppConfig).notifyOutboxEnabled = true;
    const time = controlledInvocationClock();
    let preflightsPassed = 0;
    const alwaysRefusesClient = {
      async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
        await time.advance(63_000);
        await options.resume?.prepare("segment-1", "voice-a");
        preflightsPassed++; // only reached when the preflight ADMITS the turn
        return fakeAudio();
      },
    };
    const synth = createGeminiSynthesizer(ctx, {
      client: alwaysRefusesClient as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const batchOpts = { maxInvocationDurationMs: 90_000, clock: time.clock };

    // MAX_PRETURN_REFUSALS = 6: six refused ticks must yield (pending), not fail.
    for (let tick = 1; tick <= 6; tick++) {
      const result = await runSynthesisBatch(ctx, synth, {
        owner: `worker-refcap-${tick}`,
        ...batchOpts,
      });
      assertEquals(result.yielded.length, 1, `refusal tick ${tick} must yield, not fail`);
      assertEquals(
        result.failed.length,
        0,
        `refusal tick ${tick} must not report a failure`,
      );
    }
    assertEquals(
      preflightsPassed,
      0,
      "every refused claim must have initiated zero paid turns: zero provider spend",
    );
    const beforeCap = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(beforeCap?.status, "pending", "six refusals must not have failed the episode yet");
    assertEquals(beforeCap?.refusals ?? 0, 6);

    // Tick 7: claimEpisode must refuse and fail the episode — the loop stops here.
    const terminal = await runSynthesisBatch(ctx, synth, {
      owner: "worker-refcap-7",
      ...batchOpts,
    });
    assertEquals(
      terminal.yielded.length,
      0,
      "a refusal-exhausted episode must not be claimable again",
    );
    assertEquals(
      terminal.ready.length,
      0,
      "a refusal-exhausted episode must not synthesise",
    );
    const failed = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(
      failed?.status,
      "failed",
      "the episode must reach the terminal failed state, not rot in pending",
    );
    assert(
      isPreturnRefusalExhaustion(failed?.error),
      "terminal reason must be the distinct refusal reason: " + failed?.error,
    );
    assert(
      (failed?.error ?? "").includes("6 times without ever initiating a paid turn"),
      "the reason must name the refusal count: " + failed?.error,
    );
    // The loop stays stopped: a further tick neither claims nor revives it.
    const afterStop = await runSynthesisBatch(ctx, synth, {
      owner: "worker-refcap-8",
      ...batchOpts,
    });
    assertEquals(afterStop.yielded.length, 0, "the failed episode must stay out of the queue");
    assertEquals(afterStop.ready.length, 0);
    assertEquals(failed?.attempts ?? 0, 0, "pure refusals never leave spend history behind");

    // Terminal must not be silent: the worker emits the failure notification.
    const outbox = await stores.metadata.listOutbox();
    assertEquals(outbox.length, 1, "exactly one failure notification must be queued");
    const notification = outbox[0];
    assert(notification, "the failure notification must exist");
    assertEquals(notification.status, "failed");
    assertEquals(notification.episodeId, "episode-1");
  },
);

row(
  "audio-feed-refcap: a REGENERATING episode at the refusal cap keeps its playable audio, and the record and the notification name the same reason",
  async (stores) => {
    (config as AppConfig).notifyOutboxEnabled = true;
    await setupEnv(stores);
    // A published episode the subscriber asked to regenerate: pending, still playable, old key.
    const published = makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "pending",
      regenerating: true,
      audioKey: "audio/user-1/direct/episode-1.mp3",
      contentType: "audio/mpeg",
    });
    await stores.metadata.putEpisode(published);
    const ctx = { config, stores };
    const time = controlledInvocationClock();
    const alwaysRefusesClient = {
      async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
        await time.advance(63_000);
        await options.resume?.prepare("segment-1", "voice-a");
        return fakeAudio();
      },
    };
    const synth = createGeminiSynthesizer(ctx, {
      client: alwaysRefusesClient as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const batchOpts = { maxInvocationDurationMs: 90_000, clock: time.clock };

    // Six refusals stay pending; the seventh claim crosses the cap inside claimEpisode.
    let terminal = { failed: [], ready: [], yielded: [], skipped: [] } as unknown as Awaited<
      ReturnType<typeof runSynthesisBatch>
    >;
    for (let tick = 1; tick <= 7; tick++) {
      terminal = await runSynthesisBatch(ctx, synth, {
        owner: `worker-regen-refcap-${tick}`,
        ...batchOpts,
      });
    }

    const record = await stores.metadata.getEpisode("user-1", "episode-1");
    assert(record, "the episode must still exist");
    // audio-feed-8oz: a regeneration that produces no new audio goes back to READY on its old
    // audio rather than failing out of the feed. `unsynthesized` decides that, so the refusal cap
    // inherits it — the refusal reason is recorded, the subscription keeps its playable episode.
    assertEquals(record.status, "ready", "a failed regeneration must not remove the episode");
    assertEquals(
      record.audioKey,
      published.audioKey,
      "the regeneration must leave the previously published audio in place",
    );
    assert(
      isPreturnRefusalExhaustion(record.error),
      "the record must name the refusal exhaustion: " + record.error,
    );
    assertEquals(record.regenerating, undefined, "the regeneration attempt must be closed out");
    assertEquals(record.refusals, 6, "the six counted refusals stand on the record");

    // The reviewer's P2 asked whether the record and the notification disagree here. They do not,
    // and this row is what says so: the worker's refusal-exhaustion branch is guarded by
    // `afterClaim?.status === "failed"` (src/worker/synthesis.ts), and a regenerating episode that
    // exhausts its refusals reaches `ready`, so nothing is queued. A still-playable episode must
    // never be announced as failed — the watchdog notification (`notifyOnDemand`) suppresses
    // regenerating episodes for the same reason, so both shapes agree: no failure announcement for
    // an episode that is still in the feed.
    const outbox = await stores.metadata.listOutbox();
    assertEquals(
      outbox.length,
      0,
      "a regeneration that returns to ready must not queue a failure notification: " +
        JSON.stringify(outbox.map((n) => [n.status, n.error])),
    );
    assertEquals(
      terminal.failed.length,
      0,
      "the batch must not report a failure for an episode that is still playable",
    );
  },
);
