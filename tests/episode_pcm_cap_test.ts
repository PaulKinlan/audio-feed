import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";
import {
  GeminiTtsClient,
  MAX_NEW_PCM_BYTES_PER_INVOCATION,
  MAX_NEW_PCM_SECONDS_PER_INVOCATION,
  MAX_PUBLICATION_PCM_BYTES,
  MAX_TTS_INPUT_BYTES,
  parseWavHeader,
  pcmToWav,
  splitTtsText,
  WAV_BITS_PER_SAMPLE,
  WAV_CHANNELS,
  WAV_SAMPLE_RATE,
} from "../src/tts/gemini.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { formatNarrationPrompt } from "../src/tts/gemini.ts";
import { SynthesisYieldError } from "../src/synthesis/limits.ts";
import { collect } from "../src/storage/mod.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

const body = [
  "First. " + "An episode speaks through a durable segment. ".repeat(54),
  "Second. " + "Its following audio belongs to the same episode. ".repeat(52),
].join("\n\n");
const article = { title: "Continuous narration", body };
const plan = splitTtsText(formatNarrationPrompt(article), MAX_TTS_INPUT_BYTES);

function mockClient(paid: number[]): GeminiTtsClient {
  const client = new GeminiTtsClient({ apiKey: "fixture" });
  client.sendRequest = (_request) => {
    paid.push(paid.length);
    const length = paid.length === 1 ? MAX_NEW_PCM_BYTES_PER_INVOCATION : WAV_SAMPLE_RATE * 2;
    const rawBytes = new Uint8Array(length);
    rawBytes.fill(paid.length);
    const audio: DecodedAudioResult = {
      rawBytes,
      mimeType: "audio/pcm;rate=24000",
      format: "pcm",
      sampleRate: WAV_SAMPLE_RATE,
      channels: WAV_CHANNELS,
      bitsPerSample: WAV_BITS_PER_SAMPLE,
      durationSeconds: length / (WAV_SAMPLE_RATE * WAV_CHANNELS * WAV_BITS_PER_SAMPLE / 8),
      truncated: false,
      finishReason: "STOP",
      toWav: () => pcmToWav(rawBytes),
    };
    return Promise.resolve(audio);
  };
  return client;
}

Deno.test("audio-feed-zxv2k: invocation cap follows the writer's PCM defaults, not a copied byte literal", async () => {
  const source = await Deno.readTextFile(new URL("../src/tts/gemini.ts", import.meta.url));
  assertStringIncludes(source, "MAX_NEW_PCM_SECONDS_PER_INVOCATION *");
  assertStringIncludes(source, "WAV_SAMPLE_RATE * WAV_CHANNELS * WAV_BITS_PER_SAMPLE / 8");
  assertEquals(MAX_NEW_PCM_SECONDS_PER_INVOCATION, 60 * 60);
  assertEquals(
    MAX_NEW_PCM_BYTES_PER_INVOCATION,
    MAX_NEW_PCM_SECONDS_PER_INVOCATION * WAV_SAMPLE_RATE * WAV_CHANNELS * WAV_BITS_PER_SAMPLE / 8,
  );
  assert(MAX_PUBLICATION_PCM_BYTES > MAX_NEW_PCM_BYTES_PER_INVOCATION);
  assertEquals(plan.length, 2);
});

Deno.test("audio-feed-zxv2k: at-cap turn commits; new audio never exceeds a tick, resumed PCM stitches exactly once into one ready episode", async () => {
  const stores = memoryStores();
  const userId = "cap-user";
  const episodeId = "cap-episode";
  await stores.metadata.putUser(makeUser({ id: userId, status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId }));
  await stores.metadata.putArticle(
    makeArticle({
      id: "cap-article",
      userId,
      sourceId: "inbox",
      title: article.title,
      content: body,
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: episodeId,
      userId,
      sourceId: "inbox",
      articleId: "cap-article",
      status: "pending",
      mode: "direct",
      audioKey: undefined,
    }),
  );
  const paid: number[] = [];
  const ctx = {
    config: { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "secret" },
    stores,
  };
  const synth = createGeminiSynthesizer(ctx, { client: mockClient(paid), scriptGenerator: null });
  const first = await runSynthesisBatch(ctx, synth, { owner: "cap-tick-1", maxClaims: 3 });
  assertEquals(first.yielded.length, 1);
  assertEquals(first.ready.length, 0);
  assertEquals(first.failed.length, 0);
  const committed = (await stores.metadata.listSynthesisSegments(userId, episodeId)).filter((
    segment,
  ) => segment.finalized);
  assertEquals(
    committed.length,
    1,
    "the at-cap segment persists; the overshooting segment does not",
  );
  assertEquals(
    parseWavHeader(await collect((await stores.blobs.get(committed[0]!.audioKey))!.body))
      .dataLength,
    MAX_NEW_PCM_BYTES_PER_INVOCATION,
  );
  const second = await runSynthesisBatch(ctx, synth, { owner: "cap-tick-2", maxClaims: 3 });
  assertEquals(second.ready.length, 1);
  assertEquals(second.failed.length, 0);
  const episode = await stores.metadata.getEpisode(userId, episodeId);
  assertEquals(episode?.status, "ready");
  assert(episode?.audioKey);
  const wav = await collect((await stores.blobs.get(episode.audioKey))!.body);
  const info = parseWavHeader(wav);
  assertEquals(info.dataLength, MAX_NEW_PCM_BYTES_PER_INVOCATION + WAV_SAMPLE_RATE * 2);
  assertEquals(wav[info.dataOffset], 1, "first segment begins the published asset");
  assertEquals(
    wav[info.dataOffset + MAX_NEW_PCM_BYTES_PER_INVOCATION],
    3,
    "resumed segment appears exactly once, before the newly paid segment",
  );
  assertEquals(
    (await stores.metadata.listSynthesisSegments(userId, episodeId)).length,
    0,
    "the existing successful-publication sweep clears intermediate segments",
  );
});

Deno.test("audio-feed-zxv2k: an individually over-cap turn is terminal and cannot be committed or retried", async () => {
  const client = mockClient([]);
  client.sendRequest = () => {
    const rawBytes = new Uint8Array(MAX_NEW_PCM_BYTES_PER_INVOCATION + 2);
    return Promise.resolve(
      {
        rawBytes,
        format: "pcm",
        mimeType: "audio/pcm",
        sampleRate: WAV_SAMPLE_RATE,
        channels: WAV_CHANNELS,
        bitsPerSample: WAV_BITS_PER_SAMPLE,
        durationSeconds: 3601,
        truncated: false,
        toWav: () => pcmToWav(rawBytes),
      } as DecodedAudioResult,
    );
  };
  let committed = 0;
  const error = await assertRejects(() =>
    client.synthesizeNarration({ title: "T", body: "Hello" }, {
      resume: {
        prepare: () => Promise.resolve("synthesize"),
        commit: () => {
          committed++;
          return Promise.resolve();
        },
      },
    })
  );
  assert(
    !(error instanceof SynthesisYieldError),
    "a single impossible segment is not a retryable yield",
  );
  assert(error instanceof Error);
  assertStringIncludes(error.message, "invocation PCM limit");
  assertEquals(committed, 0);
});

Deno.test("audio-feed-zxv2k: resumed WAV PCM must be complete before the next paid turn", async () => {
  const wav = pcmToWav(new Uint8Array([1, 2]));
  const corrupted = new Uint8Array(wav.length + 2);
  corrupted.set(wav);
  const paid: number[] = [];
  const client = mockClient(paid);
  const error = await assertRejects(() =>
    client.synthesizeNarration(article, {
      resume: {
        prepare: () => Promise.resolve({ wav: corrupted }),
        commit: () => Promise.resolve(),
      },
    })
  );
  assert(error instanceof Error);
  assertStringIncludes(error.message, "incomplete PCM data");
  assertEquals(paid.length, 0, "invalid cached audio never reaches a paid or published turn");
});
