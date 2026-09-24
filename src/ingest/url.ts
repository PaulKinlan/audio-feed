/// <reference lib="dom" />
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import ipaddr from "npm:ipaddr.js@2.2.0";
import { parseHTML } from "npm:linkedom@0.18.12";
import { type AudioMode, isAudioMode, isSynthesisAuthorized, type User } from "../types.ts";

export interface ExtractedArticle {
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  lead: string;
  body: string;
}

export type IngestPayload =
  | { mode: "direct"; article: ExtractedArticle; narration: string }
  | { mode: "deepdive"; article: ExtractedArticle };

export class IngestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "IngestError";
  }
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_ARTICLE_CONTENT_CHARS = 100_000;
const TIMEOUT_MS = 15_000;

/** Only global unicast addresses: deny loopback, LAN, metadata and transition ranges. */
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

export function articleUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new IngestError(400, "Provide an absolute HTTP or HTTPS article URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.port || hostname.endsWith(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname) ||
    (ipaddr.isValid(hostname) && !isPublicAddress(hostname))
  ) {
    throw new IngestError(400, "Only public HTTP(S) article URLs on standard ports are allowed.");
  }
  url.hash = "";
  return url;
}

/** Validate the addresses handed to the actual socket, not a separate DNS preflight. */
export function publicLookup(
  resolve: (host: string) => Promise<{ address: string; family: number }[]> = (host) =>
    lookup(host, { all: true, verbatim: true }),
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then((addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new IngestError(400, "Article hostname must resolve only to public addresses.");
      }
      const family = typeof options === "number" ? options : options.family;
      const selected = addresses.filter((item) => !family || item.family === family);
      const first = selected[0];
      if (!first) throw new IngestError(502, "Article hostname has no usable address.");
      if (typeof options === "object" && options.all) {
        callback(null, selected);
      } else {
        callback(null, first.address, first.family);
      }
    }).catch((error) => callback(error, "", 0));
  };
}

type Transport = (url: URL, signal: AbortSignal) => Promise<Response>;

/** Node's HTTP client exposes lookup; native Deno fetch would resolve again after validation. */
const requestPublic: Transport = (url, signal) => {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      lookup: publicLookup(),
      signal,
      agent: false,
      maxHeaderSize: 16 * 1024,
      headers: {
        "Accept": "text/html, application/xhtml+xml",
        "Accept-Encoding": "identity",
        "User-Agent": "AudioFeed/1.0 (article reader)",
      },
    }, (incoming) => {
      const headers = new Headers();
      for (const name of ["content-type", "content-length", "content-encoding", "location"]) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const status = incoming.statusCode ?? 502;
      if ([204, 205, 304].includes(status)) {
        incoming.destroy();
        resolve(new Response(null, { status, headers }));
      } else {
        const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status, headers }));
      }
    });
    request.on("error", reject);
    request.end();
  });
};

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  status: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (signal.aborted) throw new IngestError(408, "Request body timed out or was cancelled.");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new IngestError(408, "Request body timed out or was cancelled.");
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        throw new IngestError(status, "Request or article exceeds the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetch only server-rendered public HTML; never execute scripts or bypass a paywall. */
export async function fetchArticle(
  input: string,
  options: { transport?: Transport; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExtractedArticle> {
  let url = articleUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await (options.transport ?? requestPublic)(url, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || hop === 5) {
          throw new IngestError(422, "Article has an invalid or excessive redirect chain.");
        }
        url = articleUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new IngestError(422, "Article is unavailable or requires a subscription.");
      }
      const contentType = response.headers.get("content-type") ?? "";
      const encoding = response.headers.get("content-encoding");
      if (
        !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType) ||
        (encoding && encoding !== "identity")
      ) {
        await response.body?.cancel();
        throw new IngestError(422, "Article must be an uncompressed HTML page.");
      }
      if (Number(response.headers.get("content-length")) > MAX_HTML_BYTES) {
        await response.body?.cancel();
        throw new IngestError(413, "Article exceeds the 2 MiB size limit.");
      }
      const bytes = await readBounded(response.body, MAX_HTML_BYTES, 413, signal);
      const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
      let html: string;
      try {
        html = new TextDecoder(charset).decode(bytes);
      } catch {
        throw new IngestError(422, "Article uses an unsupported character encoding.");
      }
      return extractArticle(html, url.href);
    }
    throw new IngestError(422, "Article could not be fetched.");
  } catch (error) {
    if (signal.aborted) throw new IngestError(504, "Article fetch timed out or was cancelled.");
    if (error instanceof IngestError) throw error;
    throw new IngestError(502, "Unable to fetch the article.");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Feed documents (audio-feed-2e5).
 *
 * A feed URL is user-supplied, so fetching it is the same SSRF surface as
 * fetching an article: it must resolve publicly, and every REDIRECT must be
 * re-checked, because a hostile feed can redirect to an internal address. This
 * reuses `requestPublic` and `readBounded` rather than restating those rules, so
 * a fix to the guard cannot leave the feed path behind.
 *
 * The difference from `fetchArticle` is only the accepted content types: a feed
 * is XML, never HTML. HTML is refused deliberately — parsing a random web page as
 * a feed would turn "subscribe to this URL" into a content-scraping primitive.
 */
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FEED_CONTENT_TYPE =
  /^(application\/(rss|atom)\+xml|application\/xml|text\/xml|text\/rss|text\/plain|application\/octet-stream)(?:;|$)/i;

export async function fetchFeedDocument(
  input: string,
  options: {
    transport?: (url: URL, signal: AbortSignal) => Promise<Response>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<{ xml: string; url: string }> {
  let url = articleUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await (options.transport ?? requestPublic)(url, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || hop === 5) {
          throw new IngestError(422, "Feed has an invalid or excessive redirect chain.");
        }
        // Re-resolved through the public lookup, exactly as fetchArticle does.
        url = articleUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new IngestError(422, "Feed is unavailable or requires a subscription.");
      }
      const contentType = response.headers.get("content-type") ?? "";
      const encoding = response.headers.get("content-encoding");
      if (!FEED_CONTENT_TYPE.test(contentType) || (encoding && encoding !== "identity")) {
        await response.body?.cancel();
        throw new IngestError(422, "That URL is not an uncompressed RSS or Atom feed.");
      }
      if (Number(response.headers.get("content-length")) > MAX_FEED_BYTES) {
        await response.body?.cancel();
        throw new IngestError(413, "Feed exceeds the 2 MiB size limit.");
      }
      const bytes = await readBounded(response.body, MAX_FEED_BYTES, 413, signal);
      const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
      let xml: string;
      try {
        xml = new TextDecoder(charset).decode(bytes);
      } catch {
        throw new IngestError(422, "Feed uses an unsupported character encoding.");
      }
      const trimmed = xml.trimStart();
      if (
        !trimmed.startsWith("<?xml") && !trimmed.startsWith("<rss") && !trimmed.startsWith("<feed")
      ) {
        throw new IngestError(422, "That URL is not an uncompressed RSS or Atom feed.");
      }
      return { xml, url: url.href };
    }
    throw new IngestError(422, "Feed could not be fetched.");
  } catch (error) {
    if (signal.aborted) throw new IngestError(504, "Feed fetch timed out or was cancelled.");
    if (error instanceof IngestError) throw error;
    throw new IngestError(502, "Unable to fetch the feed.");
  } finally {
    clearTimeout(timeout);
  }
}

const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

function plainText(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  const text = Array.from(node.childNodes).map(plainText).join("");
  return /^(P|DIV|SECTION|H[1-6]|LI|UL|OL|PRE|BLOCKQUOTE|BR|TR)$/.test(node.nodeName)
    ? `\n${text}\n`
    : text;
}

export function extractArticle(html: string, sourceUrl: string): ExtractedArticle {
  const url = articleUrl(sourceUrl).href;
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
    throw new IngestError(413, "Article exceeds the 2 MiB size limit.");
  }
  const { document } = parseHTML(html);
  const date = document.querySelector(
    'meta[property="article:published_time"], meta[name="date"], time[datetime]',
  );
  const explicitDate = date?.getAttribute("content") ?? date?.getAttribute("datetime");
  const bylineNodes = document.querySelectorAll(
    '.byline, .author, [rel="author"], [itemprop="author"]',
  );
  const byline = clean(bylineNodes[0]?.textContent);
  // Readability can leave a visible byline in the body when a meta author already exists.
  for (const node of bylineNodes) {
    if (clean(node.textContent).length < 200) node.remove();
  }
  // Retain JSON-LD for Readability's title, author and date extraction. It is data, never executed.
  for (
    const node of document.querySelectorAll(
      'nav, aside, footer, form, button, iframe, style, noscript, svg, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], .ad, .ads, .advertisement, .cookie-banner, .paywall, .paywall-banner, .subscription-banner',
    )
  ) node.remove();
  const result = new Readability(document, { maxElemsToParse: 20_000, charThreshold: 80 }).parse();
  if (!result?.content) {
    throw new IngestError(
      422,
      "No readable article found; login and script-only pages are not supported.",
    );
  }
  const content = parseHTML(`<html><body>${result.content}</body></html>`).document.body;
  let title = clean(result.title);
  for (const heading of content.querySelectorAll("h1, h2")) {
    const text = clean(heading.textContent);
    if (text && (text === title || title.startsWith(`${text} | `))) {
      title = text;
      heading.remove();
    }
  }
  const body = plainText(content).split("\n").map(clean).filter(Boolean).join("\n\n");
  if (!title || body.length < 80) {
    throw new IngestError(
      422,
      "No readable article found; login and script-only pages are not supported.",
    );
  }
  if (body.length > MAX_ARTICLE_CONTENT_CHARS) {
    throw new IngestError(
      413,
      `Article content exceeds the character limit (${body.length} > ${MAX_ARTICLE_CONTENT_CHARS}).`,
    );
  }
  const rawDate = clean(result.publishedTime ?? explicitDate);
  const timestamp = Date.parse(rawDate);
  const publishedAt = !rawDate || Number.isNaN(timestamp)
    ? null
    : /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : new Date(timestamp).toISOString();
  return {
    url,
    title,
    author: clean(result.byline || byline).replace(/^by\s+/i, "") || null,
    publishedAt,
    lead: clean(content.querySelector("p")?.textContent) || body.split("\n\n")[0] || body,
    body,
  };
}

export function audioPayload(article: ExtractedArticle, mode: AudioMode): IngestPayload {
  if (mode === "deepdive") return { mode, article };
  const intro = [
    article.title,
    article.author ? `By ${article.author}.` : null,
    article.publishedAt ? `Published ${article.publishedAt}.` : null,
  ];
  return { mode, article, narration: [...intro.filter(Boolean), article.body].join("\n\n") };
}

export interface IngestDependencies {
  /** Resolve verified identity; the handler independently enforces admin approval. */
  authorize: (request: Request) => Promise<User | Response>;
  /** Persist the job before resolving; 202 means queued, not synthesized. Recheck approval in the worker. */
  enqueue: (
    input: { article: ExtractedArticle; mode: AudioMode; user: User },
  ) => Promise<{ articleId: string; episodeId: string }>;
  fetchArticle?: (url: string, signal: AbortSignal) => Promise<ExtractedArticle>;
}

/** Mount at POST /api/ingest. Caller supplies approved-user authorization and durable queue. */
export function createUrlIngestHandler(
  deps: IngestDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const json = (body: unknown, status: number) =>
      Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    try {
      const user = await deps.authorize(request);
      if (user instanceof Response) return user;
      if (!user?.id || !isSynthesisAuthorized(user)) {
        return json({ error: "An approved user is required." }, 403);
      }
      if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
        return json({ error: "Send an application/json body." }, 415);
      }
      let input: unknown;
      try {
        const bodySignal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
        input = JSON.parse(
          new TextDecoder().decode(await readBounded(request.body, 8 * 1024, 413, bodySignal)),
        );
      } catch (error) {
        if (error instanceof IngestError) throw error;
        return json({ error: "Invalid JSON body." }, 400);
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return json({ error: "Expected { url, mode }." }, 400);
      }
      const { url, mode = "direct" } = input as Record<string, unknown>;
      if (typeof url !== "string" || !isAudioMode(mode)) {
        return json({ error: "Expected a URL and mode direct or deepdive." }, 400);
      }
      const target = articleUrl(url).href;
      const article = await (deps.fetchArticle ?? ((url, signal) => fetchArticle(url, { signal })))(
        target,
        request.signal,
      );
      request.signal.throwIfAborted();
      const job = await deps.enqueue({ article, mode, user });
      return json({ ...job, status: "queued", mode, article }, 202);
    } catch (error) {
      return error instanceof IngestError
        ? json({ error: error.message }, error.status)
        : json({ error: "Unable to queue the article." }, 503);
    }
  };
}
