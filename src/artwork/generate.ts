/**
 * Episode & show artwork acquisition and R2 caching.
 *
 * Resolution order for episode cover art:
 *   1. Existing `episode.artworkKey` already in R2.
 *   2. Scraped article `og:image` / `twitter:image` (fetched safely, magic-byte verified).
 *   3. Optional Gemini editorial illustration (`gemini-2.5-flash-image`), single best-effort call.
 *   4. Deterministic studio-grade raster PNG via `renderCoverPng(...)` (always succeeds).
 *
 * Artwork failures are NEVER fatal to synthesis.
 */

import { articleUrl } from "../ingest/url.ts";
import type { BlobStore } from "../storage/mod.ts";
import type { Article, Episode, Source } from "../types.ts";
import { renderCoverPng } from "./png.ts";

export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
const MAX_REMOTE_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MiB cap for scraped og:image / feed art
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;
const GEMINI_IMAGE_TIMEOUT_MS = 25_000;

export interface FetchedArtwork {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  ext: "png" | "jpg" | "webp";
}

export function artworkBlobKey(
  userId: string,
  scope: "master" | "source" | "episode",
  id?: string,
  ext: "png" | "jpg" | "webp" = "png",
): string {
  const safeUser = userId.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (scope === "master") return `art/${safeUser}/master.${ext}`;
  const safeId = (id ?? "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `art/${safeUser}/${scope}/${safeId}.${ext}`;
}

/** Detect raster image format from magic bytes (never trust Content-Type alone). */
export function sniffRasterImage(bytes: Uint8Array): {
  contentType: "image/png" | "image/jpeg" | "image/webp";
  ext: "png" | "jpg" | "webp";
} | null {
  if (bytes.byteLength < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { contentType: "image/png", ext: "png" };
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", ext: "jpg" };
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { contentType: "image/webp", ext: "webp" };
  }
  return null;
}

/**
 * Safely fetch a scraped article/feed image from a public http(s) URL.
 * Validates the URL against SSRF rules (`articleUrl`), enforces a 2 MiB size ceiling,
 * and verifies PNG/JPEG/WebP magic bytes.
 */
export async function fetchSafeArtworkImage(
  rawUrl: string,
  fetchFn?: typeof fetch,
): Promise<FetchedArtwork | null> {
  let safeUrl: URL;
  try {
    safeUrl = articleUrl(rawUrl);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS);
  try {
    const doFetch = fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));
    const res = await doFetch(safeUrl.href, {
      method: "GET",
      redirect: "follow",
      headers: { accept: "image/png,image/jpeg,image/webp;q=0.9,*/*;q=0.1" },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    // Re-validate final URL after any redirect.
    if (res.url) {
      try {
        articleUrl(res.url);
      } catch {
        return null;
      }
    }

    const declaredLen = Number(res.headers.get("content-length") ?? "0");
    if (declaredLen > MAX_REMOTE_IMAGE_BYTES) return null;

    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_REMOTE_IMAGE_BYTES) return null;
      const detected = sniffRasterImage(buf);
      return detected ? { bytes: buf, ...detected } : null;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > MAX_REMOTE_IMAGE_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    const detected = sniffRasterImage(bytes);
    return detected ? { bytes, ...detected } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeImageLabel(raw: string | undefined, maxLen: number): string {
  if (!raw) return "";
  return raw
    .replace(/[\u0000-\u001f<>`"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Best-effort bespoke square editorial podcast cover illustration via Gemini Image Gen.
 * Returns `null` on any error or timeout so callers seamlessly fall back to procedural art.
 */
export async function generateGeminiCoverArt(options: {
  apiKey: string;
  title: string;
  sourceTitle?: string;
  mode?: "direct" | "deepdive";
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
}): Promise<FetchedArtwork | null> {
  if (!options.apiKey) return null;
  const cleanTitle = sanitizeImageLabel(options.title, 120);
  const cleanSource = sanitizeImageLabel(options.sourceTitle, 60);
  const mood = options.mode === "deepdive"
    ? "two-person editorial radio studio visual metaphor, warm and analytical"
    : "minimalist editorial magazine cover art, crisp geometric composition";
  const description = [
    "Square podcast cover artwork, bold modern editorial illustration, rich studio lighting, zero text or letters anywhere in the image.",
    "Theme:",
    cleanTitle || "Technology and ideas",
    cleanSource ? `Publication: ${cleanSource}.` : "",
    `Style: ${mood}.`,
  ].filter(Boolean).join(" ");

  const model = options.model ?? DEFAULT_IMAGE_MODEL;
  const base = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_IMAGE_TIMEOUT_MS);
  try {
    const doFetch = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: description }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
            inline_data?: { mime_type?: string; data?: string };
          }>;
        };
      }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) {
        const bytes = base64ToUint8Array(inline.data);
        if (bytes.byteLength > 0 && bytes.byteLength <= MAX_REMOTE_IMAGE_BYTES * 2) {
          const detected = sniffRasterImage(bytes);
          if (detected) return { bytes, ...detected };
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensure an episode has raster cover art stored in R2 and return its blob key.
 * Never throws — always falls back to procedural studio cover PNG.
 */
export async function ensureEpisodeArtwork(options: {
  blobs: BlobStore;
  episode: Episode;
  article?: Article | null;
  source?: Source | null;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  allowGeminiImageGen?: boolean;
  fetchFn?: typeof fetch;
}): Promise<string | undefined> {
  const { blobs, episode, article, source } = options;
  try {
    if (episode.artworkKey) {
      const existing = await blobs.head(episode.artworkKey).catch(() => null);
      if (existing) return episode.artworkKey;
    }

    let art: FetchedArtwork | null = null;
    if (article?.imageUrl) {
      art = await fetchSafeArtworkImage(article.imageUrl, options.fetchFn);
    }
    if (!art && options.allowGeminiImageGen && options.geminiApiKey) {
      art = await generateGeminiCoverArt({
        apiKey: options.geminiApiKey,
        title: episode.title,
        sourceTitle: source?.title ?? episode.sourceTitle,
        mode: episode.mode,
        baseUrl: options.geminiBaseUrl,
        fetchFn: options.fetchFn,
      });
    }
    if (!art && source?.imageUrl) {
      art = await fetchSafeArtworkImage(source.imageUrl, options.fetchFn);
    }
    if (!art) {
      const png = await renderCoverPng({
        seed: `${episode.sourceId}:${episode.id}:${episode.title}`,
        title: source?.title ?? episode.sourceTitle ?? episode.title,
        mode: episode.mode,
        size: 512,
      });
      art = { bytes: png, contentType: "image/png", ext: "png" };
    }

    const key = artworkBlobKey(episode.userId, "episode", episode.id, art.ext);
    await blobs.put(key, art.bytes, { contentType: art.contentType });
    return key;
  } catch {
    return undefined;
  }
}
