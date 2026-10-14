/**
 * audio-feed-wr1u — durable resumable TTS chunking.
 *
 * gueb made an over-long run stop cleanly instead of re-billing the whole episode; this is
 * the other half: what a run that DID die leaves behind, and what the next claim does with
 * it. Before wr1u a dead run left nothing — the next claimant paid for every segment again,
 * including the ones the dead worker had already spoken and thrown away. These tests drive
 * the real worker batch with a resume-aware synthesizer that behaves like the TTS client
 * (prepare before each paid call, commit after each decoded segment) and assert:
 *
 * 1. A run that dies mid-episode persists what it completed, and the retry pays ONLY for the
 *    missing segments — with byte-identical final audio to a clean single run.
 * 2. The ownership CAS: a second worker cannot reserve under a live claim, cannot finalize
 *    someone else's slot, and a superseded worker's finalize fails.
 * 3. A voice change does not reuse another voice's audio.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { DEFAULT_MAX_INVOCATION_DURATION_MS, memoryStores } from "../src/config.ts";
import {
  checkpointEpisodeClaim,
  createGeminiSynthesizer,
  runSynthesisBatch,
} from "../src/worker/synthesis.ts";
import { deleteUserSource } from "../src/compose/account.ts";
import type { Synthesizer } from "../src/worker/synthesis.ts";
import {
  decodedFromWav,
  formatCodeForTts,
  formatNarrationPrompt,
  GeminiTtsClient,
  GeminiTtsError,
  joinTtsAudio,
  MAX_TTS_INPUT_BYTES,
  MAX_TTS_SEGMENTS,
  parseWavHeader,
  pcmToWav,
  writeWavHeader,
} from "../src/tts/gemini.ts";
import {
  ESTIMATED_TTS_TURN_DURATION_MS,
  INVOCATION_FLUSH_MARGIN_MS,
  splitTextUnderByteBudget,
  SynthesisYieldError,
} from "../src/synthesis/limits.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { segmentBlobKey, segmentTextHash } from "../src/types.ts";
import { collect } from "../src/storage/mod.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

const SEGMENTS = [
  "Welcome back to the feed, this is the first movement.",
  "The second movement covers the numbers behind the claim.",
  "Third: what the critics got wrong, and why it matters.",
  "And finally, the one paragraph worth rereading. Goodbye.",
];

/** Deterministic PCM per segment text, so reused and fresh bytes compare equal. */
function segmentWav(text: string): Uint8Array {
  const pcm = new Uint8Array(64 + (text.length % 32) * 8);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (text.charCodeAt(i % text.length) + i) & 0x7f;
  return pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
}

function stitch(wavs: Uint8Array[]): DecodedAudioResult {
  const pcm = wavs.map((wav) => {
    const info = parseWavHeader(wav);
    return wav.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  });
  const total = pcm.reduce((n, part) => n + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of pcm) {
    joined.set(part, at);
    at += part.length;
  }
  const wav = pcmToWav(joined, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
  const decoded = decodedFromWav(wav);
  return decoded;
}

/**
 * A resume-aware synthesizer: exactly what the TTS client does with the hooks, minus the
 * network. `failAt` makes the paid call for that segment index throw a permanent error,
 * which is what a worker dying mid-run looks like from the queue's side.
 */
function segmentSynthesizer(
  state: { paid: string[] },
  options: { failAt?: number; voice?: string } = {},
): Synthesizer {
  const voice = options.voice ?? "Charon";
  return async ({ resume }) => {
    const wavs: Uint8Array[] = [];
    for (let index = 0; index < SEGMENTS.length; index++) {
      const text = SEGMENTS[index]!;
      const prepared = resume ? await resume.prepare(text, voice) : "synthesize";
      if (prepared === "held") {
        throw new GeminiTtsError("segment held by another claimant", 409);
      }
      if (prepared !== "synthesize") {
        wavs.push(prepared.wav);
        continue;
      }
      if (options.failAt === index) {
        throw new GeminiTtsError("simulated worker death mid-run", 400);
      }
      state.paid.push(text);
      const wav = segmentWav(text);
      const decoded = decodedFromWav(wav);
      await resume?.commit(text, decoded, voice);
      wavs.push(wav);
    }
    return stitch(wavs);
  };
}

async function queued() {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "inbox",
      content: SEGMENTS.join("\n\n"),
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
      audioKey: undefined,
    }),
  );
  return { ctx: { config, stores }, stores };
}

/**
 * Reserve, store and finalize one synthesis segment, exactly as a run that died
 * mid-episode leaves it: a record with a live blob and no episode audio yet.
 */
async function finalizeSegment(
  stores: Stores,
  text: string,
  owner: string,
  nowMs: number,
  leaseMs: number,
): Promise<string> {
  const hash = segmentTextHash(text);
  const iso = new Date(nowMs).toISOString();
  assertEquals(
    await stores.metadata.reserveSynthesisSegment(
      "user-1",
      "episode-1",
      {
        textHash: hash,
        text,
        promptVersion: "v-test",
        voice: "Charon",
        audioKey: "",
        byteLength: 0,
        owner,
        claimAt: iso,
        createdAt: iso,
        finalized: false,
      },
      nowMs,
      leaseMs,
    ),
    "reserved",
  );
  const key = segmentBlobKey({ userId: "user-1", id: "episode-1" }, hash, "rev-1");
  await stores.blobs.put(key, new Uint8Array(16), { contentType: "audio/wav" });
  assertEquals(
    await stores.metadata.finalizeSynthesisSegment(
      "user-1",
      "episode-1",
      { textHash: hash, promptVersion: "v-test", voice: "Charon" },
      { audioKey: key, byteLength: 16 },
      owner,
      nowMs,
      leaseMs,
    ),
    true,
  );
  return key;
}

/**
 * Wrap the blob store's delete so a test can see how many deletions overlap. The delay
 * is what makes the count meaningful: a serial sweep finishes each delete before it
 * starts the next, so it can never report a peak above one.
 */
function countConcurrentDeletes(
  stores: Stores,
  failKey?: string,
): { peak: () => number; calls: () => number } {
  const realDelete = stores.blobs.delete.bind(stores.blobs);
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  stores.blobs.delete = async (key: string) => {
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      if (key === failKey) throw new Error("blob store unavailable");
      await realDelete(key);
    } finally {
      inFlight--;
    }
  };
  return { peak: () => peak, calls: () => calls };
}

Deno.test("a run that dies mid-episode leaves its segments behind, and the retry pays only for the rest", async () => {
  const { ctx, stores } = await queued();

  // Run one: dies at segment three of four.
  const first = { paid: [] as string[] };
  const died = await runSynthesisBatch(ctx, segmentSynthesizer(first, { failAt: 2 }), {
    owner: "worker-a",
    maxAttempts: 1,
  });
  assertEquals(first.paid, SEGMENTS.slice(0, 2), "the dead run paid for exactly two segments");
  assertEquals(died.failed.length, 1, "the episode is failed, not silently pending");

  // What it left behind: two finalized segments with their blobs, plus the stranded
  // reservation of the segment that was in flight when the run died — unfinalized, so it
  // is not reusable, and stealable by whoever claims next.
  const records = await stores.metadata.listSynthesisSegments("user-1", "episode-1");
  const finalized = records.filter((r) => r.finalized);
  assertEquals(finalized.length, 2);
  assert(finalized.every((r) => r.audioKey.startsWith("audio-segments/")));
  for (const record of finalized) {
    const blob = await stores.blobs.get(record.audioKey);
    assert(blob, "the persisted segment blob must outlive the run that wrote it");
    assertEquals(blob.size, record.byteLength);
  }
  const stranded = records.find((r) => !r.finalized);
  assert(stranded, "the in-flight segment's reservation must survive the dead run");
  assertEquals(stranded.textHash, segmentTextHash(SEGMENTS[2]!));

  // The operator retries (the same path admin retry uses).
  const requeued = await stores.metadata.retryEpisode("user-1", "episode-1");
  assertEquals(requeued?.status, "pending");

  // Run two, a DIFFERENT worker: resumes, pays for two segments, not four.
  const second = { paid: [] as string[] };
  const resumed = await runSynthesisBatch(ctx, segmentSynthesizer(second), {
    owner: "worker-b",
    maxAttempts: 1,
  });
  assertEquals(
    second.paid,
    SEGMENTS.slice(2),
    "the resuming claimant must not re-bill segments the dead run already spoke",
  );
  assertEquals(resumed.ready.length, 1);

  // The stitched audio is what a clean single run would have produced, byte for byte.
  const clean = { paid: [] as string[] };
  const { ctx: cleanCtx, stores: cleanStores } = await queued();
  await runSynthesisBatch(cleanCtx, segmentSynthesizer(clean), {
    owner: "worker-c",
    maxAttempts: 1,
  });
  assertEquals(clean.paid, SEGMENTS, "the control run pays for all four");

  const resumedEpisode = await stores.metadata.getEpisode("user-1", "episode-1");
  const cleanEpisode = await cleanStores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(resumedEpisode?.status, "ready");
  assertEquals(
    (await stores.blobs.get(resumedEpisode!.audioKey!))!.size,
    (await cleanStores.blobs.get(cleanEpisode!.audioKey!))!.size,
    "resumed audio must be the same length as a clean run",
  );
  const resumedBytes = await collect((await stores.blobs.get(resumedEpisode!.audioKey!))!.body);
  const cleanBytes = await collect(
    (await cleanStores.blobs.get(cleanEpisode!.audioKey!))!.body,
  );
  assertEquals(resumedBytes, cleanBytes, "resumed audio must equal a clean run byte for byte");

  // And the segments are swept once the stitched audio is committed.
  assertEquals(await stores.metadata.listSynthesisSegments("user-1", "episode-1"), []);
});

Deno.test("the segment CAS refuses a second claimant while the first claim is live", async () => {
  const { ctx, stores } = await queued();
  const leaseMs = 60_000;
  const now = "2026-10-06T12:00:00.000Z";
  const t0 = Date.parse(now);

  const claimed = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-a",
    now,
    leaseMs,
    maxClaims: 3,
  });
  assert(claimed);

  const record = {
    textHash: segmentTextHash(SEGMENTS[0]!),
    text: SEGMENTS[0]!,
    promptVersion: "v",
    voice: "Charon",
    audioKey: "",
    byteLength: 0,
    owner: "worker-b",
    claimAt: now,
    createdAt: now,
    finalized: false,
  };
  assertEquals(
    await stores.metadata.reserveSynthesisSegment("user-1", "episode-1", record, t0, leaseMs),
    "no-claim",
    "worker-b holds no claim while worker-a's lease is live",
  );

  // worker-a reserves and finalizes; worker-b can neither finalize nor re-reserve the slot.
  assertEquals(
    await stores.metadata.reserveSynthesisSegment(
      "user-1",
      "episode-1",
      { ...record, owner: "worker-a" },
      t0,
      leaseMs,
    ),
    "reserved",
  );
  assertEquals(
    await stores.metadata.finalizeSynthesisSegment(
      "user-1",
      "episode-1",
      { textHash: record.textHash, promptVersion: "v", voice: "Charon" },
      { audioKey: "audio-segments/x", byteLength: 10 },
      "worker-b",
      t0,
      leaseMs,
    ),
    false,
  );
  assertEquals(
    await stores.metadata.finalizeSynthesisSegment(
      "user-1",
      "episode-1",
      { textHash: record.textHash, promptVersion: "v", voice: "Charon" },
      { audioKey: "audio-segments/x", byteLength: 10 },
      "worker-a",
      t0,
      leaseMs,
    ),
    true,
  );

  // A superseded worker-a (lease expired, worker-b claimed) can no longer finalize or reserve.
  const later = t0 + leaseMs + 1;
  const laterIso = new Date(later).toISOString();
  assert(
    await stores.metadata.claimEpisode("user-1", "episode-1", {
      owner: "worker-b",
      now: laterIso,
      leaseMs,
      maxClaims: 3,
    }),
  );
  assertEquals(
    await stores.metadata.reserveSynthesisSegment(
      "user-1",
      "episode-1",
      { ...record, textHash: "other", text: "other", owner: "worker-a" },
      later,
      leaseMs,
    ),
    "no-claim",
    "a superseded worker spends nothing",
  );
  void ctx;
});

Deno.test("a voice change re-speaks rather than reusing another voice's segments", async () => {
  const { ctx, stores } = await queued();
  const first = { paid: [] as string[] };
  await runSynthesisBatch(ctx, segmentSynthesizer(first, { failAt: 2, voice: "Charon" }), {
    owner: "worker-a",
    maxAttempts: 1,
  });
  assertEquals(first.paid.length, 2);
  await stores.metadata.retryEpisode("user-1", "episode-1");

  const second = { paid: [] as string[] };
  await runSynthesisBatch(ctx, segmentSynthesizer(second, { voice: "Kore" }), {
    owner: "worker-b",
    maxAttempts: 1,
  });
  assertEquals(
    second.paid,
    SEGMENTS,
    "segments spoken by Charon must not serve a Kore run",
  );
});

Deno.test("a voice change between death and retry opens a new slot and still resumes", async () => {
  // The reviewer's P2-1 loop: run dies, a voice (or prompt-version) change lands, the retry
  // must re-speak into a NEW slot and PERSIST there — not delete its fresh blobs as
  // superseded and re-bill forever.
  const { ctx, stores } = await queued();
  const first = { paid: [] as string[] };
  await runSynthesisBatch(ctx, segmentSynthesizer(first, { failAt: 2, voice: "Charon" }), {
    owner: "worker-a",
    maxAttempts: 1,
  });
  assertEquals(first.paid.length, 2);
  await stores.metadata.retryEpisode("user-1", "episode-1");

  // Retry under a different voice, dying again at segment three.
  const second = { paid: [] as string[] };
  await runSynthesisBatch(ctx, segmentSynthesizer(second, { failAt: 2, voice: "Kore" }), {
    owner: "worker-b",
    maxAttempts: 1,
  });
  assertEquals(
    second.paid,
    SEGMENTS.slice(0, 2),
    "Kore re-speaks exactly the segments Charon had completed, then dies at the same place",
  );
  const afterSecond = await stores.metadata.listSynthesisSegments("user-1", "episode-1");
  const koreFinalized = afterSecond.filter((r) => r.voice === "Kore" && r.finalized);
  assertEquals(
    koreFinalized.length,
    2,
    "the Kore run's completed segments must PERSIST in their own slot, not be deleted",
  );
  for (const record of koreFinalized) {
    assert(await stores.blobs.get(record.audioKey), "the fresh Kore blobs must survive");
  }

  // Third run, same voice as the second: resumes from the Kore slots.
  await stores.metadata.retryEpisode("user-1", "episode-1");
  const third = { paid: [] as string[] };
  const done = await runSynthesisBatch(ctx, segmentSynthesizer(third, { voice: "Kore" }), {
    owner: "worker-c",
    maxAttempts: 1,
  });
  assertEquals(third.paid, SEGMENTS.slice(2), "the Kore retry resumes from Kore segments");
  assertEquals(done.ready.length, 1);
});

Deno.test("deleting a source sweeps the episode's synthesis segments on the plain delete path", async () => {
  // The wr1u re-review's last P2: the non-cascade delete is the default, and a pending or
  // synthesizing episode can carry finalized segment records with live blobs. Once the row
  // is gone nothing can ever list them again, so the delete must sweep them itself.
  const { ctx, stores } = await queued();
  const leaseMs = 60_000;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  assert(
    await stores.metadata.claimEpisode("user-1", "episode-1", {
      owner: "worker-a",
      now: nowIso,
      leaseMs,
      maxClaims: 3,
    }),
  );
  const text = SEGMENTS[0]!;
  const hash = segmentTextHash(text);
  assertEquals(
    await stores.metadata.reserveSynthesisSegment(
      "user-1",
      "episode-1",
      {
        textHash: hash,
        text,
        promptVersion: "v-test",
        voice: "Charon",
        audioKey: "",
        byteLength: 0,
        owner: "worker-a",
        claimAt: nowIso,
        createdAt: nowIso,
        finalized: false,
      },
      nowMs,
      leaseMs,
    ),
    "reserved",
  );
  const key = segmentBlobKey({ userId: "user-1", id: "episode-1" }, hash, "rev-1");
  await stores.blobs.put(key, new Uint8Array(16), { contentType: "audio/wav" });
  assertEquals(
    await stores.metadata.finalizeSynthesisSegment(
      "user-1",
      "episode-1",
      { textHash: hash, promptVersion: "v-test", voice: "Charon" },
      { audioKey: key, byteLength: 16 },
      "worker-a",
      nowMs,
      leaseMs,
    ),
    true,
  );
  assertEquals((await stores.metadata.listSynthesisSegments("user-1", "episode-1")).length, 1);

  // Plain delete (no ?cascade): the episode row and its segments go together.
  const res = await deleteUserSource(
    ctx,
    new Request("https://audio.example.com/account/sources/inbox", { method: "DELETE" }),
    "user-1",
    "inbox",
  );
  assert(res.ok, `delete must succeed, got ${res.status}`);
  assertEquals(
    await stores.metadata.listSynthesisSegments("user-1", "episode-1"),
    [],
    "the plain delete path must clear segment records",
  );
  assertEquals(await stores.blobs.get(key), null, "and reclaim their blobs");
});

Deno.test("the plain delete sweeps an episode's segment blobs concurrently (audio-feed-ikst)", async () => {
  const { ctx, stores } = await queued();
  const leaseMs = 60_000;
  const nowMs = Date.now();
  assert(
    await stores.metadata.claimEpisode("user-1", "episode-1", {
      owner: "worker-a",
      now: new Date(nowMs).toISOString(),
      leaseMs,
      maxClaims: 3,
    }),
  );
  const keys: string[] = [];
  for (const text of SEGMENTS) {
    keys.push(await finalizeSegment(stores, text, "worker-a", nowMs, leaseMs));
  }
  const deletes = countConcurrentDeletes(stores);

  const res = await deleteUserSource(
    ctx,
    new Request("https://audio.example.com/account/sources/inbox", { method: "DELETE" }),
    "user-1",
    "inbox",
  );
  assert(res.ok, `delete must succeed, got ${res.status}`);
  // Four segments used to be four sequential round-trips before the row could go.
  assert(
    deletes.peak() > 1,
    "segment blob deletions must overlap; a serial sweep pays for each one in turn",
  );
  for (const key of keys) {
    assertEquals(await stores.blobs.get(key), null, "every segment blob must be reclaimed");
  }
  assertEquals(await stores.metadata.listSynthesisSegments("user-1", "episode-1"), []);
});

Deno.test("one blob that refuses to delete is recorded as an orphan, and the rest of the sweep still runs (audio-feed-ikst)", async () => {
  const { ctx, stores } = await queued();
  const leaseMs = 60_000;
  const nowMs = Date.now();
  assert(
    await stores.metadata.claimEpisode("user-1", "episode-1", {
      owner: "worker-a",
      now: new Date(nowMs).toISOString(),
      leaseMs,
      maxClaims: 3,
    }),
  );
  const keys: string[] = [];
  for (const text of SEGMENTS) {
    keys.push(await finalizeSegment(stores, text, "worker-a", nowMs, leaseMs));
  }
  const failing = keys[1]!;
  const deletes = countConcurrentDeletes(stores, failing);

  const res = await deleteUserSource(
    ctx,
    new Request("https://audio.example.com/account/sources/inbox", { method: "DELETE" }),
    "user-1",
    "inbox",
  );
  assert(res.ok, `a failed blob delete must not fail the delete, got ${res.status}`);
  // Concurrency must not swallow the failure: the key blob is recorded so the orphan
  // sweeper can reclaim it later, and it is not counted as deleted.
  assertEquals(await stores.metadata.listOrphanBlobs(10), [failing]);
  for (const key of keys) {
    if (key === failing) continue;
    assertEquals(await stores.blobs.get(key), null, "the other segment blobs are still reclaimed");
  }
  assertEquals(
    await stores.metadata.listSynthesisSegments("user-1", "episode-1"),
    [],
    "the records are cleared even when one blob could not be deleted",
  );
  assert(deletes.peak() > 1, "a failing blob must not serialise the sweep");
});

Deno.test("a finished run sweeps its segment blobs concurrently (audio-feed-ikst)", async () => {
  const { ctx, stores } = await queued();
  const deletes = countConcurrentDeletes(stores);
  const state = { paid: [] as string[] };

  const done = await runSynthesisBatch(ctx, segmentSynthesizer(state), {
    owner: "worker-a",
    maxAttempts: 1,
  });

  assertEquals(done.ready.length, 1);
  assertEquals(
    deletes.calls(),
    SEGMENTS.length,
    "the post-run sweep deletes one blob per finalized segment",
  );
  assert(
    deletes.peak() > 1,
    "the post-run sweep must overlap its deletes; it used to be the slowest part of finishing",
  );
  assertEquals(await stores.metadata.listSynthesisSegments("user-1", "episode-1"), []);
});

Deno.test("decodedFromWav round-trips pcmToWav without losing the audio", () => {
  const wav = segmentWav(SEGMENTS[0]!);
  const decoded = decodedFromWav(wav);
  assertEquals(decoded.format, "wav");
  assertEquals(decoded.sampleRate, 24000);
  assertEquals(decoded.channels, 1);
  assertEquals(decoded.truncated, false);
  assertEquals(decoded.toWav(), wav);
  assertMatch(String(decoded.durationSeconds), /^\d+(\.\d+)?$/);
  assertStringIncludes(decoded.mimeType, "wav");
});

Deno.test("audio-feed-chx6: a cap-sized TTS turn fits its estimate and the invocation window", () => {
  // The old 9lrl test compared constants to refreshed literals, then checked that three
  // estimates fit the window. It did not check whether ONE cap-sized paid call fits the
  // estimate used by preflight, so an unsafe byte cap could still pass that test.
  // Fleet-proxy ASCII ladder (kvb6/240d9a6): 1k chars ~18.7s, 3k ~26.6s, 6k ~55.1s.
  // The marginal 3k->6k rate is ~9.5ms/ASCII byte. A 15s floor PLUS that rate is a
  // conservative planning envelope, not a measured intercept or a production SLA;
  // non-ASCII provider latency needs its own measurements.
  const fixedOverheadMs = 15_000;
  const measuredMsPerAsciiByte = 9.5;
  const defaults = {
    inputCapBytes: MAX_TTS_INPUT_BYTES,
    estimateMs: ESTIMATED_TTS_TURN_DURATION_MS,
    invocationMs: DEFAULT_MAX_INVOCATION_DURATION_MS,
    flushMs: INVOCATION_FLUSH_MARGIN_MS,
    rateMsPerByte: measuredMsPerAsciiByte,
  };
  const fits = (values: typeof defaults) =>
    fixedOverheadMs + Math.ceil(values.inputCapBytes * values.rateMsPerByte) <=
      values.estimateMs &&
    values.estimateMs + values.flushMs <= values.invocationMs;

  assert(
    fits(defaults),
    "a cap-sized paid TTS turn must fit its preflight estimate, and that estimate plus flush must fit the invocation window",
  );
  assert(
    !fits({ ...defaults, inputCapBytes: 6_000 }),
    "the guard must reject the former unsafe 6k byte cap even if the invocation window stays generous",
  );
  assert(
    !fits({ ...defaults, invocationMs: 45_000 }),
    "the guard must reject the former 45s window even when the byte cap stays small",
  );
  assert(
    !fits({ ...defaults, rateMsPerByte: 10.5 }),
    "a slower measured provider must invalidate an estimate that no longer covers one cap-sized call",
  );
});

Deno.test("audio-feed-uet6: resumed invocation advancing scriptTurns from N>0 to M>N counts as madeProgress=true (attempts reset to 0), while zero script growth advances attempts", async () => {
  const { ctx, stores } = await queued();
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "pending",
      mode: "deepdive",
      // Pre-seeded with N=2 scriptTurns from a prior invocation (resumed state: initialScriptTurns > 0)
      scriptTurns: [
        { speaker: "Alex", text: "Turn 1" },
        { speaker: "Sam", text: "Turn 2" },
      ],
    }),
  );

  // Resumed invocation 1: advances scriptTurns from N=2 to M=4, then yields on invocation budget
  // without finalizing any TTS segment (finalSegments === initialSegments === 0).
  const advancingScriptSynth: Synthesizer = async ({ episode }) => {
    const nextTurns = [
      ...(episode.scriptTurns ?? []),
      { speaker: "Alex", text: "Turn 3" },
      { speaker: "Sam", text: "Turn 4" },
    ];
    await checkpointEpisodeClaim(
      stores.metadata,
      episode.userId,
      episode.id,
      episode.claimedBy ?? "worker-uet6-1",
      {
        phase: "script_generated",
        scriptTurns: nextTurns,
      },
    );
    throw new SynthesisYieldError(0, nextTurns.length, "budget reached after script continuation");
  };

  const r1 = await runSynthesisBatch(ctx, advancingScriptSynth, {
    owner: "worker-uet6-1",
    maxAttempts: 2,
  });
  assertEquals(r1.yielded.length, 1, "resumed script continuation must yield cleanly");
  assertEquals(r1.failed.length, 0);

  const afterResume1 = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(afterResume1?.status, "pending");
  assertEquals(afterResume1?.scriptTurns?.length, 4, "scriptTurns advanced from 2 to 4");
  assertEquals(
    afterResume1?.attempts,
    0,
    "advancing scriptTurns from N=2 to M=4 on a resumed invocation is durable progress (advanceAttempts: false -> attempts === 0)",
  );

  // Control: if a subsequent resumed invocation with initialScriptTurns=4 yields WITHOUT adding
  // any script turns or segments (finalScriptTurns === initialScriptTurns === 4), madeProgress
  // is false and attempts advance until failing at maxAttempts.
  const stalledScriptSynth: Synthesizer = ({ episode }) => {
    throw new SynthesisYieldError(
      0,
      episode.scriptTurns?.length ?? 4,
      "budget reached with zero new script turns",
    );
  };

  const r2 = await runSynthesisBatch(ctx, stalledScriptSynth, {
    owner: "worker-uet6-2",
    maxAttempts: 2,
  });
  assertEquals(r2.yielded.length, 1);
  const afterStall1 = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(afterStall1?.attempts, 1, "zero-progress resume must advance attempts to 1");

  const r3 = await runSynthesisBatch(ctx, stalledScriptSynth, {
    owner: "worker-uet6-3",
    maxAttempts: 2,
  });
  assertEquals(r3.yielded.length, 0);
  assertEquals(r3.failed.length, 1, "exhausting maxAttempts with zero progress must fail");
  const afterStall2 = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(afterStall2?.status, "failed");
});

Deno.test("audio-feed-8905: narration_tts sizes withInvocationBudget totalTurns against the article's actual segment count instead of MAX_TTS_SEGMENTS", async () => {
  const { ctx, stores } = await queued();
  // Build a multi-segment narration article whose prompt splits into 6 segments (< MAX_TTS_SEGMENTS = 24).
  const paragraph = `${"Narrating a detailed technical section with clear prose. ".repeat(35)}`;
  const sixSegmentBody = Array.from({ length: 6 }, (_, i) => `Section ${i + 1}: ${paragraph}`).join(
    "\n\n",
  );
  const article = makeArticle({
    id: "article-1",
    userId: "user-1",
    sourceId: "inbox",
    title: "Six Segment Article",
    content: sixSegmentBody,
  });
  await stores.metadata.putArticle(article);

  const expectedPrompt = formatNarrationPrompt({
    title: article.title,
    author: article.author,
    publishedAt: article.publishedAt,
    sourceName: "Inbox",
    body: sixSegmentBody,
  });
  const expectedSegments = splitTextUnderByteBudget(expectedPrompt, MAX_TTS_INPUT_BYTES);
  assert(
    expectedSegments.length > 1 && expectedSegments.length < MAX_TTS_SEGMENTS,
    `expected multi-segment plan strictly below MAX_TTS_SEGMENTS (${MAX_TTS_SEGMENTS}), got ${expectedSegments.length}`,
  );

  // Case 1: In-flight deadline abort during segment 2 after segment 1 commits.
  let callCount = 0;
  const client = new GeminiTtsClient({
    apiKey: "dummy-key",
    timeoutRetries: 0,
    fetchFn: (_url, init) => {
      callCount++;
      if (callCount === 1) {
        const wav = segmentWav("seg-1");
        let binary = "";
        for (const b of wav) binary += String.fromCharCode(b);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: "STOP",
                  content: {
                    parts: [{ inlineData: { mimeType: "audio/wav", data: btoa(binary) } }],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      // Segment 2 hangs until the invocation budget deadline aborts it in-flight.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  });

  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: null,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });

  const batch1 = await runSynthesisBatch(ctx, synth, {
    owner: "worker-8905-1",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });

  assertEquals(batch1.yielded.length, 1);
  assertEquals(batch1.yielded[0]?.completedTurns, 1);
  assertEquals(
    batch1.yielded[0]?.totalTurns,
    expectedSegments.length,
    "yielded totalTurns must equal actual narration segment count, never hardcoded MAX_TTS_SEGMENTS",
  );

  const ep1 = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(ep1?.status, "pending");
  assertEquals(ep1?.phase, `synthesized_1_of_${expectedSegments.length}`);
  assertEquals(ep1?.attempts, 0, "committing segment 1 before deadline abort resets attempts to 0");
});

Deno.test("audio-feed-3cf0: end-to-end synthesis of a long <pre>-heavy article through chunked TTS synthesis to ready state", async () => {
  const { ctx, stores } = await queued();

  // Construct a long <pre>-heavy technical article whose raw byte length exceeds MAX_TTS_INPUT_BYTES * MAX_TTS_SEGMENTS
  // before code stripping, and whose spoken prose spans multiple 3KB TTS segments.
  const proseSection = (n: number) =>
    `Chapter ${n}. ${
      "Modern distributed audio pipelines bound each synthesis invocation and checkpoint completed segments durably. "
        .repeat(
          18,
        )
    }`;
  const preBlock = (n: number) =>
    `<pre><code class="language-ts">${
      `const buffer_${n} = new Uint8Array(4096); // raw code block ${n}\n`.repeat(120)
    }</code></pre>`;
  const unterminatedTail = "<pre unclosed-attr";

  const longPreHeavyContent = [
    proseSection(1),
    preBlock(1),
    proseSection(2),
    preBlock(2),
    proseSection(3),
    preBlock(3),
    proseSection(4),
    preBlock(4),
    unterminatedTail,
  ].join("\n\n");

  const stripped = await formatCodeForTts(longPreHeavyContent, "skip");
  assert(!stripped.includes("Uint8Array(4096)"), "code blocks must be stripped from spoken text");
  const prompt = formatNarrationPrompt({
    title: "Long Pre-Heavy Systems Article",
    author: "Paul Kinlan",
    sourceName: "Inbox",
    body: stripped,
  });
  const expectedChunks = splitTextUnderByteBudget(prompt, MAX_TTS_INPUT_BYTES);
  assert(
    expectedChunks.length >= 3,
    `expected at least 3 TTS chunks after stripping <pre> blocks, got ${expectedChunks.length}`,
  );

  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "inbox",
      title: "Long Pre-Heavy Systems Article",
      author: "Paul Kinlan",
      content: longPreHeavyContent,
    }),
  );

  const requestedPrompts: string[] = [];
  const client = new GeminiTtsClient({
    apiKey: "dummy-key",
    timeoutRetries: 0,
    fetchFn: (_url, init) => {
      const bodyJson = JSON.parse(String(init?.body ?? "{}")) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
      };
      const text = bodyJson.contents?.[0]?.parts?.[0]?.text ?? "";
      requestedPrompts.push(text);
      const wav = segmentWav(text || `chunk-${requestedPrompts.length}`);
      let binary = "";
      for (const b of wav) binary += String.fromCharCode(b);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [{ inlineData: { mimeType: "audio/wav", data: btoa(binary) } }],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });

  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: null,
  });

  // Drive through bounded ticks (max 2 segments per invocation) until terminal ready state
  let ticks = 0;
  while (ticks < 10) {
    ticks++;
    const batch = await runSynthesisBatch(ctx, synth, {
      owner: `worker-3cf0-tick-${ticks}`,
      maxSegmentsPerInvocation: 2,
    });
    if (batch.ready.length === 1) {
      break;
    }
    assertEquals(batch.yielded.length, 1, `tick ${ticks} should yield cleanly with progress`);
    assertEquals(batch.yielded[0]?.totalTurns, expectedChunks.length);
  }

  const finalEpisode = await stores.metadata.getEpisode("user-1", "episode-1");
  assert(finalEpisode);
  assertEquals(finalEpisode.status, "ready", "long <pre>-heavy article must reach ready state");
  assertEquals(finalEpisode.phase, "ready");
  assertEquals(finalEpisode.error, undefined);
  assertEquals(
    requestedPrompts.length,
    expectedChunks.length,
    "each chunk must be synthesized exactly once across resumed ticks",
  );
  for (const sentText of requestedPrompts) {
    assert(!sentText.includes("Uint8Array(4096)"), "no raw <pre> code may reach TTS requests");
  }
  assert(finalEpisode.audioKey);
  const finalBlob = await stores.blobs.get(finalEpisode.audioKey);
  assert(finalBlob && (finalBlob.size ?? 0) > 44, "stitched WAV blob must be persisted");
  assertEquals(
    await stores.metadata.listSynthesisSegments("user-1", "episode-1"),
    [],
    "intermediate segment blobs must be swept after terminal commit",
  );
});

Deno.test(
  "audio-feed-20ke: narration mid-turn deadline abort after segment 1 commits preserves durable progress (attempts=0) and resumes from segment 2 without re-synthesizing segment 1",
  async () => {
    const { ctx, stores } = await queued();

    // Build a 3-segment narration article (~7.5 KB across 3 paragraphs).
    const para = (n: number) =>
      `Paragraph ${n}. ` +
      "Real-time audio synthesis splits long articles into bounded 3 KB segments so each turn finishes well inside the invocation budget. "
        .repeat(
          18,
        );
    const content = [para(1), para(2), para(3)].join("\n\n");
    const formatted = await formatCodeForTts(content, "skip");
    const fullPrompt = formatNarrationPrompt({
      title: "Mid-Turn Budget Narration",
      author: "Paul Kinlan",
      sourceName: "Inbox",
      body: formatted,
    });
    const expectedChunks = splitTextUnderByteBudget(fullPrompt, MAX_TTS_INPUT_BYTES);
    assert(
      expectedChunks.length >= 3,
      `expected at least 3 narration segments under ${MAX_TTS_INPUT_BYTES}B cap, got ${expectedChunks.length}`,
    );

    await stores.metadata.putArticle(
      makeArticle({
        id: "article-1",
        userId: "user-1",
        sourceId: "inbox",
        title: "Mid-Turn Budget Narration",
        author: "Paul Kinlan",
        content,
      }),
    );

    const synthesizedPrompts: string[] = [];
    let abortOnSecondTurn = true;
    const client = new GeminiTtsClient({
      apiKey: "dummy-key",
      timeoutRetries: 0,
      fetchFn: async (_url, init) => {
        const bodyJson = JSON.parse(String(init?.body ?? "{}")) as {
          contents?: Array<{ parts?: Array<{ text?: string }> }>;
        };
        const text = bodyJson.contents?.[0]?.parts?.[0]?.text ?? "";
        if (abortOnSecondTurn && synthesizedPrompts.length === 1) {
          // Simulate turn 2 stalling until the invocation budget deadline aborts the signal mid-turn.
          await new Promise<void>((_resolve, reject) => {
            const sig = init?.signal;
            if (sig?.aborted) {
              reject(sig.reason ?? new DOMException("Aborted", "AbortError"));
              return;
            }
            sig?.addEventListener(
              "abort",
              () => reject(sig.reason ?? new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        synthesizedPrompts.push(text);
        const wav = segmentWav(text || `chunk-${synthesizedPrompts.length}`);
        let binary = "";
        for (const b of wav) binary += String.fromCharCode(b);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [{ inlineData: { mimeType: "audio/wav", data: btoa(binary) } }],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const synth = createGeminiSynthesizer(ctx, {
      client,
      scriptGenerator: null,
      estimatedTurnDurationMs: 10,
      flushMarginMs: 5,
    });

    // Tick 1: Segment 1 commits, then Segment 2 stalls and aborts on the 80ms invocation budget deadline.
    const tick1 = await runSynthesisBatch(ctx, synth, {
      owner: "worker-20ke-tick1",
      maxClaims: 3,
      maxInvocationDurationMs: 80,
      estimatedTurnDurationMs: 10,
      estimatedUploadDurationMs: 5,
      flushMarginMs: 5,
    });

    assertEquals(tick1.ready.length, 0, "tick 1 must yield when turn 2 aborts on deadline");
    assertEquals(tick1.failed.length, 0, "tick 1 must not fail the episode");
    assertEquals(tick1.yielded.length, 1, "tick 1 must yield cleanly");
    assertEquals(tick1.yielded[0]?.completedTurns, 1, "segment 1 was durably committed");
    assertEquals(
      tick1.yielded[0]?.totalTurns,
      expectedChunks.length,
      "yielded totalTurns must reflect actual narration chunk count, not MAX_TTS_SEGMENTS",
    );
    assertEquals(synthesizedPrompts.length, 1, "only segment 1 completed a paid call in tick 1");

    const epAfterTick1 = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(epAfterTick1?.status, "pending");
    assertEquals(
      epAfterTick1?.attempts,
      0,
      "durable segment progress must reset attempts to 0 so retries never exhaust claim 3/3",
    );
    assertEquals(epAfterTick1?.phase, `synthesized_1_of_${expectedChunks.length}`);

    // Tick 2: Resumes with a fresh budget; segment 1 is loaded from durable cache (not re-synthesized)
    // and remaining segments complete to ready.
    abortOnSecondTurn = false;
    const tick2 = await runSynthesisBatch(ctx, synth, {
      owner: "worker-20ke-tick2",
      maxClaims: 3,
      maxInvocationDurationMs: 5_000,
      estimatedTurnDurationMs: 10,
      estimatedUploadDurationMs: 5,
      flushMarginMs: 5,
    });

    assertEquals(
      tick2.ready.length,
      1,
      "tick 2 must finish the remaining segments and commit ready",
    );
    assertEquals(
      synthesizedPrompts.length,
      expectedChunks.length,
      "segment 1 must NOT be re-synthesized on tick 2; each chunk is synthesized once in total",
    );
    const epFinal = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(epFinal?.status, "ready");
    assertEquals(epFinal?.phase, "ready");
  },
);

Deno.test(
  "audio-feed-sp38: multi-segment progress across expired leases resets attempts=0 and succeeds without premature abandonment, while consecutive zero-progress expirations abandon",
  async () => {
    const { stores } = await queued();

    let clockMs = Date.parse("2026-10-14T12:00:00.000Z");
    const leaseMs = 10_000;
    const maxClaims = 3;

    // Simulate 4 successive claims (workers) for 4 segments where each worker
    // finalizes a segment and then dies abruptly (isolate kill / OOM) leaving the claim
    // uncompleted until lease expiry.
    for (let segmentIndex = 1; segmentIndex <= 4; segmentIndex++) {
      const owner = `worker-${segmentIndex}`;
      const claimed = await stores.metadata.claimEpisode("user-1", "episode-1", {
        owner,
        now: new Date(clockMs).toISOString(),
        leaseMs,
        maxClaims,
      });
      assert(claimed, `worker-${segmentIndex} must successfully claim the episode`);
      assertEquals(
        claimed.attempts,
        1,
        `claim attempts must be 1 on segment ${segmentIndex} because prior progress reset attempts to 0`,
      );

      // Reserve and finalize segment
      const text = SEGMENTS[segmentIndex - 1]!;
      const textHash = await segmentTextHash(text);
      const slot = { textHash, promptVersion: "v1", voice: "Charon" };
      await stores.metadata.reserveSynthesisSegment(
        "user-1",
        "episode-1",
        {
          textHash,
          text,
          promptVersion: "v1",
          voice: "Charon",
          audioKey: `seg-${segmentIndex}.wav`,
          byteLength: 100,
          owner,
          claimAt: new Date(clockMs).toISOString(),
          createdAt: new Date(clockMs).toISOString(),
          finalized: false,
        },
        clockMs,
        leaseMs,
      );

      const finalized = await stores.metadata.finalizeSynthesisSegment(
        "user-1",
        "episode-1",
        slot,
        { audioKey: `seg-${segmentIndex}.wav`, byteLength: 100 },
        owner,
        clockMs,
        leaseMs,
      );
      assert(finalized, `segment ${segmentIndex} must finalize`);

      const epAfterFinalize = await stores.metadata.getEpisode("user-1", "episode-1");
      assertEquals(
        epAfterFinalize?.attempts,
        0,
        `segment ${segmentIndex} finalization must reset attempts to 0`,
      );

      // Worker dies abruptly: NO terminal write occurs, claim stays in status "synthesizing".
      // Advance clock past leaseMs so the lease expires before the next claim.
      clockMs += leaseMs + 1000;
    }

    // Now final worker-5 claims and completes the episode cleanly to ready
    const finalWorker = await stores.metadata.claimEpisode("user-1", "episode-1", {
      owner: "worker-5",
      now: new Date(clockMs).toISOString(),
      leaseMs,
      maxClaims,
    });
    assert(finalWorker, "worker-5 must successfully claim the episode");
    assertEquals(finalWorker.attempts, 1);

    const completed = await stores.metadata.completeEpisode(
      {
        ...finalWorker,
        status: "ready",
        audioKey: "final.wav",
        byteLength: 400,
        contentType: "audio/wav",
        phase: "ready",
      },
      "worker-5",
      {
        byteLength: 400,
      },
    );
    assert(completed, "episode must complete to ready");

    const epFinal = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(epFinal?.status, "ready");

    // PART 2: Zero durable progress across 3 consecutive expired leases MUST abandon.
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "episode-poison",
        userId: "user-1",
        sourceId: "inbox",
        articleId: "article-1",
        status: "pending",
        mode: "direct",
      }),
    );

    // Attempt 1: worker-p1 claims, makes zero progress, dies
    const p1 = await stores.metadata.claimEpisode("user-1", "episode-poison", {
      owner: "poison-1",
      now: new Date(clockMs).toISOString(),
      leaseMs,
      maxClaims,
    });
    assert(p1);
    assertEquals(p1.attempts, 1);

    // Attempt 2: lease expires, worker-p2 claims, makes zero progress, dies
    clockMs += leaseMs + 1000;
    const p2 = await stores.metadata.claimEpisode("user-1", "episode-poison", {
      owner: "poison-2",
      now: new Date(clockMs).toISOString(),
      leaseMs,
      maxClaims,
    });
    assert(p2);
    assertEquals(p2.attempts, 2);

    // Attempt 3: lease expires, worker-p3 claims, makes zero progress, dies
    clockMs += leaseMs + 1000;
    const p3 = await stores.metadata.claimEpisode("user-1", "episode-poison", {
      owner: "poison-3",
      now: new Date(clockMs).toISOString(),
      leaseMs,
      maxClaims,
    });
    assert(p3);
    assertEquals(p3.attempts, 3);

    // Attempt 4: lease expires. attempts > maxClaims (3) -> claimEpisode abandons!
    clockMs += leaseMs + 1000;
    const p4 = await stores.metadata.claimEpisode("user-1", "episode-poison", {
      owner: "poison-4",
      now: new Date(clockMs).toISOString(),
      leaseMs,
      maxClaims,
    });
    assertEquals(p4, null, "claim 4 must return null because episode was abandoned");

    const epPoison = await stores.metadata.getEpisode("user-1", "episode-poison");
    assertEquals(epPoison?.status, "failed");
    assertStringIncludes(
      epPoison?.error ?? "",
      "abandoned after 3 attempts; reason: claim lease expired without terminal write",
    );
  },
);

Deno.test(
  "audio-feed-sp38: joinTtsAudio shares underlying ArrayBuffer between rawBytes and toWav without duplicate memory allocation",
  () => {
    const chunk1Pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const chunk2Pcm = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);
    const chunk1 = decodedFromWav(
      pcmToWav(chunk1Pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 }),
    );
    const chunk2 = decodedFromWav(
      pcmToWav(chunk2Pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 }),
    );

    const joined = joinTtsAudio([chunk1, chunk2]);
    assertEquals(joined.rawBytes.length, 16);
    assertEquals(Array.from(joined.rawBytes), [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
    ]);

    const wav = joined.toWav();
    assertEquals(wav.length, 44 + 16);

    // Verify zero-copy buffer sharing: rawBytes and wav share the exact same ArrayBuffer!
    assertEquals(joined.rawBytes.buffer, wav.buffer);
    assertEquals(joined.rawBytes.byteOffset, 44);
    assertEquals(wav.byteOffset, 0);

    // Verify WAV header validity
    const header = parseWavHeader(wav);
    assertEquals(header.audioFormat, 1);
    assertEquals(header.channels, 1);
    assertEquals(header.sampleRate, 24000);
    assertEquals(header.dataLength, 16);
    assertEquals(header.dataOffset, 44);

    // Verify writeWavHeader independently
    const customWav = new Uint8Array(44 + 8);
    writeWavHeader(customWav, 8, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
    const customHeader = parseWavHeader(customWav);
    assertEquals(customHeader.dataLength, 8);
  },
);

Deno.test(
  "audio-feed-sp38: batch loop breaks immediately upon time-based budget yield and does not claim subsequent episode in an exhausted isolate",
  async () => {
    const { ctx, stores } = await queued();

    // Create a second episode in pending
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "episode-2",
        userId: "user-1",
        sourceId: "inbox",
        articleId: "article-1",
        status: "pending",
        mode: "direct",
      }),
    );

    // Synthesizer that yields due to time budget on episode-1
    const synth: Synthesizer = ({ episode }) => {
      if (episode.id === "episode-1") {
        throw new SynthesisYieldError(
          1,
          4,
          "Synthesis yielded before paid turn 2: remaining budget 20000ms < required 50000ms",
        );
      }
      return Promise.resolve(stitch([segmentWav("chunk")]));
    };

    // Run batch with maxInvocationDurationMs
    const batchResult = await runSynthesisBatch(ctx, synth, {
      owner: "batch-worker-1",
      maxClaims: 3,
      maxInvocationDurationMs: 90_000,
      estimatedTurnDurationMs: 10,
      flushMarginMs: 5,
    });

    assertEquals(batchResult.yielded.length, 1);
    assertEquals(batchResult.yielded[0]?.episodeId, "episode-1");

    // Episode 2 must NOT have been claimed or processed in the same batch invocation
    const ep2 = await stores.metadata.getEpisode("user-1", "episode-2");
    assertEquals(
      ep2?.status,
      "pending",
      "episode-2 must remain pending; batch loop must not claim it",
    );
    assertEquals(ep2?.claimedBy, undefined);
  },
);
