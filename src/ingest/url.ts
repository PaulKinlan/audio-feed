/// <reference lib="dom" />
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import ipaddr from "npm:ipaddr.js@2.2.0";
import { parseHTML } from "npm:linkedom@0.18.12";
import pdfParse from "npm:pdf-parse@1.1.1";
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
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const PDF_PARSE_TIMEOUT_MS = 10_000;
export const MAX_ARTICLE_CONTENT_CHARS = 2_000_000;
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

export type Transport = (
  url: URL,
  signal: AbortSignal,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

/** Node's HTTP client exposes lookup; native Deno fetch would resolve again after validation. */
export const requestPublic: Transport = (url, signal, init) => {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      lookup: publicLookup(),
      signal,
      agent: false,
      maxHeaderSize: 16 * 1024,
      headers: {
        "Accept": "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
        "Accept-Encoding": "gzip, identity",
        "User-Agent":
          "AudioFeed/1.0 (podcast generator; +https://github.com/PaulKinlan/audio-feed)",
        ...(init?.headers ?? {}),
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

function decompressBody(
  body: ReadableStream<Uint8Array> | null,
  encoding: string | null,
  kind: "Article" | "Feed" | "PDF",
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
  throw new IngestError(422, `${kind} uses an unsupported content-encoding: ${encoding}.`);
}

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

/** Fetch only server-rendered public HTML or PDF documents (audio-feed-w9n); never execute scripts or bypass a paywall. */
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
      const response = await (options.transport ?? requestPublic)(url, signal, {
        headers: {
          "Accept":
            "text/html, application/xhtml+xml, application/pdf;q=0.9, application/xml;q=0.8, */*;q=0.7",
        },
      });
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
      const isPdf = /^application\/pdf(?:;|$)/i.test(contentType);
      const isHtml = /^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType);
      if (!isHtml && !isPdf) {
        await response.body?.cancel();
        throw new IngestError(422, "Article must be an HTML page or a PDF document.");
      }
      const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_HTML_BYTES;
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new IngestError(
          413,
          isPdf ? "PDF exceeds the 10 MiB size limit." : "Article exceeds the 2 MiB size limit.",
        );
      }

      let decompressedBody: ReadableStream<Uint8Array> | null;
      try {
        decompressedBody = decompressBody(response.body, encoding, isPdf ? "PDF" : "Article");
      } catch (err) {
        await response.body?.cancel();
        throw err instanceof IngestError
          ? err
          : new IngestError(422, `${isPdf ? "PDF" : "Article"} decompression failed.`);
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBounded(decompressedBody, maxBytes, 413, signal);
      } catch (err) {
        if (err instanceof IngestError) throw err;
        throw new IngestError(422, `${isPdf ? "PDF" : "Article"} decompression failed.`);
      }

      if (isPdf) {
        return await extractPdfArticle(bytes, url.href, { timeoutMs: options.timeoutMs });
      }

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
    transport?: Transport;
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
      const response = await (options.transport ?? requestPublic)(url, signal, {
        headers: {
          "Accept":
            "application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.8, */*;q=0.5",
        },
      });
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
      if (!FEED_CONTENT_TYPE.test(contentType)) {
        await response.body?.cancel();
        throw new IngestError(422, "That URL is not an RSS or Atom feed.");
      }
      if (Number(response.headers.get("content-length")) > MAX_FEED_BYTES) {
        await response.body?.cancel();
        throw new IngestError(413, "Feed exceeds the 2 MiB size limit.");
      }

      let decompressedBody: ReadableStream<Uint8Array> | null;
      try {
        decompressedBody = decompressBody(response.body, encoding, "Feed");
      } catch (err) {
        await response.body?.cancel();
        throw err instanceof IngestError ? err : new IngestError(422, "Feed decompression failed.");
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBounded(decompressedBody, MAX_FEED_BYTES, 413, signal);
      } catch (err) {
        if (err instanceof IngestError) throw err;
        throw new IngestError(422, "Feed decompression failed.");
      }
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

/**
 * The feed-link SHAPES, in one place (audio-feed-6hw): the bookmarklet
 * (`src/routes/bookmarklet.ts`) and server-side discovery
 * (`discoverFeeds`) both read them, so a shape added for one is a shape the
 * other knows. `rel~=` matches the whitespace-separated list rather than a
 * substring; the anchor shapes are narrowed past "/feedback" to feed-ish names.
 */
export const FEED_LINK_SELECTOR = [
  'link[rel~="alternate"][type*="rss"]',
  'link[rel~="alternate"][type*="atom"]',
  'link[rel~="alternate"][type*="feed"]',
  'link[rel~="alternate"][type*="json"]',
  'link[rel~="alternate"][type*="xml"]',
].join(",");

export const FEED_ANCHOR_SELECTOR = [
  'a[href*="/feed"]',
  'a[href*="/rss"]',
  'a[href$=".xml"]',
  'a[href$=".rss"]',
  'a[href$=".atom"]',
].join(",");

export interface DiscoveredFeed {
  url: string;
  title: string;
  type: string;
}

const MAX_DISCOVERED_FEEDS = 8;

function feedTypeOf(rawType: string, href: string): string {
  const declared = rawType.trim().toLowerCase();
  if (declared) return declared;
  const lowered = href.toLowerCase();
  if (/\.rss(?:$|[?#])/.test(lowered) || /\/rss(?:$|[?#])/.test(lowered)) {
    return "application/rss+xml";
  }
  if (/\.atom(?:$|[?#])/.test(lowered) || /atom/.test(lowered)) return "application/atom+xml";
  return "application/octet-stream";
}

/**
 * Extract the feed candidates a page declares — PURE, so the shapes are unit
 * testable without a socket. Every candidate is resolved against the page URL and
 * then put through `articleUrl`, which is what keeps the answer http(s)-only:
 * `javascript:`, `data:`, credential-bearing, non-standard-port and
 * private/link-local literal hosts are DROPPED here rather than returned to a
 * page. (A public hostname that resolves privately is refused later, at the
 * socket, by `publicLookup`.)
 */
export function discoverFeedLinks(
  html: string,
  pageUrl: string,
): { url: string; title: string; feeds: DiscoveredFeed[] } {
  const { document } = parseHTML(html);
  const title = clean(document.querySelector("title")?.textContent ?? "");
  const candidates: Array<{ href: string; title: string; type: string }> = [];
  for (const node of document.querySelectorAll(FEED_LINK_SELECTOR)) {
    candidates.push({
      href: node.getAttribute("href") ?? "",
      title: clean(node.getAttribute("title") ?? ""),
      type: node.getAttribute("type") ?? "",
    });
  }
  // Anchors come second on purpose: the declared link is the publication's own
  // answer, an anchor is a guess, and the bookmarklet prefers the same one.
  for (const node of document.querySelectorAll(FEED_ANCHOR_SELECTOR)) {
    candidates.push({
      href: node.getAttribute("href") ?? "",
      title: clean(node.getAttribute("title") ?? node.textContent ?? ""),
      type: "",
    });
  }

  const feeds: DiscoveredFeed[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.href) continue;
    let resolved: URL;
    try {
      resolved = articleUrl(new URL(candidate.href, pageUrl).href);
    } catch {
      continue; // a shape the guard refuses is a shape that is not returned
    }
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);
    feeds.push({
      url: resolved.href,
      title: candidate.title,
      type: feedTypeOf(candidate.type, resolved.href),
    });
    if (feeds.length >= MAX_DISCOVERED_FEEDS) break;
  }
  return { url: pageUrl, title, feeds };
}

/**
 * Feed autodiscovery for the account page (audio-feed-6hw).
 *
 * Same security surface as `fetchArticle` and `fetchFeedDocument`, and it reuses
 * their guards rather than restating them: `articleUrl` validates the target,
 * `requestPublic` resolves the socket through `publicLookup` (refusing
 * non-public addresses), every redirect is re-validated, and the read is bounded
 * by the same 2 MiB, 15 s and 5-redirect caps. A URL that is already a feed
 * answers with itself, so a subscription page does not need to be HTML.
 */
export async function discoverFeeds(
  input: string,
  options: { transport?: Transport; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ url: string; title: string; feeds: DiscoveredFeed[] }> {
  let url = articleUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await (options.transport ?? requestPublic)(url, signal, {
        headers: {
          "Accept": "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || hop === 5) {
          throw new IngestError(422, "Page has an invalid or excessive redirect chain.");
        }
        url = articleUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new IngestError(422, "Page is unavailable or requires a subscription.");
      }
      const contentType = response.headers.get("content-type") ?? "";
      const encoding = response.headers.get("content-encoding");
      if (FEED_CONTENT_TYPE.test(contentType)) {
        // The URL is the feed: the page's own declaration is stronger than a parse.
        await response.body?.cancel();
        return {
          url: url.href,
          title: "",
          feeds: [{ url: url.href, title: "", type: contentType }],
        };
      }
      if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
        await response.body?.cancel();
        throw new IngestError(422, "Feed discovery needs an HTML page or a feed.");
      }
      if (Number(response.headers.get("content-length")) > MAX_HTML_BYTES) {
        await response.body?.cancel();
        throw new IngestError(413, "Page exceeds the 2 MiB size limit.");
      }

      let decompressedBody: ReadableStream<Uint8Array> | null;
      try {
        decompressedBody = decompressBody(response.body, encoding, "Article");
      } catch (err) {
        await response.body?.cancel();
        throw err instanceof IngestError ? err : new IngestError(422, "Page decompression failed.");
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBounded(decompressedBody, MAX_HTML_BYTES, 413, signal);
      } catch (err) {
        if (err instanceof IngestError) throw err;
        throw new IngestError(422, "Page decompression failed.");
      }
      const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
      let html: string;
      try {
        html = new TextDecoder(charset).decode(bytes);
      } catch {
        throw new IngestError(422, "Page uses an unsupported character encoding.");
      }
      return discoverFeedLinks(html, url.href);
    }
    throw new IngestError(422, "Page could not be fetched.");
  } catch (error) {
    if (signal.aborted) throw new IngestError(504, "Feed discovery timed out or was cancelled.");
    if (error instanceof IngestError) throw error;
    throw new IngestError(502, "Unable to discover feeds on that page.");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * DOM text helpers, exported for the feed-fallback path: an item's embedded HTML
 * must become the same shape of text as a fetched article's, or the two paths
 * disagree about what an article body looks like (audio-feed-8g0).
 */
export const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * Elements whose subtrees contribute no narration text (audio-feed-sa4g). A media
 * embed's fallback content is a bare link to the media file — left in place, TTS
 * spells the URL character by character before the article says a single word
 * (measured on bram.us: the narration opened with "https://... show-keystrokes.mp4").
 */
const NON_NARRATED_ELEMENTS = new Set([
  "VIDEO",
  "AUDIO",
  "SOURCE",
  "EMBED",
  "OBJECT",
  "IFRAME",
  "CANVAS",
  "TRACK",
  "SVG",
]);

/**
 * A paragraph substantial enough to count as the article's own prose (the point after
 * which figure captions are content, not decoration). 40 characters is two spoken
 * clauses — separators ("~"), credits and media fallback wrappers never reach it.
 */
const SUBSTANTIAL_PARAGRAPH_CHARS = 40;

/**
 * A link whose entire visible text is a URL or bare path is navigation chrome, not
 * prose (audio-feed-sa4g): spelled aloud it becomes "slash show dash keystrokes".
 * Domain-only text ("example.com") is kept — "example dot com" is how it is said.
 */
export function isBareUrlText(text: string | null | undefined): boolean {
  const value = clean(text);
  if (!value || /\s/.test(value)) return false;
  return /^(?:https?:)?\/\//i.test(value) ||
    /^www\./i.test(value) ||
    value.startsWith("/") ||
    /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/\S+/i.test(value);
}

/** True when the node sits inside a <figcaption> (captions are not opening prose). */
function withinFigcaption(node: Element): boolean {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.nodeName === "FIGCAPTION") return true;
  }
  return false;
}

/** The first paragraph substantial enough to be the article's opening line, if any. */
function firstSubstantialParagraph(root: ParentNode): Element | null {
  for (const p of root.querySelectorAll("p")) {
    if (withinFigcaption(p)) continue;
    if (clean(p.textContent).length >= SUBSTANTIAL_PARAGRAPH_CHARS) return p;
  }
  return null;
}

/**
 * Strip what can never be narration, in the order the later decisions depend on
 * (audio-feed-sa4g): media embeds first — their fallback wrappers must be empty
 * before "leading" is measured — then decorative paragraphs, then the captions of
 * figures that appear before the article's own first substantial paragraph. A hero
 * figure's caption is presentation (a demo pointer, a photo credit); the same
 * markup after the opening paragraph is content (a chart's caption) and stays.
 */
function stripNonNarration(content: Element): void {
  for (
    const node of content.querySelectorAll(
      "video, audio, source, embed, object, iframe, canvas, track",
    )
  ) node.remove();
  for (const p of content.querySelectorAll("p")) {
    if (!/[\p{L}\p{N}]/u.test(clean(p.textContent))) p.remove();
  }
  const firstProse = firstSubstantialParagraph(content);
  if (!firstProse) return;
  // querySelectorAll yields document order, so every figcaption seen before the
  // article's opening paragraph belongs to a leading/hero figure — drop it. The
  // same markup after that paragraph is content (a chart's caption) and stays.
  let seenProse = false;
  for (const node of content.querySelectorAll("figcaption, p")) {
    if (node === firstProse) seenProse = true;
    else if (node.nodeName === "FIGCAPTION" && !seenProse) node.remove();
  }
}

export function plainText(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (NON_NARRATED_ELEMENTS.has(node.nodeName)) return "";
  if (node.nodeName === "PRE") {
    const raw = (node.textContent ?? "").trim();
    return raw ? `\n\`\`\`\n${raw}\n\`\`\`\n` : "";
  }
  if (node.nodeName === "A" && isBareUrlText(node.textContent)) return "";
  const text = Array.from(node.childNodes).map(plainText).join("");
  return /^(P|DIV|SECTION|H[1-6]|LI|UL|OL|BLOCKQUOTE|BR|TR)$/.test(node.nodeName)
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
  stripNonNarration(content);
  const body = plainText(content).split("\n").map(clean).filter(Boolean).join("\n\n");
  // The lead is spoken in the intro (formatNarrationIntro); it must go through
  // plainText so a bare-URL anchor in the opening paragraph is not spelled out
  // there while the body strips it (review finding on audio-feed-sa4g).
  const firstProse = firstSubstantialParagraph(content);
  const lead = (firstProse ? clean(plainText(firstProse)) : "") ||
    body.split("\n\n")[0] || body;
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
    lead,
    body,
  };
}

/**
 * Run pdf-parse with bounded wall-clock execution and suppressed PDF.js log noise (audio-feed-a3y).
 * Note on cancellation: pdf-parse does not accept an AbortSignal into its worker loop,
 * so a timed-out parse promise will continue running in the background until the isolate
 * finishes or garbage-collects; bounding with Promise.race protects the request pipeline
 * from hanging indefinitely.
 */
async function parsePdfBounded(
  bytes: Uint8Array,
  timeoutMs = PDF_PARSE_TIMEOUT_MS,
): Promise<{ text: string; numpages: number; info?: Record<string, unknown> }> {
  if (timeoutMs <= 0) {
    throw new IngestError(504, "PDF parsing timed out.");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new IngestError(
            504,
            `PDF parsing timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          ),
        ),
      timeoutMs,
    );
  });

  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("Warning: Indexing all PDF objects")) {
      return;
    }
    origLog(...args);
  };

  const parsePromise = pdfParse(bytes);
  // Attach no-op catch so a later rejection after timeout loss is explicitly handled
  parsePromise.catch(() => {});

  try {
    return await Promise.race([parsePromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(
      422,
      `Unable to parse PDF document: ${(err as Error)?.message || "corrupt or invalid format"}.`,
    );
  } finally {
    clearTimeout(timer);
    console.log = origLog;
  }
}

function sanitizeMetadataText(text: string, maxLength: number): string {
  let cleanStr = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Strip C0 controls (< 32), DEL (127), and C1 controls (128-159)
    if (code >= 32 && code !== 127 && !(code >= 128 && code <= 159)) {
      cleanStr += text[i];
    } else {
      cleanStr += " ";
    }
  }
  return cleanStr.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Extract structured text and metadata from PDF bytes (audio-feed-w9n, audio-feed-a3y).
 * Uses pdf-parse to extract text, document metadata (Title, Author, CreationDate),
 * and generates clean body paragraphs suitable for TTS narration and dialogue synthesis.
 */
export async function extractPdfArticle(
  bytes: Uint8Array,
  sourceUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<ExtractedArticle> {
  const url = articleUrl(sourceUrl).href;
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new IngestError(413, "PDF exceeds the 10 MiB size limit.");
  }

  // Verify PDF header magic bytes "%PDF-"
  const header = new TextDecoder("ascii", { fatal: false }).decode(bytes.subarray(0, 8));
  if (!header.startsWith("%PDF-")) {
    throw new IngestError(422, "Invalid PDF: document does not start with %PDF- header.");
  }

  const data = await parsePdfBounded(bytes, options.timeoutMs);

  const rawText = data.text ?? "";

  // Check lines for a candidate heading
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => clean(l))
    .filter(Boolean);

  const fullText = lines.join(" ");
  if (fullText.length < 80) {
    throw new IngestError(
      422,
      "No readable text found in PDF document; scanned image or password-protected PDFs are not supported.",
    );
  }

  if (fullText.length > MAX_ARTICLE_CONTENT_CHARS) {
    throw new IngestError(
      413,
      `Article content exceeds the character limit (${fullText.length} > ${MAX_ARTICLE_CONTENT_CHARS}).`,
    );
  }

  // Title extraction:
  // 1. info.Title if meaningful
  // 2. First short line without sentence-ending punctuation (< 120 chars)
  // 3. Derived from URL pathname
  let rawTitle = "";
  const infoTitle = typeof data.info?.Title === "string" ? clean(data.info.Title) : "";
  if (infoTitle && !/^(untitled|document|pdf)$/i.test(infoTitle)) {
    rawTitle = infoTitle;
  }

  if (!rawTitle && lines.length > 0) {
    const candidate = lines[0]!;
    if (candidate.length <= 120 && !/[.?!]$/.test(candidate)) {
      rawTitle = candidate;
    }
  }

  if (!rawTitle) {
    try {
      const pathname = new URL(url).pathname;
      const basename = pathname.split("/").filter(Boolean).pop()?.replace(/\.pdf$/i, "") ?? "";
      if (basename) {
        const decoded = decodeURIComponent(basename).replace(/[-_]+/g, " ").replace(/\s+/g, " ")
          .trim();
        if (decoded) {
          rawTitle = decoded.charAt(0).toUpperCase() + decoded.slice(1);
        }
      }
    } catch {
      // ignore URL parse errors
    }
  }

  if (!rawTitle) {
    rawTitle = "PDF Document";
  }

  // Strip control chars, newlines, tabs, and cap to 200 chars max (audio-feed-a3y)
  const title = sanitizeMetadataText(rawTitle, 200) || "PDF Document";

  // Body construction:
  // If lines are separated by empty lines in rawText, keep paragraph breaks
  const rawParagraphs = rawText
    .split(/\r?\n\s*\r?\n/)
    .map((p) => clean(p))
    .filter(Boolean);

  const paragraphs = rawParagraphs.length > 1 ? rawParagraphs : lines;

  const contentParagraphs =
    (paragraphs[0] === title && paragraphs.slice(1).join("\n\n").length >= 80)
      ? paragraphs.slice(1)
      : paragraphs;

  const body = contentParagraphs.join("\n\n");

  // Author extraction (sanitized & capped, audio-feed-a3y)
  let author: string | null = null;
  if (typeof data.info?.Author === "string" && clean(data.info.Author)) {
    author = sanitizeMetadataText(data.info.Author.replace(/^by\s+/i, ""), 100) || null;
  }

  // Published date extraction from PDF metadata CreationDate (e.g. D:20260929100000Z or ISO)
  let publishedAt: string | null = null;
  const rawCreation = typeof data.info?.CreationDate === "string" ? data.info.CreationDate : null;
  if (rawCreation) {
    const match = rawCreation.match(/^D:(\d{4})(\d{2})(\d{2})/);
    if (match) {
      publishedAt = `${match[1]}-${match[2]}-${match[3]}`;
    } else {
      const parsed = Date.parse(rawCreation);
      if (!Number.isNaN(parsed)) {
        publishedAt = new Date(parsed).toISOString();
      }
    }
  }

  // Lead extraction:
  const lead = paragraphs[0] && paragraphs[0] !== title
    ? paragraphs[0].slice(0, 300)
    : paragraphs[1]?.slice(0, 300) ?? paragraphs[0]?.slice(0, 300) ?? "";

  return {
    url,
    title,
    author: author || null,
    publishedAt,
    lead,
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
