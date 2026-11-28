/**
 * Inspect and optionally backfill cover artwork (`artworkKey` + R2 blob) for existing
 * ready episodes in Cloudflare D1 + R2 that currently have no `artworkKey`.
 *
 * Dry-run by default — requires `--apply` to mutate R2 or D1. Never deletes any R2
 * objects or D1 rows.
 *
 * Resolution order per episode (via `ensureEpisodeArtwork` in `src/artwork/generate.ts`):
 *   1. Existing `article.imageUrl` (or safely scraped public `og:image` / `twitter:image`
 *      for older pre-Phase-C articles missing `article.imageUrl`).
 *   2. Optional Gemini editorial illustration when `--use-gemini` is passed AND
 *      `GEMINI_API_KEY` is set in the environment.
 *   3. Source feed artwork `source.imageUrl`, if present.
 *   4. Deterministic 512x512 studio cover PNG via `renderCoverPng(...)` (always succeeds).
 *
 * Usage:
 *   npx tsx scripts/backfill-artwork.ts --remote                  # dry-run report on prod D1
 *   npx tsx scripts/backfill-artwork.ts --local                   # dry-run report on local D1
 *   npx tsx scripts/backfill-artwork.ts --remote --apply --limit 5
 *   npx tsx scripts/backfill-artwork.ts --remote --apply --concurrency 3
 *   GEMINI_API_KEY=... npx tsx scripts/backfill-artwork.ts --remote --apply --use-gemini
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { artworkBlobKey, ensureEpisodeArtwork } from "../src/artwork/generate.ts";
import { articleUrl, requestPublic, type Transport } from "../src/ingest/url.ts";
import { assertSafeBlobKey } from "../src/storage/blob_key.ts";
import { type BlobInfo, type BlobStore, collect } from "../src/storage/mod.ts";
import type { Article, Episode, Source } from "../src/types.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_DB_NAME = "audio-feed";
export const DEFAULT_BUCKET_NAME = "audio-feed";
export const DEFAULT_BACKFILL_CONCURRENCY = 3;
export const MAX_BACKFILL_CONCURRENCY = 16;
export const SQL_COMMAND_INLINE_LIMIT_BYTES = 32_768;
export const OG_IMAGE_TIMEOUT_MS = 6_000;
export const MAX_OG_HTML_BYTES = 256 * 1024;
export const MAX_OG_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const OG_META_SELECTORS = [
  'meta[property="og:image:secure_url"]',
  'meta[property="og:image"]',
  'meta[property="og:image:url"]',
  'meta[name="twitter:image"]',
  'meta[property="twitter:image"]',
  'meta[name="twitter:image:src"]',
  'meta[property="twitter:image:src"]',
] as const;

export interface BackfillArtworkCliOptions {
  dbName: string;
  bucketName: string;
  target: "local" | "remote";
  apply: boolean;
  limit?: number;
  concurrency: number;
  useGemini: boolean;
  scrapeOg: boolean;
}

export interface RawArtworkCandidateRow {
  user_id: string;
  id: string;
  version: number | string;
  episode_data: string;
  article_url?: string | null;
  article_title?: string | null;
  article_image_url?: string | null;
  source_title?: string | null;
  source_image_url?: string | null;
  source_site_url?: string | null;
  source_feed_url?: string | null;
}

export interface ArtworkEpisodeCandidate {
  userId: string;
  id: string;
  version: number;
  episode: Episode;
  article: {
    url?: string;
    title?: string;
    imageUrl?: string;
  } | null;
  source: {
    title?: string;
    imageUrl?: string;
    siteUrl?: string;
    feedUrl?: string;
  } | null;
}

export interface BackfillArtworkSummary {
  count: number;
  withArticleImageUrl: number;
  eligibleForOgScrape: number;
  withSourceImageUrl: number;
  proceduralFallbackOnly: number;
}

export interface CapturedArtworkBlob {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface DiscoverOgImageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  transport?: Transport;
  fetchFn?: typeof fetch;
}

export interface ResolveCandidateArtworkOptions {
  blobs?: BlobStore;
  scrapeOg?: boolean;
  useGemini?: boolean;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  fetchFn?: typeof fetch;
  ogTransport?: Transport;
  ogTimeoutMs?: number;
}

export type ResolveCandidateArtworkResult =
  | {
    status: "skipped";
    artworkKey: string;
    reason: "already-has-artwork";
  }
  | {
    status: "generated";
    artworkKey: string;
    bytes: Uint8Array;
    contentType: string;
    scrapedOgImageUrl?: string;
  };

export interface BackfillEpisodeOutcome {
  id: string;
  userId: string;
  status: "updated" | "skipped" | "cas-conflict" | "failed";
  artworkKey?: string;
  contentType?: string;
  byteLength?: number;
  scrapedOgImageUrl?: string;
  error?: string;
}

export interface BackfillRunResult {
  dryRun: boolean;
  total: number;
  updated: number;
  skipped: number;
  casConflicts: number;
  failed: number;
  outcomes: BackfillEpisodeOutcome[];
}

export interface BackfillArtworkDeps {
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  blobs?: BlobStore;
  fetchFn?: typeof fetch;
  ogTransport?: Transport;
  ogTimeoutMs?: number;
  uploadArtwork?: (args: {
    candidate: ArtworkEpisodeCandidate;
    artworkKey: string;
    bytes: Uint8Array;
    contentType: string;
    index: number;
  }) => Promise<void>;
  commitEpisodeArtwork?: (args: {
    candidate: ArtworkEpisodeCandidate;
    artworkKey: string;
    sql: string;
    useFile: boolean;
    nextVersion: number;
    updatedEpisode: Episode;
    index: number;
  }) => Promise<boolean>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** Canonical R2 blob key for episode artwork, matching `src/artwork/generate.ts` & `src/routes/artwork.ts`. */
export function episodeArtworkKey(
  userId: string,
  episodeId: string,
  ext: "png" | "jpg" | "webp" = "png",
): string {
  return artworkBlobKey(userId, "episode", episodeId, ext);
}

/** Parse CLI flags for `scripts/backfill-artwork.ts`. Defaults strictly to safe `--local` dry-run. */
export function parseBackfillArtworkArgs(argv: readonly string[]): BackfillArtworkCliOptions {
  let dbName = DEFAULT_DB_NAME;
  let bucketName = DEFAULT_BUCKET_NAME;
  let target: "local" | "remote" = "local";
  let apply = false;
  let limit: number | undefined;
  let concurrency = DEFAULT_BACKFILL_CONCURRENCY;
  let useGemini = false;
  let scrapeOg = true;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eqIdx = raw.indexOf("=");
    const arg = eqIdx !== -1 ? raw.slice(0, eqIdx) : raw;
    const inlineVal = eqIdx !== -1 ? raw.slice(eqIdx + 1) : undefined;
    const takeValue = (): string | undefined => {
      if (inlineVal !== undefined) return inlineVal;
      if (i + 1 < argv.length) return argv[++i];
      return undefined;
    };

    if (arg === "--db") {
      const val = takeValue();
      if (val) dbName = val;
    } else if (arg === "--bucket") {
      const val = takeValue();
      if (val) bucketName = val;
    } else if (arg === "--remote") {
      target = "remote";
    } else if (arg === "--local") {
      target = "local";
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg === "--use-gemini") {
      useGemini = true;
    } else if (arg === "--no-gemini") {
      useGemini = false;
    } else if (arg === "--scrape-og") {
      scrapeOg = true;
    } else if (arg === "--no-scrape-og") {
      scrapeOg = false;
    } else if (arg === "--limit") {
      const val = takeValue();
      if (val !== undefined) {
        const parsed = Number.parseInt(val, 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      }
    } else if (arg === "--concurrency") {
      const val = takeValue();
      if (val !== undefined) {
        const parsed = Number.parseInt(val, 10);
        if (Number.isFinite(parsed) && parsed >= 1) {
          concurrency = Math.min(MAX_BACKFILL_CONCURRENCY, parsed);
        }
      }
    }
  }

  return { dbName, bucketName, target, apply, limit, concurrency, useGemini, scrapeOg };
}

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function tryParseJsonFragment<T>(fragment: string, openChar: "[" | "{"): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(fragment) as T };
  } catch {
    const closeChar = openChar === "[" ? "]" : "}";
    const endIdx = fragment.lastIndexOf(closeChar);
    if (endIdx > 0 && endIdx < fragment.length - 1) {
      try {
        return { ok: true, value: JSON.parse(fragment.slice(0, endIdx + 1)) as T };
      } catch {
        // fall through
      }
    }
    return { ok: false };
  }
}

/**
 * Parse JSON output from `wrangler d1 execute --json`, stripping any leading or trailing
 * spinner, banner, or warning chrome that Wrangler prints to stdout around the JSON payload.
 */
export function parseWranglerJson<T>(raw: string): T {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const openChar = trimmed[0] as "[" | "{";
    const parsed = tryParseJsonFragment<T>(trimmed, openChar);
    if (parsed.ok) return parsed.value;
  }
  // Prefer newline-anchored JSON starts first so `[update available]` or `[WARN]` in banner
  // lines do not prematurely match before the real JSON payload.
  for (const [marker, openChar] of [["\n[", "["], ["\n{", "{"]] as const) {
    let idx = trimmed.indexOf(marker);
    while (idx !== -1) {
      const candidate = trimmed.slice(idx + 1).trim();
      const parsed = tryParseJsonFragment<T>(candidate, openChar);
      if (parsed.ok) return parsed.value;
      idx = trimmed.indexOf(marker, idx + 1);
    }
  }
  for (const ch of ["[", "{"] as const) {
    let idx = trimmed.indexOf(ch);
    while (idx !== -1) {
      const candidate = trimmed.slice(idx).trim();
      const parsed = tryParseJsonFragment<T>(candidate, ch);
      if (parsed.ok) return parsed.value;
      idx = trimmed.indexOf(ch, idx + 1);
    }
  }
  return JSON.parse(trimmed) as T;
}

/**
 * Build the D1 SELECT query for ready episodes missing `artworkKey`, joined with
 * lightweight `articles` and `sources` metadata (never pulling full article body text).
 */
export function buildMissingArtworkQuerySql(limit?: number): string {
  const limitClause = limit && Number.isSafeInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : "";
  return (
    `SELECT ` +
    `e.user_id, ` +
    `e.id, ` +
    `e.version, ` +
    `e.data AS episode_data, ` +
    `COALESCE(json_extract(a.data, '$.url'), a.url) AS article_url, ` +
    `json_extract(a.data, '$.title') AS article_title, ` +
    `json_extract(a.data, '$.imageUrl') AS article_image_url, ` +
    `json_extract(s.data, '$.title') AS source_title, ` +
    `json_extract(s.data, '$.imageUrl') AS source_image_url, ` +
    `json_extract(s.data, '$.siteUrl') AS source_site_url, ` +
    `json_extract(s.data, '$.feedUrl') AS source_feed_url ` +
    `FROM episodes e ` +
    `LEFT JOIN articles a ON a.user_id = e.user_id AND a.id = json_extract(e.data, '$.articleId') ` +
    `LEFT JOIN sources s ON s.user_id = e.user_id AND s.id = e.source_id ` +
    `WHERE e.status = 'ready' ` +
    `AND (json_extract(e.data, '$.artworkKey') IS NULL OR json_extract(e.data, '$.artworkKey') = '') ` +
    `ORDER BY e.created_at DESC${limitClause}`
  );
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseArtworkCandidateRow(row: RawArtworkCandidateRow): ArtworkEpisodeCandidate {
  const episode = JSON.parse(row.episode_data) as Episode;
  const articleUrlVal = nonEmptyString(row.article_url);
  const articleTitleVal = nonEmptyString(row.article_title);
  const articleImageVal = nonEmptyString(row.article_image_url);
  const article = (articleUrlVal || articleTitleVal || articleImageVal)
    ? {
      ...(articleUrlVal ? { url: articleUrlVal } : {}),
      ...(articleTitleVal ? { title: articleTitleVal } : {}),
      ...(articleImageVal ? { imageUrl: articleImageVal } : {}),
    }
    : null;

  const sourceTitleVal = nonEmptyString(row.source_title);
  const sourceImageVal = nonEmptyString(row.source_image_url);
  const sourceSiteVal = nonEmptyString(row.source_site_url);
  const sourceFeedVal = nonEmptyString(row.source_feed_url);
  const source = (sourceTitleVal || sourceImageVal || sourceSiteVal || sourceFeedVal)
    ? {
      ...(sourceTitleVal ? { title: sourceTitleVal } : {}),
      ...(sourceImageVal ? { imageUrl: sourceImageVal } : {}),
      ...(sourceSiteVal ? { siteUrl: sourceSiteVal } : {}),
      ...(sourceFeedVal ? { feedUrl: sourceFeedVal } : {}),
    }
    : null;

  return {
    userId: row.user_id,
    id: row.id,
    version: Number(row.version),
    episode,
    article,
    source,
  };
}

function isPublicHttpUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    articleUrl(raw);
    return true;
  } catch {
    return false;
  }
}

export function summarizeArtworkCandidates(
  candidates: readonly ArtworkEpisodeCandidate[],
): BackfillArtworkSummary {
  let withArticleImageUrl = 0;
  let eligibleForOgScrape = 0;
  let withSourceImageUrl = 0;
  let proceduralFallbackOnly = 0;

  for (const c of candidates) {
    if (isPublicHttpUrl(c.article?.imageUrl)) {
      withArticleImageUrl++;
    } else if (isPublicHttpUrl(c.article?.url)) {
      eligibleForOgScrape++;
    } else if (isPublicHttpUrl(c.source?.imageUrl)) {
      withSourceImageUrl++;
    } else {
      proceduralFallbackOnly++;
    }
  }

  return {
    count: candidates.length,
    withArticleImageUrl,
    eligibleForOgScrape,
    withSourceImageUrl,
    proceduralFallbackOnly,
  };
}

/**
 * Build the optimistic-CAS D1 `UPDATE episodes` statement that sets `artworkKey` inside
 * `episodes.data` while incrementing `version`. Sets `useFile` when SQL exceeds 32 KiB.
 */
export function buildArtworkUpdateSql(
  candidate: Pick<ArtworkEpisodeCandidate, "userId" | "id" | "version" | "episode">,
  artworkKey: string,
): { sql: string; nextVersion: number; updatedEpisode: Episode; useFile: boolean } {
  if (!Number.isSafeInteger(candidate.version) || candidate.version < 0) {
    throw new Error(`Invalid episode version for ${candidate.id}: ${candidate.version}`);
  }
  assertSafeBlobKey(artworkKey);
  const updatedEpisode: Episode = {
    ...candidate.episode,
    artworkKey,
  };
  const nextVersion = candidate.version + 1;
  const sql =
    `UPDATE episodes ` +
    `SET version = ${nextVersion}, ` +
    `data = ${sqlLiteral(JSON.stringify(updatedEpisode))} ` +
    `WHERE user_id = ${sqlLiteral(candidate.userId)} ` +
    `AND id = ${sqlLiteral(candidate.id)} ` +
    `AND version = ${candidate.version};`;
  const useFile = Buffer.byteLength(sql, "utf8") > SQL_COMMAND_INLINE_LIMIT_BYTES;
  return { sql, nextVersion, updatedEpisode, useFile };
}

export function buildR2PutArgs(options: {
  bucketName: string;
  artworkKey: string;
  filePath: string;
  contentType: string;
  target: "local" | "remote";
}): string[] {
  assertSafeBlobKey(options.artworkKey);
  return [
    "r2",
    "object",
    "put",
    `${options.bucketName}/${options.artworkKey}`,
    "--file",
    options.filePath,
    "--content-type",
    options.contentType,
    options.target === "remote" ? "--remote" : "--local",
  ];
}

export function buildD1ExecuteArgs(options: {
  dbName: string;
  target: "local" | "remote";
  sql: string;
  sqlFilePath?: string;
  useFile: boolean;
}): string[] {
  if (options.useFile && !options.sqlFilePath) {
    throw new Error("sqlFilePath is required when useFile is true");
  }
  return [
    "d1",
    "execute",
    options.dbName,
    options.target === "remote" ? "--remote" : "--local",
    "--yes",
    "--json",
    ...(options.useFile ? ["--file", options.sqlFilePath!] : ["--command", options.sql]),
  ];
}

/**
 * Pure SSRF-safe extraction of OpenGraph / Twitter Card image URL from HTML.
 * Resolves relative URLs against `pageUrl` and rejects non-public / private / invalid URLs
 * via `articleUrl(...)`.
 */
export function extractOgImageFromHtml(html: string, pageUrl: string): string | null {
  if (!html) return null;
  let baseHref: string;
  try {
    baseHref = articleUrl(pageUrl).href;
  } catch {
    return null;
  }
  try {
    const { document } = parseHTML(html);
    for (const selector of OG_META_SELECTORS) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const raw = node.getAttribute("content")?.trim();
        if (!raw) continue;
        try {
          const resolved = new URL(raw, baseHref).href;
          return articleUrl(resolved).href;
        } catch {
          // Reject unsafe/private/invalid candidate and check next meta tag.
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function maybeDecompressStream(
  body: ReadableStream<Uint8Array> | null,
  encoding: string | null,
): ReadableStream<Uint8Array> | null {
  if (!body || !encoding) return body;
  const normalized = encoding.trim().toLowerCase();
  if (normalized === "" || normalized === "identity") return body;
  if (normalized === "gzip" || normalized === "x-gzip") {
    return body.pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  }
  if (normalized === "deflate") {
    return body.pipeThrough(
      new DecompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  }
  return null;
}

function wrapFetchAsTransport(fetchFn: typeof fetch): Transport {
  return async (url, signal, init) => {
    const res = await fetchFn(url.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: init?.headers,
    });
    // `fetch` already decompresses gzip/deflate transparently; omit `content-encoding`
    // so downstream code does not attempt double decompression.
    const headers = new Headers();
    for (const name of ["content-type", "content-length", "location"]) {
      const value = res.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if ([204, 205, 304].includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      return new Response(null, { status: res.status, headers });
    }
    return new Response(res.body, { status: res.status, headers });
  };
}

async function readHeadBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let html = "";
  let totalBytes = 0;

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        break;
      }
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      totalBytes += slice.byteLength;
      html += decoder.decode(slice, { stream: true });
      const headClose = html.search(/<\/head>/i);
      if (headClose !== -1) {
        html = html.slice(0, headClose + "</head>".length);
        await reader.cancel().catch(() => {});
        break;
      }
      if (totalBytes >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    html += decoder.decode();
    return html;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * Safely scrape an article page's public `og:image` / `twitter:image` URL.
 *
 * Enforces SSRF protection via `articleUrl` on the initial URL, every redirect hop,
 * and the extracted image URL, uses `requestPublic` (`publicLookup()`) by default in Node,
 * applies a short timeout and 256 KiB read cap, and swallows all failures cleanly (`null`).
 */
export async function discoverArticleOgImage(
  rawUrl: string,
  options: DiscoverOgImageOptions = {},
): Promise<string | null> {
  let currentUrl: URL;
  try {
    currentUrl = articleUrl(rawUrl);
  } catch {
    return null;
  }

  const timeoutMs = options.timeoutMs ?? OG_IMAGE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_OG_HTML_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_OG_REDIRECTS;
  const transport: Transport = options.transport ??
    (options.fetchFn ? wrapFetchAsTransport(options.fetchFn) : requestPublic);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await transport(currentUrl, controller.signal, {
        headers: {
          "Accept": "text/html, application/xhtml+xml;q=0.9, */*;q=0.1",
        },
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location || hop === maxRedirects) return null;
        try {
          currentUrl = articleUrl(new URL(location, currentUrl).href);
        } catch {
          return null;
        }
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        return null;
      }

      const encoding = res.headers.get("content-encoding");
      const stream = maybeDecompressStream(res.body, encoding);
      if (!stream) {
        await res.body?.cancel().catch(() => {});
        return null;
      }

      const html = await readHeadBounded(stream, maxBytes, controller.signal);
      if (controller.signal.aborted) return null;
      return extractOgImageFromHtml(html, currentUrl.href);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Node CLI `fetch` adapter for `ensureEpisodeArtwork` that routes GET image downloads through
 * `requestPublic` (`publicLookup()` + manual redirect validation via `articleUrl`), while
 * forwarding POST requests (Gemini Image Gen API) to standard `fetch`.
 */
export function createSafePublicFetch(transport: Transport = requestPublic): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") {
      return await globalThis.fetch(input, init);
    }

    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    let currentUrl = articleUrl(rawUrl);
    const signal = init?.signal ?? new AbortController().signal;

    const reqHeaders: Record<string, string> = {
      "Accept-Encoding": "identity",
    };
    if (init?.headers) {
      const h = new Headers(init.headers);
      const accept = h.get("accept");
      if (accept) reqHeaders["Accept"] = accept;
    }

    for (let hop = 0; hop <= MAX_OG_REDIRECTS; hop++) {
      const res = await transport(currentUrl, signal, { headers: reqHeaders });
      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location || hop === MAX_OG_REDIRECTS) {
          return new Response(null, { status: 502 });
        }
        currentUrl = articleUrl(new URL(location, currentUrl).href);
        continue;
      }
      const encoding = res.headers.get("content-encoding");
      const isCompressed = Boolean(
        encoding && encoding.trim() && encoding.trim().toLowerCase() !== "identity",
      );
      const body = maybeDecompressStream(res.body, encoding);
      if (res.body && !body) {
        await res.body.cancel().catch(() => {});
        return new Response(null, { status: 415 });
      }
      const headers = new Headers();
      const ct = res.headers.get("content-type");
      if (ct !== null) headers.set("content-type", ct);
      if (!isCompressed) {
        const cl = res.headers.get("content-length");
        if (cl !== null) headers.set("content-length", cl);
      }
      return new Response(body, { status: res.status, headers });
    }
    return new Response(null, { status: 502 });
  };
}

/**
 * `BlobStore` wrapper that records the exact `{ key, bytes, contentType }` written by
 * `ensureEpisodeArtwork`, optionally forwarding reads/writes to an underlying `BlobStore`
 * (e.g. `MemoryBlobStore` in tests). Explicitly forbids `delete()`.
 */
export function createCapturingBlobStore(delegate?: BlobStore): {
  blobs: BlobStore;
  getCaptured(): CapturedArtworkBlob | null;
} {
  let captured: CapturedArtworkBlob | null = null;

  const blobs: BlobStore = {
    async put(key, body, opts): Promise<BlobInfo> {
      assertSafeBlobKey(key);
      const bytes = body instanceof Uint8Array ? body : await collect(body);
      const contentType = opts?.contentType ?? "application/octet-stream";
      captured = { key, bytes, contentType };
      if (delegate) {
        return await delegate.put(key, bytes, opts);
      }
      return { key, size: bytes.byteLength, contentType };
    },
    async putIfAbsent(key, body, opts): Promise<BlobInfo | null> {
      assertSafeBlobKey(key);
      const bytes = body instanceof Uint8Array ? body : await collect(body);
      const contentType = opts?.contentType ?? "application/octet-stream";
      if (delegate) {
        const res = await delegate.putIfAbsent(key, bytes, opts);
        if (res) captured = { key, bytes, contentType };
        return res;
      }
      captured = { key, bytes, contentType };
      return { key, size: bytes.byteLength, contentType };
    },
    async get(key, opts) {
      return delegate ? await delegate.get(key, opts) : null;
    },
    async head(key) {
      return delegate ? await delegate.head(key) : null;
    },
    async delete(): Promise<void> {
      throw new Error("backfill-artwork must never delete blobs");
    },
    async url(key, opts) {
      return delegate ? await delegate.url(key, opts) : null;
    },
    directUrlOrigin() {
      return delegate ? delegate.directUrlOrigin() : null;
    },
  };

  return {
    blobs,
    getCaptured: () => captured,
  };
}

/**
 * Resolve cover artwork for one episode candidate using `ensureEpisodeArtwork`.
 *
 * - Idempotent: if `candidate.episode.artworkKey` is already populated (and present in `blobs`
 *   when a `BlobStore` is supplied), returns `status: "skipped"` without writing.
 * - If `article.imageUrl` is missing and `scrapeOg` is enabled, safely scrapes the article's
 *   public `og:image` before calling `ensureEpisodeArtwork`.
 * - Falls back cleanly via `ensureEpisodeArtwork`: article image -> Gemini (only if
 *   `useGemini && geminiApiKey`) -> source image -> deterministic 512x512 procedural PNG.
 */
export async function resolveCandidateArtwork(
  candidate: ArtworkEpisodeCandidate,
  options: ResolveCandidateArtworkOptions = {},
): Promise<ResolveCandidateArtworkResult> {
  const existingKey = nonEmptyString(candidate.episode.artworkKey);
  if (existingKey) {
    if (!options.blobs) {
      return {
        status: "skipped",
        artworkKey: existingKey,
        reason: "already-has-artwork",
      };
    }
    const head = await options.blobs.head(existingKey).catch(() => null);
    if (head) {
      return {
        status: "skipped",
        artworkKey: existingKey,
        reason: "already-has-artwork",
      };
    }
  }

  let scrapedOgImageUrl: string | undefined;
  const shouldScrapeOg = options.scrapeOg !== false;
  if (!candidate.article?.imageUrl && shouldScrapeOg && candidate.article?.url) {
    const discovered = await discoverArticleOgImage(candidate.article.url, {
      timeoutMs: options.ogTimeoutMs,
      transport: options.ogTransport,
      fetchFn: options.fetchFn,
    });
    if (discovered) {
      scrapedOgImageUrl = discovered;
    }
  }

  const effectiveArticleImageUrl = candidate.article?.imageUrl || scrapedOgImageUrl;
  const articleForArtwork: Article | null = (candidate.article || effectiveArticleImageUrl)
    ? {
      id: candidate.episode.articleId,
      userId: candidate.userId,
      sourceId: candidate.episode.sourceId,
      url: candidate.article?.url ?? "",
      title: candidate.article?.title ?? candidate.episode.title,
      content: "",
      ingestedAt: candidate.episode.createdAt,
      ...(effectiveArticleImageUrl ? { imageUrl: effectiveArticleImageUrl } : {}),
    }
    : null;

  const sourceForArtwork: Source | null = candidate.source
    ? {
      id: candidate.episode.sourceId,
      userId: candidate.userId,
      title: candidate.source.title || candidate.episode.sourceTitle || candidate.episode.title,
      ...(candidate.source.feedUrl ? { feedUrl: candidate.source.feedUrl } : {}),
      ...(candidate.source.siteUrl ? { siteUrl: candidate.source.siteUrl } : {}),
      ...(candidate.source.imageUrl ? { imageUrl: candidate.source.imageUrl } : {}),
      modes: [candidate.episode.mode],
      voices: {},
      createdAt: candidate.episode.createdAt,
    }
    : null;

  const { blobs, getCaptured } = createCapturingBlobStore(options.blobs);
  const fetchFn = options.fetchFn ?? createSafePublicFetch();
  const allowGeminiImageGen = Boolean(options.useGemini && options.geminiApiKey);

  const artworkKey = await ensureEpisodeArtwork({
    blobs,
    episode: {
      ...candidate.episode,
      // Ensure ensureEpisodeArtwork regenerates if existingKey was missing in blobs.
      artworkKey: undefined,
    },
    article: articleForArtwork,
    source: sourceForArtwork,
    geminiApiKey: allowGeminiImageGen ? options.geminiApiKey : undefined,
    geminiBaseUrl: options.geminiBaseUrl,
    allowGeminiImageGen,
    fetchFn,
  });

  const captured = getCaptured();
  if (!artworkKey || !captured || captured.key !== artworkKey || captured.bytes.byteLength === 0) {
    throw new Error(`ensureEpisodeArtwork produced no artwork blob for episode ${candidate.id}`);
  }
  assertSafeBlobKey(artworkKey);

  return {
    status: "generated",
    artworkKey,
    bytes: captured.bytes,
    contentType: captured.contentType,
    ...(scrapedOgImageUrl ? { scrapedOgImageUrl } : {}),
  };
}

/** Run async work over `items` with a bounded worker pool, preserving result order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!, idx);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

/**
 * Orchestrate artwork backfill across candidates with bounded concurrency, dry-run safety,
 * optimistic D1 CAS updates, idempotency, and per-episode error isolation.
 */
export async function backfillArtworkCandidates(
  candidates: readonly ArtworkEpisodeCandidate[],
  opts: BackfillArtworkCliOptions,
  deps: BackfillArtworkDeps = {},
): Promise<BackfillRunResult> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const errorLog = deps.error ?? console.error;

  if (!opts.apply) {
    return {
      dryRun: true,
      total: candidates.length,
      updated: 0,
      skipped: candidates.length,
      casConflicts: 0,
      failed: 0,
      outcomes: [],
    };
  }

  const outcomes = await mapWithConcurrency(
    candidates,
    opts.concurrency,
    async (candidate, index): Promise<BackfillEpisodeOutcome> => {
      try {
        const resolved = await resolveCandidateArtwork(candidate, {
          blobs: deps.blobs,
          scrapeOg: opts.scrapeOg,
          useGemini: opts.useGemini,
          geminiApiKey: deps.geminiApiKey,
          geminiBaseUrl: deps.geminiBaseUrl,
          fetchFn: deps.fetchFn,
          ogTransport: deps.ogTransport,
          ogTimeoutMs: deps.ogTimeoutMs,
        });

        if (resolved.status === "skipped") {
          log(
            `[backfill-artwork] Skipped ${candidate.id} (already has artworkKey=${resolved.artworkKey})`,
          );
          return {
            id: candidate.id,
            userId: candidate.userId,
            status: "skipped",
            artworkKey: resolved.artworkKey,
          };
        }

        if (deps.uploadArtwork) {
          await deps.uploadArtwork({
            candidate,
            artworkKey: resolved.artworkKey,
            bytes: resolved.bytes,
            contentType: resolved.contentType,
            index,
          });
        }

        const cas = buildArtworkUpdateSql(candidate, resolved.artworkKey);
        const committed = deps.commitEpisodeArtwork
          ? await deps.commitEpisodeArtwork({
            candidate,
            artworkKey: resolved.artworkKey,
            sql: cas.sql,
            useFile: cas.useFile,
            nextVersion: cas.nextVersion,
            updatedEpisode: cas.updatedEpisode,
            index,
          })
          : true;

        if (!committed) {
          warn(
            `[backfill-artwork] Skipped CAS commit for ${candidate.id} ` +
              `(concurrent version change at v${candidate.version}; no rows deleted).`,
          );
          return {
            id: candidate.id,
            userId: candidate.userId,
            status: "cas-conflict",
            artworkKey: resolved.artworkKey,
            contentType: resolved.contentType,
            byteLength: resolved.bytes.byteLength,
            scrapedOgImageUrl: resolved.scrapedOgImageUrl,
          };
        }

        log(
          `[backfill-artwork] Updated ${candidate.id} -> ${resolved.artworkKey} ` +
            `(${resolved.contentType}, ${(resolved.bytes.byteLength / 1024).toFixed(1)} KiB` +
            `${resolved.scrapedOgImageUrl ? ", scraped og:image" : ""})`,
        );
        return {
          id: candidate.id,
          userId: candidate.userId,
          status: "updated",
          artworkKey: resolved.artworkKey,
          contentType: resolved.contentType,
          byteLength: resolved.bytes.byteLength,
          scrapedOgImageUrl: resolved.scrapedOgImageUrl,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errorLog(`[backfill-artwork] Failed ${candidate.id}: ${message}`);
        return {
          id: candidate.id,
          userId: candidate.userId,
          status: "failed",
          error: message,
        };
      }
    },
  );

  let updated = 0;
  let skipped = 0;
  let casConflicts = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "updated") updated++;
    else if (outcome.status === "skipped") skipped++;
    else if (outcome.status === "cas-conflict") casConflicts++;
    else failed++;
  }

  return {
    dryRun: false,
    total: candidates.length,
    updated,
    skipped,
    casConflicts,
    failed,
    outcomes,
  };
}

async function runWrangler(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("npx", ["wrangler", ...args], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    const detail = (e.stderr || e.stdout || e.message || String(err)).trim();
    throw new Error(`wrangler ${args[0] ?? ""} failed: ${detail}`);
  }
}

async function queryMissingArtworkEpisodes(
  opts: BackfillArtworkCliOptions,
): Promise<ArtworkEpisodeCandidate[]> {
  const sql = buildMissingArtworkQuerySql(opts.limit);
  const raw = await runWrangler(
    buildD1ExecuteArgs({
      dbName: opts.dbName,
      target: opts.target,
      sql,
      useFile: false,
    }),
  );

  const parsed = parseWranglerJson<Array<{ results?: RawArtworkCandidateRow[] }>>(raw);
  const rows = parsed[0]?.results ?? [];
  return rows.map(parseArtworkCandidateRow);
}

function safeTempStem(id: string, index: number): string {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return `ep-${index}-${safeId}`;
}

async function main(): Promise<void> {
  const opts = parseBackfillArtworkArgs(process.argv.slice(2));
  const geminiApiKey = nonEmptyString(process.env.GEMINI_API_KEY);
  const geminiBaseUrl = nonEmptyString(process.env.GEMINI_API_BASE_URL);

  if (opts.useGemini && !geminiApiKey) {
    console.warn(
      "[backfill-artwork] --use-gemini was passed but GEMINI_API_KEY is unset; " +
        "will fall back cleanly to article/og:image -> source image -> procedural PNG.",
    );
  }

  const candidates = await queryMissingArtworkEpisodes(opts);
  const summary = summarizeArtworkCandidates(candidates);

  console.log(
    `[backfill-artwork] Found ${summary.count} ready episode(s) without artworkKey ` +
      `in D1 "${opts.dbName}" (${opts.target})`,
  );
  console.log(
    `[backfill-artwork] Breakdown: article.imageUrl=${summary.withArticleImageUrl}, ` +
      `public-url-og-scrape=${summary.eligibleForOgScrape}, ` +
      `source.imageUrl=${summary.withSourceImageUrl}, ` +
      `procedural-fallback=${summary.proceduralFallbackOnly}`,
  );
  console.log(
    `[backfill-artwork] Options: mode=${opts.apply ? "apply" : "dry-run"}, ` +
      `concurrency=${opts.concurrency}, scrapeOg=${opts.scrapeOg}, ` +
      `gemini=${Boolean(opts.useGemini && geminiApiKey)}`,
  );

  for (const c of candidates.slice(0, 15)) {
    const hint = isPublicHttpUrl(c.article?.imageUrl)
      ? `article.imageUrl`
      : isPublicHttpUrl(c.article?.url)
      ? `og:image(${c.article!.url})`
      : isPublicHttpUrl(c.source?.imageUrl)
      ? `source.imageUrl`
      : "procedural";
    console.log(
      `  - ${c.id} (${c.episode.mode}, v${c.version}) "${c.episode.title}" [${hint}]`,
    );
  }
  if (candidates.length > 15) {
    console.log(`  ... and ${candidates.length - 15} more`);
  }

  if (!opts.apply) {
    console.log(
      "[backfill-artwork] Dry-run complete (no R2 or D1 changes made). Pass --apply to backfill.",
    );
    return;
  }

  if (candidates.length === 0) {
    console.log("[backfill-artwork] Nothing to backfill.");
    return;
  }

  const scratchDir = mkdtempSync(join(tmpdir(), "audio-feed-backfill-artwork-"));
  try {
    const result = await backfillArtworkCandidates(candidates, opts, {
      geminiApiKey,
      geminiBaseUrl,
      uploadArtwork: async ({ candidate, artworkKey, bytes, contentType, index }) => {
        const ext = contentType === "image/jpeg"
          ? "jpg"
          : contentType === "image/webp"
          ? "webp"
          : "png";
        const filePath = join(scratchDir, `${safeTempStem(candidate.id, index)}.${ext}`);
        try {
          writeFileSync(filePath, bytes);
          await runWrangler(
            buildR2PutArgs({
              bucketName: opts.bucketName,
              artworkKey,
              filePath,
              contentType,
              target: opts.target,
            }),
          );
        } finally {
          rmSync(filePath, { force: true });
        }
      },
      commitEpisodeArtwork: async ({ candidate, sql, useFile, index }) => {
        const sqlPath = join(scratchDir, `${safeTempStem(candidate.id, index)}.sql`);
        try {
          if (useFile) {
            writeFileSync(sqlPath, sql, "utf8");
          }
          const out = await runWrangler(
            buildD1ExecuteArgs({
              dbName: opts.dbName,
              target: opts.target,
              sql,
              sqlFilePath: useFile ? sqlPath : undefined,
              useFile,
            }),
          );
          const parsed = parseWranglerJson<Array<{ meta?: { changes?: number } }>>(out);
          return (parsed[0]?.meta?.changes ?? 0) === 1;
        } finally {
          rmSync(sqlPath, { force: true });
        }
      },
    });

    console.log(
      `[backfill-artwork] Completed: updated=${result.updated}/${result.total}, ` +
        `skipped=${result.skipped}, casConflicts=${result.casConflicts}, failed=${result.failed}`,
    );
    if (result.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

const entrypoint = process.argv[1];
const isEntrypoint = entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error("[backfill-artwork] Fatal error:", err);
    process.exitCode = 1;
  });
}
