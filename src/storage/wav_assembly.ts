/**
 * Streaming WAV assembly into R2 Multipart Upload (~16 MB constant peak RAM).
 *
 * Eliminates full-WAV double-buffering (which OOMs Cloudflare Workers' 128 MB
 * isolate RAM limit on episodes > ~45 MB). Each finalized TTS segment stays in
 * R2 while only ~200 bytes of metadata (`StoredWavSegment`) live in memory.
 * At assembly time, a single reusable 8 MiB part buffer streams the 44-byte
 * RIFF/WAVE header followed by each segment's PCM byte range directly into
 * `blobs.createMultipartUpload(...)` -> `uploadPart(...)` -> `complete(...)`.
 */

import type { BlobInfo, BlobMultipartPart, BlobStore } from "./mod.ts";
import { collect } from "./mod.ts";
import {
  GeminiTtsError,
  MAX_PUBLICATION_PCM_BYTES,
  parseWavHeader,
  writeWavHeader,
} from "../tts/gemini.ts";

/** R2 / S3 minimum part size for every non-final part (5 MiB). */
export const R2_MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
/** Default streaming part buffer size (8 MiB -> ~16 MB peak RAM with R2 stream chunks). */
export const DEFAULT_MULTIPART_PART_BYTES = 8 * 1024 * 1024;
/** Header probe size for reading RIFF/WAVE fmt + data chunk offsets without fetching full blobs. */
const WAV_HEADER_PROBE_BYTES = 256;

export interface StoredWavSegment {
  audioKey: string;
  pcmOffset: number;
  pcmByteLength: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number;
  byteLength: number;
}

/**
 * Inspect a stored WAV segment in `blobs` using a small Range read (256 bytes)
 * instead of loading the entire multi-MB segment into isolate RAM.
 */
export async function inspectStoredWavSegment(
  blobs: BlobStore,
  audioKey: string,
  expectedByteLength?: number,
): Promise<StoredWavSegment | null> {
  const head = await blobs.head(audioKey).catch(() => null);
  if (!head || head.size < 44) return null;
  if (expectedByteLength !== undefined && head.size !== expectedByteLength) return null;

  const probeEnd = Math.min(head.size - 1, WAV_HEADER_PROBE_BYTES - 1);
  const probeObj = await blobs.get(audioKey, { range: { start: 0, end: probeEnd } }).catch(
    () => null,
  );
  if (!probeObj) return null;
  const headerBytes = await collect(probeObj.body);
  if (headerBytes.byteLength < 44) return null;

  let info: ReturnType<typeof parseWavHeader>;
  try {
    info = parseWavHeader(headerBytes);
  } catch {
    return null;
  }

  const pcmByteLength = info.declaredDataLength;
  if (
    info.audioFormat !== 1 ||
    pcmByteLength <= 0 ||
    info.blockAlign <= 0 ||
    pcmByteLength % info.blockAlign !== 0 ||
    info.dataOffset + pcmByteLength > head.size
  ) {
    return null;
  }

  const bytesPerSec = info.byteRate > 0
    ? info.byteRate
    : (info.sampleRate * info.channels * info.bitsPerSample) / 8;
  const durationSeconds = bytesPerSec > 0 ? pcmByteLength / bytesPerSec : 0;

  return {
    audioKey,
    pcmOffset: info.dataOffset,
    pcmByteLength,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitsPerSample: info.bitsPerSample,
    durationSeconds,
    byteLength: head.size,
  };
}

/**
 * Compute a deterministic content revision hash from ordered segment metadata
 * without reading or hashing the full multi-megabyte WAV in memory.
 */
export async function computeStreamingWavRevisionHash(
  segments: readonly StoredWavSegment[],
  previousAudioKey?: string,
): Promise<string> {
  const descriptor = [
    previousAudioKey ?? "",
    ...segments.map((s) =>
      `${s.audioKey}:${s.pcmOffset}:${s.pcmByteLength}:${s.sampleRate}:${s.channels}:${s.bitsPerSample}`
    ),
  ].join("|");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(descriptor)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AssembleWavOptions {
  blobs: BlobStore;
  destinationKey: string;
  segments: readonly StoredWavSegment[];
  /** Part size in bytes (default 8 MiB; must be >= 5 MiB when using R2 multipart). */
  partSizeBytes?: number;
  signal?: AbortSignal;
}

export interface AssembleWavResult {
  stored: BlobInfo;
  byteLength: number;
  durationSeconds: number;
  partsUploaded: number;
}

/**
 * Stream-stitch `segments` into a single valid RIFF/WAVE object at `destinationKey`.
 *
 * - If total WAV size < `partSizeBytes` (default 8 MiB) or `blobs.createMultipartUpload` is
 *   unavailable, writes via single `blobs.put(...)`.
 * - If total WAV size >= `partSizeBytes` and `blobs.createMultipartUpload` is available,
 *   streams through a single reusable `partSizeBytes` buffer into multipart parts
 *   (every non-final part is guaranteed >= 5 MiB), aborting cleanly on any error.
 */
export async function assembleWavToBlobStore(
  options: AssembleWavOptions,
): Promise<AssembleWavResult> {
  const { blobs, destinationKey, segments, signal } = options;
  if (segments.length === 0) {
    throw new GeminiTtsError("Cannot assemble WAV from zero segments", 400);
  }

  const first = segments[0]!;
  let totalPcmBytes = 0;
  for (const seg of segments) {
    if (
      seg.sampleRate !== first.sampleRate ||
      seg.channels !== first.channels ||
      seg.bitsPerSample !== first.bitsPerSample ||
      seg.pcmByteLength <= 0
    ) {
      throw new GeminiTtsError("TTS segments returned incompatible or incomplete audio");
    }
    totalPcmBytes += seg.pcmByteLength;
  }

  if (totalPcmBytes > MAX_PUBLICATION_PCM_BYTES) {
    throw new GeminiTtsError("Episode exceeds the RIFF WAV publication limit", 400);
  }

  const totalWavBytes = 44 + totalPcmBytes;
  const bytesPerSec = (first.sampleRate * first.channels * first.bitsPerSample) / 8;
  const durationSeconds = bytesPerSec > 0 ? totalPcmBytes / bytesPerSec : 0;

  const partSizeBytes = Math.max(
    R2_MIN_MULTIPART_PART_BYTES,
    options.partSizeBytes ?? DEFAULT_MULTIPART_PART_BYTES,
  );

  const header = new Uint8Array(44);
  writeWavHeader(header, totalPcmBytes, {
    sampleRate: first.sampleRate,
    numChannels: first.channels,
    bitsPerSample: first.bitsPerSample,
  });

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  // Fast path: single-part PUT when total payload fits in one part (< 8 MiB) or store has no multipart.
  if (totalWavBytes < partSizeBytes || !blobs.createMultipartUpload) {
    const out = new Uint8Array(totalWavBytes);
    out.set(header, 0);
    let offset = 44;
    for (const seg of segments) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const obj = await blobs.get(seg.audioKey, {
        range: { start: seg.pcmOffset, end: seg.pcmOffset + seg.pcmByteLength - 1 },
      });
      if (!obj) {
        throw new Error(`Missing synthesis segment blob during WAV assembly: ${seg.audioKey}`);
      }
      const reader = obj.body.getReader();
      let segRead = 0;
      let streamDone = false;
      try {
        while (true) {
          if (signal?.aborted) {
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
          }
          const { done, value } = await reader.read();
          if (done) {
            streamDone = true;
            break;
          }
          if (!value || value.byteLength === 0) continue;
          const remainingForSeg = seg.pcmByteLength - segRead;
          const toCopy = Math.min(value.byteLength, remainingForSeg);
          out.set(value.subarray(0, toCopy), offset);
          offset += toCopy;
          segRead += toCopy;
          if (segRead >= seg.pcmByteLength) break;
        }
      } finally {
        if (!streamDone) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (segRead !== seg.pcmByteLength) {
        throw new Error(
          `Short read on segment ${seg.audioKey}: expected ${seg.pcmByteLength} PCM bytes, got ${segRead}`,
        );
      }
    }
    const stored = await blobs.put(destinationKey, out, {
      contentType: "audio/wav",
      signal,
    });
    return {
      stored,
      byteLength: stored.size ?? totalWavBytes,
      durationSeconds,
      partsUploaded: 1,
    };
  }

  // Streaming R2 Multipart Upload path (~16 MB constant RAM).
  const upload = await blobs.createMultipartUpload(destinationKey, {
    contentType: "audio/wav",
    signal,
  });

  const partBuffer = new Uint8Array(partSizeBytes);
  let buffered = 0;
  let partNumber = 1;
  const uploadedParts: BlobMultipartPart[] = [];

  const flushPart = async (count: number) => {
    if (count <= 0) return;
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const uploaded = await upload.uploadPart(partNumber++, partBuffer.subarray(0, count));
    uploadedParts.push(uploaded);
    buffered = 0;
  };

  const appendBytes = async (chunk: Uint8Array) => {
    let srcOffset = 0;
    while (srcOffset < chunk.byteLength) {
      const space = partSizeBytes - buffered;
      const take = Math.min(space, chunk.byteLength - srcOffset);
      partBuffer.set(chunk.subarray(srcOffset, srcOffset + take), buffered);
      buffered += take;
      srcOffset += take;
      if (buffered === partSizeBytes) {
        await flushPart(buffered);
      }
    }
  };

  try {
    await appendBytes(header);

    for (const seg of segments) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const obj = await blobs.get(seg.audioKey, {
        range: { start: seg.pcmOffset, end: seg.pcmOffset + seg.pcmByteLength - 1 },
      });
      if (!obj) {
        throw new Error(`Missing synthesis segment blob during WAV assembly: ${seg.audioKey}`);
      }
      const reader = obj.body.getReader();
      let segRead = 0;
      let streamDone = false;
      try {
        while (true) {
          if (signal?.aborted) {
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
          }
          const { done, value } = await reader.read();
          if (done) {
            streamDone = true;
            break;
          }
          if (!value || value.byteLength === 0) continue;
          const remainingForSeg = seg.pcmByteLength - segRead;
          const toCopy = Math.min(value.byteLength, remainingForSeg);
          await appendBytes(value.subarray(0, toCopy));
          segRead += toCopy;
          if (segRead >= seg.pcmByteLength) break;
        }
      } finally {
        if (!streamDone) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (segRead !== seg.pcmByteLength) {
        throw new Error(
          `Short read on segment ${seg.audioKey}: expected ${seg.pcmByteLength} PCM bytes, got ${segRead}`,
        );
      }
    }

    if (buffered > 0) {
      await flushPart(buffered);
    }

    const stored = await upload.complete(uploadedParts);
    return {
      stored,
      byteLength: stored.size ?? totalWavBytes,
      durationSeconds,
      partsUploaded: uploadedParts.length,
    };
  } catch (error) {
    await upload.abort().catch(() => {});
    throw error;
  }
}
