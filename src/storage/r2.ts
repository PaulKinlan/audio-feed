/**
 * Native Cloudflare R2 Worker binding adapter for `BlobStore`.
 *
 * Talks directly to the bound R2 bucket inside Cloudflare Workers with zero S3
 * credential management, zero network signing overhead, full HTTP Range seeking,
 * and zero-copy ReadableStream responses.
 */

import { assertSafeBlobKey } from "./blob_key.ts";
import {
  type BlobInfo,
  type BlobMultipartPart,
  type BlobMultipartUpload,
  type BlobObject,
  type BlobStore,
  type ByteRange,
  RangeNotSatisfiableError,
} from "./mod.ts";

export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  range?: { offset?: number; length?: number; suffix?: number };
}

export interface R2UploadedPartLike {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUploadLike {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string,
  ): Promise<R2UploadedPartLike>;
  abort(): Promise<void>;
  complete(uploadedParts: R2UploadedPartLike[]): Promise<R2ObjectLike>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null,
    options?: {
      httpMetadata?: { contentType?: string };
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<R2ObjectLike | null>;
  createMultipartUpload?(
    key: string,
    options?: {
      httpMetadata?: { contentType?: string };
    },
  ): Promise<R2MultipartUploadLike>;
  get(
    key: string,
    options?: {
      range?: { offset?: number; length?: number; suffix?: number };
    },
  ): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
}

export class R2BlobStore implements BlobStore {
  readonly #bucket: R2BucketLike;
  readonly createMultipartUpload?: (
    key: string,
    opts?: { contentType?: string; signal?: AbortSignal },
  ) => Promise<BlobMultipartUpload>;

  constructor(bucket: R2BucketLike) {
    this.#bucket = bucket;
    if (typeof bucket.createMultipartUpload === "function") {
      this.createMultipartUpload = async (
        key: string,
        opts?: { contentType?: string; signal?: AbortSignal },
      ): Promise<BlobMultipartUpload> => {
        assertSafeBlobKey(key);
        const contentType = opts?.contentType ?? "application/octet-stream";
        if (opts?.signal?.aborted) {
          throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        const upload = await this.#bucket.createMultipartUpload!(key, {
          httpMetadata: { contentType },
        });
        return {
          key: upload.key,
          uploadId: upload.uploadId,
          async uploadPart(partNumber: number, data: Uint8Array): Promise<BlobMultipartPart> {
            if (opts?.signal?.aborted) {
              throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
            }
            const part = await upload.uploadPart(partNumber, data);
            return { partNumber: part.partNumber, etag: part.etag };
          },
          async complete(parts: BlobMultipartPart[]): Promise<BlobInfo> {
            if (opts?.signal?.aborted) {
              throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
            }
            const obj = await upload.complete(parts);
            return {
              key,
              size: obj.size,
              contentType: obj.httpMetadata?.contentType ?? contentType,
              etag: obj.etag,
            };
          },
          async abort(): Promise<void> {
            await upload.abort();
          },
        };
      };
    }
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string; signal?: AbortSignal },
  ): Promise<BlobInfo> {
    assertSafeBlobKey(key);
    const contentType = opts?.contentType ?? "application/octet-stream";
    if (opts?.signal?.aborted) {
      throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const obj = await this.#bucket.put(key, body, {
      httpMetadata: { contentType },
    });
    if (!obj) {
      throw new Error(`R2 put returned null for key "${key}"`);
    }
    return {
      key,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType ?? contentType,
      etag: obj.etag,
    };
  }

  async putIfAbsent(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string; signal?: AbortSignal },
  ): Promise<BlobInfo | null> {
    assertSafeBlobKey(key);
    const contentType = opts?.contentType ?? "application/octet-stream";
    if (opts?.signal?.aborted) {
      throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const obj = await this.#bucket.put(key, body, {
      httpMetadata: { contentType },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!obj) return null;
    return {
      key,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType ?? contentType,
      etag: obj.etag,
    };
  }

  async get(key: string, opts?: { range?: ByteRange }): Promise<BlobObject | null> {
    assertSafeBlobKey(key);

    if (!opts?.range) {
      const obj = await this.#bucket.get(key);
      if (!obj) return null;
      return {
        key,
        size: obj.size,
        contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
        etag: obj.etag,
        body: obj.body,
      };
    }

    // Resolve exact bounds first so out-of-range requests throw RangeNotSatisfiableError
    // consistently with S3BlobStore and MemoryBlobStore.
    const meta = await this.#bucket.head(key);
    if (!meta) return null;
    const total = meta.size;

    let start: number;
    let end: number;
    if (opts.range.start < 0) {
      const suffix = -opts.range.start;
      if (suffix === 0 || total === 0) throw new RangeNotSatisfiableError(total);
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = opts.range.start;
      end = opts.range.end === undefined ? total - 1 : Math.min(opts.range.end, total - 1);
      if (start >= total || end < start) {
        throw new RangeNotSatisfiableError(total);
      }
    }

    const length = end - start + 1;
    const obj = await this.#bucket.get(key, {
      range: { offset: start, length },
    });
    if (!obj) return null;

    return {
      key,
      size: total,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      etag: obj.etag,
      body: obj.body,
      range: { start, end, total },
    };
  }

  async head(key: string): Promise<BlobInfo | null> {
    assertSafeBlobKey(key);
    const meta = await this.#bucket.head(key);
    if (!meta) return null;
    return {
      key,
      size: meta.size,
      contentType: meta.httpMetadata?.contentType ?? "application/octet-stream",
      etag: meta.etag,
    };
  }

  async delete(key: string): Promise<void> {
    assertSafeBlobKey(key);
    await this.#bucket.delete(key);
  }

  url(_key: string, _opts?: { expiresInSeconds?: number }): Promise<string | null> {
    // Native R2 binding streams directly through GET /audio/:key same-origin.
    return Promise.resolve(null);
  }

  directUrlOrigin(): string | null {
    return null;
  }
}
