/// <reference lib="dom" />
/**
 * Email-to-Podcast ingestion via Cloudflare Email Routing & Email Workers.
 *
 * Subscribers forward newsletters (Substack, Stratechery, TLDR, paywalled emails)
 * to `save+<feedToken>@audiofeed.app` (or `save+<feedToken>+deepdive@audiofeed.app`).
 *
 * Security invariants:
 * - Enforce `MAX_EMAIL_BYTES` (2 MiB) BEFORE reading a raw stream, and again while streaming.
 * - Bound MIME recursion depth (<= `MAX_MIME_DEPTH` = 8) and total parts (<= `MAX_MIME_PARTS`).
 * - NEVER log or echo `feedToken` or the raw `to` address in logs or `setReject` reasons.
 * - Require an `approved` subscriber (`isSynthesisAuthorized`) before queueing any episode.
 * - Validate every extracted `imageUrl` via `articleUrl` (public http/https only).
 */

import { parseHTML } from "linkedom";
import {
  articleUrl,
  clean,
  cleanBylineName,
  extractArticle,
  type ExtractedArticle,
  IngestError,
  MAX_ARTICLE_CONTENT_CHARS,
  plainText,
  readBounded,
} from "./url.ts";
import {
  type Article,
  type AudioMode,
  type Episode,
  isAudioMode,
  isSynthesisAuthorized,
  type User,
} from "../types.ts";
import type { AppContext } from "../app.ts";
import { newArticleId, newEpisodeId } from "../ids.ts";
import { ingestCreationLimiter } from "../compose/ingest.ts";
import type { RateLimitResult } from "../auth/rate_limit.ts";
import { screenErrorForLogging } from "../observability/error_screen.ts";

/** Hard ceiling for raw RFC 5322 email bytes (2 MiB). */
export const MAX_EMAIL_BYTES = 2 * 1024 * 1024;
/** Maximum nested MIME multipart / message/rfc822 depth. */
export const MAX_MIME_DEPTH = 8;
/** Maximum total MIME parts visited across a single message (anti-fanout cap). */
export const MAX_MIME_PARTS = 64;
/** Maximum headers accepted per MIME entity. */
const MAX_HEADERS_PER_ENTITY = 200;
/** Minimum readable text characters after stripping newsletter boilerplate. */
const MIN_READABLE_EMAIL_CHARS = 40;
/** Timeout for reading an incoming email raw stream. */
const STREAM_READ_TIMEOUT_MS = 15_000;

/** Stable synthetic source id and display title for forwarded newsletters. */
export const EMAIL_SOURCE_ID = "email-newsletters";
export const EMAIL_SOURCE_TITLE = "Email Newsletters";

const DEFAULT_EMAIL_DOMAIN = "audiofeed.app";
const RECIPIENT_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RECIPIENT_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const textEncoder = new TextEncoder();

export interface ParsedEmailRecipient {
  prefix: "save" | "in";
  feedToken: string;
  mode: AudioMode;
  domain: string;
}

export interface ParsedMimeEmail {
  subject: string;
  from: string;
  fromName: string | null;
  fromAddress: string | null;
  messageId: string | null;
  date: string | null;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  depthLimitReached: boolean;
}

export interface EmailIngestInput {
  to: string;
  from?: string;
  raw: Uint8Array | string | ReadableStream<Uint8Array>;
  rawSize?: number;
  headers?: Headers | Record<string, string>;
  signal?: AbortSignal;
}

export type EmailIngestRejectionCode =
  | "oversize"
  | "invalid_recipient"
  | "unknown_recipient"
  | "unapproved_user"
  | "unparseable"
  | "empty_body"
  | "rate_limited";

export type EmailIngestResult =
  | {
    ok: true;
    deduplicated: false;
    userId: string;
    sourceId: string;
    articleId: string;
    episodeId: string;
    mode: AudioMode;
    title: string;
  }
  | {
    ok: true;
    deduplicated: true;
    userId: string;
    sourceId: string;
    articleId: string;
    mode: AudioMode;
  }
  | {
    ok: false;
    reject: boolean;
    code: EmailIngestRejectionCode;
    reason: string;
  };

// ---------------------------------------------------------------------------
// Address formatting & recipient parsing
// ---------------------------------------------------------------------------

function extractEmailDomain(publicBaseUrl: string): string {
  const trimmed = (publicBaseUrl ?? "").trim();
  if (!trimmed) return DEFAULT_EMAIL_DOMAIN;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:[/]{2}/i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase().replace(/\.$/, "");
    return host || DEFAULT_EMAIL_DOMAIN;
  } catch {
    return DEFAULT_EMAIL_DOMAIN;
  }
}

/**
 * Format a subscriber's private Email-to-Podcast forwarding address.
 * Example: `save+<feedToken>@audiofeed.app` (or `save+<feedToken>+deepdive@audiofeed.app`).
 */
export function emailIngestAddress(
  publicBaseUrl: string,
  feedToken: string,
  mode: AudioMode = "direct",
): string {
  const domain = extractEmailDomain(publicBaseUrl);
  const token = feedToken.trim();
  return mode === "deepdive" ? `save+${token}+deepdive@${domain}` : `save+${token}@${domain}`;
}

/**
 * Parse a recipient address such as `save+<feedToken>@<domain>`,
 * `save+<feedToken>+<mode>@<domain>`, or `in+<feedToken>@<domain>`.
 *
 * Accepts optional RFC 5322 display name / angle brackets (`"Audio Feed" <save+...@...>`).
 * Returns `null` for any malformed, missing-token, unknown-prefix, or unknown-mode address.
 */
export function parseEmailRecipient(to: string): ParsedEmailRecipient | null {
  if (typeof to !== "string") return null;
  const trimmed = to.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n\0]/.test(trimmed)) return null;

  let addr = trimmed;
  if (trimmed.includes("<") || trimmed.includes(">")) {
    const match = /^[^<>]*<([^<>@\s,;]+@[^<>@\s,;]+)>$/.exec(trimmed);
    if (!match?.[1]) return null;
    addr = match[1].trim();
  }

  if (/[\s,;]/.test(addr)) return null;
  const atIndex = addr.indexOf("@");
  if (atIndex <= 0 || atIndex !== addr.lastIndexOf("@")) return null;

  const localPart = addr.slice(0, atIndex);
  const domain = addr.slice(atIndex + 1).toLowerCase();
  if (domain.length > 253 || !RECIPIENT_DOMAIN_RE.test(domain)) return null;

  const parts = localPart.split("+");
  if (parts.length !== 2 && parts.length !== 3) return null;

  const rawPrefix = (parts[0] ?? "").toLowerCase();
  if (rawPrefix !== "save" && rawPrefix !== "in") return null;

  const feedToken = parts[1] ?? "";
  if (!RECIPIENT_TOKEN_RE.test(feedToken)) return null;

  let mode: AudioMode = "direct";
  if (parts.length === 3) {
    const rawMode = (parts[2] ?? "").toLowerCase();
    if (!isAudioMode(rawMode)) return null;
    mode = rawMode;
  }

  return {
    prefix: rawPrefix,
    feedToken,
    mode,
    domain,
  };
}

// ---------------------------------------------------------------------------
// Zero-dependency MIME decoding primitives (Base64, Quoted-Printable, RFC 2047)
// ---------------------------------------------------------------------------

const BASE64_TABLE = new Int8Array(128).fill(-1);
{
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) {
    BASE64_TABLE[alphabet.charCodeAt(i)] = i;
  }
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30; // 0-9
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10; // A-F
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10; // a-f
  return -1;
}

/** Decode MIME Base64 bytes (ignoring RFC 2045 whitespace and optional missing padding). */
export function decodeBase64Bytes(input: Uint8Array | string): Uint8Array {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  const maxOut = Math.ceil((bytes.byteLength * 3) / 4) + 3;
  const out = new Uint8Array(maxOut);
  let outPos = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i]!;
    if (b === 0x3d) break; // '=' padding terminates stream
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    const val = b < 128 ? BASE64_TABLE[b]! : -1;
    if (val < 0) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outPos++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outPos);
}

/** Decode RFC 2045 Quoted-Printable bytes (soft line breaks + `=XX` hex escapes). */
export function decodeQuotedPrintable(input: Uint8Array | string): Uint8Array {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  const out = new Uint8Array(bytes.byteLength);
  let outPos = 0;
  let i = 0;

  while (i < bytes.byteLength) {
    const b = bytes[i]!;
    if (b === 0x3d) {
      // Check soft line break: '=' followed by optional SP/HTAB and CRLF or LF.
      let j = i + 1;
      while (j < bytes.byteLength && (bytes[j] === 0x20 || bytes[j] === 0x09)) {
        j++;
      }
      if (j < bytes.byteLength && bytes[j] === 0x0d && j + 1 < bytes.byteLength && bytes[j + 1] === 0x0a) {
        i = j + 2;
        continue;
      }
      if (j < bytes.byteLength && bytes[j] === 0x0a) {
        i = j + 1;
        continue;
      }
      if (i + 2 < bytes.byteLength) {
        const hi = hexValue(bytes[i + 1]!);
        const lo = hexValue(bytes[i + 2]!);
        if (hi >= 0 && lo >= 0) {
          out[outPos++] = (hi << 4) | lo;
          i += 3;
          continue;
        }
      }
    }
    out[outPos++] = b;
    i++;
  }
  return out.subarray(0, outPos);
}

function normalizeCharset(rawCharset?: string): string {
  if (!rawCharset) return "utf-8";
  const cleaned = rawCharset
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\*.*$/, "") // strip RFC 2231 language tag
    .toLowerCase();
  if (!cleaned || cleaned === "utf8" || cleaned === "utf-8" || cleaned === "us-ascii" || cleaned === "ascii") {
    return "utf-8";
  }
  if (cleaned === "latin1" || cleaned === "latin-1" || cleaned === "iso-8859-1" || cleaned === "cp1252") {
    return "windows-1252";
  }
  return cleaned;
}

function decodeWithCharset(bytes: Uint8Array, charset?: string): string {
  const normalized = normalizeCharset(charset);
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeRfc2047QBytes(encoded: string): Uint8Array {
  const out = new Uint8Array(encoded.length);
  let outPos = 0;
  let i = 0;
  while (i < encoded.length) {
    const ch = encoded.charCodeAt(i);
    if (ch === 0x5f) {
      // '_' represents ASCII space 0x20 in RFC 2047 Q-encoding.
      out[outPos++] = 0x20;
      i++;
      continue;
    }
    if (ch === 0x3d && i + 2 < encoded.length) {
      const hi = hexValue(encoded.charCodeAt(i + 1));
      const lo = hexValue(encoded.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        out[outPos++] = (hi << 4) | lo;
        i += 3;
        continue;
      }
    }
    out[outPos++] = ch & 0xff;
    i++;
  }
  return out.subarray(0, outPos);
}

const RFC2047_WORD_RE = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/**
 * Decode RFC 2047 encoded-word sequences (`=?UTF-8?B?...?=` and `=?UTF-8?Q?...?=`).
 * Collapses linear whitespace between adjacent encoded-words (RFC 2047 §6.2) and
 * merges adjacent words sharing a charset before decoding so split multi-byte UTF-8
 * sequences decode losslessly.
 */
export function decodeRfc2047(input: string): string {
  if (!input || !input.includes("=?")) return input;

  interface WordMatch {
    start: number;
    end: number;
    charset: string;
    bytes: Uint8Array;
  }

  const matches: WordMatch[] = [];
  RFC2047_WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RFC2047_WORD_RE.exec(input)) !== null) {
    const rawCharset = m[1] ?? "utf-8";
    const enc = (m[2] ?? "").toUpperCase();
    const payload = m[3] ?? "";
    const bytes = enc === "B" ? decodeBase64Bytes(payload) : decodeRfc2047QBytes(payload);
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      charset: normalizeCharset(rawCharset),
      bytes,
    });
  }

  if (matches.length === 0) return input;

  const out: string[] = [];
  let cursor = 0;
  let i = 0;

  while (i < matches.length) {
    const first = matches[i]!;
    if (first.start > cursor) {
      out.push(input.slice(cursor, first.start));
    }

    // Group adjacent encoded-words separated solely by linear whitespace.
    let groupEnd = i;
    while (groupEnd + 1 < matches.length) {
      const curr = matches[groupEnd]!;
      const next = matches[groupEnd + 1]!;
      const between = input.slice(curr.end, next.start);
      if (/^[ \t]+$/.test(between) || between === "") {
        groupEnd++;
      } else {
        break;
      }
    }

    // Within the adjacent group, concatenate consecutive runs with the same charset.
    let runStart = i;
    while (runStart <= groupEnd) {
      const charset = matches[runStart]!.charset;
      let runEnd = runStart;
      let totalLen = matches[runStart]!.bytes.byteLength;
      while (runEnd + 1 <= groupEnd && matches[runEnd + 1]!.charset === charset) {
        runEnd++;
        totalLen += matches[runEnd]!.bytes.byteLength;
      }
      if (runStart === runEnd) {
        out.push(decodeWithCharset(matches[runStart]!.bytes, charset));
      } else {
        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (let k = runStart; k <= runEnd; k++) {
          const chunk = matches[k]!.bytes;
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        out.push(decodeWithCharset(combined, charset));
      }
      runStart = runEnd + 1;
    }

    cursor = matches[groupEnd]!.end;
    i = groupEnd + 1;
  }

  if (cursor < input.length) {
    out.push(input.slice(cursor));
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Byte-level MIME entity & multipart parser
// ---------------------------------------------------------------------------

function decodeAsciiRange(bytes: Uint8Array, start: number, end: number): string {
  // Decode 7-bit/8-bit header bytes without mangling valid UTF-8 header values.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, end));
}

function splitHeadersAndBody(raw: Uint8Array): {
  headers: Record<string, string>;
  body: Uint8Array;
} {
  const headers: Record<string, string> = {};
  const lines: string[] = [];
  let pos = 0;
  let bodyStart = raw.byteLength;

  while (pos < raw.byteLength) {
    let lineEnd = pos;
    while (lineEnd < raw.byteLength && raw[lineEnd] !== 0x0a) {
      lineEnd++;
    }
    const hasLf = lineEnd < raw.byteLength && raw[lineEnd] === 0x0a;
    const strippedEnd = lineEnd > pos && raw[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
    const nextPos = hasLf ? lineEnd + 1 : lineEnd;

    if (strippedEnd === pos) {
      // Blank line separates headers from body.
      bodyStart = nextPos;
      break;
    }

    const line = decodeAsciiRange(raw, pos, strippedEnd);
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${line.trimStart()}`;
    } else if (lines.length < MAX_HEADERS_PER_ENTITY) {
      lines.push(line);
    }
    pos = nextPos;
  }

  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!name) continue;
    if (!(name in headers)) {
      headers[name] = value;
    }
  }

  return { headers, body: raw.subarray(bodyStart) };
}

interface ParsedContentType {
  mediaType: string;
  params: Record<string, string>;
}

function parseContentType(headerValue?: string): ParsedContentType {
  if (!headerValue) {
    return { mediaType: "text/plain", params: {} };
  }
  const params: Record<string, string> = {};
  let i = 0;
  const len = headerValue.length;

  // Read media type up to first ';'
  let semi = headerValue.indexOf(";");
  const mediaType = (semi === -1 ? headerValue : headerValue.slice(0, semi))
    .trim()
    .toLowerCase() || "text/plain";
  if (semi === -1) return { mediaType, params };

  i = semi + 1;
  while (i < len) {
    while (i < len && /[\s;]/.test(headerValue[i]!)) i++;
    if (i >= len) break;
    const eq = headerValue.indexOf("=", i);
    if (eq === -1) break;
    const key = headerValue.slice(i, eq).trim().toLowerCase();
    i = eq + 1;
    while (i < len && /\s/.test(headerValue[i]!)) i++;
    let value = "";
    if (i < len && headerValue[i] === '"') {
      i++; // skip opening quote
      while (i < len) {
        const ch = headerValue[i]!;
        if (ch === "\\" && i + 1 < len) {
          value += headerValue[i + 1]!;
          i += 2;
        } else if (ch === '"') {
          i++;
          break;
        } else {
          value += ch;
          i++;
        }
      }
      // Advance past any trailing characters before the next semicolon.
      const nextSemi = headerValue.indexOf(";", i);
      i = nextSemi === -1 ? len : nextSemi + 1;
    } else {
      const nextSemi = headerValue.indexOf(";", i);
      const end = nextSemi === -1 ? len : nextSemi;
      value = headerValue.slice(i, end).trim();
      i = nextSemi === -1 ? len : nextSemi + 1;
    }
    if (key) params[key] = value;
  }

  return { mediaType, params };
}

function bytesEqualAt(haystack: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset < 0 || offset + needle.byteLength > haystack.byteLength) return false;
  for (let i = 0; i < needle.byteLength; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}

/**
 * Split a MIME multipart body into raw sub-part byte slices per RFC 2046 §5.1.1.
 * Boundary comparisons are exact and case-sensitive, and require start-of-line alignment
 * plus valid delimiter termination (`[ \t]*(\r?\n|$)` or `--[ \t]*(\r?\n|$)`).
 */
function splitMultipartParts(body: Uint8Array, boundary: string): Uint8Array[] {
  if (!boundary || boundary.length > 200) return [];
  const delim = textEncoder.encode(`--${boundary}`);
  const parts: Uint8Array[] = [];

  let pos = 0;
  let currentPartStart = -1;

  while (pos <= body.byteLength - delim.byteLength) {
    // Only match delimiter at start of body or immediately after a line break.
    const lineStart = pos;
    if (bytesEqualAt(body, lineStart, delim)) {
      let after = lineStart + delim.byteLength;
      let isClosing = false;
      if (
        after + 1 < body.byteLength &&
        body[after] === 0x2d &&
        body[after + 1] === 0x2d
      ) {
        isClosing = true;
        after += 2;
      }
      while (after < body.byteLength && (body[after] === 0x20 || body[after] === 0x09)) {
        after++;
      }
      let nextLineStart = -1;
      if (after === body.byteLength) {
        nextLineStart = body.byteLength;
      } else if (body[after] === 0x0a) {
        nextLineStart = after + 1;
      } else if (
        body[after] === 0x0d &&
        after + 1 < body.byteLength &&
        body[after + 1] === 0x0a
      ) {
        nextLineStart = after + 2;
      }

      if (nextLineStart !== -1) {
        if (currentPartStart !== -1) {
          // Strip the single line break belonging to this boundary delimiter.
          let partEnd = lineStart;
          if (partEnd >= currentPartStart + 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
            partEnd -= 2;
          } else if (partEnd >= currentPartStart + 1 && body[partEnd - 1] === 0x0a) {
            partEnd -= 1;
          }
          parts.push(body.subarray(currentPartStart, Math.max(currentPartStart, partEnd)));
        }
        if (isClosing) {
          currentPartStart = -1;
          break;
        }
        currentPartStart = nextLineStart;
        pos = nextLineStart;
        if (parts.length >= MAX_MIME_PARTS) break;
        continue;
      }
    }

    // Advance to the start of the next line.
    while (pos < body.byteLength && body[pos] !== 0x0a) {
      pos++;
    }
    if (pos < body.byteLength) pos++;
  }

  // Handle malformed mailers that omit the closing `--boundary--`.
  if (currentPartStart !== -1 && currentPartStart < body.byteLength && parts.length < MAX_MIME_PARTS) {
    parts.push(body.subarray(currentPartStart));
  }

  return parts;
}

function decodeBodyText(
  rawBody: Uint8Array,
  transferEncoding: string | undefined,
  charset: string | undefined,
): string {
  const enc = (transferEncoding ?? "").trim().toLowerCase();
  let decodedBytes: Uint8Array;
  if (enc === "base64") {
    decodedBytes = decodeBase64Bytes(rawBody);
  } else if (enc === "quoted-printable") {
    decodedBytes = decodeQuotedPrintable(rawBody);
  } else {
    decodedBytes = rawBody;
  }
  return decodeWithCharset(decodedBytes, charset);
}

interface MimeWalkState {
  htmlCandidates: string[];
  textCandidates: string[];
  partsVisited: number;
  depthLimitReached: boolean;
  embeddedHeaders?: Record<string, string>;
}

function walkMimeEntity(
  entityBytes: Uint8Array,
  depth: number,
  state: MimeWalkState,
): Record<string, string> {
  const { headers, body } = splitHeadersAndBody(entityBytes);
  const disposition = (headers["content-disposition"] ?? "").trim().toLowerCase();
  if (disposition.startsWith("attachment")) {
    return headers;
  }

  const ct = parseContentType(headers["content-type"]);

  if (ct.mediaType.startsWith("multipart/")) {
    if (depth >= MAX_MIME_DEPTH) {
      state.depthLimitReached = true;
      return headers;
    }
    const boundary = ct.params["boundary"];
    if (!boundary) return headers;
    const subParts = splitMultipartParts(body, boundary);

    if (ct.mediaType === "multipart/alternative") {
      // RFC 2046 §5.1.4: parts are ordered least-faithful to most-faithful; prefer later parts.
      const altState: MimeWalkState = {
        htmlCandidates: [],
        textCandidates: [],
        partsVisited: state.partsVisited,
        depthLimitReached: state.depthLimitReached,
      };
      for (const part of subParts) {
        if (altState.partsVisited >= MAX_MIME_PARTS) break;
        altState.partsVisited++;
        walkMimeEntity(part, depth + 1, altState);
      }
      state.partsVisited = altState.partsVisited;
      state.depthLimitReached = altState.depthLimitReached;
      if (altState.htmlCandidates.length > 0) {
        state.htmlCandidates.push(altState.htmlCandidates[altState.htmlCandidates.length - 1]!);
      }
      if (altState.textCandidates.length > 0) {
        state.textCandidates.push(altState.textCandidates[altState.textCandidates.length - 1]!);
      }
      if (!state.embeddedHeaders && altState.embeddedHeaders) {
        state.embeddedHeaders = altState.embeddedHeaders;
      }
    } else {
      for (const part of subParts) {
        if (state.partsVisited >= MAX_MIME_PARTS) break;
        state.partsVisited++;
        walkMimeEntity(part, depth + 1, state);
      }
    }
    return headers;
  }

  if (ct.mediaType === "message/rfc822") {
    if (depth >= MAX_MIME_DEPTH) {
      state.depthLimitReached = true;
      return headers;
    }
    if (state.partsVisited < MAX_MIME_PARTS) {
      state.partsVisited++;
      const innerHeaders = walkMimeEntity(body, depth + 1, state);
      if (!state.embeddedHeaders) state.embeddedHeaders = innerHeaders;
    }
    return headers;
  }

  if (ct.mediaType === "text/html" || ct.mediaType === "application/xhtml+xml") {
    const html = decodeBodyText(body, headers["content-transfer-encoding"], ct.params["charset"]);
    if (html.trim()) state.htmlCandidates.push(html);
  } else if (ct.mediaType === "text/plain") {
    const text = decodeBodyText(body, headers["content-transfer-encoding"], ct.params["charset"]);
    if (text.trim()) state.textCandidates.push(text);
  }

  return headers;
}

function parseFromHeader(rawFrom: string): { name: string | null; address: string | null } {
  const decoded = clean(decodeRfc2047(rawFrom));
  if (!decoded) return { name: null, address: null };
  const angleMatch = /^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(decoded);
  if (angleMatch) {
    const rawName = (angleMatch[1] ?? "").trim().replace(/^["']|["']$/g, "").trim();
    const address = (angleMatch[2] ?? "").trim().toLowerCase();
    return {
      name: rawName || null,
      address: address || null,
    };
  }
  const bareMatch = /^([^\s<>]+@[^\s<>]+)$/.exec(decoded);
  if (bareMatch?.[1]) {
    return { name: null, address: bareMatch[1].toLowerCase() };
  }
  return { name: decoded, address: null };
}

function parseEmailDate(rawDate?: string): string | null {
  if (!rawDate) return null;
  const trimmed = rawDate.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sanitizeControlChars(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 32 && code !== 127 && !(code >= 128 && code <= 159)) {
      out += text[i]!;
    } else {
      out += " ";
    }
  }
  return out;
}

/**
 * Parse a raw RFC 5322 / MIME email into decoded headers and best `text/html` / `text/plain` bodies.
 * Enforces `MAX_EMAIL_BYTES` (2 MiB) and bounded recursion depth (<= `MAX_MIME_DEPTH` = 8).
 */
export function parseMimeEmail(raw: Uint8Array | string): ParsedMimeEmail {
  let bytes: Uint8Array;
  if (typeof raw === "string") {
    if (raw.length > MAX_EMAIL_BYTES) {
      throw new IngestError(413, "Email exceeds the 2 MiB size limit.");
    }
    bytes = textEncoder.encode(raw);
  } else {
    bytes = raw;
  }

  if (bytes.byteLength > MAX_EMAIL_BYTES) {
    throw new IngestError(413, "Email exceeds the 2 MiB size limit.");
  }

  const state: MimeWalkState = {
    htmlCandidates: [],
    textCandidates: [],
    partsVisited: 1,
    depthLimitReached: false,
  };
  const rootHeaders = walkMimeEntity(bytes, 0, state);

  const rawSubject = rootHeaders["subject"] ?? state.embeddedHeaders?.["subject"] ?? "";
  const rawFrom = rootHeaders["from"] ?? state.embeddedHeaders?.["from"] ?? "";
  const rawMessageId = rootHeaders["message-id"] ?? state.embeddedHeaders?.["message-id"] ?? "";
  const rawDate = rootHeaders["date"] ?? state.embeddedHeaders?.["date"];

  const subject = clean(sanitizeControlChars(decodeRfc2047(rawSubject)));
  const fromDecoded = clean(sanitizeControlChars(decodeRfc2047(rawFrom)));
  const { name: fromName, address: fromAddress } = parseFromHeader(rawFrom);
  const messageId = clean(rawMessageId) || null;
  const date = parseEmailDate(rawDate);

  // Pick the most substantive HTML part (avoid concatenating multiple full HTML documents).
  let html: string | null = null;
  for (const candidate of state.htmlCandidates) {
    if (!html || candidate.length > html.length) {
      html = candidate;
    }
  }

  const text = state.textCandidates.length > 0
    ? state.textCandidates.join("\n\n").trim() || null
    : null;

  return {
    subject,
    from: fromDecoded,
    fromName,
    fromAddress,
    messageId,
    date,
    html,
    text,
    headers: rootHeaders,
    depthLimitReached: state.depthLimitReached,
  };
}

// ---------------------------------------------------------------------------
// Newsletter content extraction & boilerplate stripping
// ---------------------------------------------------------------------------

const BOILERPLATE_LINE_PATTERNS: readonly RegExp[] = [
  /^(?:view|read|open)\s+(?:this\s+)?(?:email|post|newsletter|issue|message|article)\s+(?:in\s+(?:your\s+)?(?:browser|the\s+app)|online|on\s+the\s+web)\b.{0,120}$/i,
  /^(?:view|read)\s+(?:in\s+(?:your\s+)?browser|online|on\s+the\s+web)\.?$/i,
  /^having\s+trouble\s+(?:viewing|reading)\s+this\s+(?:email|newsletter)\??.{0,120}$/i,
  /^(?:click\s+here\s+to\s+)?(?:unsubscribe|opt[\s-]?out|manage\s+(?:your\s+)?(?:email\s+)?(?:preferences|subscriptions?)|update\s+(?:your\s+)?(?:email\s+)?preferences|change\s+your\s+subscription)\b.{0,180}$/i,
  /^(?:you(?:'re|\s+are)\s+receiving\s+this\s+(?:email|newsletter|message)|you\s+received\s+this\s+(?:email|newsletter|message))\s+because\b.{0,300}$/i,
  /^want\s+to\s+change\s+how\s+you\s+receive\s+these\s+emails\??.{0,200}$/i,
  /^no\s+longer\s+want\s+to\s+receive\s+these\s+emails\??.{0,200}$/i,
  /^(?:forwarded\s+this\s+(?:email|newsletter)\??\s*)?(?:subscribe|sign\s+up)\s+(?:here|now|for\s+free)\.?$/i,
  /^(?:start\s+writing|get\s+the\s+(?:substack\s+)?app|read\s+in\s+app)\.?$/i,
  /^(?:©|copyright\s*©?)\s*\d{4}\b.{0,200}$/i,
  /^(?:all\s+rights\s+reserved\.?|privacy\s+policy\s*[|·•-]\s*terms(?:\s+of\s+service)?)$/i,
  /^(?:unsubscribe|manage\s+preferences|view\s+in\s+browser)(?:\s*[|·•/,-]\s*(?:unsubscribe|manage\s+preferences|view\s+in\s+browser|privacy\s+policy|terms(?:\s+of\s+service)?|update\s+preferences|web\s+version))+$/i,
  /^[-=_*]{3,}$/,
];

const FORWARD_MARKER_RE = /^(?:-{3,}\s*forwarded\s+message\s*-{3,}|begin\s+forwarded\s+message:?)$/i;
const FORWARD_HEADER_RE = /^(?:from|date|sent|subject|to|cc|reply-to):\s+.+$/i;

function isBoilerplateLine(line: string): boolean {
  const trimmed = clean(line);
  if (!trimmed) return true;
  if (/^https?:[/]{2}\S+$/i.test(trimmed)) return true;
  return BOILERPLATE_LINE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Strip common newsletter boilerplate (view-in-browser, unsubscribe/preferences footers,
 * Gmail/Apple Mail forward headers, bare redirect URLs) while preserving article prose.
 */
export function stripNewsletterBoilerplate(text: string): string {
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let forwardState: "none" | "marker" | "headers" = "none";

  for (const rawLine of rawLines) {
    // Remove inline bracketed tracking URLs like `[https://substack.com/redirect/...]` or `<https://...>`.
    const withoutInlineUrls = rawLine
      .replace(/\s*[[(<]https?:[/]{2}[^\s\]>)]+[\])>]/gi, "")
      .trim();

    if (!withoutInlineUrls) {
      if (forwardState === "headers") {
        forwardState = "none";
      }
      kept.push("");
      continue;
    }

    if (FORWARD_MARKER_RE.test(withoutInlineUrls)) {
      forwardState = "marker";
      continue;
    }
    if (forwardState !== "none" && FORWARD_HEADER_RE.test(withoutInlineUrls)) {
      forwardState = "headers";
      continue;
    }
    forwardState = "none";

    if (isBoilerplateLine(withoutInlineUrls)) {
      continue;
    }

    kept.push(clean(withoutInlineUrls));
  }

  // Collapse runs of blank lines into clean paragraph breaks.
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of kept) {
    if (!line) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else if (/^#{1,6}\s+\S/.test(line)) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      paragraphs.push(line);
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }

  return paragraphs.filter((p) => !isBoilerplateLine(p)).join("\n\n").trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripForwardPrefixes(subject: string): string {
  return clean(subject.replace(/^(?:(?:fwd?|fw)\s*:\s*)+/i, ""));
}

const TRACKER_IMAGE_URL_RE =
  /(?:[/?&_.-](?:pixel|track(?:ing)?|beacon|open|spacer|blank|transparent|1x1)(?:[/?&_.-]|$)|\/email[-_]open\b|unsubscribe|social[-_]?icon)/i;

function parseDimensionAttr(value: string | null): number | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function isTinyOrTrackerImage(img: Element, resolvedHref: string): boolean {
  if (TRACKER_IMAGE_URL_RE.test(resolvedHref)) return true;
  const wAttr = parseDimensionAttr(img.getAttribute("width"));
  const hAttr = parseDimensionAttr(img.getAttribute("height"));
  if ((wAttr !== null && wAttr <= 32) || (hAttr !== null && hAttr <= 32)) {
    return true;
  }
  const style = (img.getAttribute("style") ?? "").toLowerCase();
  if (/\bdisplay\s*:\s*none\b/.test(style) || /\bvisibility\s*:\s*hidden\b/.test(style)) {
    return true;
  }
  const styleW = /\bwidth\s*:\s*(\d+)px\b/.exec(style);
  const styleH = /\bheight\s*:\s*(\d+)px\b/.exec(style);
  if (
    (styleW?.[1] && Number(styleW[1]) <= 32) ||
    (styleH?.[1] && Number(styleH[1]) <= 32)
  ) {
    return true;
  }
  return false;
}

function extractPublicEmailImage(document: Document): string | null {
  // 1. Prefer OpenGraph / Twitter card artwork if present.
  const metaImg = document.querySelector(
    'meta[property="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]',
  )?.getAttribute("content")?.trim();
  if (metaImg) {
    try {
      return articleUrl(metaImg).href;
    } catch {
      // fall through to first hero <img>
    }
  }

  // 2. Fall back to the first public HTTP(S) hero <img>, skipping tracking pixels & tiny icons.
  for (const img of document.querySelectorAll("img[src]")) {
    const rawSrc = img.getAttribute("src")?.trim();
    if (!rawSrc || !/^https?:[/]{2}/i.test(rawSrc)) continue;
    let resolvedHref: string;
    try {
      resolvedHref = articleUrl(rawSrc).href;
    } catch {
      continue;
    }
    if (isTinyOrTrackerImage(img, resolvedHref)) continue;
    return resolvedHref;
  }

  return null;
}

const NEWSLETTER_CHROME_CLASS_RE =
  /(?:^|[\s_-])(?:preheader|preview-text|email-preheader|unsubscribe|email-footer|newsletter-footer|view-in-browser|web-version|social-links|share-buttons|forward-footer)(?:$|[\s_-])/i;

function precleanEmailDom(document: Document): void {
  // Remove hidden preheaders, scripts, styles, and invisible elements.
  for (
    const el of document.querySelectorAll(
      'script, style, noscript, [hidden], [aria-hidden="true"]',
    )
  ) {
    el.remove();
  }

  for (const el of Array.from(document.querySelectorAll("[style], [class], [id]"))) {
    const style = (el.getAttribute("style") ?? "").toLowerCase();
    if (
      /\bdisplay\s*:\s*none\b/.test(style) ||
      /\bvisibility\s*:\s*hidden\b/.test(style) ||
      /\bmax-height\s*:\s*0(?:px)?\b/.test(style) ||
      /\bfont-size\s*:\s*0(?:px)?\b/.test(style)
    ) {
      el.remove();
      continue;
    }
    const marker = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
    if (NEWSLETTER_CHROME_CLASS_RE.test(marker) && clean(el.textContent).length < 600) {
      el.remove();
    }
  }

  // Remove short block-level boilerplate elements (e.g. "View in browser", "Unsubscribe").
  // Deliberately omits inline <a>/<span> so words inside real article sentences are never plucked.
  for (const el of Array.from(document.querySelectorAll("p, div, td, tr, footer, section, header"))) {
    if (!el.parentElement) continue;
    const text = clean(el.textContent);
    if (!text || text.length > 260) continue;
    // Skip broad layout containers that contain headings, tables, or multiple paragraphs.
    if (el.querySelector("h1, h2, h3, article, table, p + p")) continue;
    if (isBoilerplateLine(text)) {
      el.remove();
    }
  }
}

function collectDomHeadings(root: Element): string[] {
  const headings: string[] = [];
  const seen = new Set<string>();
  for (const h of root.querySelectorAll("h1, h2, h3")) {
    const text = clean(h.textContent);
    if (text.length >= 3 && text.length <= 96) {
      const key = text.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        headings.push(text);
      }
    }
  }
  return headings;
}

function collectPlainTextHeadings(text: string): string[] {
  const headings: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (!match?.[1]) continue;
    const heading = clean(match[1]);
    if (heading.length >= 3 && heading.length <= 96) {
      const key = heading.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        headings.push(heading);
      }
    }
  }
  return headings;
}

function getOptionalHeader(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * Convert a parsed MIME email into an `ExtractedArticle` ready for podcast synthesis.
 * Uses `extractArticle` (`@mozilla/readability` + `linkedom`) on cleaned HTML with
 * graceful DOM and `text/plain` fallbacks, extracts headings & public hero/og:image,
 * and strips newsletter unsubscribe / view-in-browser boilerplate.
 */
export function extractEmailArticle(
  parsed: ParsedMimeEmail,
  opts: {
    fallbackFrom?: string;
    headers?: Headers | Record<string, string>;
    url?: string;
  } = {},
): ExtractedArticle {
  const headerSubject = parsed.subject ||
    clean(sanitizeControlChars(decodeRfc2047(getOptionalHeader(opts.headers, "subject") ?? "")));
  const cleanedSubject = stripForwardPrefixes(headerSubject);

  const rawFallbackFrom = opts.fallbackFrom || getOptionalHeader(opts.headers, "from") || "";
  const fallbackFromParsed = rawFallbackFrom
    ? parseFromHeader(rawFallbackFrom)
    : { name: null, address: null };
  const senderAuthor = cleanBylineName(parsed.fromName || fallbackFromParsed.name) ||
    parsed.fromAddress ||
    fallbackFromParsed.address ||
    null;

  const publishedAt = parsed.date ??
    parseEmailDate(getOptionalHeader(opts.headers, "date") ?? undefined);

  let title = cleanedSubject;
  let author: string | null = senderAuthor;
  let body = "";
  let lead = "";
  let imageUrl: string | null = null;
  let headings: string[] = [];

  if (parsed.html) {
    const wrappedHtml = /<html[\s>]/i.test(parsed.html)
      ? parsed.html
      : `<!doctype html><html><head></head><body>${parsed.html}</body></html>`;
    const { document } = parseHTML(wrappedHtml);
    imageUrl = extractPublicEmailImage(document);
    precleanEmailDom(document);

    // Ensure `<title>` exists so Readability / `extractArticle` always has a title,
    // while preserving any `<meta>` author / published_time tags in `<head>`.
    const existingTitle = clean(document.querySelector("title")?.textContent);
    const fallbackHtmlTitle = cleanedSubject || existingTitle || "Email Newsletter";
    if (!existingTitle) {
      let head = document.head ?? document.querySelector("head");
      if (!head && document.documentElement) {
        head = document.createElement("head");
        document.documentElement.insertBefore(head, document.documentElement.firstChild);
      }
      if (head) {
        const titleEl = document.createElement("title");
        titleEl.textContent = fallbackHtmlTitle;
        head.appendChild(titleEl);
      }
    }

    const headInner = document.head?.innerHTML ?? `<title>${escapeHtml(fallbackHtmlTitle)}</title>`;
    const cleanedHtmlDoc =
      `<!doctype html><html><head>${headInner}</head><body>${document.body?.innerHTML ?? ""}</body></html>`;

    let usedReadability = false;
    try {
      const extracted = extractArticle(cleanedHtmlDoc, "upload://email/extract");
      const scrubbed = stripNewsletterBoilerplate(extracted.body);
      if (scrubbed.length >= MIN_READABLE_EMAIL_CHARS) {
        body = scrubbed;
        if (!title) title = clean(extracted.title);
        if (extracted.author) author = extracted.author;
        headings = extracted.headings ?? [];
        usedReadability = true;
      }
    } catch {
      // Table-heavy newsletters can fail Readability scoring; fall back to cleaned DOM text.
    }

    if (!usedReadability && document.body) {
      const domHeadings = collectDomHeadings(document.body);
      const rawDomText = plainText(document.body)
        .split("\n")
        .map(clean)
        .filter(Boolean)
        .join("\n\n");
      const scrubbedDom = stripNewsletterBoilerplate(rawDomText);
      if (scrubbedDom.length >= MIN_READABLE_EMAIL_CHARS) {
        body = scrubbedDom;
        headings = domHeadings;
        if (!title && domHeadings[0]) {
          title = domHeadings[0];
        }
      }
    }
  }

  // Fallback to text/plain if HTML was absent or yielded insufficient readable text.
  if (body.length < MIN_READABLE_EMAIL_CHARS && parsed.text) {
    const scrubbedPlain = stripNewsletterBoilerplate(parsed.text);
    if (scrubbedPlain.length > body.length) {
      body = scrubbedPlain;
      headings = collectPlainTextHeadings(scrubbedPlain);
    }
  }

  if (body.length < MIN_READABLE_EMAIL_CHARS) {
    throw new IngestError(422, "Email contains no readable text content.");
  }
  if (body.length > MAX_ARTICLE_CONTENT_CHARS) {
    throw new IngestError(
      413,
      `Article content exceeds the character limit (${body.length} > ${MAX_ARTICLE_CONTENT_CHARS}).`,
    );
  }

  const finalTitle = sanitizeControlChars(title || "Email Newsletter").replace(/\s+/g, " ").trim()
    .slice(0, 200) || "Email Newsletter";

  const paragraphs = body.split(/\n\n+/).map(clean).filter(Boolean);
  const firstProse = paragraphs.find((p) => p.length >= 40) ?? paragraphs[0] ?? body;
  lead = firstProse.slice(0, 300);

  return {
    url: opts.url ?? "email://pending",
    title: finalTitle,
    author,
    publishedAt,
    lead,
    body,
    ...(imageUrl ? { imageUrl } : {}),
    ...(headings.length > 0 ? { headings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Deterministic deduplication URL
// ---------------------------------------------------------------------------

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function normalizeMessageId(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^<+|>+$/g, "").replace(/\s+/g, "");
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Deterministic canonical URL for an ingested email so forwarding or retrying
 * the same message never creates duplicate episodes.
 */
export async function emailCanonicalUrl(input: {
  messageId?: string | null;
  from?: string | null;
  subject?: string | null;
  body: string;
}): Promise<string> {
  const normMsgId = normalizeMessageId(input.messageId);
  if (normMsgId) {
    const hash = await sha256Hex(normMsgId);
    return `email://msgid/${hash}`;
  }
  const normFrom = (input.from ?? "").trim().toLowerCase();
  const normSubject = clean(input.subject ?? "").toLowerCase();
  const normBody = clean(input.body).toLowerCase();
  const hash = await sha256Hex(`${normFrom}\0${normSubject}\0${normBody}`);
  return `email://content/${hash}`;
}

// ---------------------------------------------------------------------------
// End-to-end email ingestion
// ---------------------------------------------------------------------------

async function resolveSubscriberByToken(
  ctx: AppContext,
  feedToken: string,
): Promise<User | null> {
  const exact = await ctx.stores.metadata.getUserByFeedToken(feedToken);
  if (exact) return exact;
  const lowered = feedToken.toLowerCase();
  if (lowered !== feedToken) {
    return await ctx.stores.metadata.getUserByFeedToken(lowered);
  }
  return null;
}

async function readEmailRawBytes(
  raw: Uint8Array | string | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (typeof raw === "string") {
    if (raw.length > MAX_EMAIL_BYTES) {
      throw new IngestError(413, "Email exceeds the 2 MiB size limit.");
    }
    const encoded = textEncoder.encode(raw);
    if (encoded.byteLength > MAX_EMAIL_BYTES) {
      throw new IngestError(413, "Email exceeds the 2 MiB size limit.");
    }
    return encoded;
  }
  if (raw instanceof Uint8Array) {
    if (raw.byteLength > MAX_EMAIL_BYTES) {
      throw new IngestError(413, "Email exceeds the 2 MiB size limit.");
    }
    return raw;
  }
  const timeoutSignal = AbortSignal.timeout(STREAM_READ_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return await readBounded(
    raw,
    MAX_EMAIL_BYTES,
    413,
    combined,
    "Email exceeds the 2 MiB size limit.",
  );
}

async function releaseCreationCredit(
  limiter: ReturnType<typeof ingestCreationLimiter>,
  userId: string,
  reservation: RateLimitResult | undefined,
): Promise<void> {
  if (reservation?.recordedAt === undefined) return;
  try {
    await limiter.release(userId, reservation.recordedAt);
  } catch (err) {
    const screened = screenErrorForLogging(err);
    console.warn(
      `[audio-feed] email ingest failed to release creation credit for user ${userId}: ${screened.message}`,
    );
  }
}

/**
 * Ingest a forwarded newsletter email for an approved subscriber.
 *
 * Security & correctness guarantees:
 * - Size limit (`MAX_EMAIL_BYTES`), recipient parsing, and subscriber approval are
 *   verified BEFORE reading the raw body stream.
 * - Permanent rejections return `{ ok: false, reject: true, code, reason }` with
 *   static reasons that never echo `feedToken` or recipient addresses.
 * - Duplicate emails (matching `Message-ID` or normalized content hash) deduplicate
 *   atomically via `insertArticleWithEpisodeIfAbsent` and return `{ ok: true, deduplicated: true }`.
 */
export async function ingestEmailMessage(
  ctx: AppContext,
  input: EmailIngestInput,
): Promise<EmailIngestResult> {
  // 1. Enforce 2 MiB ceiling BEFORE reading any stream.
  if (typeof input.rawSize === "number" && input.rawSize > MAX_EMAIL_BYTES) {
    return {
      ok: false,
      reject: true,
      code: "oversize",
      reason: "Message exceeds the 2 MiB size limit.",
    };
  }

  // 2. Parse recipient address BEFORE hitting D1 or reading raw bytes.
  const recipient = parseEmailRecipient(input.to);
  if (!recipient) {
    return {
      ok: false,
      reject: true,
      code: "invalid_recipient",
      reason: "Invalid recipient address.",
    };
  }

  // 3. Resolve approved subscriber by feedToken (never log or echo token).
  const user = await resolveSubscriberByToken(ctx, recipient.feedToken);
  if (!user) {
    return {
      ok: false,
      reject: true,
      code: "unknown_recipient",
      reason: "Unknown recipient.",
    };
  }
  if (!isSynthesisAuthorized(user)) {
    return {
      ok: false,
      reject: true,
      code: "unapproved_user",
      reason: "Recipient account is not active.",
    };
  }

  // 4. Read raw bytes with strict 2 MiB bound (defense-in-depth if rawSize was omitted or lied).
  let rawBytes: Uint8Array;
  try {
    rawBytes = await readEmailRawBytes(input.raw, input.signal);
  } catch (err) {
    if (err instanceof IngestError && err.status === 413) {
      return {
        ok: false,
        reject: true,
        code: "oversize",
        reason: "Message exceeds the 2 MiB size limit.",
      };
    }
    return {
      ok: false,
      reject: true,
      code: "unparseable",
      reason: "Message body could not be read.",
    };
  }

  // 5. Parse MIME and extract clean article content.
  let parsed: ParsedMimeEmail;
  try {
    parsed = parseMimeEmail(rawBytes);
  } catch (err) {
    if (err instanceof IngestError && err.status === 413) {
      return {
        ok: false,
        reject: true,
        code: "oversize",
        reason: "Message exceeds the 2 MiB size limit.",
      };
    }
    return {
      ok: false,
      reject: true,
      code: "unparseable",
      reason: "Message could not be parsed.",
    };
  }

  let extracted: ExtractedArticle;
  try {
    extracted = extractEmailArticle(parsed, {
      fallbackFrom: input.from,
      headers: input.headers,
    });
  } catch (err) {
    if (err instanceof IngestError && err.status === 413) {
      return {
        ok: false,
        reject: true,
        code: "oversize",
        reason: "Message exceeds the maximum readable content limit.",
      };
    }
    return {
      ok: false,
      reject: true,
      code: "empty_body",
      reason: "Message contains no readable text content.",
    };
  }

  // 6. Compute deterministic canonical URL for deduplication.
  const messageId = parsed.messageId ?? getOptionalHeader(input.headers, "message-id");
  const canonicalUrl = await emailCanonicalUrl({
    messageId,
    from: parsed.fromAddress || parsed.from || input.from || "",
    subject: extracted.title,
    body: extracted.body,
  });

  // Fast-path dedupe check before charging the creation rate limiter.
  const existing = await ctx.stores.metadata.findArticleByUrl(user.id, canonicalUrl);
  if (existing) {
    return {
      ok: true,
      deduplicated: true,
      userId: user.id,
      sourceId: existing.sourceId,
      articleId: existing.id,
      mode: recipient.mode,
    };
  }

  // 7. Enforce shared per-subscriber daily episode creation budget.
  const limiter = ingestCreationLimiter(ctx, user);
  const reservation = await limiter.check(user.id);
  if (!reservation.allowed) {
    return {
      ok: false,
      reject: false,
      code: "rate_limited",
      reason: "Daily episode limit reached.",
    };
  }

  // 8. Reuse or seed the per-user "Email Newsletters" synthetic source and persist atomically.
  const existingSource = await ctx.stores.metadata.getSource(user.id, EMAIL_SOURCE_ID);
  const sourceTitle = existingSource?.title || EMAIL_SOURCE_TITLE;
  const now = new Date().toISOString();
  const articleId = newArticleId();
  const episodeId = newEpisodeId();

  const article: Article = {
    id: articleId,
    userId: user.id,
    sourceId: EMAIL_SOURCE_ID,
    url: canonicalUrl,
    title: extracted.title,
    author: extracted.author ?? undefined,
    publishedAt: extracted.publishedAt ?? undefined,
    content: extracted.body,
    excerpt: extracted.lead,
    ...(extracted.imageUrl ? { imageUrl: extracted.imageUrl } : {}),
    ...(extracted.headings?.length ? { headings: extracted.headings } : {}),
    ingestedAt: now,
  };

  const episode: Episode = {
    id: episodeId,
    userId: user.id,
    sourceId: EMAIL_SOURCE_ID,
    sourceTitle,
    articleId,
    mode: recipient.mode,
    status: "pending",
    title: extracted.title,
    description: extracted.lead,
    createdAt: now,
  };

  let inserted: boolean;
  try {
    inserted = await ctx.stores.metadata.insertArticleWithEpisodeIfAbsent(article, episode);
  } catch (err) {
    await releaseCreationCredit(limiter, user.id, reservation);
    throw err;
  }

  if (!inserted) {
    await releaseCreationCredit(limiter, user.id, reservation);
    const raced = await ctx.stores.metadata.findArticleByUrl(user.id, canonicalUrl);
    return {
      ok: true,
      deduplicated: true,
      userId: user.id,
      sourceId: raced?.sourceId ?? EMAIL_SOURCE_ID,
      articleId: raced?.id ?? articleId,
      mode: recipient.mode,
    };
  }

  // Post-commit synthetic source creation (mirrors enqueueInboxArticle: never fail a committed episode).
  if (!existingSource) {
    try {
      await ctx.stores.metadata.putSource({
        id: EMAIL_SOURCE_ID,
        userId: user.id,
        title: EMAIL_SOURCE_TITLE,
        modes: ["direct", "deepdive"],
        voices: {},
        createdAt: now,
      });
    } catch (err) {
      const screened = screenErrorForLogging(err);
      console.warn(
        `[audio-feed] failed to seed email source for user ${user.id}; episode ${episodeId} was queued: ${screened.message}`,
      );
    }
  }

  // Best-effort durable log (never includes recipient address or feedToken).
  try {
    await ctx.stores.metadata.appendLog({
      time: now,
      severity: "info",
      type: "email.ingested",
      message: `Email newsletter queued as episode ${episodeId}`,
      process: "worker",
      userId: user.id,
      episodeId,
      context: {
        sourceId: EMAIL_SOURCE_ID,
        articleId,
        mode: recipient.mode,
      },
    });
  } catch {
    // ignore logging failure
  }

  // Trigger immediate Cloudflare Workflow synthesis when configured.
  if (ctx.triggerSynthesis) {
    try {
      await ctx.triggerSynthesis(episodeId, user.id);
    } catch (err) {
      const screened = screenErrorForLogging(err);
      console.warn(
        `[audio-feed] workflow trigger failed for email episode ${episodeId}: ${screened.message}`,
      );
    }
  }

  return {
    ok: true,
    deduplicated: false,
    userId: user.id,
    sourceId: EMAIL_SOURCE_ID,
    articleId,
    episodeId,
    mode: recipient.mode,
    title: extracted.title,
  };
}
