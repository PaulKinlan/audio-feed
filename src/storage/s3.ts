/**
 * S3 / Cloudflare R2 blob adapter — the production `BlobStore`.
 *
 * Uses SigV4 via `aws4fetch`, which works on Deno Deploy (no Node crypto
 * dependency). R2 is S3-compatible, so the only difference is the endpoint.
 *
 * Owned by: audio-feed-0h8.
 */

import { AwsClient } from "aws4fetch";
import { assertSafeBlobKey } from "./blob_key.ts";
import {
  type BlobInfo,
  type BlobObject,
  type BlobStore,
  type ByteRange,
  detachUint8Array,
  RangeNotSatisfiableError,
} from "./mod.ts";

export interface S3Config {
  bucket: string;
  /** Full endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 ignores regions but SigV4 still needs one. */
  region?: string;
  /** Public base URL for unsigned playback, when the bucket is public. */
  publicBaseUrl?: string;
  /** Lifetime of generated signed URLs. */
  signedUrlSeconds?: number;
}

export class S3BlobStore implements BlobStore {
  #client: AwsClient;
  #config:
    & Required<Pick<S3Config, "bucket" | "endpoint" | "region" | "signedUrlSeconds">>
    & S3Config;

  constructor(config: S3Config) {
    this.#config = {
      region: "auto",
      signedUrlSeconds: 3600,
      ...config,
      endpoint: config.endpoint.replace(/\/+$/, ""),
    };
    this.#client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: this.#config.region,
      service: "s3",
    });
  }

  /**
   * Percent-encode a key for a URL, REFUSING unsafe shapes first.
   *
   * The store is the boundary, not the callers: `encodeURIComponent` keeps `..` intact, so a
   * key carrying a dot segment would address an object outside its prefix. Every URL this
   * store builds goes through here, so a caller that forgets `isSafeBlobKey` cannot reach the
   * bucket with an escaping key. Valid keys encode byte-identically to before.
   */
  #encodeKey(key: string): string {
    assertSafeBlobKey(key);
    return key.split("/").map(encodeURIComponent).join("/");
  }

  #objectUrl(key: string): string {
    return `${this.#config.endpoint}/${this.#config.bucket}/${this.#encodeKey(key)}`;
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string; signal?: AbortSignal },
  ): Promise<BlobInfo> {
    const contentType = opts?.contentType ?? "application/octet-stream";
    const headers: Record<string, string> = { "content-type": contentType };

    // SigV4 needs a length or an explicit streaming mode; buffering a stream is
    // the honest option here rather than pretending chunked upload works.
    const bytes = toBodyBytes(body instanceof Uint8Array ? body : await collectStream(body));
    headers["content-length"] = String(bytes.byteLength);

    // audio-feed-1ib3: S3 Multipart Upload for large payloads (> 20 MB) using 8 MB chunks
    if (bytes.byteLength > 20 * 1024 * 1024) {
      const multipart = await this.#putMultipart(key, bytes, contentType, opts);
      if (multipart) return multipart;
    }

    // audio-feed-aqms: the signal is threaded to the underlying fetch (aws4fetch
    // carries RequestInit.signal onto the signed Request), which makes the put
    // GENUINELY ABORTABLE: the invocation-budget deadline closes the socket and
    // the promise rejects with the abort reason instead of the isolate sitting in
    // an await it cannot exit. A bound by construction, not by estimate.
    // audio-feed-1ib3: Use UNSIGNED-PAYLOAD and sign only URL/headers to prevent aws4fetch
    // hashing and duplicating large audio payloads in V8 memory.
    headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
    const signed = await this.#client.sign(this.#objectUrl(key), {
      method: "PUT",
      headers,
    });
    const res = await fetch(signed.url, {
      method: "PUT",
      headers: signed.headers,
      body: bytes,
      signal: opts?.signal,
    });
    if (!res.ok) {
      throw new Error(`S3 put failed (${res.status}): ${await safeText(res)}`);
    }
    await res.body?.cancel();
    return {
      key,
      size: bytes.byteLength,
      contentType,
      etag: res.headers.get("etag") ?? undefined,
    };
  }

  async putIfAbsent(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string; signal?: AbortSignal },
  ): Promise<BlobInfo | null> {
    const contentType = opts?.contentType ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "content-type": contentType,
      "if-none-match": "*",
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    };

    const bytes = toBodyBytes(body instanceof Uint8Array ? body : await collectStream(body));
    headers["content-length"] = String(bytes.byteLength);

    const signed = await this.#client.sign(this.#objectUrl(key), {
      method: "PUT",
      headers,
    });
    const res = await fetch(signed.url, {
      method: "PUT",
      headers: signed.headers,
      body: bytes,
      signal: opts?.signal,
    });
    if (res.status === 412 || res.status === 409) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      throw new Error(`S3 putIfAbsent failed (${res.status}): ${await safeText(res)}`);
    }
    await res.body?.cancel();
    return {
      key,
      size: bytes.byteLength,
      contentType,
      etag: res.headers.get("etag") ?? undefined,
    };
  }

  async #putMultipart(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    opts?: { signal?: AbortSignal },
  ): Promise<BlobInfo | null> {
    const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
    const initiateUrl = new URL(this.#objectUrl(key));
    initiateUrl.searchParams.set("uploads", "");

    const initiateHeaders: Record<string, string> = {
      "content-type": contentType,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    };
    const signedInitiate = await this.#client.sign(initiateUrl.toString(), {
      method: "POST",
      headers: initiateHeaders,
    });

    const initiateRes = await fetch(signedInitiate.url, {
      method: "POST",
      headers: signedInitiate.headers,
      signal: opts?.signal,
    });

    if (
      initiateRes.status === 404 ||
      initiateRes.status === 405 ||
      initiateRes.status === 501
    ) {
      await initiateRes.body?.cancel();
      return null;
    }

    if (!initiateRes.ok) {
      throw new Error(
        `S3 initiate multipart upload failed (${initiateRes.status}): ${await safeText(
          initiateRes,
        )}`,
      );
    }

    const initiateXml = await initiateRes.text();
    const uploadIdMatch = /<UploadId>([^<]+)<\/UploadId>/.exec(initiateXml);
    const uploadId = uploadIdMatch?.[1];
    if (!uploadId) {
      throw new Error(
        `S3 initiate multipart upload returned no UploadId: ${initiateXml.slice(0, 300)}`,
      );
    }

    const parts: Array<{ partNumber: number; etag: string }> = [];
    try {
      let partNumber = 1;
      for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += MULTIPART_PART_BYTES, partNumber++
      ) {
        const end = Math.min(offset + MULTIPART_PART_BYTES, bytes.byteLength);
        const partSlice = toBodyBytes(bytes.subarray(offset, end));
        const partUrl = new URL(this.#objectUrl(key));
        partUrl.searchParams.set("partNumber", String(partNumber));
        partUrl.searchParams.set("uploadId", uploadId);

        const partHeaders: Record<string, string> = {
          "content-length": String(partSlice.byteLength),
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        };
        const signedPart = await this.#client.sign(partUrl.toString(), {
          method: "PUT",
          headers: partHeaders,
        });

        const partRes = await fetch(signedPart.url, {
          method: "PUT",
          headers: signedPart.headers,
          body: partSlice,
          signal: opts?.signal,
        });

        if (!partRes.ok) {
          throw new Error(
            `S3 upload part ${partNumber} failed (${partRes.status}): ${await safeText(partRes)}`,
          );
        }
        const etag = partRes.headers.get("etag");
        await partRes.body?.cancel();
        if (!etag) {
          throw new Error(`S3 upload part ${partNumber} returned no ETag`);
        }
        parts.push({ partNumber, etag });
      }

      const completeUrl = new URL(this.#objectUrl(key));
      completeUrl.searchParams.set("uploadId", uploadId);

      const completeXml = `<CompleteMultipartUpload>${
        parts
          .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
          .join("")
      }</CompleteMultipartUpload>`;

      const completeHeaders: Record<string, string> = {
        "content-type": "application/xml",
        "content-length": String(new TextEncoder().encode(completeXml).byteLength),
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      };

      const signedComplete = await this.#client.sign(completeUrl.toString(), {
        method: "POST",
        headers: completeHeaders,
      });

      const completeRes = await fetch(signedComplete.url, {
        method: "POST",
        headers: signedComplete.headers,
        body: completeXml,
        signal: opts?.signal,
      });

      if (!completeRes.ok) {
        throw new Error(
          `S3 complete multipart upload failed (${completeRes.status}): ${await safeText(
            completeRes,
          )}`,
        );
      }

      const completeResText = await completeRes.text();
      const etagMatch = /<ETag>([^<]+)<\/ETag>/.exec(completeResText);
      const finalEtag = completeRes.headers.get("etag") ?? (etagMatch ? etagMatch[1] : undefined);

      return {
        key,
        size: bytes.byteLength,
        contentType,
        etag: finalEtag,
      };
    } catch (err) {
      try {
        const abortUrl = new URL(this.#objectUrl(key));
        abortUrl.searchParams.set("uploadId", uploadId);
        const signedAbort = await this.#client.sign(abortUrl.toString(), {
          method: "DELETE",
          headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
        });
        const abortRes = await fetch(signedAbort.url, {
          method: "DELETE",
          headers: signedAbort.headers,
        });
        await abortRes.body?.cancel();
      } catch {
        // ignore cleanup error
      }
      throw err;
    }
  }

  async get(key: string, opts?: { range?: ByteRange }): Promise<BlobObject | null> {
    const headers: Record<string, string> = {};
    if (opts?.range) headers["range"] = toRangeHeader(opts.range);

    const res = await this.#client.fetch(this.#objectUrl(key), { method: "GET", headers });

    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status === 416) {
      await res.body?.cancel();
      throw new RangeNotSatisfiableError(parseTotalFromContentRange(res) ?? 0);
    }
    if (!res.ok) {
      throw new Error(`S3 get failed (${res.status}): ${await safeText(res)}`);
    }

    const contentRange = res.headers.get("content-range");
    const parsed = contentRange ? parseContentRange(contentRange) : null;
    const size = parsed?.total ?? Number(res.headers.get("content-length") ?? 0);

    return {
      key,
      size,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      etag: res.headers.get("etag") ?? undefined,
      body: res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      ...(parsed ? { range: parsed } : {}),
    };
  }

  async head(key: string): Promise<BlobInfo | null> {
    const res = await this.#client.fetch(this.#objectUrl(key), { method: "HEAD" });
    await res.body?.cancel();
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 head failed (${res.status})`);
    return {
      key,
      size: Number(res.headers.get("content-length") ?? 0),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      etag: res.headers.get("etag") ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.#client.fetch(this.#objectUrl(key), { method: "DELETE" });
    await res.body?.cancel();
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 delete failed (${res.status})`);
    }
  }

  async url(key: string, opts?: { expiresInSeconds?: number }): Promise<string | null> {
    if (this.#config.publicBaseUrl) {
      const base = this.#config.publicBaseUrl.replace(/\/+$/, "");
      return `${base}/${this.#encodeKey(key)}`;
    }
    const expires = opts?.expiresInSeconds ?? this.#config.signedUrlSeconds;
    const target = new URL(this.#objectUrl(key));
    target.searchParams.set("X-Amz-Expires", String(expires));
    const signed = await this.#client.sign(target.toString(), {
      method: "GET",
      aws: { signQuery: true },
    });
    return signed.url;
  }

  /**
   * The origin `url()` aims every direct playback URL at (audio-feed-327mm delta):
   * the public base when configured, otherwise the S3/R2 endpoint presigned URLs
   * are signed against. Derived from the SAME configuration `url()` builds the
   * redirect from — `url()` itself cannot serve this, because it is per-key, async,
   * and signs, while the origin is per-store configuration the CSP builder needs
   * synchronously. Non-HTTP schemes parse to the string origin `"null"`, which
   * permits nothing; report those (and unparseable config) as `null`.
   */
  directUrlOrigin(): string | null {
    try {
      const url = new URL(this.#config.publicBaseUrl ?? this.#config.endpoint);
      return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
    } catch {
      return null;
    }
  }
}

function toRangeHeader(range: ByteRange): string {
  if (range.start < 0) return `bytes=-${-range.start}`;
  return range.end === undefined ? `bytes=${range.start}-` : `bytes=${range.start}-${range.end}`;
}

export function parseContentRange(
  header: string,
): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
  if (!match) return null;
  const [, start, end, total] = match;
  return {
    start: Number(start),
    end: Number(end),
    total: total === "*" ? Number(end) + 1 : Number(total),
  };
}

function parseTotalFromContentRange(res: Response): number | null {
  const header = res.headers.get("content-range");
  if (!header) return null;
  const match = /\/(\d+)$/.exec(header.trim());
  return match?.[1] ? Number(match[1]) : null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}

/**
 * `BodyInit` only accepts an `ArrayBuffer`-backed view — a `SharedArrayBuffer`-backed
 * `Uint8Array` is not a valid request body. The shared `BlobStore` interface
 * should not have to care, so normalise at this boundary instead. The copy only
 * happens in the shared-buffer case, which audio bytes never hit in practice.
 */
function toBodyBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  return input.buffer instanceof ArrayBuffer
    ? (input as Uint8Array<ArrayBuffer>)
    : new Uint8Array(input);
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
    detachUint8Array(chunk);
  }
  return out;
}
