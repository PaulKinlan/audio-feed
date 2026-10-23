/**
 * Tests for PDF document ingestion (audio-feed-w9n).
 *
 * Verifies:
 * - fetchArticle accepts application/pdf content type
 * - extractPdfArticle extracts clean structured text, title, author, date, and lead
 * - Title fallbacks (info.Title -> first heading -> URL filename -> default)
 * - Author and CreationDate parsing
 * - Rejection of invalid/corrupt PDFs (422)
 * - Rejection of unreadable/scanned image PDFs (< 80 chars) (422)
 * - Rejection of oversized PDFs (> 10 MiB) (413)
 * - Rejection of oversized text (> 100,000 chars) (413)
 * - audioPayload produces valid direct and deepdive payloads
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  audioPayload,
  extractPdfArticle,
  fetchArticle,
  IngestError,
  MAX_ARTICLE_CONTENT_CHARS,
  MAX_PDF_BYTES,
  truncateAtReferencesSection,
} from "../src/ingest/url.ts";

/** Helper to generate valid synthetic PDF bytes for testing. */
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

const LONG_PARA_1 =
  "The rapid evolution of modern web architectures has demonstrated that declarative specifications and bounded runtimes outperform hand-crafted pipelines.";
const LONG_PARA_2 =
  "In this paper, we examine empirical measurements from real-world deployments across edge runtimes, comparing memory overhead and latency distributions.";

Deno.test("extractPdfArticle: extracts metadata and body from PDF document (audio-feed-w9n)", async () => {
  const bytes = makeSyntheticPdf({
    title: "Empirical Edge Runtimes",
    author: "Ada Lovelace",
    creationDate: "D:20260929120000Z",
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  const article = await extractPdfArticle(bytes, "https://example.com/papers/edge.pdf");
  assertEquals(article.url, "https://example.com/papers/edge.pdf");
  assertEquals(article.title, "Empirical Edge Runtimes");
  assertEquals(article.author, "Ada Lovelace");
  assertEquals(article.publishedAt, "2026-09-29");
  assertStringIncludes(article.body, LONG_PARA_1);
  assertStringIncludes(article.body, LONG_PARA_2);
  assert(article.lead.length > 0);
});

Deno.test("extractPdfArticle: falls back to first heading when info.Title is missing (audio-feed-w9n)", async () => {
  const heading = "Architecture of Distributed Edge Networks";
  const bytes = makeSyntheticPdf({
    author: "Grace Hopper",
    lines: [heading, LONG_PARA_1, LONG_PARA_2],
  });

  const article = await extractPdfArticle(bytes, "https://example.com/docs/paper.pdf");
  assertEquals(article.title, heading);
  assertEquals(article.author, "Grace Hopper");
  // Heading was stripped from body to avoid redundant repetition
  assertEquals(article.body.startsWith(heading), false);
  assertStringIncludes(article.body, LONG_PARA_1);
});

Deno.test("extractPdfArticle: falls back to URL filename when title metadata and headings are missing (audio-feed-w9n)", async () => {
  const bytes = makeSyntheticPdf({
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  const article = await extractPdfArticle(
    bytes,
    "https://example.com/downloads/distributed-consensus-protocols.pdf",
  );
  assertEquals(article.title, "Distributed consensus protocols");
  assertEquals(article.author, null);
  assertStringIncludes(article.body, LONG_PARA_1);
});

Deno.test("extractPdfArticle: strips leading 'by' from author metadata (audio-feed-w9n)", async () => {
  const bytes = makeSyntheticPdf({
    title: "Document Title",
    author: "by Dr. Turing",
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  const article = await extractPdfArticle(bytes, "https://example.com/doc.pdf");
  assertEquals(article.author, "Dr. Turing");
});

Deno.test("extractPdfArticle: rejects corrupt PDF without %PDF- header (audio-feed-w9n)", async () => {
  const garbage = new TextEncoder().encode("Not a valid PDF header at all");
  const err = await assertRejects(
    () => extractPdfArticle(garbage, "https://example.com/bad.pdf"),
    IngestError,
  );
  assertEquals(err.status, 422);
  assertStringIncludes(err.message, "%PDF- header");
});

Deno.test("extractPdfArticle: rejects corrupt PDF bytes starting with %PDF- (audio-feed-w9n)", async () => {
  const corrupt = new TextEncoder().encode("%PDF-1.4\ncorrupted garbage binary data");
  const err = await assertRejects(
    () => extractPdfArticle(corrupt, "https://example.com/corrupt.pdf"),
    IngestError,
  );
  assertEquals(err.status, 422);
  assertStringIncludes(err.message, "Unable to parse PDF document");
});

Deno.test("extractPdfArticle: rejects scanned or empty PDF with < 80 characters text (audio-feed-w9n)", async () => {
  const shortPdf = makeSyntheticPdf({
    title: "Short",
    lines: ["Tiny text."],
  });

  const err = await assertRejects(
    () => extractPdfArticle(shortPdf, "https://example.com/short.pdf"),
    IngestError,
  );
  assertEquals(err.status, 422);
  assertStringIncludes(err.message, "No readable text found in PDF document");
});

Deno.test("extractPdfArticle: rejects oversized PDF (> 10 MiB) (audio-feed-w9n)", async () => {
  const bigBytes = new Uint8Array(MAX_PDF_BYTES + 1);
  const err = await assertRejects(
    () => extractPdfArticle(bigBytes, "https://example.com/big.pdf"),
    IngestError,
  );
  assertEquals(err.status, 413);
  assertStringIncludes(err.message, "10 MiB size limit");
});

Deno.test("extractPdfArticle: rejects content exceeding character limit (> 2,000,000 chars) (audio-feed-w9n, audio-feed-cei)", async () => {
  // Generate many repeated lines that parse cleanly to > 2,000,000 chars
  const lines: string[] = [];
  const line = "A".repeat(80);
  for (let i = 0; i < 26_000; i++) {
    lines.push(`${line} ${i}`);
  }

  const bigPdf = makeSyntheticPdf({
    title: "Huge PDF",
    lines,
  });

  const err = await assertRejects(
    () => extractPdfArticle(bigPdf, "https://example.com/huge.pdf"),
    IngestError,
  );
  assertEquals(err.status, 413);
  assertStringIncludes(err.message, "character limit");
  assertStringIncludes(err.message, String(MAX_ARTICLE_CONTENT_CHARS));
});

const CONCLUSION_LINE =
  "We conclude that bounded runtimes and declarative specs materially reduce narration waste.";
const CITATION_1 = "[1] Smith, J. Deep Edges (2024). Journal of Bounded Things, 12(3), 45-67.";
const CITATION_2 =
  "[2] Lovelace, A. Notes on Runtime Overhead (2025). Annals of Declarative Work, 1(1), 1-22.";
const CITATION_3 = "Doe, J. and Roe, R. Measuring Citations at Scale (2023). doi:10.1000/xyz123.";

Deno.test("truncateAtReferencesSection: cuts the last bare heading and everything after it (audio-feed-cco6g)", () => {
  const text = [LONG_PARA_1, CONCLUSION_LINE, "References", CITATION_1, CITATION_2, CITATION_3]
    .join(
      "\n",
    );
  const truncated = truncateAtReferencesSection(text);
  assertStringIncludes(truncated, CONCLUSION_LINE);
  assert(!truncated.includes(CITATION_1), "citations must be truncated");
  assert(!truncated.includes("References"), "the heading itself must go too");
});

Deno.test("truncateAtReferencesSection: case-insensitive and variant headings (audio-feed-cco6g)", () => {
  for (const heading of ["REFERENCES", "bibliography", "Works Cited", "  references  "]) {
    const text = [LONG_PARA_1, heading, CITATION_1].join("\n");
    const truncated = truncateAtReferencesSection(text);
    assertStringIncludes(truncated, LONG_PARA_1);
    assert(!truncated.includes(CITATION_1), `heading ${JSON.stringify(heading)} must truncate`);
  }
});

Deno.test("truncateAtReferencesSection: a line that merely says the word references is prose, not a heading (audio-feed-cco6g)", () => {
  const proseLine = "As the references above anchor, these claims are empirical.";
  const text = [LONG_PARA_1, proseLine, CONCLUSION_LINE, CITATION_1].join("\n");
  const truncated = truncateAtReferencesSection(text);
  // No bare heading anywhere: nothing is truncated.
  assertEquals(truncated, text);
});

Deno.test("truncateAtReferencesSection: truncates at the LAST heading, keeping content after an early one (audio-feed-cco6g)", () => {
  const afterEarlyHeading = "Appendix material aside, the body continues here with real findings.";
  const text = [
    LONG_PARA_1,
    "References", // early bare heading (e.g. an in-text section pointer)
    afterEarlyHeading,
    "Bibliography", // the real citations section at the end
    CITATION_1,
    CITATION_2,
  ].join("\n");
  const truncated = truncateAtReferencesSection(text);
  assertStringIncludes(truncated, afterEarlyHeading, "content between the headings must survive");
  assert(!truncated.includes(CITATION_1), "the final citations block must go");
});

Deno.test("truncateAtReferencesSection: a heading on the FIRST line never truncates (audio-feed-cco6g)", () => {
  const text = ["References", LONG_PARA_1, CONCLUSION_LINE].join("\n");
  assertEquals(truncateAtReferencesSection(text), text);
  assertEquals(truncateAtReferencesSection(""), "");
});

Deno.test("extractPdfArticle: a PDF ending in a References block narrates without its citations (audio-feed-cco6g)", async () => {
  const lines = [LONG_PARA_1, LONG_PARA_2, CONCLUSION_LINE, "References"];
  // A realistically long citations block: 60 reference lines.
  for (let i = 1; i <= 60; i++) {
    lines.push(`[${i}] Author${i}, A. Title ${i} (202${i % 10}). Venue ${i}, 1-9.`);
  }
  const bytes = makeSyntheticPdf({ title: "Cited Paper", lines });

  const article = await extractPdfArticle(bytes, "https://example.com/papers/cited.pdf");
  assertStringIncludes(article.body, CONCLUSION_LINE);
  assert(!article.body.includes("[60] Author60"), "citations must not reach the narration body");
  assert(!article.body.includes("References"), "the heading must not reach the narration body");
  const bodyBytes = new TextEncoder().encode(article.body).byteLength;
  assert(bodyBytes < 192_000, `body must sit under the 192,000-byte ceiling, got ${bodyBytes}`);
});

Deno.test("extractPdfArticle: a mid-document prose mention of references does not truncate (audio-feed-cco6g)", async () => {
  const lines = [
    LONG_PARA_1,
    "The references discussed in the introduction are expanded here.",
    LONG_PARA_2,
    CONCLUSION_LINE,
  ];
  const bytes = makeSyntheticPdf({ title: "Prose Paper", lines });

  const article = await extractPdfArticle(bytes, "https://example.com/papers/prose.pdf");
  assertStringIncludes(article.body, CONCLUSION_LINE, "the ending must survive a prose mention");
  assertStringIncludes(article.body, LONG_PARA_2);
});

Deno.test("fetchArticle: fetches and extracts application/pdf documents (audio-feed-w9n)", async () => {
  const pdfBytes = makeSyntheticPdf({
    title: "Edge Computing Report",
    author: "Research Team",
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  const article = await fetchArticle("https://example.com/report.pdf", {
    transport: () =>
      Promise.resolve(
        new Response(pdfBytes as unknown as BodyInit, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": String(pdfBytes.byteLength),
          },
        }),
      ),
  });

  assertEquals(article.url, "https://example.com/report.pdf");
  assertEquals(article.title, "Edge Computing Report");
  assertEquals(article.author, "Research Team");
  assertStringIncludes(article.body, LONG_PARA_1);
});

Deno.test("fetchArticle: rejects PDF exceeding 10 MiB size limit via content-length (audio-feed-w9n)", async () => {
  const err = await assertRejects(
    () =>
      fetchArticle("https://example.com/oversized.pdf", {
        transport: () =>
          Promise.resolve(
            new Response(new Uint8Array(100) as unknown as BodyInit, {
              status: 200,
              headers: {
                "content-type": "application/pdf",
                "content-length": String(MAX_PDF_BYTES + 1000),
              },
            }),
          ),
      }),
    IngestError,
  );

  assertEquals(err.status, 413);
  assertStringIncludes(err.message, "PDF exceeds the 10 MiB size limit");
});

Deno.test("fetchArticle: sends application/pdf in Accept header (audio-feed-w9n)", async () => {
  let capturedAccept = "";
  const pdfBytes = makeSyntheticPdf({
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  await fetchArticle("https://example.com/accept.pdf", {
    transport: (_url, _signal, init) => {
      capturedAccept = init?.headers?.["Accept"] ?? "";
      return Promise.resolve(
        new Response(pdfBytes as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      );
    },
  });

  assertStringIncludes(capturedAccept, "application/pdf");
});

Deno.test("audioPayload: prepares direct narration and deepdive payloads from PDF article (audio-feed-w9n)", async () => {
  const bytes = makeSyntheticPdf({
    title: "Attention Is All You Need",
    author: "Vaswani et al",
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  const article = await extractPdfArticle(bytes, "https://example.com/attention.pdf");

  // Direct mode
  const direct = audioPayload(article, "direct");
  assertEquals(direct.mode, "direct");
  if (direct.mode === "direct") {
    assertStringIncludes(direct.narration, "Attention Is All You Need");
    assertStringIncludes(direct.narration, "By Vaswani et al.");
    assertStringIncludes(direct.narration, LONG_PARA_1);
  }

  // Deep dive mode
  const deepdive = audioPayload(article, "deepdive");
  assertEquals(deepdive.mode, "deepdive");
  assertEquals(deepdive.article.title, "Attention Is All You Need");
});

Deno.test("extractPdfArticle: strips newlines, control characters, and caps title at 200 chars (audio-feed-a3y)", async () => {
  const multilineTitle = "A".repeat(150) + "\n\r\tMalicious\nInjected\r\nNewline\x00Control" +
    "B".repeat(100);
  const bytes = makeSyntheticPdf({
    title: multilineTitle,
    author: "Author\nWith\rNewlines\x07",
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  const article = await extractPdfArticle(bytes, "https://example.com/sanitized.pdf");
  // Asserts title is capped at 200 chars max
  assertEquals(article.title.length <= 200, true);
  // Asserts no non-printable / control characters (C0, DEL, C1) exist in title or author
  for (let i = 0; i < article.title.length; i++) {
    const code = article.title.charCodeAt(i);
    assertEquals(code >= 32 && code !== 127 && !(code >= 128 && code <= 159), true);
  }
  for (let i = 0; i < article.author!.length; i++) {
    const code = article.author!.charCodeAt(i);
    assertEquals(code >= 32 && code !== 127 && !(code >= 128 && code <= 159), true);
  }
  assertEquals(article.author, "Author With Newlines");
});

Deno.test("extractPdfArticle: suppresses PDF.js indexing warnings during parse (audio-feed-a3y)", async () => {
  const bytes = makeSyntheticPdf({
    title: "Quiet Parse",
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  let printedWarning = false;
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("Indexing all PDF objects")) {
      printedWarning = true;
    }
    origLog(...args);
  };

  try {
    await extractPdfArticle(bytes, "https://example.com/quiet.pdf");
  } finally {
    console.log = origLog;
  }

  assertEquals(printedWarning, false, "PDF.js indexing warning must be suppressed");
});

Deno.test("extractPdfArticle: enforces bounded parse timeout (audio-feed-a3y)", async () => {
  const bytes = makeSyntheticPdf({
    title: "Timed Out Document",
    lines: [LONG_PARA_1, LONG_PARA_2],
  });

  // Calling with timeoutMs: 0 causes immediate timeout
  const err = await assertRejects(
    () => extractPdfArticle(bytes, "https://example.com/timeout.pdf", { timeoutMs: 0 }),
    IngestError,
  );
  assertEquals(err.status, 504);
  assertStringIncludes(err.message, "PDF parsing timed out");
});
