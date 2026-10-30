/**
 * audio-feed-y9kk — unsigned payload writes are impossible in the worker path, BY CONSTRUCTION.
 *
 * aqms made the TERMINAL upload abortable; the same class survived elsewhere: the segment
 * commit put (worker), the voice-sample route put, the legacy migration putIfAbsent. The fix
 * is a class fix: runSynthesisBatch obtains its blob store through boundedBlobStore, which
 * THROWS on any put without an abort signal (allowlist: empty for the worker path, explicit
 * and reasoned wherever one genuinely cannot take a signal), and the stage signal now rides
 * the resume hooks into the segment put. These tests pin the PROPERTY, not today's call-site
 * list: a decorating store underneath the worker refuses any unsigned payload write while a
 * real multi-segment batch runs, so a future call site that forgets the signal fails this
 * test instead of quietly starting an uninterruptible transfer that outlives its invocation.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import type { Synthesizer } from "../src/worker/synthesis.ts";
import {
  boundedBlobStore,
  type UnsignedPutAllowlistEntry,
  UnsignedPutError,
} from "../src/storage/bounded.ts";
import type { BlobStore } from "../src/storage/mod.ts";
import { decodedFromWav, GeminiTtsClient, GeminiTtsError, pcmToWav } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

const SEGMENTS = [
  "The first movement states the claim the episode will test.",
  "The second movement is the evidence, in the order it was found.",
  "The third movement is what the claim looks like once corrected.",
];

function segmentWav(text: string): Uint8Array {
  const pcm = new Uint8Array(64 + (text.length % 32) * 8);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i + text.charCodeAt(i % text.length)) & 0x7f;
  return pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
}

/**
 * THE DECORATING STORE: records every payload write and whether it was signed. It sits
 * UNDER the production wrapper, so it still pins the property if the wrapper is ever
 * removed — and its `throws` mode (used by the refusal half below) makes unsigned writes
 * loud even for callers the production wrapper does not wrap.
 */
function guardingStore(
  inner: BlobStore,
): { store: BlobStore; signed: string[]; unsigned: string[]; signals: AbortSignal[] } {
  const signed: string[] = [];
  const unsigned: string[] = [];
  const signals: AbortSignal[] = [];
  const store: BlobStore = {
    put(key, body, opts) {
      if (opts?.signal) {
        signed.push(key);
        signals.push(opts.signal);
      } else {
        unsigned.push(key);
      }
      return inner.put(key, body, opts);
    },
    putIfAbsent(key, body, opts) {
      if (opts?.signal) {
        signed.push(key);
        signals.push(opts.signal);
      } else {
        unsigned.push(key);
      }
      return inner.putIfAbsent(key, body, opts);
    },
    get(key, opts) {
      return inner.get(key, opts);
    },
    head(key) {
      return inner.head(key);
    },
    delete(key) {
      return inner.delete(key);
    },
    url(key, opts) {
      return inner.url(key, opts);
    },
    directUrlOrigin: () => inner.directUrlOrigin(),
  };
  return { store, signed, unsigned, signals };
}

/** A resume-aware synthesizer shaped exactly like the TTS client: prepare, paid call, commit
 * WITH the stage's signal — the honest caller. A synthesizer that forgets the signal is the
 * mutation these tests must catch. */
function segmentSynthesizer(
  state: { paid: string[] },
  options: { signal?: () => AbortSignal | undefined } = {},
): Synthesizer {
  const voice = "Charon";
  return async ({ resume }) => {
    const wavs: Uint8Array[] = [];
    for (const text of SEGMENTS) {
      const prepared = resume ? await resume.prepare(text, voice) : "synthesize";
      if (prepared === "held") throw new GeminiTtsError("segment held", 409);
      if (prepared !== "synthesize") {
        wavs.push(prepared.wav);
        continue;
      }
      state.paid.push(text);
      const decoded = decodedFromWav(segmentWav(text));
      await resume?.commit(text, decoded, voice, options.signal?.());
      wavs.push(segmentWav(text));
    }
    const total = wavs.reduce((n, wav) => n + (wav.length - 44), 0);
    const pcm = new Uint8Array(total);
    let at = 0;
    for (const wav of wavs) {
      pcm.set(wav.subarray(44), at);
      at += wav.length - 44;
    }
    return decodedFromWav(pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 }));
  };
}

async function queued(stores: Stores) {
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
  return { ctx: { config, stores } };
}

Deno.test("audio-feed-y9kk: a real multi-segment batch writes EVERY payload signed, or not at all", async () => {
  const base = memoryStores();
  const guard = guardingStore(base.blobs);
  const stores: Stores = { ...base, blobs: guard.store };
  const { ctx } = await queued(stores);
  const state = { paid: [] as string[] };
  const stageController = new AbortController();

  const result = await runSynthesisBatch(
    ctx as never,
    segmentSynthesizer(state, {
      // The REAL client passes the stage's signal into commit; the harness must be that
      // honest caller, or the wrapper (correctly) refuses the segment puts.
      signal: () => stageController.signal,
    }),
    {
      owner: "worker-1",
      leaseMs: 60_000,
      maxClaims: 3,
      nowMs: Date.parse("2026-10-11T12:00:00Z"),
      maxInvocationDurationMs: 3_600_000,
    },
  );

  // THE PROPERTY: zero unsigned payload writes reached the store during the whole batch.
  // Every segment-commit put and the terminal upload arrived signed, so an invocation
  // killed at its deadline always has a way to close the transfer it is inside.
  assertEquals(
    guard.unsigned,
    [],
    "every payload write during runSynthesisBatch must carry an abort signal (audio-feed-y9kk)",
  );
  // Sanity, not the property: the batch really did synthesize and write (three segments
  // committed resumably plus the terminal upload), so the property was exercised, not vacuous.
  assertEquals(state.paid.length, SEGMENTS.length);
  assertEquals(result.ready.length, 1, "the episode must finish");
  assert(guard.signed.length >= SEGMENTS.length + 1, "segments + terminal upload all wrote");
  assert(guard.signals.every((signal) => signal instanceof AbortSignal && !signal.aborted));
});

Deno.test("audio-feed-y9kk: the production wrapper refuses an unsigned put and admits a REASONED allowlist", async () => {
  const base = memoryStores();
  // No signal and no allowlist: refuse, naming the key.
  const strict = boundedBlobStore(base.blobs, { warnOnAllowlisted: false });
  await assertRejects(
    () =>
      strict.put("episodes/user-1/episode-1/audio.wav", new Uint8Array(8), {
        contentType: "audio/wav",
      }),
    UnsignedPutError,
    "unsigned payload write refused",
  );

  // Allowlisted WITH A REASON: proceeds. The reason is a required field of the entry, and
  // the property test for the worker path uses an EMPTY allowlist, so an admitted write
  // here is a DECISION someone wrote down, never an accident.
  const allowlist: readonly UnsignedPutAllowlistEntry[] = [{
    test: (key) => key.startsWith("legacy/"),
    reason:
      "operator-run CLI migration: no invocation deadline exists to abort against; the operator is the bound.",
  }];
  const bounded = boundedBlobStore(base.blobs, { allowlist, warnOnAllowlisted: false });
  const stored = await bounded.put("legacy/user-1/episode-9/audio.wav", new Uint8Array(8), {
    contentType: "audio/wav",
  });
  assertEquals(stored.size, 8);
  // Outside the allowlist's pattern, still refused even though another key was admitted.
  await assertRejects(
    () =>
      bounded.putIfAbsent("episodes/user-1/episode-1/audio.wav", new Uint8Array(8), {
        contentType: "audio/wav",
      }),
    UnsignedPutError,
  );
  // Signed writes are never the wrapper's business: they pass through untouched.
  const passed = await bounded.put("episodes/user-1/episode-2/audio.wav", new Uint8Array(4), {
    contentType: "audio/wav",
    signal: AbortSignal.timeout(1_000),
  });
  assertEquals(passed.size, 4);
});

Deno.test("audio-feed-y9kk: the TTS client hands the stage signal to the resume commit hook", async () => {
  // The other half of the wiring: the worker signs its commit puts with whatever the client
  // passes as the hook's fourth argument, so the CLIENT must forward the synthesis options'
  // signal. A client that forgets it turns every segment put into the very zombie the
  // wrapper refuses — this pins the pass-through where it is written.
  const controller = new AbortController();
  const commitSignals: Array<AbortSignal | undefined> = [];
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: (() => {
      const pcm = new Uint8Array(96).map((_, i) => (i * 7) & 0x7f);
      const b64 = btoa(String.fromCharCode(...pcm));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{
              content: {
                parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: b64 } }],
              },
              finishReason: "STOP",
            }],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch,
  });
  await client.synthesizeNarration(
    { title: "t", body: "one small body", voice: "Charon", includeIntro: false },
    {
      signal: controller.signal,
      resume: {
        prepare: () => Promise.resolve("synthesize" as const),
        commit: (_text: string, _decoded: unknown, _voice: string, signal?: AbortSignal) => {
          commitSignals.push(signal);
          return Promise.resolve();
        },
      },
    },
  );
  assertEquals(commitSignals.length, 1);
  assert(
    commitSignals[0] === controller.signal,
    "the client must forward its options.signal into resume.commit (audio-feed-y9kk)",
  );

  // Same pin on the DIALOGUE path: a mutation check found the first version of this test
  // drove only narration, so dropping the signal from the dialogue hook survived it.
  const dialogueSignals: Array<AbortSignal | undefined> = [];
  await client.synthesizeDialogue(
    {
      topic: "Signal threading",
      turns: [
        { speaker: "Alex", text: "The put must carry the signal." },
        { speaker: "Sam", text: "Or the wrapper refuses it." },
      ],
      speakers: [
        { name: "Alex", role: "expert", voice: "Fenrir" },
        { name: "Sam", role: "curious_foil", voice: "Puck" },
      ],
    },
    {
      signal: controller.signal,
      resume: {
        prepare: () => Promise.resolve("synthesize" as const),
        commit: (_text: string, _decoded: unknown, _voice: string, signal?: AbortSignal) => {
          dialogueSignals.push(signal);
          return Promise.resolve();
        },
      },
    },
  );
  assert(
    dialogueSignals.length > 0 && dialogueSignals.every((signal) => signal === controller.signal),
    "the dialogue path must forward its options.signal into resume.commit too (audio-feed-y9kk)",
  );
});
