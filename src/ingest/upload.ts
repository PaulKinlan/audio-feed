/// <reference lib="dom" />
import {
  clean,
  extractArticle,
  type ExtractedArticle,
  extractPdfArticle,
  IngestError,
  PDF_PARSE_TIMEOUT_MS,
  readBounded,
} from "./url.ts";
import { type AudioMode, isSynthesisAuthorized, type User } from "../types.ts";
import { newArticleId, newEpisodeId } from "../ids.ts";
import { MAX_TTS_INPUT_BYTES, MAX_TTS_SEGMENTS } from "../tts/gemini.ts";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_NARRATION_BYTES = MAX_TTS_INPUT_BYTES * MAX_TTS_SEGMENTS; // 72,000 bytes
/**
 * Bound on the INFLATED size of a .docx's word/document.xml (audio-feed-yl3bq).
 * MAX_UPLOAD_BYTES bounds the COMPRESSED bytes; deflate inflates them, and a
 * 16 KB bomb was measured expanding to 16,000,000 text bytes before the
 * 72,000-byte narration check ever ran. No document that can pass the
 * narration ceiling needs anywhere near this much XML (it is ~58x the ceiling
 * in pure markup), so nothing legitimate is refused. Decompression is bounded
 * WHILE streaming: the allocation below can never exceed this.
 */
export const MAX_DOCX_INFLATED_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface UploadDependencies {
  authorize: (request: Request) => Promise<User | Response>;
  enqueue: (
    input: {
      article: ExtractedArticle;
      mode: AudioMode;
      user: User;
      articleId?: string;
      episodeId?: string;
    },
  ) => Promise<{ articleId: string; episodeId: string }>;
  onSuccess?: (info: {
    user: User;
    episodeId: string;
    articleId: string;
    article: ExtractedArticle;
    mode: AudioMode;
    filename: string;
    bytes: number;
  }) => Promise<void> | void;
  onFailure?: (info: {
    user?: User;
    reason: string;
    status: number;
    correlationId: string;
    error?: string;
    filename?: string;
    limit?: number;
    actual?: number;
    mode?: AudioMode;
  }) => Promise<void> | void;
}

export type DetectedFileType =
  | { kind: "pdf" }
  | { kind: "docx" }
  | { kind: "doc" }
  | { kind: "zip" }
  | { kind: "html" }
  | { kind: "text" }
  | { kind: "binary" };

export function detectFileType(bytes: Uint8Array, filename: string): DetectedFileType {
  const ext = filename.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() ?? "";

  // 1. PDF magic bytes: %PDF
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 && // '%'
    bytes[1] === 0x50 && // 'P'
    bytes[2] === 0x44 && // 'D'
    bytes[3] === 0x46 // 'F'
  ) {
    return { kind: "pdf" };
  }

  // 2. Old binary OLE Word (.doc): D0 CF 11 E0 A1 B1 1A E1
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  ) {
    return { kind: "doc" };
  }

  // 3. Zip magic: PK\x03\x04
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && // 'P'
    bytes[1] === 0x4b && // 'K'
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    if (ext === "docx") {
      return { kind: "docx" };
    }
    return { kind: "zip" };
  }

  // 4. Any file with .docx extension, even if corrupt/partial
  if (ext === "docx") {
    return { kind: "docx" };
  }

  // 5. Binary / null byte check: valid text/HTML has no null bytes
  const scanLimit = Math.min(bytes.length, 8192);
  for (let i = 0; i < scanLimit; i++) {
    if (bytes[i] === 0x00) {
      return { kind: "binary" };
    }
  }

  // 6. HTML check: sniff leading <!doctype html or <html, or .html/.htm extension
  let startOffset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    startOffset = 3;
  }
  const previewSlice = bytes.subarray(startOffset, Math.min(bytes.length, startOffset + 512));
  const previewText = new TextDecoder("utf-8", { fatal: false }).decode(previewSlice).trimStart();
  const lowerPreview = previewText.toLowerCase();

  if (
    lowerPreview.startsWith("<!doctype html") ||
    lowerPreview.startsWith("<html") ||
    ext === "html" ||
    ext === "htm"
  ) {
    return { kind: "html" };
  }

  // 7. Otherwise treat as text/.txt/.md (verify UTF-8 decodable)
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "text" };
  } catch {
    return { kind: "binary" };
  }
}

export function sanitizeFilenameTitle(filename: string): string {
  // Strip path separators and directory parts (prevent traversal like ../../x)
  const basename = filename.split(/[/\\]/).filter(Boolean).pop() ?? "";
  // Strip extension
  const withoutExt = basename.replace(/\.[a-zA-Z0-9]+$/, "");
  // Replace underscores, dashes with spaces
  const cleaned = withoutExt
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Strip control characters (ASCII < 32, DEL and the C1 range) by CODE POINT rather than by a regex range of
  // literal control characters, which deno lint rejects (no-control-regex) - and the gate runs lint, so a regex
  // here fails the whole gate rather than just this function.
  const sanitized = [...cleaned]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join("")
    .trim();
  return sanitized;
}

export function ensurePlainTextOnly(text: string): string {
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, "");
}

/**
 * Inflate a deflate-raw stream with a hard bound on the OUTPUT bytes
 * (audio-feed-yl3bq). The reader is cancelled the moment the inflated total
 * crosses maxBytes, so a zip bomb is rejected by a 413 naming the limit rather
 * than materializing an unbounded ArrayBuffer, XML string and DOM. A genuinely
 * corrupt stream keeps the pre-existing 415 mapping.
 */
async function inflateRawBounded(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([data as unknown as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new IngestError(
          413,
          `This .docx decompresses to more than 4 MiB of document XML ` +
            `(limit: ${
              maxBytes.toLocaleString("en-US")
            } bytes); split the document or upload a smaller part.`,
          { limit: maxBytes },
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(415, "This file is not a valid .docx (unparseable XML).");
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Decode XML entities the way DOM textContent would: the five named entities
 * and numeric character references, in a SINGLE left-to-right pass so
 * `&amp;lt;` decodes to the text `&lt;`, never to `<`.
 */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, body) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const cp = body[1] === "x" || body[1] === "X"
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m;
  });
}

const TAG_NAME_END = new Set([">", " ", "\t", "\n", "\r", "/"]);

/**
 * Extract paragraph text from word/document.xml by SCANNING, never by building
 * a DOM (audio-feed-heeem). Measured on the reviewer's repro: 3.3 MB of
 * markup-dense XML holding two characters of text - under the 4 MiB inflated
 * cap - became a ~260 MB DOM. The extraction needs only w:t text inside w:p
 * elements (getElementsByTagName already assumed the literal w: prefix), so a
 * bounded scan over the already size-capped string replaces the parser: memory
 * stays proportional to the capped input plus the extracted text, and the DOM
 * amplification class is GONE rather than capped. Malformed XML no longer
 * fails well-formedness; it yields whatever text is visible, which
 * ensurePlainTextOnly renders inert - the corruption rejections that remain
 * (bad zip, bad deflate, no document.xml) are the ones with operator meaning.
 */
function extractDocxParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const pOpen = xml.indexOf("<w:p", cursor);
    if (pOpen === -1) break;
    // `<w:p` must BE the w:p element, not w:pPr / w:pgSz / w:pStyle: the next
    // character ends the tag name.
    if (!TAG_NAME_END.has(xml[pOpen + 4] ?? "")) {
      cursor = pOpen + 4;
      continue;
    }
    const pEnd = xml.indexOf("</w:p>", pOpen);
    const pClose = pEnd === -1 ? xml.length : pEnd;
    let para = "";
    let tCursor = pOpen;
    while (tCursor < pClose) {
      const tOpen = xml.indexOf("<w:t", tCursor);
      if (tOpen === -1 || tOpen >= pClose) break;
      // `<w:t` must be w:t, not w:tbl / w:tc / w:tr (a table cell's paragraphs
      // are found by the OUTER loop, exactly as getElementsByTagName found
      // them).
      if (!TAG_NAME_END.has(xml[tOpen + 4] ?? "")) {
        tCursor = tOpen + 4;
        continue;
      }
      const tagEnd = xml.indexOf(">", tOpen);
      if (tagEnd === -1 || tagEnd >= pClose) break;
      if (xml[tagEnd - 1] === "/") {
        tCursor = tagEnd + 1; // <w:t/> carries no text
        continue;
      }
      const tEnd = xml.indexOf("</w:t>", tagEnd);
      if (tEnd === -1 || tEnd > pClose) break;
      para += decodeXmlEntities(xml.slice(tagEnd + 1, tEnd));
      tCursor = tEnd + 6;
    }
    if (para.trim().length > 0) paragraphs.push(para.trim());
    if (pEnd === -1) break;
    cursor = pEnd + 6;
  }
  return paragraphs;
}

export async function extractDocxArticle(
  bytes: Uint8Array,
  syntheticUrl: string,
  displayTitle: string,
): Promise<ExtractedArticle> {
  // 1. Locate EOCD signature 0x06054b50 searching backwards from end
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 65535 - 22);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new IngestError(415, "This file is not a valid .docx (no word/document.xml).");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (cdOffset < 0 || cdOffset + cdSize > bytes.length) {
    throw new IngestError(415, "This file is not a valid .docx (no word/document.xml).");
  }

  // 2. Walk Central Directory entries
  let entryOffset = cdOffset;
  let targetEntry: {
    compressionMethod: number;
    compressedSize: number;
    localHeaderOffset: number;
  } | null = null;

  for (let i = 0; i < totalEntries && entryOffset + 46 <= cdOffset + cdSize; i++) {
    if (view.getUint32(entryOffset, true) !== 0x02014b50) {
      break;
    }
    const compressionMethod = view.getUint16(entryOffset + 10, true);
    const compressedSize = view.getUint32(entryOffset + 20, true);
    const nameLen = view.getUint16(entryOffset + 28, true);
    const extraLen = view.getUint16(entryOffset + 30, true);
    const commentLen = view.getUint16(entryOffset + 32, true);
    const localHeaderOffset = view.getUint32(entryOffset + 42, true);

    if (entryOffset + 46 + nameLen > bytes.length) break;

    const nameBytes = bytes.subarray(entryOffset + 46, entryOffset + 46 + nameLen);
    const name = new TextDecoder("utf-8").decode(nameBytes);

    if (name === "word/document.xml") {
      targetEntry = {
        compressionMethod,
        compressedSize,
        localHeaderOffset,
      };
      break;
    }

    entryOffset += 46 + nameLen + extraLen + commentLen;
  }

  if (!targetEntry) {
    throw new IngestError(415, "This file is not a valid .docx (no word/document.xml).");
  }

  const { compressionMethod, compressedSize, localHeaderOffset } = targetEntry;

  if (localHeaderOffset + 30 > bytes.length) {
    throw new IngestError(415, "This file is not a valid .docx (no word/document.xml).");
  }

  if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
    throw new IngestError(415, "This file is not a valid .docx (no word/document.xml).");
  }

  const localNameLen = view.getUint16(localHeaderOffset + 26, true);
  const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
  const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

  if (dataOffset + compressedSize > bytes.length) {
    throw new IngestError(415, "This file is not a valid .docx (no word/document.xml).");
  }

  const compressedData = bytes.subarray(dataOffset, dataOffset + compressedSize);
  let xmlBytes: Uint8Array;
  if (compressionMethod === 0) {
    // Stored, not compressed: the bytes are already bounded by the 10 MiB upload
    // cap, but the same inflated-XML bound applies so a stored 10 MiB of markup
    // is refused at the same place a deflated bomb is.
    if (compressedSize > MAX_DOCX_INFLATED_BYTES) {
      throw new IngestError(
        413,
        `This .docx holds more than 4 MiB of document XML ` +
          `(limit: ${
            MAX_DOCX_INFLATED_BYTES.toLocaleString("en-US")
          } bytes); split the document or upload a smaller part.`,
        { limit: MAX_DOCX_INFLATED_BYTES, actual: compressedSize },
      );
    }
    xmlBytes = compressedData;
  } else if (compressionMethod === 8) {
    xmlBytes = await inflateRawBounded(compressedData, MAX_DOCX_INFLATED_BYTES);
  } else {
    throw new IngestError(415, "This file is not a valid .docx (no word/document.xml).");
  }

  const xmlText = new TextDecoder("utf-8", { fatal: false }).decode(xmlBytes);
  const paragraphs = extractDocxParagraphs(xmlText);

  const cleanBody = ensurePlainTextOnly(paragraphs.join("\n\n").trim());
  if (!cleanBody) {
    throw new IngestError(415, "This file is not a valid .docx (contains no readable text).");
  }

  const firstPara = cleanBody.split(/\r?\n\s*\r?\n/)[0]?.trim() ?? "";
  const lead = firstPara.slice(0, 300);
  const title = displayTitle || "Uploaded Document";

  return {
    url: syntheticUrl,
    title,
    author: null,
    publishedAt: null,
    lead,
    body: cleanBody,
  };
}

/** Mount at POST /api/upload. Caller supplies approved-user authorization and durable queue. */
export function createUploadIngestHandler(
  deps: UploadDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const json = (body: unknown, status: number) =>
      Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    let user: User | Response | undefined;
    try {
      user = await deps.authorize(request);
      if (user instanceof Response) return user;
      if (!user?.id || !isSynthesisAuthorized(user)) {
        const correlationId = crypto.randomUUID();
        const error = "An approved user is required.";
        await deps.onFailure?.({ user, reason: "unauthorized", status: 403, correlationId, error });
        return json({ error, correlationId }, 403);
      }

      const contentType = request.headers.get("content-type") ?? "";
      if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
        const correlationId = crypto.randomUUID();
        const error = "Expected multipart/form-data request.";
        await deps.onFailure?.({
          user,
          reason: "unsupported_media",
          status: 415,
          correlationId,
          error,
        });
        return json({ error, correlationId }, 415);
      }

      let detectedFilename: string | undefined;
      const inspector = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!detectedFilename) {
            const text = new TextDecoder().decode(chunk.subarray(0, 2048));
            const match = text.match(/filename="?([^"\r\n;]+)"?/i);
            if (match && match[1]) detectedFilename = match[1].trim();
          }
          controller.enqueue(chunk);
        },
      });

      const inspectedBody = request.body ? request.body.pipeThrough(inspector) : null;
      let bodyBytes: Uint8Array;
      const bodySignal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
      try {
        bodyBytes = await readBounded(
          inspectedBody,
          MAX_UPLOAD_BYTES,
          413,
          bodySignal,
          `File exceeds the 10 MiB limit of ${MAX_UPLOAD_BYTES} bytes.`,
        );
      } catch (err) {
        if (err instanceof IngestError && err.status === 413) {
          const correlationId = crypto.randomUUID();
          const actual = err.actual ?? (MAX_UPLOAD_BYTES + 1);
          const file = detectedFilename ?? "upload";
          const error =
            `File '${file}' exceeds the 10 MiB limit of 10,485,760 bytes (received ${actual} bytes).`;
          await deps.onFailure?.({
            user,
            reason: "payload_too_large",
            status: 413,
            correlationId,
            error,
            filename: file,
            limit: MAX_UPLOAD_BYTES,
            actual,
          });
          return json({
            error,
            correlationId,
            file,
            limit: MAX_UPLOAD_BYTES,
            actual,
          }, 413);
        }
        if (err instanceof IngestError) {
          const correlationId = crypto.randomUUID();
          const reason = err.status === 408 ? "timeout" : "internal_error";
          await deps.onFailure?.({
            user,
            reason,
            status: err.status,
            correlationId,
            error: err.message,
            filename: detectedFilename,
          });
          return json({
            error: err.message,
            correlationId,
            ...(detectedFilename ? { file: detectedFilename } : {}),
          }, err.status);
        }
        throw err;
      }

      let formData: FormData;
      try {
        formData = await new Response(bodyBytes as BodyInit, {
          headers: { "content-type": contentType },
        }).formData();
      } catch (formError) {
        const correlationId = crypto.randomUUID();
        const error = "Failed to parse multipart form data: " +
          ((formError as Error)?.message || "invalid format");
        await deps.onFailure?.({
          user,
          reason: "invalid_input",
          status: 400,
          correlationId,
          error,
          filename: detectedFilename,
        });
        return json({
          error,
          correlationId,
          ...(detectedFilename ? { file: detectedFilename } : {}),
        }, 400);
      }

      const fileEntries = formData.getAll("file");
      if (fileEntries.length === 0 || !(fileEntries[0] instanceof File)) {
        const correlationId = crypto.randomUUID();
        const error = "No 'file' field found in multipart upload.";
        await deps.onFailure?.({
          user,
          reason: "invalid_input",
          status: 400,
          correlationId,
          error,
        });
        return json({ error, correlationId }, 400);
      }
      if (fileEntries.length > 1) {
        const correlationId = crypto.randomUUID();
        const error = "Only one file upload is supported per request.";
        await deps.onFailure?.({
          user,
          reason: "invalid_input",
          status: 400,
          correlationId,
          error,
        });
        return json({ error, correlationId }, 400);
      }

      const file = fileEntries[0] as File;
      const rawFilename = file.name || detectedFilename || "upload";
      const displayTitle = sanitizeFilenameTitle(rawFilename);

      const rawMode = formData.get("mode");
      if (rawMode && rawMode !== "direct" && rawMode !== "deepdive") {
        const correlationId = crypto.randomUUID();
        const error = `Expected mode direct or deepdive, received "${rawMode}".`;
        await deps.onFailure?.({
          user,
          reason: "invalid_input",
          status: 400,
          correlationId,
          error,
          filename: rawFilename,
        });
        return json({ error, correlationId, file: rawFilename }, 400);
      }
      const mode: AudioMode = rawMode === "deepdive" ? "deepdive" : "direct";

      const fileBytes = new Uint8Array(await file.arrayBuffer());
      if (fileBytes.byteLength === 0) {
        const correlationId = crypto.randomUUID();
        const error = `File '${rawFilename}' is empty.`;
        await deps.onFailure?.({
          user,
          reason: "invalid_input",
          status: 400,
          correlationId,
          error,
          filename: rawFilename,
          actual: 0,
          mode,
        });
        return json({ error, correlationId, file: rawFilename, actual: 0 }, 400);
      }

      if (fileBytes.byteLength > MAX_UPLOAD_BYTES) {
        const correlationId = crypto.randomUUID();
        const error =
          `File '${rawFilename}' exceeds the 10 MiB limit of 10,485,760 bytes (received ${fileBytes.byteLength} bytes).`;
        await deps.onFailure?.({
          user,
          reason: "payload_too_large",
          status: 413,
          correlationId,
          error,
          filename: rawFilename,
          limit: MAX_UPLOAD_BYTES,
          actual: fileBytes.byteLength,
          mode,
        });
        return json({
          error,
          correlationId,
          file: rawFilename,
          limit: MAX_UPLOAD_BYTES,
          actual: fileBytes.byteLength,
        }, 413);
      }

      const detected = detectFileType(fileBytes, rawFilename);
      if (detected.kind === "doc") {
        const correlationId = crypto.randomUUID();
        const error =
          "Legacy .doc files (Word 97-2003) are not supported. Save the document as .docx and upload that.";
        await deps.onFailure?.({
          user,
          reason: "unsupported_media",
          status: 415,
          correlationId,
          error,
          filename: rawFilename,
          mode,
        });
        return json({ error, correlationId, file: rawFilename }, 415);
      }
      if (detected.kind === "zip") {
        const correlationId = crypto.randomUUID();
        const error = "Zip archives are not supported.";
        await deps.onFailure?.({
          user,
          reason: "unsupported_media",
          status: 415,
          correlationId,
          error,
          filename: rawFilename,
          mode,
        });
        return json({ error, correlationId, file: rawFilename }, 415);
      }
      if (detected.kind === "binary") {
        const correlationId = crypto.randomUUID();
        const error =
          `Unsupported binary file format for '${rawFilename}'. Only text, markdown, HTML, and PDF files are supported.`;
        await deps.onFailure?.({
          user,
          reason: "unsupported_media",
          status: 415,
          correlationId,
          error,
          filename: rawFilename,
          mode,
        });
        return json({ error, correlationId, file: rawFilename }, 415);
      }

      const articleId = newArticleId();
      const episodeId = newEpisodeId();
      const syntheticUrl = `upload://${user.id}/${articleId}`;

      let article: ExtractedArticle;
      if (detected.kind === "docx") {
        let extracted: ExtractedArticle;
        try {
          extracted = await extractDocxArticle(fileBytes, syntheticUrl, displayTitle);
        } catch (err) {
          const correlationId = crypto.randomUUID();
          const status = err instanceof IngestError ? err.status : 415;
          const error = (err as Error)?.message || "Failed to parse DOCX document.";
          await deps.onFailure?.({
            user,
            reason: "unsupported_media",
            status,
            correlationId,
            error,
            filename: rawFilename,
            mode,
          });
          return json({ error, correlationId, file: rawFilename }, status);
        }
        article = extracted;
      } else if (detected.kind === "pdf") {
        let extracted: ExtractedArticle;
        try {
          extracted = await extractPdfArticle(fileBytes, syntheticUrl, {
            timeoutMs: PDF_PARSE_TIMEOUT_MS,
          });
        } catch (err) {
          const correlationId = crypto.randomUUID();
          const status = err instanceof IngestError ? err.status : 422;
          const error = (err as Error)?.message || "Failed to parse PDF document.";
          await deps.onFailure?.({
            user,
            reason: "extraction_failed",
            status,
            correlationId,
            error,
            filename: rawFilename,
            mode,
          });
          return json({ error, correlationId, file: rawFilename }, status);
        }
        const title = (extracted.title && extracted.title !== "PDF Document")
          ? extracted.title
          : (displayTitle || "PDF Document");
        article = {
          url: syntheticUrl,
          title,
          author: extracted.author ?? null,
          publishedAt: extracted.publishedAt ?? null,
          lead: extracted.lead,
          body: extracted.body,
        };
      } else if (detected.kind === "html") {
        const htmlText = new TextDecoder("utf-8", { fatal: false }).decode(fileBytes);
        let extracted: ExtractedArticle;
        try {
          extracted = extractArticle(htmlText, syntheticUrl);
        } catch (err) {
          const correlationId = crypto.randomUUID();
          const status = err instanceof IngestError ? err.status : 422;
          const error = (err as Error)?.message || "Failed to extract article from HTML.";
          await deps.onFailure?.({
            user,
            reason: "extraction_failed",
            status,
            correlationId,
            error,
            filename: rawFilename,
            mode,
          });
          return json({ error, correlationId, file: rawFilename }, status);
        }
        const cleanBody = ensurePlainTextOnly(extracted.body);
        const title = clean(extracted.title) || displayTitle || "Uploaded Article";
        article = {
          url: syntheticUrl,
          title,
          author: extracted.author ?? null,
          publishedAt: extracted.publishedAt ?? null,
          lead: extracted.lead,
          body: cleanBody,
        };
      } else {
        // detected.kind === "text"
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes).replace(/^\uFEFF/, "");
        } catch {
          const correlationId = crypto.randomUUID();
          const error = `File '${rawFilename}' is not valid UTF-8 text.`;
          await deps.onFailure?.({
            user,
            reason: "unsupported_media",
            status: 415,
            correlationId,
            error,
            filename: rawFilename,
            mode,
          });
          return json({ error, correlationId, file: rawFilename }, 415);
        }
        const cleanBody = text.trim();
        if (!cleanBody) {
          const correlationId = crypto.randomUUID();
          const error = `File '${rawFilename}' contains no readable text.`;
          await deps.onFailure?.({
            user,
            reason: "invalid_input",
            status: 400,
            correlationId,
            error,
            filename: rawFilename,
            actual: 0,
            mode,
          });
          return json({ error, correlationId, file: rawFilename, actual: 0 }, 400);
        }
        const firstPara = cleanBody.split(/\r?\n\s*\r?\n/)[0]?.trim() ?? "";
        const lead = firstPara.slice(0, 300);
        const title = displayTitle || "Uploaded Document";
        article = {
          url: syntheticUrl,
          title,
          author: null,
          publishedAt: null,
          lead,
          body: cleanBody,
        };
      }

      // Check narration limit (72,000 bytes)
      const textBytes = new TextEncoder().encode(article.body).byteLength;
      if (textBytes > MAX_NARRATION_BYTES) {
        const correlationId = crypto.randomUUID();
        const error =
          `Extracted text from '${rawFilename}' exceeds the narration limit of 72,000 bytes (actual: ${textBytes} bytes).`;
        await deps.onFailure?.({
          user,
          reason: "payload_too_large",
          status: 413,
          correlationId,
          error,
          filename: rawFilename,
          limit: MAX_NARRATION_BYTES,
          actual: textBytes,
          mode,
        });
        return json({
          error,
          correlationId,
          file: rawFilename,
          limit: MAX_NARRATION_BYTES,
          actual: textBytes,
        }, 413);
      }

      let job: { articleId: string; episodeId: string };
      try {
        job = await deps.enqueue({
          article,
          mode,
          user,
          articleId,
          episodeId,
        });
      } catch (err) {
        const correlationId = crypto.randomUUID();
        const error = (err as Error)?.message || "Unable to queue episode.";
        await deps.onFailure?.({
          user,
          reason: "enqueue_failed",
          status: 503,
          correlationId,
          error,
          filename: rawFilename,
          mode,
        });
        return json(
          { error: "Unable to queue the upload.", correlationId, file: rawFilename },
          503,
        );
      }

      await deps.onSuccess?.({
        user,
        episodeId: job.episodeId,
        articleId: job.articleId,
        article,
        mode,
        filename: rawFilename,
        bytes: textBytes,
      });

      return json({
        ...job,
        status: "queued",
        mode,
        article,
        correlationId: job.episodeId,
      }, 202);
    } catch (error) {
      const correlationId = crypto.randomUUID();
      const message = error instanceof IngestError
        ? error.message
        : "Unable to process file upload.";
      const status = error instanceof IngestError ? error.status : 503;
      return json({ error: message, correlationId }, status);
    }
  };
}
