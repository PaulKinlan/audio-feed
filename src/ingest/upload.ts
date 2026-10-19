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

  // 2. Zip magic: PK\x03\x04
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && // 'P'
    bytes[1] === 0x4b && // 'K'
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    if (ext === "docx" || ext === "doc") {
      return { kind: "docx" };
    }
    return { kind: "zip" };
  }

  // 3. Old binary OLE Word (.doc): D0 CF 11 E0 A1 B1 1A E1
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    ext === "doc"
  ) {
    return { kind: "docx" };
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
  // Strip control characters (ASCII < 32 and DEL / C1)
  const sanitized = cleaned.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  return sanitized;
}

export function ensurePlainTextOnly(text: string): string {
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, "");
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
      if (detected.kind === "docx") {
        const correlationId = crypto.randomUUID();
        const error = "DOCX files are not yet supported.";
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
      if (detected.kind === "pdf") {
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
