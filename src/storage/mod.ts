/**
 * Storage contracts for audio-feed.
 *
 * Two independent concerns, deliberately kept apart:
 *   - `MetadataStore` — users, sources, articles, episodes. Deno KV in prod.
 *   - `BlobStore`     — audio bytes. R2/S3 in prod, memory/disk in tests.
 *
 * Every implementation of either interface must pass the shared conformance
 * suite in `tests/conformance/`. If your lane needs a new query, add it to the
 * interface *and* the conformance suite — do not reach around the interface
 * into `Deno.openKv()` or `fetch()` from feature code.
 *
 * Owned by: audio-feed-0h8.
 */

import type { Article, AudioMode, Episode, EpisodeStatus, Source, User } from "../types.ts";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface EpisodeQuery {
  userId: string;
  /** Omit for the master feed (all sources). */
  sourceId?: string;
  /** Omit to include both modes. */
  mode?: AudioMode;
  status?: EpisodeStatus;
  /** Newest first. Default 50. */
  limit?: number;
}

export interface MetadataStore {
  // -- users ------------------------------------------------------------
  putUser(user: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  listUsers(): Promise<User[]>;

  // -- sources ----------------------------------------------------------
  putSource(source: Source): Promise<void>;
  getSource(userId: string, id: string): Promise<Source | null>;
  listSources(userId: string): Promise<Source[]>;

  // -- articles ---------------------------------------------------------
  putArticle(article: Article): Promise<void>;
  getArticle(userId: string, id: string): Promise<Article | null>;
  /** Dedupe hook for repeat ingests of the same URL. */
  findArticleByUrl(userId: string, url: string): Promise<Article | null>;

  // -- episodes ---------------------------------------------------------
  putEpisode(episode: Episode): Promise<void>;
  getEpisode(userId: string, id: string): Promise<Episode | null>;
  /** Newest first. Backs both the per-source and master feeds. */
  listEpisodes(query: EpisodeQuery): Promise<Episode[]>;

  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

export interface BlobInfo {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
}

export interface ByteRange {
  /** Inclusive first byte. */
  start: number;
  /** Inclusive last byte. Omit for "to the end". */
  end?: number;
}

export interface BlobObject extends BlobInfo {
  body: ReadableStream<Uint8Array>;
  /** Present when the read was satisfied as a partial response. */
  range?: { start: number; end: number; total: number };
}

export interface BlobStore {
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string },
  ): Promise<BlobInfo>;
  /**
   * Range requests are not optional: podcast clients (Apple Podcasts, Pocket
   * Casts, Overcast) seek with `Range`, and a store that ignores it breaks
   * scrubbing.
   */
  get(key: string, opts?: { range?: ByteRange }): Promise<BlobObject | null>;
  head(key: string): Promise<BlobInfo | null>;
  delete(key: string): Promise<void>;
  /**
   * Direct playback URL, signed where the backend requires it.
   * `null` means "this store cannot be reached by a client" — callers fall back
   * to proxying through `GET /audio/:key`.
   */
  url(key: string, opts?: { expiresInSeconds?: number }): Promise<string | null>;
}

/** Thrown for a syntactically valid but unsatisfiable range. */
export class RangeNotSatisfiableError extends Error {
  constructor(readonly size: number) {
    super(`Range not satisfiable for object of ${size} bytes`);
    this.name = "RangeNotSatisfiableError";
  }
}

/**
 * Clamp a requested range against a known object size.
 * Returns `null` when the whole object should be returned.
 */
export function resolveRange(range: ByteRange | undefined, size: number) {
  if (!range) return null;
  if (size === 0) throw new RangeNotSatisfiableError(0);
  const requested = Math.trunc(range.start);

  // Negative start encodes the suffix form (`bytes=-500` → last 500 bytes).
  if (requested < 0) {
    const suffix = -requested;
    if (suffix === 0) throw new RangeNotSatisfiableError(size);
    return { start: Math.max(0, size - suffix), end: size - 1, total: size };
  }

  if (requested >= size) throw new RangeNotSatisfiableError(size);
  const end = range.end === undefined ? size - 1 : Math.min(Math.trunc(range.end), size - 1);
  if (end < requested) throw new RangeNotSatisfiableError(size);
  return { start: requested, end, total: size };
}

/** Parse a single-range HTTP `Range` header. Multi-range is not supported. */
export function parseRangeHeader(header: string | null): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  if (rawStart === "") {
    // Suffix form: `bytes=-500` means the last 500 bytes. Resolved by the store,
    // which is the only thing that knows the size, so signal it with a negative
    // start the store normalizes.
    return { start: -Number(rawEnd) };
  }
  return rawEnd === ""
    ? { start: Number(rawStart) }
    : { start: Number(rawStart), end: Number(rawEnd) };
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
