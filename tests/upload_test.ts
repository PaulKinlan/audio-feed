import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
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

Deno.test("POST /api/upload with docx rejects as 'not yet supported' (415)", async () => {
  const { app, user } = await setupTestApp();
  const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
  const formData = new FormData();
  formData.append("file", new File([docxBytes], "manuscript.docx"));

  const res = await app.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { "x-feed-token": user.feedToken },
      body: formData,
    }),
  );

  assertEquals(res.status, 415);
  const data = await res.json();
  assertStringIncludes(data.error.toLowerCase(), "not yet supported");
  assert(data.correlationId);
  assertEquals(data.file, "manuscript.docx");
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
