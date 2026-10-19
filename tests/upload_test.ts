import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { extractDocxArticle, MAX_DOCX_INFLATED_BYTES } from "../src/ingest/upload.ts";
import { makeUser } from "./fixtures.ts";
import type { User } from "../src/types.ts";

function makeSyntheticPdf(options: {
  title?: string;
  author?: string;
  creationDate?: string;
  lines: string[];
}): Uint8Array {
  const contentStream = options.lines.map((line, idx) =>
    `BT /F1 12 Tf 50 ${700 - idx * 25} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`
  ).join("\n");
  const streamLength = new TextEncoder().encode(contentStream).length;

  const infoEntries: string[] = [];
  if (options.title) infoEntries.push(`/Title (${options.title.replace(/[()\\]/g, "\\$&")})`);
  if (options.author) infoEntries.push(`/Author (${options.author.replace(/[()\\]/g, "\\$&")})`);
  if (options.creationDate) {
    infoEntries.push(`/CreationDate (${options.creationDate.replace(/[()\\]/g, "\\$&")})`);
  }
  const infoObj = infoEntries.length > 0 ? `6 0 obj\n<< ${infoEntries.join(" ")} >>\nendobj\n` : "";

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${streamLength} >>
stream
${contentStream}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
${infoObj}xref
0 7
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
0000000227 00000 n 
0000000350 00000 n 
0000000450 00000 n 
trailer
<< /Size 7 /Root 1 0 R ${infoEntries.length > 0 ? "/Info 6 0 R" : ""} >>
startxref
550
%%EOF`;

  return new TextEncoder().encode(pdf);
}

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

async function setupTestApp(approvedOverrides: Partial<User> = {}) {
  const stores: Stores = memoryStores();
  const user = makeUser({ id: "user-1", status: "approved", ...approvedOverrides });
  await stores.metadata.putUser(user);
  const app = createApp({ config, stores }, createHandlers({ config, stores }));
  return { app, stores, user };
}

Deno.test("POST /api/upload accepts .txt, creates pending episode with synthetic upload:// url", async () => {
  const { app, stores, user } = await setupTestApp();
  const txtContent =
    "The quick brown fox jumps over the lazy dog. A distinctive sentence for plain text upload testing.";
  const formData = new FormData();
  formData.append("file", new File([txtContent], "notes.txt", { type: "text/plain" }));
  formData.append("mode", "direct");

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 202);
  const body = await res.json();
  assertEquals(body.status, "queued");
  assertEquals(body.mode, "direct");
  assertStringIncludes(body.article.url, `upload://${user.id}/`);
  assertEquals(body.article.url.includes("notes.txt"), false);
  assertEquals(body.article.body, txtContent);

  const article = await stores.metadata.getArticle(user.id, body.articleId);
  assert(article);
  assertEquals(article.content, txtContent);
  assertEquals(article.url, body.article.url);

  const episode = await stores.metadata.getEpisode(user.id, body.episodeId);
  assert(episode);
  assertEquals(episode.status, "pending");
  assertEquals(episode.articleId, body.articleId);
  assertEquals(episode.mode, "direct");
});

Deno.test("POST /api/upload accepts .html, extracts clean body and creates pending episode", async () => {
  const { app, stores, user } = await setupTestApp();
  const distinctive =
    "The rain in Spain stays mainly in the plain, providing ample demonstration of phonetic accuracy.";
  const htmlContent = `<!DOCTYPE html><html><head><title>Phonetics Today</title></head><body>
    <h1>Phonetics Today</h1>
    <p>${distinctive}</p>
    <p>Subsequent paragraphs expand upon dialectal variation across mountainous terrain and valleys.</p>
  </body></html>`;

  const formData = new FormData();
  formData.append("file", new File([htmlContent], "article.html", { type: "text/html" }));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 202);
  const body = await res.json();
  assertStringIncludes(body.article.url, `upload://${user.id}/`);

  const article = await stores.metadata.getArticle(user.id, body.articleId);
  assert(article);
  assertStringIncludes(article.content, distinctive);

  const episode = await stores.metadata.getEpisode(user.id, body.episodeId);
  assert(episode);
  assertEquals(episode.status, "pending");
});

Deno.test("POST /api/upload accepts .pdf, extracts text layer and creates pending episode", async () => {
  const { app, stores, user } = await setupTestApp();
  const distinctive =
    "The majestic eagle soared across the azure mountain peaks with unparalleled elegance and strength.";
  const pdfBytes = makeSyntheticPdf({
    title: "Alpine Aviation",
    lines: [
      distinctive,
      "Second line of detailed aerodynamic observation documenting lift, drag, and thermal soaring techniques.",
    ],
  });

  const formData = new FormData();
  formData.append(
    "file",
    new File([pdfBytes as unknown as BlobPart], "flight-report.pdf", { type: "application/pdf" }),
  );

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 202);
  const body = await res.json();
  assertStringIncludes(body.article.url, `upload://${user.id}/`);

  const article = await stores.metadata.getArticle(user.id, body.articleId);
  assert(article);
  assertStringIncludes(article.content, distinctive);

  const episode = await stores.metadata.getEpisode(user.id, body.episodeId);
  assert(episode);
  assertEquals(episode.status, "pending");
});

Deno.test("POST /api/upload with .html containing <script> strips scripts, alert, and HTML tags", async () => {
  const { app, stores, user } = await setupTestApp();
  const safeSentence =
    "This is completely safe prose for the narrator to read aloud to the subscriber without any harmful markup.";
  const htmlWithScript = `<!DOCTYPE html><html><head><title>Security Audit</title></head><body>
    <h1>Security Audit Header</h1>
    <p>${safeSentence}</p>
    <script>alert("xss-payload-should-not-exist");</script>
    <p>Another safe paragraph following the script block to ensure clean, plain text extraction.</p>
  </body></html>`;

  const formData = new FormData();
  formData.append("file", new File([htmlWithScript], "exploit.html", { type: "text/html" }));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 202);
  const body = await res.json();
  const article = await stores.metadata.getArticle(user.id, body.articleId);
  assert(article);
  assertEquals(article.content.includes("<script"), false);
  assertEquals(article.content.includes("alert("), false);
  assertEquals(article.content.includes("xss-payload"), false);
  assertEquals(article.content.includes("<p>"), false);
  assertEquals(article.content.includes("</p>"), false);
  assertEquals(article.content.includes("<"), false);
});

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function makeZip(
  entries: Array<{ name: string; stored: Uint8Array; size: number; method: number }>,
): Uint8Array {
  const fileEntries: Array<
    { nameBytes: Uint8Array; offset: number; stored: number; size: number; method: number }
  > = [];
  let offset = 0;
  const parts: Uint8Array[] = [];

  for (const file of entries) {
    const nameBytes = new TextEncoder().encode(file.name);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, file.method, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, 0, true);
    view.setUint32(18, file.stored.length, true);
    view.setUint32(22, file.size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    parts.push(localHeader);
    parts.push(file.stored);

    fileEntries.push({
      nameBytes,
      offset,
      stored: file.stored.length,
      size: file.size,
      method: file.method,
    });

    offset += localHeader.length + file.stored.length;
  }

  const cdStart = offset;
  for (const entry of fileEntries) {
    const cdHeader = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(cdHeader.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, 0, true);
    view.setUint32(20, entry.stored, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, entry.offset, true);
    cdHeader.set(entry.nameBytes, 46);

    parts.push(cdHeader);
    offset += cdHeader.length;
  }

  const cdSize = offset - cdStart;
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, fileEntries.length, true);
  view.setUint16(10, fileEntries.length, true);
  view.setUint32(12, cdSize, true);
  view.setUint32(16, cdStart, true);
  view.setUint16(20, 0, true);

  parts.push(eocd);

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const zip = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    zip.set(p, pos);
    pos += p.length;
  }
  return zip;
}

function makeStoredZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  return makeZip(
    files.map((f) => ({ name: f.name, stored: f.data, size: f.data.length, method: 0 })),
  );
}

/** A deflate-compressed zip: the .docx bomb shape (audio-feed-yl3bq). */
async function makeDeflatedZip(
  files: Array<{ name: string; data: Uint8Array }>,
): Promise<Uint8Array> {
  const entries = [];
  for (const f of files) {
    const buf = await new Response(
      new Blob([f.data as unknown as BlobPart]).stream().pipeThrough(
        new CompressionStream("deflate-raw"),
      ),
    ).arrayBuffer();
    entries.push({ name: f.name, stored: new Uint8Array(buf), size: f.data.length, method: 8 });
  }
  return makeZip(entries);
}

// Built zip containing [Content_Types].xml and word/document.xml with 2 paragraphs,
// paragraph 1 split across two w:r runs.
const REAL_DOCX_BASE64 =
  "UEsDBBQAAAAIAAAAAAAAAAAAoAAAAMgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbCWOTQ6CMBBG95yimT0UXRhjKCz8OQEeYFIGJLbTho6m3N4g6/flfa/psnfqS0uaAxs4VDUoYhuGmScDz/5RnkElQR7QBSYDKyXo2qLp10hJZe84GXiJxIvWyb7IY6pCJM7ejWHxKKkKy6Qj2jdOpI91fdI2sBBLKZsD2kKp5kYjfpyoexbivSV7B+q6T7c3Axijmy3KHFhvVLdFo/8h7Q9QSwMEFAAAAAgAAAAAAAAAAADlAAAAlwEAABEAAAB3b3JkL2RvY3VtZW50LnhtbH2QQWrEMAxF93MK4X3jtItSQpLZ9QTTA7i2JjHYkrGcJrl9cWYKhaHdiCfQl75+f95igC/M4pkG9dy0CpAsO0/ToD4u709vCqQYciYw4aB2FHUeT/3aObZLRCqwxUDSrYOaS0md1mJnjEYaTkhbDFfO0RRpOE965exSZosinqYY9EvbvupoPKnxBNCv3Se7veLRpBsdnMd+7cp4mRGuPkuBZLKZskkzCFJBsgi9riO15kelZSqeFnTgCcqMIGiZHOSFmgdhxfv1v33cF/wyUoMSsBxTwIJhhyO1f9ZXuL1c6SfS8RtQSwECFAAUAAAACAAAAAAAAAAAAKAAAADIAAAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAIAAAAAAAAAAAA5QAAAJcBAAARAAAAAAAAAAAAAAAAANEAAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAgACAIAAAADlAQAAAAA=";

// Zip containing [Content_Types].xml but no word/document.xml
const NO_DOC_XML_ZIP_BASE64 =
  "UEsDBBQAAAAAAAAAAAAAAAAACAAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcy8+UEsBAhQAFAAAAAAAAAAAAAAAAAAIAAAACAAAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwUGAAAAAAEAAQBBAAAAOQAAAAAA";

Deno.test("POST /api/upload accepts valid .docx with multiple runs and paragraphs, queues episode", async () => {
  const { app, stores, user } = await setupTestApp();
  const docxBytes = base64ToBytes(REAL_DOCX_BASE64);
  const formData = new FormData();
  formData.append(
    "file",
    new File([docxBytes as unknown as BlobPart], "sample-report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );
  formData.append("mode", "direct");

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 202);
  const body = await res.json();
  assertEquals(body.status, "queued");
  assertEquals(body.mode, "direct");
  assertStringIncludes(body.article.url, `upload://${user.id}/`);
  assertStringIncludes(
    body.article.body,
    "The first paragraph sentence continued in the second run.",
  );
  assertStringIncludes(
    body.article.body,
    "The second paragraph stands completely alone.",
  );

  const article = await stores.metadata.getArticle(user.id, body.articleId);
  assert(article);
  assertStringIncludes(
    article.content,
    "The first paragraph sentence continued in the second run.",
  );
  assertStringIncludes(
    article.content,
    "The second paragraph stands completely alone.",
  );

  const episode = await stores.metadata.getEpisode(user.id, body.episodeId);
  assert(episode);
  assertEquals(episode.status, "pending");
  assertEquals(episode.articleId, body.articleId);
});

Deno.test("POST /api/upload rejects zip without word/document.xml with specific 415 message", async () => {
  const { app, user } = await setupTestApp();
  const zipBytes = base64ToBytes(NO_DOC_XML_ZIP_BASE64);
  const formData = new FormData();
  formData.append("file", new File([zipBytes as unknown as BlobPart], "no-document.docx"));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 415);
  const data = await res.json();
  assertEquals(data.error, "This file is not a valid .docx (no word/document.xml).");
  assert(data.correlationId);
  assertEquals(data.file, "no-document.docx");
});

Deno.test("POST /api/upload rejects legacy .doc (Word 97-2003) with specific 415 message", async () => {
  const { app, user } = await setupTestApp();
  // OLE compound document magic: D0 CF 11 E0 A1 B1 1A E1
  // A real legacy sample from Apache Tika was verified against this handler (tested with /tmp/real.doc).
  const oleBytes = new Uint8Array([
    0xd0,
    0xcf,
    0x11,
    0xe0,
    0xa1,
    0xb1,
    0x1a,
    0xe1,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const formData = new FormData();
  formData.append(
    "file",
    new File([oleBytes as unknown as BlobPart], "legacy.doc", { type: "application/msword" }),
  );

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 415);
  const data = await res.json();
  assertEquals(
    data.error,
    "Legacy .doc files (Word 97-2003) are not supported. Save the document as .docx and upload that.",
  );
  assert(data.correlationId);
  assertEquals(data.file, "legacy.doc");
});

Deno.test("POST /api/upload rejects oversize docx > 10 MiB with 413 naming limit and byte count", async () => {
  const { app, user } = await setupTestApp();
  const oversizeBytes = new Uint8Array(10 * 1024 * 1024 + 256);
  // Zip magic header PK\x03\x04
  oversizeBytes[0] = 0x50;
  oversizeBytes[1] = 0x4b;
  oversizeBytes[2] = 0x03;
  oversizeBytes[3] = 0x04;
  const formData = new FormData();
  formData.append(
    "file",
    new File([oversizeBytes as unknown as BlobPart], "huge-document.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 413);
  const data = await res.json();
  assert(data.correlationId);
  assertEquals(data.limit, 10 * 1024 * 1024);
  assert(data.actual >= 10 * 1024 * 1024);
  assertStringIncludes(data.error, "10 MiB");
  assertStringIncludes(data.error, "10,485,760");
  assertEquals(data.file, "huge-document.docx");
});

Deno.test("POST /api/upload rejects docx whose text exceeds 72,000 bytes with 413 naming narration cap", async () => {
  const { app, user } = await setupTestApp();
  const longText = "Word paragraph with many descriptive terms repeating continuously. ".repeat(
    1200,
  );
  const textBytes = new TextEncoder().encode(longText.trim()).byteLength;
  assert(textBytes > 72_000);

  const docXml = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${longText}</w:t></w:r></w:p>
  </w:body>
</w:document>`);

  const zipBytes = makeStoredZip([
    { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
    { name: "word/document.xml", data: docXml },
  ]);

  const formData = new FormData();
  formData.append(
    "file",
    new File([zipBytes as unknown as BlobPart], "encyclopedia.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 413);
  const data = await res.json();
  assert(data.correlationId);
  assertEquals(data.limit, 72000);
  assertEquals(data.actual, textBytes);
  assertStringIncludes(data.error, "72,000");
  assertStringIncludes(data.error, String(textBytes));
  assertEquals(data.file, "encyclopedia.docx");
});

Deno.test("extractDocxArticle rejects a deflated zip bomb DURING decompression, before allocation (audio-feed-yl3bq)", async () => {
  // The reviewer's repro shape: ~16 KB compressed inflating to 16,000,000 text
  // bytes. The bound must trip WHILE streaming, so the 16 MB ArrayBuffer, XML
  // string and DOM are never materialized.
  const bombXml = new TextEncoder().encode(
    `<w:document><w:body><w:p><w:r><w:t>${
      "A".repeat(16_000_000)
    }</w:t></w:r></w:p></w:body></w:document>`,
  );
  const zipBytes = await makeDeflatedZip([
    { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
    { name: "word/document.xml", data: bombXml },
  ]);
  assert(
    zipBytes.byteLength < 200_000,
    `the bomb must be tiny compressed, was ${zipBytes.byteLength}`,
  );
  const err = await assertRejects(
    () => extractDocxArticle(zipBytes, "upload://u/1", "bomb"),
    Error,
    "decompresses to more than 4 MiB",
  );
  assertEquals((err as { status?: number }).status, 413);
  assertEquals((err as { limit?: number }).limit, MAX_DOCX_INFLATED_BYTES);
});

Deno.test("POST /api/upload rejects a deflated .docx zip bomb with 413 naming the inflated limit (audio-feed-yl3bq)", async () => {
  const { app, user } = await setupTestApp();
  const bombXml = new TextEncoder().encode(
    `<w:document><w:body><w:p><w:r><w:t>${
      "A".repeat(16_000_000)
    }</w:t></w:r></w:p></w:body></w:document>`,
  );
  const zipBytes = await makeDeflatedZip([
    { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
    { name: "word/document.xml", data: bombXml },
  ]);

  const formData = new FormData();
  formData.append(
    "file",
    new File([zipBytes as unknown as BlobPart], "bomb.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 413);
  const data = await res.json();
  assert(data.correlationId);
  assertStringIncludes(data.error, "4,194,304");
  assertStringIncludes(data.error, "decompress");
  assertEquals(data.file, "bomb.docx");
});

Deno.test("POST /api/upload rejects a stored .docx whose document XML exceeds the inflated bound (audio-feed-yl3bq)", async () => {
  const { app, user } = await setupTestApp();
  // Stored (method 0) is already bounded by the 10 MiB upload cap, but the same
  // 4 MiB document-XML bound applies so both compression methods refuse at the
  // same place. 5 MiB of mostly-markup XML has under 72,000 bytes of text, so
  // this rejection must be the INFLATED-XML cap, not the narration cap.
  const bigXml = new TextEncoder().encode(
    `<w:document><w:body><w:p><w:r><w:t>real text</w:t></w:r>${
      "<w:r></w:r>".repeat(460_000)
    }</w:p></w:body></w:document>`,
  );
  assert(bigXml.byteLength > MAX_DOCX_INFLATED_BYTES);
  const zipBytes = makeStoredZip([
    { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") },
    { name: "word/document.xml", data: bigXml },
  ]);

  const formData = new FormData();
  formData.append(
    "file",
    new File([zipBytes as unknown as BlobPart], "bloated.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 413);
  const data = await res.json();
  assert(data.correlationId);
  assertStringIncludes(data.error, "4,194,304");
  assertEquals(data.file, "bloated.docx");
});

Deno.test("POST /api/upload rejects bodies > 10 MiB with 413 naming limit and byte count", async () => {
  const { app, user } = await setupTestApp();
  const oversizeBytes = new Uint8Array(10 * 1024 * 1024 + 128);
  oversizeBytes.fill(66);
  const formData = new FormData();
  formData.append("file", new File([oversizeBytes], "huge-file.txt", { type: "text/plain" }));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 413);
  const data = await res.json();
  assert(data.correlationId);
  assertEquals(data.limit, 10 * 1024 * 1024);
  assert(data.actual >= 10 * 1024 * 1024);
  assertStringIncludes(data.error, "10 MiB");
  assertStringIncludes(data.error, "10,485,760");
});

Deno.test("POST /api/upload rejects extracted text > 72,000 bytes with 413 naming the limit", async () => {
  const { app, user } = await setupTestApp();
  // Generate 75,000 bytes of text (well under 10 MiB upload cap, but exceeds 72,000 narration limit)
  const longText = "Prose paragraph with words. ".repeat(2800); // ~78,400 bytes
  const textBytes = new TextEncoder().encode(longText.trim()).byteLength;
  assert(textBytes > 72_000);

  const formData = new FormData();
  formData.append("file", new File([longText], "encyclopedia.txt", { type: "text/plain" }));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 413);
  const data = await res.json();
  assert(data.correlationId);
  assertEquals(data.limit, 72000);
  assertEquals(data.actual, textBytes);
  assertStringIncludes(data.error, "72,000");
  assertEquals(data.file, "encyclopedia.txt");
});

Deno.test("POST /api/upload with no-text PDF surfaces the existing scanned/password message", async () => {
  const { app, user } = await setupTestApp();
  const emptyPdf = makeSyntheticPdf({ lines: [] });
  const formData = new FormData();
  formData.append(
    "file",
    new File([emptyPdf as unknown as BlobPart], "scanned-page.pdf", { type: "application/pdf" }),
  );

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 422);
  const data = await res.json();
  assertEquals(
    data.error,
    "No readable text found in PDF document; scanned image or password-protected PDFs are not supported.",
  );
  assert(data.correlationId);
  assertEquals(data.file, "scanned-page.pdf");
});

Deno.test("POST /api/upload with zip sent as .html cleanly rejects naming the type (415)", async () => {
  const { app, user } = await setupTestApp();
  // Valid zip header PK\x03\x04
  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const formData = new FormData();
  formData.append("file", new File([zipBytes], "deceptive.html", { type: "text/html" }));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 415);
  const data = await res.json();
  assertStringIncludes(data.error.toLowerCase(), "zip");
  assert(data.correlationId);
  assertEquals(data.file, "deceptive.html");
});

Deno.test("POST /api/upload with path traversal filename sanitizes for title and stores clean synthetic url", async () => {
  const { app, stores, user } = await setupTestApp();
  const content =
    "Content of a file with a suspicious path traversal filename to test security sanitization.";
  const formData = new FormData();
  formData.append("file", new File([content], "../../etc/passwd", { type: "text/plain" }));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 202);
  const data = await res.json();
  assertStringIncludes(data.article.url, `upload://${user.id}/${data.articleId}`);
  assertEquals(data.article.url.includes(".."), false);
  assertEquals(data.article.url.includes("passwd"), false);
  assertEquals(data.article.url.includes("etc"), false);

  const article = await stores.metadata.getArticle(user.id, data.articleId);
  assert(article);
  assertEquals(article.url, data.article.url);
  assertEquals(article.url.includes(".."), false);
});

Deno.test("POST /api/upload rejects non-multipart requests with 415 and correlationId", async () => {
  const { app, user } = await setupTestApp();

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }),
  );

  assertEquals(res.status, 415);
  const data = await res.json();
  assertStringIncludes(data.error.toLowerCase(), "multipart");
  assert(data.correlationId);
});

Deno.test("POST /api/upload rejects multipart without file field with 400 and correlationId", async () => {
  const { app, user } = await setupTestApp();
  const formData = new FormData();
  formData.append("mode", "direct");

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 400);
  const data = await res.json();
  assertStringIncludes(data.error.toLowerCase(), "file");
  assert(data.correlationId);
});

Deno.test("POST /api/upload records upload.accepted log linked to episode correlationId", async () => {
  const { app, stores, user } = await setupTestApp();
  const txtContent =
    "Logging verification paragraph with enough text to successfully test structured observability logs.";
  const formData = new FormData();
  formData.append("file", new File([txtContent], "log-test.txt", { type: "text/plain" }));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 202);
  const data = await res.json();

  const logs = await stores.metadata.listLogs({ limit: 50 });
  const acceptedLog = logs.find(
    (l) => l.type === "upload.accepted" && l.episodeId === data.episodeId,
  );
  assert(acceptedLog, "Expected upload.accepted log record");
  assertEquals(acceptedLog.correlationId, data.episodeId);
  assertEquals(acceptedLog.severity, "info");
  assertEquals(acceptedLog.route, "/api/upload");
  assertEquals(acceptedLog.userId, user.id);
});

Deno.test("POST /api/upload records upload.failed log on rejection with matching correlationId", async () => {
  const { app, stores, user } = await setupTestApp();
  const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const formData = new FormData();
  formData.append("file", new File([docxBytes], "error-test.docx"));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 415);
  const data = await res.json();

  const logs = await stores.metadata.listLogs({ limit: 50 });
  const failedLog = logs.find((l) => l.correlationId === data.correlationId);
  assert(failedLog, "Expected upload.failed log record with matching correlationId");
  assertEquals(failedLog.type, "upload.failed");
  assertEquals(failedLog.severity, "warn");
  assertEquals(failedLog.route, "/api/upload");
  assertEquals(failedLog.userId, user.id);
});

Deno.test("POST /api/upload rejects unapproved or missing credential with 403", async () => {
  const { app } = await setupTestApp({ status: "pending" });
  const formData = new FormData();
  formData.append("file", new File(["sample text"], "sample.txt", { type: "text/plain" }));

  // Missing credential entirely
  const resMissing = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      body: formData,
    }),
  );
  assertEquals(resMissing.status, 403);

  // Pending user token
  const resPending = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": "token-user-1" },
      body: formData,
    }),
  );
  assertEquals(resPending.status, 403);
});
