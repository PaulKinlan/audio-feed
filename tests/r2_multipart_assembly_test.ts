/**
 * P1 Streaming R2 Multipart Assembly tests:
 * - Native R2 createMultipartUpload / uploadPart / complete / abort
 * - Strict >= 5 MiB non-final part size invariant
 * - Exact byte-for-byte WAV stitching across multi-segment boundaries
 * - Small (< 8 MiB) single-PUT fast path
 * - Clean multipart abort on read/stream error
 * - End-to-end runSynthesisBatch with R2BlobStore using streaming segment refs (zero full-WAV RAM)
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { MemoryMetadataStore } from "../src/storage/memory.ts";
import {
  R2BlobStore,
  type R2BucketLike,
  type R2MultipartUploadLike,
  type R2ObjectBodyLike,
  type R2ObjectLike,
  type R2UploadedPartLike,
} from "../src/storage/r2.ts";
import {
  assembleWavToBlobStore,
  inspectStoredWavSegment,
  R2_MIN_MULTIPART_PART_BYTES,
} from "../src/storage/wav_assembly.ts";
import { collect, streamOf } from "../src/storage/mod.ts";
import {
  GeminiTtsClient,
  parseWavHeader,
  pcmToWav,
  uint8ArrayToBase64,
} from "../src/tts/gemini.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

interface MockR2Stats {
  puts: string[];
  multipartCreated: string[];
  multipartAborted: string[];
  uploadedPartSizes: number[];
}

function createMockMultipartR2Bucket(): {
  bucket: R2BucketLike;
  objects: Map<string, { bytes: Uint8Array; contentType: string; etag: string }>;
  stats: MockR2Stats;
} {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; etag: string }>();
  const stats: MockR2Stats = {
    puts: [],
    multipartCreated: [],
    multipartAborted: [],
    uploadedPartSizes: [],
  };
  let etagSeq = 0;

  const toBytes = async (
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null,
  ): Promise<Uint8Array> => {
    if (value === null) return new Uint8Array(0);
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    }
    return await collect(value);
  };

  const bucket: R2BucketLike = {
    async put(key, value, options): Promise<R2ObjectLike | null> {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = await toBytes(value);
      const contentType = options?.httpMetadata?.contentType ?? "application/octet-stream";
      const etag = `etag-${++etagSeq}`;
      objects.set(key, { bytes, contentType, etag });
      stats.puts.push(key);
      return { key, size: bytes.byteLength, etag, httpMetadata: { contentType } };
    },
    async createMultipartUpload(key, options): Promise<R2MultipartUploadLike> {
      stats.multipartCreated.push(key);
      const uploadId = `mpu-${++etagSeq}`;
      const contentType = options?.httpMetadata?.contentType ?? "application/octet-stream";
      const parts = new Map<number, { bytes: Uint8Array; etag: string }>();
      let aborted = false;

      return {
        key,
        uploadId,
        async uploadPart(partNumber, value): Promise<R2UploadedPartLike> {
          if (aborted) throw new Error("Upload already aborted");
          const bytes = await toBytes(value);
          stats.uploadedPartSizes.push(bytes.byteLength);
          const etag = `part-${partNumber}-${++etagSeq}`;
          parts.set(partNumber, { bytes, etag });
          return { partNumber, etag };
        },
        async abort(): Promise<void> {
          aborted = true;
          stats.multipartAborted.push(key);
          parts.clear();
        },
        async complete(uploadedParts): Promise<R2ObjectLike> {
          if (aborted) throw new Error("Upload already aborted");
          if (uploadedParts.length === 0) throw new Error("No parts");
          // Enforce R2/S3 strict >= 5 MiB rule for all non-final parts!
          for (let i = 0; i < uploadedParts.length - 1; i++) {
            const p = parts.get(uploadedParts[i]!.partNumber);
            if (!p) throw new Error(`Missing part ${uploadedParts[i]!.partNumber}`);
            if (p.bytes.byteLength < R2_MIN_MULTIPART_PART_BYTES) {
              throw new Error(
                `R2 multipart violation: non-final part ${uploadedParts[i]!.partNumber} is ${p.bytes.byteLength} bytes < 5 MiB`,
              );
            }
          }
          const ordered = uploadedParts.map((up) => {
            const p = parts.get(up.partNumber);
            if (!p || p.etag !== up.etag) throw new Error(`Part mismatch ${up.partNumber}`);
            return p.bytes;
          });
          const total = ordered.reduce((sum, b) => sum + b.byteLength, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const b of ordered) {
            merged.set(b, off);
            off += b.byteLength;
          }
          const etag = `mpu-complete-${++etagSeq}`;
          objects.set(key, { bytes: merged, contentType, etag });
          return { key, size: total, etag, httpMetadata: { contentType } };
        },
      };
    },
    async get(key, options): Promise<R2ObjectBodyLike | null> {
      const obj = objects.get(key);
      if (!obj) return null;
      let slice = obj.bytes;
      if (options?.range) {
        const start = options.range.offset ?? 0;
        const end = options.range.length !== undefined
          ? Math.min(obj.bytes.byteLength, start + options.range.length)
          : obj.bytes.byteLength;
        slice = obj.bytes.subarray(start, end);
      }
      return {
        key,
        size: obj.bytes.byteLength,
        etag: obj.etag,
        httpMetadata: { contentType: obj.contentType },
        body: streamOf(slice),
      };
    },
    async head(key): Promise<R2ObjectLike | null> {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        key,
        size: obj.bytes.byteLength,
        etag: obj.etag,
        httpMetadata: { contentType: obj.contentType },
      };
    },
    async delete(keys): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(k);
      }
    },
  };

  return { bucket, objects, stats };
}

Deno.test("P1: streaming R2 multipart assembly stitches > 12 MiB WAV with >= 5 MiB parts and exact bytes", async () => {
  const { bucket, objects, stats } = createMockMultipartR2Bucket();
  const blobs = new R2BlobStore(bucket);

  // Create 3 segments of 4.5 MiB PCM each (~13.5 MiB total > 8 MiB default part size -> 2 parts)
  const segPcmSize = 4_500_000;
  const segKeys = ["seg/u1/ep1/s0.wav", "seg/u1/ep1/s1.wav", "seg/u1/ep1/s2.wav"];
  const segPatterns = [0x11, 0x22, 0x33];

  const inspected = [];
  for (let i = 0; i < segKeys.length; i++) {
    const pcm = new Uint8Array(segPcmSize);
    pcm.fill(segPatterns[i]!);
    const wav = pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 16 });
    await blobs.put(segKeys[i]!, wav, { contentType: "audio/wav" });
    const meta = await inspectStoredWavSegment(blobs, segKeys[i]!);
    assert(meta !== null);
    assertEquals(meta.pcmByteLength, segPcmSize);
    assertEquals(meta.pcmOffset, 44);
    inspected.push(meta);
  }

  const destKey = "audio/u1/direct/ep1.wav";
  const assembled = await assembleWavToBlobStore({
    blobs,
    destinationKey: destKey,
    segments: inspected,
  });

  assertEquals(stats.multipartCreated, [destKey], "must use native R2 multipart upload");
  assertEquals(stats.multipartAborted.length, 0);
  assertEquals(assembled.partsUploaded, 2, "13.5 MiB at 8 MiB part size = 2 parts");
  assertEquals(stats.uploadedPartSizes[0], 8 * 1024 * 1024, "Part 1 must be full 8 MiB (>= 5 MiB)");
  assertEquals(assembled.byteLength, 44 + segPcmSize * 3);

  // Verify the final assembled WAV header & PCM byte-for-byte across all 3 segments
  const stored = objects.get(destKey);
  assert(stored);
  const info = parseWavHeader(stored.bytes);
  assertEquals(info.audioFormat, 1);
  assertEquals(info.sampleRate, 24000);
  assertEquals(info.channels, 1);
  assertEquals(info.bitsPerSample, 16);
  assertEquals(info.declaredDataLength, segPcmSize * 3);
  assertEquals(stored.bytes[44], 0x11);
  assertEquals(stored.bytes[44 + segPcmSize - 1], 0x11);
  assertEquals(stored.bytes[44 + segPcmSize], 0x22);
  assertEquals(stored.bytes[44 + segPcmSize * 2 - 1], 0x22);
  assertEquals(stored.bytes[44 + segPcmSize * 2], 0x33);
  assertEquals(stored.bytes[44 + segPcmSize * 3 - 1], 0x33);
});

Deno.test("P1: small WAV (< 8 MiB) uses single-PUT fast path without multipart overhead", async () => {
  const { bucket, stats } = createMockMultipartR2Bucket();
  const blobs = new R2BlobStore(bucket);

  const wav = pcmToWav(new Uint8Array(48_000).fill(0x5a));
  await blobs.put("seg/u1/ep2/s0.wav", wav, { contentType: "audio/wav" });
  const meta = await inspectStoredWavSegment(blobs, "seg/u1/ep2/s0.wav");
  assert(meta);

  const destKey = "audio/u1/direct/ep2.wav";
  const assembled = await assembleWavToBlobStore({
    blobs,
    destinationKey: destKey,
    segments: [meta],
  });
  assertEquals(stats.multipartCreated.length, 0, "small WAV must use normal put()");
  assert(stats.puts.includes(destKey));
  assertEquals(assembled.partsUploaded, 1);
  assertEquals(assembled.byteLength, 44 + 48_000);
});

Deno.test("P1: multipart upload aborts cleanly when a segment blob is missing mid-stream", async () => {
  const { bucket, stats } = createMockMultipartR2Bucket();
  const blobs = new R2BlobStore(bucket);

  const segPcmSize = 5_000_000;
  const wav = pcmToWav(new Uint8Array(segPcmSize).fill(0x77));
  await blobs.put("seg/u1/ep3/s0.wav", wav, { contentType: "audio/wav" });
  const meta0 = await inspectStoredWavSegment(blobs, "seg/u1/ep3/s0.wav");
  assert(meta0);
  const missingMeta = { ...meta0, audioKey: "seg/u1/ep3/missing.wav" };

  await assertRejects(
    () =>
      assembleWavToBlobStore({
        blobs,
        destinationKey: "audio/u1/direct/ep3.wav",
        segments: [meta0, missingMeta],
      }),
    Error,
    "Missing synthesis segment blob",
  );
  assertEquals(
    stats.multipartAborted,
    ["audio/u1/direct/ep3.wav"],
    "failed multipart upload must call abort() to avoid leaking incomplete R2 parts",
  );
});

Deno.test("P1: end-to-end runSynthesisBatch with R2BlobStore uses streaming segment refs and cleans up segment blobs", async () => {
  const { bucket, objects } = createMockMultipartR2Bucket();
  const blobs = new R2BlobStore(bucket);
  const metadata = new MemoryMetadataStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));
  const twoSegBody = [
    "Paragraph one: " + "streaming assembly keeps worker memory constant across hours. ".repeat(25),
    "Paragraph two: " + "each segment flushes to R2 and releases its buffer immediately. ".repeat(25),
  ].join("\n\n");
  await metadata.putArticle(
    makeArticle({ id: "a1", userId: "u1", sourceId: "inbox", title: "Streamed", content: twoSegBody }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-stream",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "direct",
    }),
  );

  let segNum = 0;
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: () => {
      segNum++;
      const pcm = new Uint8Array(2_400).fill(segNum);
      const wav = pcmToWav(pcm);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{
              finishReason: "STOP",
              content: {
                parts: [{ inlineData: { mimeType: "audio/wav", data: uint8ArrayToBase64(wav) } }],
              },
            }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });

  const ctx = {
    config: { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "secret" },
    stores: { metadata, blobs, describe: "metadata=memory blobs=r2" },
  };
  const synth = createGeminiSynthesizer(ctx, { client, scriptGenerator: null });
  const batch = await runSynthesisBatch(ctx, synth, { owner: "p1-w1" });

  assertEquals(batch.ready.length, 1);
  assertEquals(segNum, 2);
  const ep = await metadata.getEpisode("u1", "ep-stream");
  assertEquals(ep?.status, "ready");
  assert(ep?.audioKey);
  const finalObj = objects.get(ep.audioKey);
  assert(finalObj);
  const info = parseWavHeader(finalObj.bytes);
  assertEquals(info.declaredDataLength, 4_800);
  assertEquals(finalObj.bytes[44], 1);
  assertEquals(finalObj.bytes[44 + 2_400], 2);
  assertEquals((await metadata.listSynthesisSegments("u1", "ep-stream")).length, 0);
});
