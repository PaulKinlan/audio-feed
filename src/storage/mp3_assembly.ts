/**
 * Streaming MP3 assembly with broadcast audio craft and R2 Multipart Upload.
 *
 * Replaces raw 24 kHz 16-bit mono WAV (~384 kbps, 17–90 MB/episode) with
 * standards-compliant MPEG-2 Layer III MP3 (`audio/mpeg`, 64 kbps mono @ 24 kHz,
 * ~6x smaller) while keeping peak isolate RAM bounded well below Cloudflare
 * Workers' 128 MB ceiling:
 *
 *   - Stream-reads finalized WAV segments (`StoredWavSegment`) from R2.
 *   - Segments <= 4 MiB (~87s of 24 kHz mono PCM) are read once into a transient
 *     buffer for loudness analysis + encoding (~12 MiB peak RAM with the 8 MiB
 *     output buffer); larger segments automatically use two-pass R2 streaming
 *     (~10 MiB peak RAM even for multi-hour audio).
 *   - Applies podcast audio craft per segment:
 *       * Silence-gated RMS loudness normalization targeting -16 dBFS (clamped to
 *         [-18 dB, +18 dB] so near-silence is never boosted).
 *       * C1-smooth soft-knee peak limiting asymptotically capped at -1 dBFS so
 *         plosive transients never hard-clip.
 *       * 10 ms raised-cosine (Hann) fade-in and fade-out at segment boundaries.
 *       * 250 ms smooth silence padding between consecutive segments.
 *   - Encodes continuously via pure-JS `@breezystack/lamejs` (zero native addons,
 *     zero WASM compilation hazards, compatible with Node 22 and `workerd`).
 *   - Streams encoded MP3 bytes into R2 using single `blobs.put` when < 8 MiB
 *     and lazy-promoted R2 Multipart Upload when >= 8 MiB (guaranteeing every
 *     non-final part >= 5 MiB and aborting cleanly on any error).
 */

import { Mp3Encoder } from "@breezystack/lamejs";
import type { BlobInfo, BlobMultipartPart, BlobMultipartUpload, BlobStore } from "./mod.ts";
import {
  DEFAULT_MULTIPART_PART_BYTES,
  R2_MIN_MULTIPART_PART_BYTES,
  type StoredWavSegment,
} from "./wav_assembly.ts";
import { GeminiTtsError, parseWavHeader } from "../tts/gemini.ts";

/** Default podcast MP3 bitrate (64 kbps mono @ 24 kHz -> ~6x smaller than 384 kbps WAV). */
export const DEFAULT_MP3_BITRATE_KBPS = 64;
/** Target active-speech loudness in dBFS RMS (podcast standard). */
export const DEFAULT_TARGET_RMS_DBFS = -16;
/** Soft-limiter peak ceiling in dBFS (prevents inter-sample & codec clipping). */
export const DEFAULT_PEAK_CEILING_DBFS = -1;
/** Silence padding inserted between consecutive TTS segments in milliseconds. */
export const DEFAULT_SEGMENT_GAP_MS = 250;
/** Silence padding inserted between consecutive TTS segments in seconds. */
export const DEFAULT_SEGMENT_GAP_SECONDS = DEFAULT_SEGMENT_GAP_MS / 1000;
/** Raised-cosine fade-in / fade-out length at segment boundaries in milliseconds. */
export const DEFAULT_BOUNDARY_FADE_MS = 10;
/** Maximum absolute normalization gain adjustment in dB. */
export const DEFAULT_MAX_GAIN_DB = 18;
/** Minimum active RMS below which normalization leaves gain at unity (-55 dBFS). */
const SILENCE_FLOOR_DBFS = -55;
const SILENCE_FLOOR_LINEAR = Math.pow(10, SILENCE_FLOOR_DBFS / 20);
/** Silence gate threshold for 50ms loudness blocks (-50 dBFS). */
const ACTIVE_GATE_MEAN_SQ = Math.pow(10, -50 / 10);
/** Number of mono samples fed per `Mp3Encoder.encodeBuffer` call (2 MPEG-2 frames). */
const MP3_ENCODE_BLOCK_SAMPLES = 1152;
/** Segments up to 4 MiB (~87s @ 24 kHz mono) are read once; larger segments use two-pass streaming. */
export const SINGLE_READ_SEGMENT_CAP_BYTES = 4 * 1024 * 1024;
/** Content-addressing version tag for MP3 assembly parameters. */
export const MP3_ASSEMBLY_VERSION = "mp3-v1";

/** Sample rates supported by MPEG-1 / MPEG-2 / MPEG-2.5 Layer III encoders. */
export const SUPPORTED_MP3_SAMPLE_RATES = new Set([
  8000,
  11025,
  12000,
  16000,
  22050,
  24000,
  32000,
  44100,
  48000,
]);

export interface Mp3CraftOptions {
  /** Output MP3 bitrate in kbps (default 64). */
  bitrateKbps?: number;
  /** Target gated RMS loudness in dBFS (default -16). */
  targetRmsDbfs?: number;
  /** Soft-limiter peak ceiling in dBFS (default -1). */
  peakCeilingDbfs?: number;
  /** Silence padding between consecutive segments in ms (default 250). */
  segmentGapMs?: number;
  /** Boundary fade-in/fade-out duration in ms (default 10). */
  fadeMs?: number;
  /** Max normalization gain/attenuation in dB (default 18). */
  maxGainDb?: number;
}

export interface AssembleMp3Options extends Mp3CraftOptions {
  blobs: BlobStore;
  destinationKey: string;
  segments: readonly StoredWavSegment[];
  /** Part size in bytes (default 8 MiB; floored to >= 5 MiB for R2 multipart compliance). */
  partSizeBytes?: number;
  /** Segment byte threshold below which a single R2 read is used (default 4 MiB). */
  singleReadSegmentCapBytes?: number;
  signal?: AbortSignal;
}

export interface SegmentLoudnessStats {
  sampleCount: number;
  /** Active-block gated RMS (falling back to overall RMS), linear [0..1]. */
  rms: number;
  /** Overall ungated RMS across the entire segment, linear [0..1]. */
  overallRms: number;
  /** Peak absolute sample amplitude, linear [0..1]. */
  peak: number;
  /** Applied linear normalization gain (before soft peak limiting). */
  gain: number;
}

export interface AssembleMp3Result {
  stored: BlobInfo;
  byteLength: number;
  durationSeconds: number;
  partsUploaded: number;
  sourceWavBytes: number;
  segmentGapSeconds: number;
  segmentLoudness: SegmentLoudnessStats[];
}

export interface Mp3StreamInspection {
  valid: boolean;
  hasId3v2: boolean;
  frameCount: number;
  mpegVersion: "1" | "2" | "2.5" | "unknown";
  layer: number;
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  totalFrameBytes: number;
  trailingBytes: number;
  durationSeconds: number;
}

/**
 * Convert an ArrayBufferView (note: `@breezystack/lamejs` returns `Int8Array`
 * at runtime despite its `.d.ts` typing `Uint8Array`) to a zero-copy `Uint8Array`.
 */
function asUint8Array(view: ArrayBufferView): Uint8Array {
  if (view instanceof Uint8Array) return view;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Convert linear amplitude to dBFS (returns -Infinity for 0). */
export function linearToDbfs(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * C1-smooth soft-knee peak limiter asymptotically bounded strictly below `ceilingLinear`.
 *
 * Below `knee = 0.75 * ceilingLinear` (~-3.5 dBFS for a -1 dBFS ceiling), audio passes
 * through 100% linearly with zero distortion. Above the knee, a continuous `tanh` curve
 * gently rounds peaks so output never clips and never exceeds `ceilingLinear`.
 */
export function softLimitSample(sample: number, ceilingLinear: number): number {
  if (ceilingLinear <= 0) return 0;
  const abs = Math.abs(sample);
  const knee = ceilingLinear * 0.75;
  if (abs <= knee) return sample;
  const headroom = ceilingLinear - knee;
  const limited = knee + headroom * Math.tanh((abs - knee) / headroom);
  return sample < 0 ? -limited : limited;
}

/**
 * Compute raised-cosine (Hann half-window) boundary fade gain for sample `sampleIndex`
 * of a segment containing `totalSamples` samples. Guarantees exact 0 at index 0 and
 * `totalSamples - 1` when `fadeSamples > 0` so segment joins never click.
 */
export function boundaryFadeMultiplier(
  sampleIndex: number,
  totalSamples: number,
  fadeSamples: number,
): number {
  if (fadeSamples <= 0 || totalSamples <= 1) return 1;
  const effectiveFade = Math.min(fadeSamples, Math.floor(totalSamples / 2));
  if (effectiveFade <= 0) return 1;
  if (sampleIndex < effectiveFade) {
    return 0.5 * (1 - Math.cos((Math.PI * sampleIndex) / effectiveFade));
  }
  const fromEnd = totalSamples - 1 - sampleIndex;
  if (fromEnd < effectiveFade) {
    return 0.5 * (1 - Math.cos((Math.PI * fromEnd) / effectiveFade));
  }
  return 1;
}

/**
 * Constant-memory streaming loudness analyzer computing silence-gated RMS
 * (50ms blocks above -50 dBFS) and sample peak in a single O(1)-RAM pass.
 */
export class StreamingLoudnessMeter {
  readonly #blockSize: number;
  #totalSumSq = 0;
  #totalSamples = 0;
  #activeSumSq = 0;
  #activeSamples = 0;
  #blockSumSq = 0;
  #blockSamples = 0;
  #peak = 0;

  constructor(sampleRate: number) {
    this.#blockSize = Math.max(1, Math.round(sampleRate * 0.05));
  }

  pushSample(normalizedSample: number): void {
    const abs = Math.abs(normalizedSample);
    if (abs > this.#peak) this.#peak = abs;
    const sq = normalizedSample * normalizedSample;
    this.#totalSumSq += sq;
    this.#totalSamples++;
    this.#blockSumSq += sq;
    this.#blockSamples++;
    if (this.#blockSamples === this.#blockSize) {
      if (this.#blockSumSq / this.#blockSamples >= ACTIVE_GATE_MEAN_SQ) {
        this.#activeSumSq += this.#blockSumSq;
        this.#activeSamples += this.#blockSamples;
      }
      this.#blockSumSq = 0;
      this.#blockSamples = 0;
    }
  }

  finish(
    targetRmsDbfs = DEFAULT_TARGET_RMS_DBFS,
    maxGainDb = DEFAULT_MAX_GAIN_DB,
  ): SegmentLoudnessStats {
    if (
      this.#blockSamples > 0 &&
      this.#blockSumSq / this.#blockSamples >= ACTIVE_GATE_MEAN_SQ
    ) {
      this.#activeSumSq += this.#blockSumSq;
      this.#activeSamples += this.#blockSamples;
      this.#blockSumSq = 0;
      this.#blockSamples = 0;
    }

    const overallRms = this.#totalSamples > 0
      ? Math.sqrt(this.#totalSumSq / this.#totalSamples)
      : 0;
    const rms = this.#activeSamples > 0
      ? Math.sqrt(this.#activeSumSq / this.#activeSamples)
      : overallRms;

    let gain = 1;
    if (rms >= SILENCE_FLOOR_LINEAR && this.#peak >= SILENCE_FLOOR_LINEAR) {
      const targetLinear = Math.pow(10, targetRmsDbfs / 20);
      const maxGain = Math.pow(10, maxGainDb / 20);
      const minGain = Math.pow(10, -maxGainDb / 20);
      gain = Math.min(maxGain, Math.max(minGain, targetLinear / rms));
    }

    return {
      sampleCount: this.#totalSamples,
      rms,
      overallRms,
      peak: this.#peak,
      gain,
    };
  }
}

/**
 * Decode arbitrary-alignment little-endian 16-bit PCM byte chunks into mono
 * normalized float samples `[-1, 1]` (downmixing stereo cleanly if `channels === 2`).
 * Handles odd/misaligned chunk boundaries without corrupting sample framing.
 */
class Pcm16MonoDecoder {
  readonly #channels: number;
  readonly #frameBytes: number;
  readonly #carry: Uint8Array;
  #carryLen = 0;

  constructor(channels: number) {
    if (channels !== 1 && channels !== 2) {
      throw new GeminiTtsError(`Unsupported PCM channel count for MP3 assembly: ${channels}`, 400);
    }
    this.#channels = channels;
    this.#frameBytes = channels * 2;
    this.#carry = new Uint8Array(this.#frameBytes);
  }

  feed(bytes: Uint8Array, onSample: (normalizedSample: number) => void): void {
    let offset = 0;
    const len = bytes.byteLength;
    const frameBytes = this.#frameBytes;

    if (this.#carryLen > 0) {
      const need = frameBytes - this.#carryLen;
      const take = Math.min(need, len);
      this.#carry.set(bytes.subarray(0, take), this.#carryLen);
      this.#carryLen += take;
      offset += take;
      if (this.#carryLen === frameBytes) {
        onSample(this.#decodeFrame(this.#carry, 0));
        this.#carryLen = 0;
      } else {
        return;
      }
    }

    const limit = len - ((len - offset) % frameBytes);
    if (this.#channels === 1) {
      while (offset < limit) {
        let s = (bytes[offset + 1]! << 8) | bytes[offset]!;
        if (s & 0x8000) s -= 0x10000;
        onSample(s / 32768);
        offset += 2;
      }
    } else {
      while (offset < limit) {
        onSample(this.#decodeFrame(bytes, offset));
        offset += 4;
      }
    }

    const rem = len - offset;
    if (rem > 0) {
      this.#carry.set(bytes.subarray(offset), 0);
      this.#carryLen = rem;
    }
  }

  #decodeFrame(buf: Uint8Array, off: number): number {
    let left = (buf[off + 1]! << 8) | buf[off]!;
    if (left & 0x8000) left -= 0x10000;
    if (this.#channels === 1) return left / 32768;
    let right = (buf[off + 3]! << 8) | buf[off + 2]!;
    if (right & 0x8000) right -= 0x10000;
    return (left + right) / 65536;
  }
}

/**
 * Pure DSP helper: apply normalization gain, raised-cosine boundary fades, and
 * soft peak limiting to a mono 16-bit PCM array. Useful for direct verification
 * and standalone WAV->MP3 transcoding.
 */
export function processMonoPcm16(
  samples: Int16Array,
  sampleRate: number,
  options: Mp3CraftOptions = {},
): { processed: Int16Array; loudness: SegmentLoudnessStats } {
  const targetRmsDbfs = options.targetRmsDbfs ?? DEFAULT_TARGET_RMS_DBFS;
  const peakCeilingDbfs = options.peakCeilingDbfs ?? DEFAULT_PEAK_CEILING_DBFS;
  const fadeMs = options.fadeMs ?? DEFAULT_BOUNDARY_FADE_MS;
  const maxGainDb = options.maxGainDb ?? DEFAULT_MAX_GAIN_DB;

  const meter = new StreamingLoudnessMeter(sampleRate);
  for (let i = 0; i < samples.length; i++) {
    meter.pushSample(samples[i]! / 32768);
  }
  const loudness = meter.finish(targetRmsDbfs, maxGainDb);
  const ceilingLinear = Math.pow(10, peakCeilingDbfs / 20);
  const fadeSamples = fadeMs > 0 ? Math.round((sampleRate * fadeMs) / 1000) : 0;

  const processed = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const scaled = (samples[i]! / 32768) * loudness.gain;
    const limited = softLimitSample(scaled, ceilingLinear);
    const faded = limited * boundaryFadeMultiplier(i, samples.length, fadeSamples);
    processed[i] = Math.max(-32768, Math.min(32767, Math.round(faded * 32767)));
  }
  return { processed, loudness };
}

/**
 * Compute exact inter-segment gap in seconds for a given sample rate and gap ms.
 */
export function segmentGapDurationSeconds(
  sampleRate: number,
  segmentGapMs = DEFAULT_SEGMENT_GAP_MS,
): number {
  if (sampleRate <= 0 || segmentGapMs <= 0) return 0;
  return Math.round((sampleRate * segmentGapMs) / 1000) / sampleRate;
}

/**
 * Compute total assembled MP3 audio duration including inter-segment silence padding.
 * Shared single source of truth between MP3 assembly and chapter timestamp accounting.
 */
export function computeAssembledMp3DurationSeconds(
  segments: readonly Pick<StoredWavSegment, "durationSeconds" | "sampleRate">[],
  segmentGapMs = DEFAULT_SEGMENT_GAP_MS,
): number {
  if (segments.length === 0) return 0;
  const sampleRate = segments[0]!.sampleRate || 24_000;
  const gapSec = segmentGapDurationSeconds(sampleRate, segmentGapMs);
  const speechSec = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
  return speechSec + Math.max(0, segments.length - 1) * gapSec;
}

/**
 * Compute a deterministic content revision hash for an MP3 assembly from ordered
 * segment metadata and encoding craft options without reading full PCM into RAM.
 */
export async function computeStreamingMp3RevisionHash(
  segments: readonly StoredWavSegment[],
  previousAudioKey?: string,
  options: Mp3CraftOptions = {},
): Promise<string> {
  const bitrateKbps = options.bitrateKbps ?? DEFAULT_MP3_BITRATE_KBPS;
  const targetRmsDbfs = options.targetRmsDbfs ?? DEFAULT_TARGET_RMS_DBFS;
  const peakCeilingDbfs = options.peakCeilingDbfs ?? DEFAULT_PEAK_CEILING_DBFS;
  const segmentGapMs = options.segmentGapMs ?? DEFAULT_SEGMENT_GAP_MS;
  const fadeMs = options.fadeMs ?? DEFAULT_BOUNDARY_FADE_MS;
  const maxGainDb = options.maxGainDb ?? DEFAULT_MAX_GAIN_DB;

  const descriptor = [
    MP3_ASSEMBLY_VERSION,
    `br=${bitrateKbps}`,
    `rms=${targetRmsDbfs}`,
    `ceil=${peakCeilingDbfs}`,
    `gap=${segmentGapMs}`,
    `fade=${fadeMs}`,
    `maxg=${maxGainDb}`,
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

/**
 * Lazy-promoting streaming R2 output sink.
 *
 * Buffers encoded MP3 bytes into a single reusable `partSizeBytes` (default 8 MiB)
 * buffer. If the full MP3 fits inside one part (< 8 MiB, ~17.5 min @ 64 kbps),
 * writes once via `blobs.put(...)` with zero multipart overhead. As soon as output
 * reaches `partSizeBytes` and `blobs.createMultipartUpload` is available, promotes
 * to R2 Multipart Upload so peak output RAM never exceeds `partSizeBytes` and every
 * non-final part is strictly >= `R2_MIN_MULTIPART_PART_BYTES` (5 MiB).
 */
class StreamingMp3BlobSink {
  readonly #blobs: BlobStore;
  readonly #destinationKey: string;
  readonly #partSizeBytes: number;
  readonly #signal: AbortSignal | undefined;
  readonly #partBuffer: Uint8Array;
  readonly #fallbackChunks: Uint8Array[] = [];
  #buffered = 0;
  #totalBytes = 0;
  #multipartUpload: BlobMultipartUpload | null = null;
  #partNumber = 1;
  readonly #uploadedParts: BlobMultipartPart[] = [];

  constructor(
    blobs: BlobStore,
    destinationKey: string,
    partSizeBytes: number,
    signal?: AbortSignal,
  ) {
    this.#blobs = blobs;
    this.#destinationKey = destinationKey;
    this.#partSizeBytes = partSizeBytes;
    this.#signal = signal;
    this.#partBuffer = new Uint8Array(partSizeBytes);
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  async append(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    let srcOffset = 0;
    while (srcOffset < chunk.byteLength) {
      const space = this.#partSizeBytes - this.#buffered;
      const take = Math.min(space, chunk.byteLength - srcOffset);
      this.#partBuffer.set(chunk.subarray(srcOffset, srcOffset + take), this.#buffered);
      this.#buffered += take;
      this.#totalBytes += take;
      srcOffset += take;
      if (this.#buffered === this.#partSizeBytes) {
        await this.#flushFullBuffer();
      }
    }
  }

  async #flushFullBuffer(): Promise<void> {
    if (this.#signal?.aborted) {
      throw this.#signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (this.#blobs.createMultipartUpload) {
      if (!this.#multipartUpload) {
        this.#multipartUpload = await this.#blobs.createMultipartUpload(this.#destinationKey, {
          contentType: "audio/mpeg",
          signal: this.#signal,
        });
      }
      const part = await this.#multipartUpload.uploadPart(
        this.#partNumber++,
        this.#partBuffer.subarray(0, this.#buffered),
      );
      this.#uploadedParts.push(part);
    } else {
      // Store has no multipart support: spill a copy and assemble on finish.
      this.#fallbackChunks.push(this.#partBuffer.slice(0, this.#buffered));
    }
    this.#buffered = 0;
  }

  async finish(): Promise<{ stored: BlobInfo; byteLength: number; partsUploaded: number }> {
    if (this.#signal?.aborted) {
      throw this.#signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (this.#multipartUpload) {
      if (this.#buffered > 0) {
        const finalPart = await this.#multipartUpload.uploadPart(
          this.#partNumber++,
          this.#partBuffer.subarray(0, this.#buffered),
        );
        this.#uploadedParts.push(finalPart);
        this.#buffered = 0;
      }
      const stored = await this.#multipartUpload.complete(this.#uploadedParts);
      return {
        stored,
        byteLength: stored.size ?? this.#totalBytes,
        partsUploaded: this.#uploadedParts.length,
      };
    }

    let payload: Uint8Array;
    if (this.#fallbackChunks.length === 0) {
      payload = this.#partBuffer.subarray(0, this.#buffered);
    } else {
      payload = new Uint8Array(this.#totalBytes);
      let off = 0;
      for (const part of this.#fallbackChunks) {
        payload.set(part, off);
        off += part.byteLength;
      }
      if (this.#buffered > 0) {
        payload.set(this.#partBuffer.subarray(0, this.#buffered), off);
      }
      this.#fallbackChunks.length = 0;
    }

    const stored = await this.#blobs.put(this.#destinationKey, payload, {
      contentType: "audio/mpeg",
      signal: this.#signal,
    });
    return {
      stored,
      byteLength: stored.size ?? this.#totalBytes,
      partsUploaded: 1,
    };
  }

  async abort(): Promise<void> {
    if (this.#multipartUpload) {
      await this.#multipartUpload.abort().catch(() => {});
      this.#multipartUpload = null;
    }
  }
}

async function readSegmentPcmStream(
  blobs: BlobStore,
  seg: StoredWavSegment,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const obj = await blobs.get(seg.audioKey, {
    range: { start: seg.pcmOffset, end: seg.pcmOffset + seg.pcmByteLength - 1 },
  });
  if (!obj) {
    throw new Error(`Missing synthesis segment blob during MP3 assembly: ${seg.audioKey}`);
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
      const toUse = Math.min(value.byteLength, remainingForSeg);
      if (toUse > 0) {
        await onChunk(value.subarray(0, toUse));
        segRead += toUse;
      }
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

/**
 * Stream-assemble stored WAV segments into a normalized, gap-padded,
 * standards-compliant MP3 (`audio/mpeg`) in `blobs` at `destinationKey`.
 */
export async function assembleMp3ToBlobStore(
  options: AssembleMp3Options,
): Promise<AssembleMp3Result> {
  const { blobs, destinationKey, segments, signal } = options;
  if (segments.length === 0) {
    throw new GeminiTtsError("Cannot assemble MP3 from zero segments", 400);
  }

  const first = segments[0]!;
  if (!SUPPORTED_MP3_SAMPLE_RATES.has(first.sampleRate)) {
    throw new GeminiTtsError(
      `Unsupported sample rate for MP3 encoding: ${first.sampleRate} Hz`,
      400,
    );
  }
  if (first.bitsPerSample !== 16 || (first.channels !== 1 && first.channels !== 2)) {
    throw new GeminiTtsError(
      `Unsupported PCM format for MP3 encoding: ${first.bitsPerSample}-bit ${first.channels}ch`,
      400,
    );
  }

  let totalPcmBytes = 0;
  for (const seg of segments) {
    const frameBytes = (seg.channels * seg.bitsPerSample) / 8;
    if (
      seg.sampleRate !== first.sampleRate ||
      seg.channels !== first.channels ||
      seg.bitsPerSample !== first.bitsPerSample ||
      seg.pcmByteLength <= 0 ||
      frameBytes <= 0 ||
      seg.pcmByteLength % frameBytes !== 0
    ) {
      throw new GeminiTtsError("TTS segments returned incompatible or incomplete audio");
    }
    totalPcmBytes += seg.pcmByteLength;
  }

  const sampleRate = first.sampleRate;
  const channels = first.channels;
  const frameBytes = channels * 2;
  const bitrateKbps = options.bitrateKbps ?? DEFAULT_MP3_BITRATE_KBPS;
  const targetRmsDbfs = options.targetRmsDbfs ?? DEFAULT_TARGET_RMS_DBFS;
  const peakCeilingDbfs = options.peakCeilingDbfs ?? DEFAULT_PEAK_CEILING_DBFS;
  const segmentGapMs = options.segmentGapMs ?? DEFAULT_SEGMENT_GAP_MS;
  const fadeMs = options.fadeMs ?? DEFAULT_BOUNDARY_FADE_MS;
  const maxGainDb = options.maxGainDb ?? DEFAULT_MAX_GAIN_DB;
  const singleReadCap = options.singleReadSegmentCapBytes ?? SINGLE_READ_SEGMENT_CAP_BYTES;

  const partSizeBytes = Math.max(
    R2_MIN_MULTIPART_PART_BYTES,
    options.partSizeBytes ?? DEFAULT_MULTIPART_PART_BYTES,
  );
  const ceilingLinear = Math.pow(10, peakCeilingDbfs / 20);
  const fadeSamples = fadeMs > 0 ? Math.round((sampleRate * fadeMs) / 1000) : 0;
  const gapSamples = segmentGapMs > 0 ? Math.round((sampleRate * segmentGapMs) / 1000) : 0;
  const segmentGapSeconds = gapSamples / sampleRate;
  const durationSeconds = computeAssembledMp3DurationSeconds(segments, segmentGapMs);
  const sourceWavBytes = 44 + totalPcmBytes;

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const encoder = new Mp3Encoder(1, sampleRate, bitrateKbps);
  const sink = new StreamingMp3BlobSink(blobs, destinationKey, partSizeBytes, signal);
  const blockBuf = new Int16Array(MP3_ENCODE_BLOCK_SAMPLES);
  let blockFill = 0;
  const segmentLoudness: SegmentLoudnessStats[] = [];

  const flushEncodeBlock = async (count: number) => {
    if (count <= 0) return;
    const encoded = encoder.encodeBuffer(
      count === MP3_ENCODE_BLOCK_SAMPLES ? blockBuf : blockBuf.subarray(0, count),
    );
    if (encoded.length > 0) {
      await sink.append(asUint8Array(encoded));
    }
    blockFill = 0;
  };

  const pushMonoInt16 = async (sample: number) => {
    blockBuf[blockFill++] = sample;
    if (blockFill === MP3_ENCODE_BLOCK_SAMPLES) {
      await flushEncodeBlock(MP3_ENCODE_BLOCK_SAMPLES);
    }
  };

  const encodePcmChunkWithCraft = async (
    chunk: Uint8Array,
    decoder: Pcm16MonoDecoder,
    gain: number,
    segTotalSamples: number,
    state: { sampleIndex: number },
  ) => {
    // Collect encoded MP3 slices synchronously during chunk decode, then flush to sink.
    const pendingOutputs: Uint8Array[] = [];
    decoder.feed(chunk, (normalized) => {
      const idx = state.sampleIndex++;
      const scaled = normalized * gain;
      const limited = softLimitSample(scaled, ceilingLinear);
      const faded = limited * boundaryFadeMultiplier(idx, segTotalSamples, fadeSamples);
      blockBuf[blockFill++] = Math.max(-32768, Math.min(32767, Math.round(faded * 32767)));
      if (blockFill === MP3_ENCODE_BLOCK_SAMPLES) {
        const encoded = encoder.encodeBuffer(blockBuf);
        if (encoded.length > 0) {
          // Copy slice because subsequent encodeBuffer calls inside this chunk may share backing storage.
          pendingOutputs.push(asUint8Array(encoded).slice());
        }
        blockFill = 0;
      }
    });
    for (const out of pendingOutputs) {
      await sink.append(out);
    }
  };

  try {
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const seg = segments[segIdx]!;
      const segTotalSamples = seg.pcmByteLength / frameBytes;

      if (seg.pcmByteLength <= singleReadCap) {
        // Fast single-read path for normal segments (<= 4 MiB): 1 R2 read, bounded RAM.
        const segPcm = new Uint8Array(seg.pcmByteLength);
        let writeOff = 0;
        await readSegmentPcmStream(blobs, seg, signal, (chunk) => {
          segPcm.set(chunk, writeOff);
          writeOff += chunk.byteLength;
        });

        const meter = new StreamingLoudnessMeter(sampleRate);
        const scanDecoder = new Pcm16MonoDecoder(channels);
        scanDecoder.feed(segPcm, (s) => meter.pushSample(s));
        const stats = meter.finish(targetRmsDbfs, maxGainDb);
        segmentLoudness.push(stats);

        // Encode in 64 KiB sub-slices so intermediate output slices stay tiny.
        const encodeDecoder = new Pcm16MonoDecoder(channels);
        const state = { sampleIndex: 0 };
        const SUB_SLICE_BYTES = 64 * 1024;
        for (let off = 0; off < segPcm.byteLength; off += SUB_SLICE_BYTES) {
          if (signal?.aborted) {
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
          }
          const slice = segPcm.subarray(off, Math.min(off + SUB_SLICE_BYTES, segPcm.byteLength));
          await encodePcmChunkWithCraft(slice, encodeDecoder, stats.gain, segTotalSamples, state);
        }
      } else {
        // Two-pass streaming path for very large segments (> 4 MiB): constant ~10 MiB RAM.
        const meter = new StreamingLoudnessMeter(sampleRate);
        const scanDecoder = new Pcm16MonoDecoder(channels);
        await readSegmentPcmStream(blobs, seg, signal, (chunk) => {
          scanDecoder.feed(chunk, (s) => meter.pushSample(s));
        });
        const stats = meter.finish(targetRmsDbfs, maxGainDb);
        segmentLoudness.push(stats);

        const encodeDecoder = new Pcm16MonoDecoder(channels);
        const state = { sampleIndex: 0 };
        await readSegmentPcmStream(blobs, seg, signal, async (chunk) => {
          await encodePcmChunkWithCraft(chunk, encodeDecoder, stats.gain, segTotalSamples, state);
        });
      }

      // Insert smooth silence padding between consecutive segments.
      if (segIdx < segments.length - 1 && gapSamples > 0) {
        for (let g = 0; g < gapSamples; g++) {
          await pushMonoInt16(0);
        }
      }
    }

    // Flush trailing samples and MP3 encoder bit reservoir.
    if (blockFill > 0) {
      await flushEncodeBlock(blockFill);
    }
    const flushed = encoder.flush();
    if (flushed.length > 0) {
      await sink.append(asUint8Array(flushed));
    }

    const finished = await sink.finish();
    return {
      stored: finished.stored,
      byteLength: finished.byteLength,
      durationSeconds,
      partsUploaded: finished.partsUploaded,
      sourceWavBytes,
      segmentGapSeconds,
      segmentLoudness,
    };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

/**
 * Transcode a complete in-memory RIFF/WAVE buffer into a normalized MP3 byte buffer.
 * Used by CLI backfill tools and standalone unit tests.
 */
export function encodeWavBytesToMp3(
  wavBytes: Uint8Array,
  options: Mp3CraftOptions = {},
): { mp3: Uint8Array; durationSeconds: number; loudness: SegmentLoudnessStats } {
  const info = parseWavHeader(wavBytes);
  if (info.audioFormat !== 1 || info.bitsPerSample !== 16) {
    throw new GeminiTtsError(
      `Unsupported WAV format for MP3 transcoding (format=${info.audioFormat}, bits=${info.bitsPerSample})`,
      400,
    );
  }
  if (!SUPPORTED_MP3_SAMPLE_RATES.has(info.sampleRate)) {
    throw new GeminiTtsError(
      `Unsupported sample rate for MP3 transcoding: ${info.sampleRate} Hz`,
      400,
    );
  }
  const pcmSlice = wavBytes.subarray(info.dataOffset, info.dataOffset + info.declaredDataLength);
  const frameBytes = info.channels * 2;
  const totalSamples = Math.floor(pcmSlice.byteLength / frameBytes);
  if (totalSamples <= 0) {
    throw new GeminiTtsError("Cannot encode empty WAV PCM to MP3", 400);
  }

  const mono = new Int16Array(totalSamples);
  const decoder = new Pcm16MonoDecoder(info.channels);
  let idx = 0;
  decoder.feed(pcmSlice, (s) => {
    mono[idx++] = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
  });

  const { processed, loudness } = processMonoPcm16(mono, info.sampleRate, options);
  const bitrateKbps = options.bitrateKbps ?? DEFAULT_MP3_BITRATE_KBPS;
  const encoder = new Mp3Encoder(1, info.sampleRate, bitrateKbps);
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < processed.length; off += MP3_ENCODE_BLOCK_SAMPLES) {
    const slice = processed.subarray(off, Math.min(off + MP3_ENCODE_BLOCK_SAMPLES, processed.length));
    const enc = encoder.encodeBuffer(slice);
    if (enc.length > 0) chunks.push(asUint8Array(enc).slice());
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(asUint8Array(tail).slice());

  const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const mp3 = new Uint8Array(totalBytes);
  let outOff = 0;
  for (const c of chunks) {
    mp3.set(c, outOff);
    outOff += c.byteLength;
  }
  return {
    mp3,
    durationSeconds: totalSamples / info.sampleRate,
    loudness,
  };
}

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000, 0];
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000, 0];
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000, 0];

/**
 * Parse and validate an MPEG Layer III bitstream (skipping any leading ID3v2 tag).
 * Walks every frame header verifying sync word, MPEG version, Layer III, bitrate,
 * sample rate, channel mode, and frame boundaries.
 */
export function inspectMp3Stream(bytes: Uint8Array): Mp3StreamInspection {
  let pos = 0;
  let hasId3v2 = false;

  if (
    bytes.byteLength >= 10 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    hasId3v2 = true;
    const tagSize =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    pos = 10 + tagSize;
  }

  let frameCount = 0;
  let totalFrameBytes = 0;
  let totalSamples = 0;
  let firstVersion: "1" | "2" | "2.5" | "unknown" = "unknown";
  let firstLayer = 0;
  let firstBitrate = 0;
  let firstSampleRate = 0;
  let firstChannels = 0;

  while (pos + 4 <= bytes.byteLength) {
    const b0 = bytes[pos]!;
    const b1 = bytes[pos + 1]!;
    const b2 = bytes[pos + 2]!;
    const b3 = bytes[pos + 3]!;

    // 11-bit frame sync: 11111111 111xxxxx
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) break;

    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const sampleRateIdx = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;
    const channelMode = (b3 >> 6) & 0x03;

    // Layer III is encoded as `01` (1); versionBits === 1 is reserved.
    if (versionBits === 1 || layerBits !== 1) break;

    const mpegVersion: "1" | "2" | "2.5" = versionBits === 3
      ? "1"
      : versionBits === 2
      ? "2"
      : "2.5";
    const bitrateKbps = mpegVersion === "1"
      ? MPEG1_L3_BITRATES[bitrateIdx]!
      : MPEG2_L3_BITRATES[bitrateIdx]!;
    const sampleRate = mpegVersion === "1"
      ? MPEG1_SAMPLE_RATES[sampleRateIdx]!
      : mpegVersion === "2"
      ? MPEG2_SAMPLE_RATES[sampleRateIdx]!
      : MPEG25_SAMPLE_RATES[sampleRateIdx]!;

    if (bitrateKbps <= 0 || sampleRate <= 0) break;

    const samplesPerFrame = mpegVersion === "1" ? 1152 : 576;
    const frameLength = Math.floor(((samplesPerFrame / 8) * (bitrateKbps * 1000)) / sampleRate) +
      padding;
    if (frameLength < 4 || pos + frameLength > bytes.byteLength) break;

    if (frameCount === 0) {
      firstVersion = mpegVersion;
      firstLayer = 3;
      firstBitrate = bitrateKbps;
      firstSampleRate = sampleRate;
      firstChannels = channelMode === 3 ? 1 : 2;
    }

    frameCount++;
    totalFrameBytes += frameLength;
    totalSamples += samplesPerFrame;
    pos += frameLength;
  }

  const trailingBytes = bytes.byteLength - pos;
  const durationSeconds = firstSampleRate > 0 ? totalSamples / firstSampleRate : 0;

  return {
    valid: frameCount > 0 && trailingBytes === 0,
    hasId3v2,
    frameCount,
    mpegVersion: firstVersion,
    layer: firstLayer,
    bitrateKbps: firstBitrate,
    sampleRate: firstSampleRate,
    channels: firstChannels,
    totalFrameBytes,
    trailingBytes,
    durationSeconds,
  };
}
