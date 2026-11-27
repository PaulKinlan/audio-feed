/**
 * OPML 2.0 subscription import parser and exporter.
 *
 * Uses `linkedom`'s XML `DOMParser` (already a core dependency — zero new packages)
 * with an iterative DOM walk so deeply nested malicious documents cannot overflow
 * the call stack, and `linkedom` never resolves external XML entities (XXE).
 */

import { DOMParser } from "linkedom";
import type { Source } from "../types.ts";

/** Maximum OPML request payload size accepted by `POST /api/account/sources/opml` (512 KiB). */
export const MAX_OPML_BYTES = 512 * 1024;

/** Maximum unique feeds extracted per OPML import. */
export const MAX_OPML_FEEDS = 100;

/** Maximum invalid entries retained in parse diagnostics so responses stay bounded. */
const MAX_INVALID_ENTRIES = 100;

/** Illegal XML 1.0 control characters (everything below 0x20 except TAB, LF, CR, plus DEL). */
// deno-lint-ignore no-control-regex
const XML_ILLEGAL_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** All ASCII control characters stripped when normalizing feed titles/labels. */
// deno-lint-ignore no-control-regex
const ALL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export interface OpmlFeedEntry {
  /** Normalized http(s) feed URL (fragment stripped). */
  xmlUrl: string;
  /** Feed display title (from `title` or fallback `text`). */
  title?: string;
  /** Raw `text` attribute if present. */
  text?: string;
  /** Optional normalized http(s) site URL (`htmlUrl`). */
  htmlUrl?: string;
}

export interface OpmlInvalidEntry {
  url: string;
  reason: string;
}

export interface OpmlParseResult {
  /** True when the input parsed as an OPML document (`<opml>` or `<outline>` present). */
  hasOpmlStructure: boolean;
  /** Validated, deduplicated http(s) feed entries, capped at `maxFeeds`. */
  feeds: OpmlFeedEntry[];
  /** Invalid or non-http(s) `xmlUrl` entries stripped from the document. */
  invalid: OpmlInvalidEntry[];
  /** Number of duplicate normalized URLs skipped within the document. */
  duplicates: number;
  /** Number of additional unique valid feeds dropped beyond `maxFeeds`. */
  truncated: number;
}

export interface ParseOpmlOptions {
  /** Maximum unique feeds to return (clamped to `[1, MAX_OPML_FEEDS]`). */
  maxFeeds?: number;
}

export interface RenderOpmlOptions {
  title?: string;
  ownerName?: string;
  ownerEmail?: string;
  dateCreated?: Date | string;
}

/** Escape text or attribute values for XML 1.0, stripping illegal control characters. */
export function xmlEscape(value: string): string {
  return value
    .replace(XML_ILLEGAL_CONTROL_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Normalize an http(s) feed or site URL for deduplication.
 * Rejects non-http(s) schemes (`javascript:`, `file:`, `data:`, `ftp:`, etc.) and control chars.
 */
export function normalizeOpmlUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || ALL_CONTROL_CHARS.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  parsed.hash = "";
  return parsed.href;
}

function sanitizeLabel(raw: string | undefined, maxLength = 200): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(ALL_CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

function readLowercaseAttributes(node: Element): Map<string, string> {
  const attrs = new Map<string, string>();
  const list = node.attributes;
  if (!list) return attrs;
  for (let i = 0; i < list.length; i++) {
    const attr = list[i];
    if (!attr?.name) continue;
    const key = attr.name.toLowerCase();
    if (!attrs.has(key)) attrs.set(key, attr.value ?? "");
  }
  return attrs;
}

/**
 * Parse an OPML 2.0 XML document into deduplicated, http(s)-only feed entries.
 */
export function parseOpml(xml: string, options: ParseOpmlOptions = {}): OpmlParseResult {
  const result: OpmlParseResult = {
    hasOpmlStructure: false,
    feeds: [],
    invalid: [],
    duplicates: 0,
    truncated: 0,
  };
  if (typeof xml !== "string" || !xml.trim()) return result;

  const requestedMax = options.maxFeeds ?? MAX_OPML_FEEDS;
  const maxFeeds = Number.isFinite(requestedMax)
    ? Math.min(Math.max(1, Math.trunc(requestedMax)), MAX_OPML_FEEDS)
    : MAX_OPML_FEEDS;

  let document: Document;
  try {
    document = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    return result;
  }

  const seenUrls = new Set<string>();
  const stack: Node[] = [];
  const rootChildren = document.childNodes;
  for (let i = rootChildren.length - 1; i >= 0; i--) {
    const child = rootChildren[i];
    if (child) stack.push(child);
  }

  while (stack.length > 0) {
    const node = stack.pop()!;
    const name = typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "";
    if (name === "opml") {
      result.hasOpmlStructure = true;
    } else if (name === "outline") {
      result.hasOpmlStructure = true;
      const attrs = readLowercaseAttributes(node as Element);
      const rawXmlUrl = attrs.get("xmlurl")?.trim();
      if (rawXmlUrl) {
        const normalized = normalizeOpmlUrl(rawXmlUrl);
        if (!normalized) {
          if (result.invalid.length < MAX_INVALID_ENTRIES) {
            result.invalid.push({
              url: rawXmlUrl.slice(0, 500),
              reason: "Only valid http(s) feed URLs are supported.",
            });
          }
        } else if (seenUrls.has(normalized)) {
          result.duplicates++;
        } else if (result.feeds.length >= maxFeeds) {
          seenUrls.add(normalized);
          result.truncated++;
        } else {
          seenUrls.add(normalized);
          const text = sanitizeLabel(attrs.get("text"));
          const title = sanitizeLabel(attrs.get("title")) ?? text;
          const rawHtmlUrl = attrs.get("htmlurl");
          const htmlUrl = rawHtmlUrl ? (normalizeOpmlUrl(rawHtmlUrl) ?? undefined) : undefined;
          result.feeds.push({
            xmlUrl: normalized,
            ...(title ? { title } : {}),
            ...(text ? { text } : {}),
            ...(htmlUrl ? { htmlUrl } : {}),
          });
        }
      }
    }

    const children = node.childNodes;
    if (children && children.length > 0) {
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child) stack.push(child);
      }
    }
  }

  return result;
}

/**
 * Render subscribed RSS/Atom sources as a standards-compliant OPML 2.0 XML document.
 * Non-feed sources (such as the synthetic "Send to Audio" inbox) are omitted.
 */
export function renderOpml(
  sources: readonly Pick<Source, "title" | "feedUrl" | "siteUrl">[],
  options: RenderOpmlOptions = {},
): string {
  const docTitle = sanitizeLabel(options.title, 200) ?? "Audio Feed Subscriptions";
  const dateCreated = options.dateCreated instanceof Date
    ? options.dateCreated.toUTCString()
    : typeof options.dateCreated === "string" && options.dateCreated.trim()
    ? options.dateCreated.trim()
    : new Date().toUTCString();
  const ownerName = sanitizeLabel(options.ownerName, 120);
  const ownerEmail = sanitizeLabel(options.ownerEmail, 254);

  const headLines: string[] = [
    `    <title>${xmlEscape(docTitle)}</title>`,
    `    <dateCreated>${xmlEscape(dateCreated)}</dateCreated>`,
  ];
  if (ownerName) {
    headLines.push(`    <ownerName>${xmlEscape(ownerName)}</ownerName>`);
  }
  if (ownerEmail) {
    headLines.push(`    <ownerEmail>${xmlEscape(ownerEmail)}</ownerEmail>`);
  }

  const seenUrls = new Set<string>();
  const outlines: string[] = [];
  for (const source of sources) {
    if (!source.feedUrl) continue;
    const xmlUrl = normalizeOpmlUrl(source.feedUrl);
    if (!xmlUrl || seenUrls.has(xmlUrl)) continue;
    seenUrls.add(xmlUrl);

    const label = sanitizeLabel(source.title, 200) ?? xmlUrl;
    const htmlUrl = source.siteUrl ? normalizeOpmlUrl(source.siteUrl) : null;
    const htmlAttr = htmlUrl ? ` htmlUrl="${xmlEscape(htmlUrl)}"` : "";
    outlines.push(
      `    <outline type="rss" text="${xmlEscape(label)}" title="${xmlEscape(label)}" xmlUrl="${
        xmlEscape(xmlUrl)
      }"${htmlAttr} />`,
    );
  }

  const bodyBlock = outlines.length > 0
    ? `  <body>\n${outlines.join("\n")}\n  </body>`
    : `  <body />`;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0">`,
    `  <head>`,
    ...headLines,
    `  </head>`,
    bodyBlock,
    `</opml>`,
    "",
  ].join("\n");
}
