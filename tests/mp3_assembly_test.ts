/**
 * Streaming MP3 assembly, audio craft, R2 Multipart Upload, and WAV backward-compatibility tests:
 * - Standards-compliant MPEG-2 Layer III (64 kbps mono @ 24 kHz) frame sync, bitrate, & duration
 * - Realistic 6x (64 kbps) and 8x (48 kbps) compression ratios vs uncompressed 24 kHz PCM WAV
 * - Silence-gated RMS loudness normalization (~-16 dBFS) + soft peak limiting (-1 dBFS)
 * - Raised-cosine 10 ms boundary fades + 250 ms inter-segment silence padding
 * - Odd/misaligned stream chunk handling & bit-for-bit parity between single-read and two-pass streaming
 * - Reader cancellation on AbortSignal & clean R2 multipart abort on mid-stream error
 * - R2 Multipart Upload (>= 5 MiB non-final part invariant) vs < 8 MiB single-PUT fast path
 * - 100% backward compatibility serving existing `audio/wav` episodes alongside new `audio/mpeg` episodes
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { toFeedEpisodes } from "../src/feed/adapter.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { collect, streamOf } from "../src/storage/mod.ts";
import {
  assembleMp3ToBlobStore,
  boundaryFadeMultiplier,
  computeAssembledMp3DurationSeconds,
  computeStreamingMp3RevisionHash,
  DEFAULT_MP3_BITRATE_KBPS,
  DEFAULT_PEAK_CEILING_DBFS,
  DEFAULT_SEGMENT_GAP_MS,
  DEFAULT_TARGET_RMS_DBFS,
  encodeWavBytesToMp3,
  inspectMp3Stream,
  linearToDbfs,
  processMonoPcm16,
  softLimitSample,
} from "../src/storage/mp3_assembly.ts";
import {
  R2BlobStore,
  type R2BucketLike,
  type R2MultipartUploadLike,
  type R2ObjectBodyLike,
  type R2ObjectLike,
  type R2UploadedPartLike,
} from "../src/storage/r2.ts";
import {
  inspectStoredWavSegment,
  R2_MIN_MULTIPART_PART_BYTES,
} from "../src/storage/wav_assembly.ts";
import { pcmToWav } from "../src/tts/gemini.ts";
import { parseBackfillArgs, summarizeBackfillCandidates } from "../scripts/backfill-mp3.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";

/** Synthesize a deterministic speech-like harmonic mono 16-bit PCM signal as little-endian bytes. */
function makeTonePcmBytes(opts: {
  durationSeconds: number;
  sampleRate?: number;
  amplitude?: number;
  freqHz?: number;
  channels?: 1 | 2;
}): Uint8Array {
  const sampleRate = opts.sampleRate ?? 24_000;
  const amplitude = opts.amplitude ?? 0.3;
  const freqHz = opts.freqHz ?? 240;
  const channels = opts.channels ?? 1;
  const frames = Math.round(sampleRate * opts.durationSeconds);
  const out = new Uint8Array(frames * channels * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const raw = amplitude * (
      0.7 * Math.sin(2 * Math.PI * freqHz * t) +
      0.3 * Math.sin(2 * Math.PI * freqHz * 2.02 * t)
    );
    const s = Math.max(-32768, Math.min(32767, Math.round(raw * 32767)));
    if (channels === 1) {
      view.setInt16(i * 2, s, true);
    } else {
      view.setInt16(i * 4, s, true);
      view.setInt16(i * 4 + 2, s, true);
    }
  }
  return out;
}

function makeInt16Sine(durationSeconds: number, rmsDbfs: number, sampleRate = 24_000): Int16Array {
  // Sine wave peak = RMS * sqrt(2)
  const peak = Math.pow(10, rmsDbfs / 20) * Math.SQRT2;
  const count = Math.round(durationSeconds * sampleRate);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const v = peak * Math.sin((2 * Math.PI * 300 * i) / sampleRate);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

function measureRmsDbfs(samples: Int16Array, start = 0, end = samples.length): number {
  let sumSq = 0;
  let n = 0;
  for (let i = start; i < end; i++) {
    const x = samples[i]! / 32768;
    sumSq += x * x;
    n++;
  }
  return linearToDbfs(n > 0 ? Math.sqrt(sumSq / n) : 0);
}

interface MockR2Stats {
  puts: string[];
  multipartCreated: string[];
  multipartAborted: string[];
  uploadedPartSizes: number[];
  getCountByKey: Map<string, number>;
  cancelledStreams: number;
}

function createMockMultipartR2Bucket(opts: { chunkPattern?: number[] } = {}): {
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
    getCountByKey: new Map(),
    cancelledStreams: 0,
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

  const makeStream = (slice: Uint8Array): ReadableStream<Uint8Array> => {
    const pattern = opts.chunkPattern;
    if (!pattern || pattern.length === 0) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (slice.byteLength > 0) controller.enqueue(slice);
          controller.close();
        },
        cancel() {
          stats.cancelledStreams++;
        },
      });
    }
    let off = 0;
    let step = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (off >= slice.byteLength) {
          controller.close();
          return;
        }
        const sz = pattern[step++ % pattern.length]!;
        const end = Math.min(slice.byteLength, off + sz);
        controller.enqueue(slice.subarray(off, end));
        off = end;
      },
      cancel() {
        stats.cancelledStreams++;
      },
    });
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
          // Enforce R2/S3 strict >= 5 MiB rule for all non-final parts.
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
      stats.getCountByKey.set(key, (stats.getCountByKey.get(key) ?? 0) + 1);
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
        body: makeStream(slice),
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

Deno.test("MP3 assembly: encodes valid 64 kbps mono 24 kHz MPEG-2 Layer III with ~6x compression vs WAV", async () => {
  const blobs = new MemoryBlobStore();
  // 3 x 20s segments = 60s speech (~2.88 MB WAV)
  const segs = [];
  for (let i = 0; i < 3; i++) {
    const pcm = makeTonePcmBytes({
      durationSeconds: 20,
      amplitude: i === 0 ? 0.08 : i === 1 ? 0.35 : 0.2,
      freqHz: 220 + i * 70,
    });
    const key = `audio-segments/u1/ep1/s${i}.wav`;
    await blobs.put(key, pcmToWav(pcm), { contentType: "audio/wav" });
    const meta = await inspectStoredWavSegment(blobs, key);
    assert(meta);
    segs.push(meta);
  }

  const destKey = "audio/u1/direct/ep1.mp3";
  const result = await assembleMp3ToBlobStore({
    blobs,
    destinationKey: destKey,
    segments: segs,
  });

  assertEquals(result.stored.contentType, "audio/mpeg");
  assertEquals(result.partsUploaded, 1);
  assertEquals(result.segmentGapSeconds, 0.25);
  assertEquals(result.durationSeconds, 60.5);
  assertEquals(result.sourceWavBytes, 44 + 3 * 20 * 24_000 * 2);

  const storedObj = await blobs.get(destKey);
  assert(storedObj);
  assertEquals(storedObj.contentType, "audio/mpeg");
  const mp3Bytes = await collect(storedObj.body);
  assertEquals(mp3Bytes.byteLength, result.byteLength);

  // Verify real MPEG-2 Layer III frame sync, headers, and zero trailing garbage.
  assertEquals(mp3Bytes[0], 0xff);
  assertEquals((mp3Bytes[1]! & 0xe0), 0xe0);
  const inspected = inspectMp3Stream(mp3Bytes);
  assertEquals(inspected.valid, true, "every byte must belong to a valid MPEG frame");
  assertEquals(inspected.trailingBytes, 0);
  assertEquals(inspected.mpegVersion, "2");
  assertEquals(inspected.layer, 3);
  assertEquals(inspected.bitrateKbps, DEFAULT_MP3_BITRATE_KBPS);
  assertEquals(inspected.sampleRate, 24_000);
  assertEquals(inspected.channels, 1);
  assert(inspected.frameCount >= 2500, `expected >= 2500 frames, got ${inspected.frameCount}`);
  assert(
    Math.abs(inspected.durationSeconds - result.durationSeconds) < 0.1,
    `decoded duration ${inspected.durationSeconds}s should closely match ${result.durationSeconds}s`,
  );

  // 64 kbps CBR vs 384 kbps WAV (with 0.5s added padding) -> ~5.95x compression!
  const ratio = result.sourceWavBytes / result.byteLength;
  assert(ratio >= 5.9, `expected ~6x compression at 64 kbps, got ${ratio.toFixed(2)}x`);

  // Also verify 48 kbps yields ~8x compression on the same 60s episode.
  const result48 = await assembleMp3ToBlobStore({
    blobs,
    destinationKey: "audio/u1/direct/ep1-48k.mp3",
    segments: segs,
    bitrateKbps: 48,
  });
  const ratio48 = result48.sourceWavBytes / result48.byteLength;
  assert(ratio48 >= 7.85, `expected ~8x compression at 48 kbps, got ${ratio48.toFixed(2)}x`);
  const inspected48 = inspectMp3Stream(await collect((await blobs.get("audio/u1/direct/ep1-48k.mp3"))!.body));
  assertEquals(inspected48.valid, true);
  assertEquals(inspected48.bitrateKbps, 48);
});

Deno.test("Audio craft: RMS loudness normalization targets -16 dBFS, soft limiter caps peaks at -1 dBFS, and silence is untouched", () => {
  const sr = 24_000;
  // Quiet (-30 dBFS) vs Hot (-6 dBFS) segments (24 dB mismatch!)
  const quiet = makeInt16Sine(1.5, -30, sr);
  const hot = makeInt16Sine(1.5, -6, sr);

  const normQuiet = processMonoPcm16(quiet, sr);
  const normHot = processMonoPcm16(hot, sr);

  // Measure middle steady-state region (excluding 10ms fades)
  const quietOutDb = measureRmsDbfs(normQuiet.processed, 500, quiet.length - 500);
  const hotOutDb = measureRmsDbfs(normHot.processed, 500, hot.length - 500);

  assert(
    Math.abs(quietOutDb - DEFAULT_TARGET_RMS_DBFS) < 0.5,
    `quiet segment should normalize near -16 dBFS, got ${quietOutDb.toFixed(2)} dBFS`,
  );
  assert(
    Math.abs(hotOutDb - DEFAULT_TARGET_RMS_DBFS) < 0.5,
    `hot segment should normalize near -16 dBFS, got ${hotOutDb.toFixed(2)} dBFS`,
  );
  assert(
    Math.abs(quietOutDb - hotOutDb) < 0.5,
    `normalized segments must match loudness within 0.5 dB, delta=${Math.abs(quietOutDb - hotOutDb).toFixed(2)} dB`,
  );

  // Spiky plosive test: quiet -26 dBFS voice with a huge full-scale transient spike.
  const spiky = makeInt16Sine(1.0, -26, sr);
  for (let i = 4000; i < 4040; i++) {
    spiky[i] = i % 2 === 0 ? 32767 : -32767;
  }
  const normSpiky = processMonoPcm16(spiky, sr);
  const ceilingInt16 = Math.ceil(Math.pow(10, DEFAULT_PEAK_CEILING_DBFS / 20) * 32767);
  let maxAbs = 0;
  for (let i = 0; i < normSpiky.processed.length; i++) {
    const a = Math.abs(normSpiky.processed[i]!);
    if (a > maxAbs) maxAbs = a;
  }
  assert(
    maxAbs <= ceilingInt16,
    `soft limiter must cap peaks <= -1 dBFS (${ceilingInt16}), got ${maxAbs}`,
  );
  assert(Math.abs(softLimitSample(10.0, 0.89125)) <= 0.891251);
  assert(Math.abs(softLimitSample(-10.0, 0.89125)) <= 0.891251);

  // Silence-gated RMS: 1s silence + 1s of -26 dBFS tone must normalize active speech to -16 dBFS (not -13 dBFS!)
  const gatedInput = new Int16Array(sr * 2);
  const activeTone = makeInt16Sine(1.0, -26, sr);
  gatedInput.set(activeTone, sr);
  const normGated = processMonoPcm16(gatedInput, sr);
  const activeRegionDb = measureRmsDbfs(normGated.processed, sr + 500, sr * 2 - 500);
  assert(
    Math.abs(activeRegionDb - DEFAULT_TARGET_RMS_DBFS) < 0.5,
    `silence-gated active region should hit -16 dBFS, got ${activeRegionDb.toFixed(2)} dBFS`,
  );

  // Digital silence stays silent with unity gain.
  const silence = new Int16Array(sr);
  const normSilence = processMonoPcm16(silence, sr);
  assertEquals(normSilence.loudness.gain, 1);
  assertEquals(normSilence.processed.every((v) => v === 0), true);
});

Deno.test("Audio craft: 10 ms boundary fades prevent boundary clicks and 250 ms inter-segment padding adds exact gap duration", async () => {
  const sr = 24_000;
  // Constant DC-offset-like non-zero signal to verify exact 0 at boundaries.
  const block = new Int16Array(sr).fill(12_000);
  const { processed } = processMonoPcm16(block, sr, { fadeMs: 10 });
  assertEquals(processed[0], 0, "first sample must fade from exact 0");
  assertEquals(processed[processed.length - 1], 0, "last sample must fade to exact 0");
  assert(Math.abs(processed[120]!) > 0 && Math.abs(processed[120]!) < Math.abs(processed[240]!));
  assertEquals(boundaryFadeMultiplier(0, 1000, 240), 0);
  assertEquals(boundaryFadeMultiplier(999, 1000, 240), 0);
  assertEquals(boundaryFadeMultiplier(500, 1000, 240), 1);

  // Verify 3 x 1.0s segments with default 250ms padding vs 0ms padding.
  const blobs = new MemoryBlobStore();
  const metas = [];
  for (let i = 0; i < 3; i++) {
    const key = `audio-segments/u1/gap/s${i}.wav`;
    await blobs.put(key, pcmToWav(makeTonePcmBytes({ durationSeconds: 1.0, freqHz: 260 + i * 40 })), {
      contentType: "audio/wav",
    });
    const meta = await inspectStoredWavSegment(blobs, key);
    assert(meta);
    metas.push(meta);
  }

  const withGap = await assembleMp3ToBlobStore({
    blobs,
    destinationKey: "audio/u1/direct/with-gap.mp3",
    segments: metas,
    segmentGapMs: DEFAULT_SEGMENT_GAP_MS,
  });
  const noGap = await assembleMp3ToBlobStore({
    blobs,
    destinationKey: "audio/u1/direct/no-gap.mp3",
    segments: metas,
    segmentGapMs: 0,
  });

  assertEquals(withGap.durationSeconds, 3.5);
  assertEquals(noGap.durationSeconds, 3.0);
  assertEquals(computeAssembledMp3DurationSeconds(metas, 250), 3.5);

  const inspWithGap = inspectMp3Stream(await collect((await blobs.get("audio/u1/direct/with-gap.mp3"))!.body));
  const inspNoGap = inspectMp3Stream(await collect((await blobs.get("audio/u1/direct/no-gap.mp3"))!.body));
  const deltaDuration = inspWithGap.durationSeconds - inspNoGap.durationSeconds;
  assert(
    Math.abs(deltaDuration - 0.5) < 0.05,
    `2 x 250ms inter-segment gaps should add ~0.50s to MP3 stream, got ${deltaDuration.toFixed(3)}s`,
  );
});

Deno.test("MP3 assembly: odd chunk alignment & two-pass streaming match single-read output byte-for-byte", async () => {
  const alignedMock = createMockMultipartR2Bucket();
  const oddChunkMock = createMockMultipartR2Bucket({ chunkPattern: [1, 3, 7, 13, 5, 19, 1021] });
  const alignedBlobs = new R2BlobStore(alignedMock.bucket);
  const oddBlobs = new R2BlobStore(oddChunkMock.bucket);

  const segKeys = ["audio-segments/u1/parity/s0.wav", "audio-segments/u1/parity/s1.wav"];
  const alignedMetas = [];
  const oddMetas = [];

  for (let i = 0; i < segKeys.length; i++) {
    const wav = pcmToWav(makeTonePcmBytes({ durationSeconds: 1.2, freqHz: 300 + i * 110 }));
    await alignedBlobs.put(segKeys[i]!, wav, { contentType: "audio/wav" });
    await oddBlobs.put(segKeys[i]!, wav, { contentType: "audio/wav" });
    alignedMetas.push((await inspectStoredWavSegment(alignedBlobs, segKeys[i]!))!);
    oddMetas.push((await inspectStoredWavSegment(oddBlobs, segKeys[i]!))!);
  }

  // Single-read fast path (default 4 MiB cap -> 1 R2 read per segment after header inspect)
  await assembleMp3ToBlobStore({
    blobs: alignedBlobs,
    destinationKey: "audio/u1/direct/parity.mp3",
    segments: alignedMetas,
  });
  // Forced two-pass streaming path with odd 1/3/7-byte chunk boundaries!
  await assembleMp3ToBlobStore({
    blobs: oddBlobs,
    destinationKey: "audio/u1/direct/parity.mp3",
    segments: oddMetas,
    singleReadSegmentCapBytes: 1,
  });

  const singleBytes = alignedMock.objects.get("audio/u1/direct/parity.mp3")!.bytes;
  const twoPassBytes = oddChunkMock.objects.get("audio/u1/direct/parity.mp3")!.bytes;
  assertEquals(twoPassBytes, singleBytes, "two-pass odd-chunk streaming must be byte-identical to single-read");
  // Header inspect = 1 read; single-read adds 1 get (= 2), two-pass adds 2 gets (= 3).
  assertEquals(alignedMock.stats.getCountByKey.get(segKeys[0]!), 2);
  assertEquals(oddChunkMock.stats.getCountByKey.get(segKeys[0]!), 3);
});

Deno.test("MP3 assembly: R2 Multipart Upload enforces >= 5 MiB non-final parts and aborts cleanly on mid-stream error", async () => {
  const { bucket, objects, stats } = createMockMultipartR2Bucket();
  const blobs = new R2BlobStore(bucket);

  // Two 135s segments (270s total) @ 160 kbps -> ~5.4 MiB MP3 (> 5 MiB part size -> 2 multipart parts)
  // Each segment is 6.48 MB PCM (> 4 MiB cap), exercising two-pass streaming + multipart together!
  const pcm135s = makeTonePcmBytes({ durationSeconds: 135, freqHz: 220, amplitude: 0.22 });
  const wav = pcmToWav(pcm135s);
  await blobs.put("audio-segments/u1/mpu/s0.wav", wav, { contentType: "audio/wav" });
  await blobs.put("audio-segments/u1/mpu/s1.wav", wav, { contentType: "audio/wav" });
  const meta0 = (await inspectStoredWavSegment(blobs, "audio-segments/u1/mpu/s0.wav"))!;
  const meta1 = (await inspectStoredWavSegment(blobs, "audio-segments/u1/mpu/s1.wav"))!;

  const destKey = "audio/u1/direct/ep-multipart.mp3";
  const result = await assembleMp3ToBlobStore({
    blobs,
    destinationKey: destKey,
    segments: [meta0, meta1],
    bitrateKbps: 160,
    partSizeBytes: R2_MIN_MULTIPART_PART_BYTES,
  });

  assertEquals(stats.multipartCreated, [destKey], "must promote to R2 multipart when >= partSizeBytes");
  assertEquals(stats.multipartAborted.length, 0);
  assertEquals(result.partsUploaded, 2);
  assertEquals(stats.uploadedPartSizes[0], R2_MIN_MULTIPART_PART_BYTES, "Part 1 must be exact 5 MiB");
  assert(result.byteLength > R2_MIN_MULTIPART_PART_BYTES);

  const stored = objects.get(destKey)!;
  assertEquals(stored.contentType, "audio/mpeg");
  const inspected = inspectMp3Stream(stored.bytes);
  assertEquals(inspected.valid, true);
  assertEquals(inspected.bitrateKbps, 160);
  assertEquals(inspected.sampleRate, 24_000);
  assertEquals(inspected.channels, 1);

  // Mid-stream failure after Part 1 has already been uploaded -> must call upload.abort()!
  const missingMeta = { ...meta1, audioKey: "audio-segments/u1/mpu/missing.wav" };
  const abortDest = "audio/u1/direct/ep-abort.mp3";
  await assertRejects(
    () =>
      assembleMp3ToBlobStore({
        blobs,
        destinationKey: abortDest,
        segments: [meta0, meta1, missingMeta],
        bitrateKbps: 160,
        partSizeBytes: R2_MIN_MULTIPART_PART_BYTES,
      }),
    Error,
    "Missing synthesis segment blob",
  );
  assertEquals(
    stats.multipartAborted,
    [abortDest],
    "failed multipart MP3 upload must abort cleanly to prevent orphaned R2 parts",
  );
});

Deno.test("MP3 assembly: cancels reader on AbortSignal mid-stream", async () => {
  const { bucket, stats } = createMockMultipartR2Bucket({ chunkPattern: [4096] });
  const blobs = new R2BlobStore(bucket);
  const wav = pcmToWav(makeTonePcmBytes({ durationSeconds: 2.0 }));
  await blobs.put("audio-segments/u1/abort/s0.wav", wav, { contentType: "audio/wav" });
  const meta = (await inspectStoredWavSegment(blobs, "audio-segments/u1/abort/s0.wav"))!;

  const controller = new AbortController();
  controller.abort(new DOMException("Cancelled by test", "AbortError"));
  await assertRejects(
    () =>
      assembleMp3ToBlobStore({
        blobs,
        destinationKey: "audio/u1/direct/cancelled.mp3",
        segments: [meta],
        signal: controller.signal,
      }),
    DOMException,
  );
  assertEquals(stats.puts.includes("audio/u1/direct/cancelled.mp3"), false);
});

Deno.test("Backward compatibility: audio route & RSS feed adapter serve existing audio/wav episodes alongside new audio/mpeg episodes", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  const user = makeUser({ id: "u-compat", status: "approved", feedToken: "tok-compat-123" });
  await metadata.putUser(user);

  const wavBytes = pcmToWav(makeTonePcmBytes({ durationSeconds: 1.0 }));
  const { mp3: mp3Bytes, durationSeconds: mp3Dur } = encodeWavBytesToMp3(wavBytes);

  const wavKey = "audio/u-compat/direct/ep-old.wav";
  const mp3Key = "audio/u-compat/direct/ep-new-sha256-abc.mp3";
  await blobs.put(wavKey, wavBytes, { contentType: "audio/wav" });
  await blobs.put(mp3Key, mp3Bytes, { contentType: "audio/mpeg" });

  const oldEp = makeEpisode({
    id: "ep-old",
    userId: "u-compat",
    sourceId: "inbox",
    articleId: "a-old",
    status: "ready",
    mode: "direct",
    audioKey: wavKey,
    contentType: "audio/wav",
    byteLength: wavBytes.byteLength,
    durationSeconds: 1.0,
  });
  const newEp = makeEpisode({
    id: "ep-new",
    userId: "u-compat",
    sourceId: "inbox",
    articleId: "a-new",
    status: "ready",
    mode: "direct",
    audioKey: mp3Key,
    contentType: "audio/mpeg",
    byteLength: mp3Bytes.byteLength,
    durationSeconds: mp3Dur,
  });
  await metadata.putEpisode(oldEp);
  await metadata.putEpisode(newEp);

  // Feed projection preserves both formats cleanly.
  const projected = toFeedEpisodes([oldEp, newEp], {
    publicBaseUrl: "https://audio.example.com",
    feedToken: user.feedToken,
  });
  assertEquals(projected.length, 2);
  assertEquals(projected[0]!.mimeType, "audio/wav");
  assertEquals(projected[0]!.audioUrl, "https://audio.example.com/audio/u-compat/direct/ep-old.wav");
  assertEquals(projected[1]!.mimeType, "audio/mpeg");
  assertEquals(
    projected[1]!.audioUrl,
    "https://audio.example.com/audio/u-compat/direct/ep-new-sha256-abc.mp3",
  );

  // HTTP /audio route serves HEAD, full GET, and Range 206 for both WAV and MP3!
  const ctx = {
    config: { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "secret" },
    stores: { metadata, blobs, describe: "memory" },
  };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const wavHead = await fetch(new Request(projected[0]!.audioUrl, { method: "HEAD" }));
  assertEquals(wavHead.status, 200);
  assertEquals(wavHead.headers.get("content-type"), "audio/wav");
  assertEquals(wavHead.headers.get("content-length"), String(wavBytes.byteLength));

  const wavRange = await fetch(
    new Request(projected[0]!.audioUrl, { headers: { range: "bytes=0-11" } }),
  );
  assertEquals(wavRange.status, 206);
  assertEquals(wavRange.headers.get("content-type"), "audio/wav");
  const wavPrefix = new Uint8Array(await wavRange.arrayBuffer());
  assertEquals(new TextDecoder().decode(wavPrefix.subarray(0, 4)), "RIFF");

  const mp3Head = await fetch(new Request(projected[1]!.audioUrl, { method: "HEAD" }));
  assertEquals(mp3Head.status, 200);
  assertEquals(mp3Head.headers.get("content-type"), "audio/mpeg");
  assertEquals(mp3Head.headers.get("content-length"), String(mp3Bytes.byteLength));

  const mp3Get = await fetch(new Request(projected[1]!.audioUrl));
  assertEquals(mp3Get.status, 200);
  assertEquals(mp3Get.headers.get("content-type"), "audio/mpeg");
  const gotMp3 = new Uint8Array(await mp3Get.arrayBuffer());
  assertEquals(inspectMp3Stream(gotMp3).valid, true);
});

Deno.test("MP3 assembly: stereo WAV downmixes cleanly, revision hashes are deterministic, and backfill CLI defaults to dry-run", async () => {
  const stereoWav = pcmToWav(
    makeTonePcmBytes({ durationSeconds: 1.0, channels: 2, amplitude: 0.25 }),
    { sampleRate: 24_000, numChannels: 2, bitsPerSample: 16 },
  );
  const { mp3, durationSeconds } = encodeWavBytesToMp3(stereoWav);
  assertEquals(durationSeconds, 1.0);
  const inspected = inspectMp3Stream(mp3);
  assertEquals(inspected.valid, true);
  assertEquals(inspected.channels, 1);
  assertEquals(inspected.bitrateKbps, 64);

  const blobs = new MemoryBlobStore();
  await blobs.put("audio-segments/u1/h/s0.wav", pcmToWav(makeTonePcmBytes({ durationSeconds: 0.5 })), {
    contentType: "audio/wav",
  });
  const seg = (await inspectStoredWavSegment(blobs, "audio-segments/u1/h/s0.wav"))!;
  const h1 = await computeStreamingMp3RevisionHash([seg]);
  const h2 = await computeStreamingMp3RevisionHash([seg]);
  const hDiffBitrate = await computeStreamingMp3RevisionHash([seg], undefined, { bitrateKbps: 48 });
  assertEquals(h1, h2);
  assert(h1 !== hDiffBitrate, "changing encoding bitrate must produce a distinct immutable key hash");

  // Backfill CLI defaults to safe dry-run
  const cliDefaults = parseBackfillArgs(["--remote"]);
  assertEquals(cliDefaults.target, "remote");
  assertEquals(cliDefaults.apply, false);
  assertEquals(cliDefaults.deleteOldWav, false);
  const summary = summarizeBackfillCandidates([
    {
      userId: "u1",
      id: "ep1",
      version: 1,
      episode: makeEpisode({ id: "ep1", byteLength: 18_000_000 }),
    },
  ]);
  assertEquals(summary.count, 1);
  assertEquals(summary.totalWavBytes, 18_000_000);
  assertEquals(summary.estimatedMp3Bytes, 3_000_000);
  assertEquals(summary.estimatedSavingsBytes, 15_000_000);
});
