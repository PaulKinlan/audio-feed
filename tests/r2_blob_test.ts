/**
 * Runs the shared `BlobStore` conformance suite against `R2BlobStore` using an
 * in-memory `R2BucketLike` test double that implements R2's exact range, ETag,
 * and conditional `onlyIf.etagDoesNotMatch` semantics.
 */

import { runBlobConformance } from "./conformance/blobs.ts";
import { R2BlobStore, type R2BucketLike, type R2ObjectBodyLike, type R2ObjectLike } from "../src/storage/r2.ts";

function createFakeR2Bucket(): R2BucketLike {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; etag: string }>();
  let seq = 0;

  async function toBytes(
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null,
  ): Promise<Uint8Array> {
    if (value === null) return new Uint8Array();
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  return {
    async put(key, value, options): Promise<R2ObjectLike | null> {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
        return null;
      }
      const bytes = await toBytes(value);
      const etag = `"r2-${++seq}"`;
      const contentType = options?.httpMetadata?.contentType ?? "application/octet-stream";
      objects.set(key, { bytes, contentType, etag });
      return { key, size: bytes.byteLength, etag, httpMetadata: { contentType } };
    },

    get(key, options): Promise<R2ObjectBodyLike | null> {
      const found = objects.get(key);
      if (!found) return Promise.resolve(null);
      let slice = found.bytes;
      if (options?.range) {
        const offset = options.range.offset ?? 0;
        const end = options.range.length !== undefined
          ? offset + options.range.length
          : found.bytes.byteLength;
        slice = found.bytes.subarray(offset, end);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(slice));
          controller.close();
        },
      });
      return Promise.resolve({
        key,
        size: found.bytes.byteLength,
        etag: found.etag,
        httpMetadata: { contentType: found.contentType },
        body,
        range: options?.range,
      });
    },

    head(key): Promise<R2ObjectLike | null> {
      const found = objects.get(key);
      if (!found) return Promise.resolve(null);
      return Promise.resolve({
        key,
        size: found.bytes.byteLength,
        etag: found.etag,
        httpMetadata: { contentType: found.contentType },
      });
    },

    delete(keys): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(k);
      }
      return Promise.resolve();
    },
  };
}

runBlobConformance({
  name: "R2BlobStore",
  create: () => new R2BlobStore(createFakeR2Bucket()),
});
