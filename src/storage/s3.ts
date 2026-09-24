/**
 * S3 / Cloudflare R2 blob adapter — the production `BlobStore`.
 *
 * Uses SigV4 via `aws4fetch`, which works on Deno Deploy (no Node crypto
 * dependency). R2 is S3-compatible, so the only difference is the endpoint.
 *
 * Owned by: audio-feed-0h8.
 */

import { AwsClient } from "aws4fetch";
import {
  type BlobInfo,
  type BlobObject,
  type BlobStore,
  type ByteRange,
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

  #objectUrl(key: string): string {
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    return `${this.#config.endpoint}/${this.#config.bucket}/${encoded}`;
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string },
  ): Promise<BlobInfo> {
    const contentType = opts?.contentType ?? "application/octet-stream";
    const headers: Record<string, string> = { "content-type": contentType };

    // SigV4 needs a length or an explicit streaming mode; buffering a stream is
    // the honest option here rather than pretending chunked upload works.
    const bytes = toBodyBytes(body instanceof Uint8Array ? body : await collectStream(body));
    headers["content-length"] = String(bytes.byteLength);

    const res = await this.#client.fetch(this.#objectUrl(key), {
      method: "PUT",
      body: bytes,
      headers,
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
      return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
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
  }
  return out;
}
