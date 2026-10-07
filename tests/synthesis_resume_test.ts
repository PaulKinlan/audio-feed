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
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { deleteUserSource } from "../src/compose/account.ts";
import type { Synthesizer } from "../src/worker/synthesis.ts";
import { decodedFromWav, GeminiTtsError, parseWavHeader, pcmToWav } from "../src/tts/gemini.ts";
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
