/**
 * Unit and end-to-end tests for Email-to-Podcast ingestion (`src/ingest/email.ts`)
 * and the Cloudflare Email Worker handler (`worker.email` in `src/worker_entry.ts`).
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import worker, {
  emailIngestAddress as workerEmailIngestAddress,
  type ForwardableEmailMessageLike,
  type WorkerEnv,
} from "../src/worker_entry.ts";
import {
  decodeBase64Bytes,
  decodeQuotedPrintable,
  decodeRfc2047,
  EMAIL_SOURCE_ID,
  EMAIL_SOURCE_TITLE,
  emailCanonicalUrl,
  emailIngestAddress,
  extractEmailArticle,
  MAX_EMAIL_BYTES,
  MAX_MIME_DEPTH,
  parseEmailRecipient,
  parseMimeEmail,
  stripNewsletterBoilerplate,
} from "../src/ingest/email.ts";
import { IngestError } from "../src/ingest/url.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import { createTestD1 } from "./sqlite_d1.ts";
import { makeUser } from "./fixtures.ts";

const enc = new TextEncoder();

function makeExecCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      promises.push(p);
    },
    passThroughOnException() {},
    flush: () => Promise.all(promises),
  };
}

function streamFromBytes(bytes: Uint8Array, onRead?: () => void): ReadableStream<Uint8Array> {
  // Use highWaterMark: 0 so WHATWG ReadableStream only invokes `pull()` when a consumer
  // actually calls `reader.read()`. Also spy on `getReader()` to detect any stream touch.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onRead?.();
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const origGetReader = stream.getReader.bind(stream);
  stream.getReader = ((...args: Parameters<typeof origGetReader>) => {
    onRead?.();
    return origGetReader(...args);
  }) as typeof stream.getReader;
  return stream;
}

function makeEmailMessage(opts: {
  to: string;
  from?: string;
  raw: string | Uint8Array;
  rawSize?: number;
  headers?: Record<string, string>;
  onStreamRead?: () => void;
}): {
  message: ForwardableEmailMessageLike;
  rejections: string[];
  wasStreamRead: () => boolean;
} {
  const bytes = typeof opts.raw === "string" ? enc.encode(opts.raw) : opts.raw;
  const rejections: string[] = [];
  let streamRead = false;
  const headers = new Headers(opts.headers ?? {});

  const message: ForwardableEmailMessageLike = {
    from: opts.from ?? "newsletter@stratechery.example",
    to: opts.to,
    headers,
    raw: streamFromBytes(bytes, () => {
      streamRead = true;
      opts.onStreamRead?.();
    }),
    rawSize: opts.rawSize ?? bytes.byteLength,
    setReject(reason: string) {
      rejections.push(reason);
    },
  };

  return { message, rejections, wasStreamRead: () => streamRead };
}

function encodeBase64(text: string): string {
  const bytes = enc.encode(text);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// 1. Recipient parsing & address helper
// ---------------------------------------------------------------------------

Deno.test("email: parseEmailRecipient parses save/in addresses, modes, case, and display names", () => {
  assertEquals(parseEmailRecipient("save+tok123@audiofeed.app"), {
    prefix: "save",
    feedToken: "tok123",
    mode: "direct",
    domain: "audiofeed.app",
  });

  assertEquals(parseEmailRecipient("save+tok123+deepdive@audiofeed.app"), {
    prefix: "save",
    feedToken: "tok123",
    mode: "deepdive",
    domain: "audiofeed.app",
  });

  assertEquals(parseEmailRecipient("IN+token-user_42+DIRECT@AudioFeed.APP"), {
    prefix: "in",
    feedToken: "token-user_42",
    mode: "direct",
    domain: "audiofeed.app",
  });

  assertEquals(parseEmailRecipient('"Paul Kinlan" <SAVE+abc999+DeepDive@audiofeed.app>'), {
    prefix: "save",
    feedToken: "abc999",
    mode: "deepdive",
    domain: "audiofeed.app",
  });
});

Deno.test("email: parseEmailRecipient rejects malformed, missing-token, and invalid-mode addresses", () => {
  const invalid = [
    "",
    "   ",
    "save@audiofeed.app",
    "save+@audiofeed.app",
    "in+@audiofeed.app",
    "other+tok123@audiofeed.app",
    "save+tok123+podcast@audiofeed.app",
    "save+tok123+@audiofeed.app",
    "save+tok123+direct+extra@audiofeed.app",
    "save+tok123",
    "save+tok123@localhost",
    "save+tok 123@audiofeed.app",
    "save+tok/123@audiofeed.app",
    "save+tok123@audiofeed.app\r\nBcc: attacker@evil.example",
    "save+tok123@audiofeed.app, other@audiofeed.app",
    "save+tok123@audiofeed.app>",
  ];
  for (const addr of invalid) {
    assertEquals(parseEmailRecipient(addr), null, `expected null for ${JSON.stringify(addr)}`);
  }
});

Deno.test("email: emailIngestAddress formats public forwarding addresses consistently", () => {
  assertEquals(
    emailIngestAddress("https://audiofeed.app", "abc123"),
    "save+abc123@audiofeed.app",
  );
  assertEquals(
    workerEmailIngestAddress("https://audiofeed.app/", "abc123", "deepdive"),
    "save+abc123+deepdive@audiofeed.app",
  );
  assertEquals(
    emailIngestAddress("https://podcasts.example.org:8443/account", "tok_9"),
    "save+tok_9@podcasts.example.org",
  );
  assertEquals(emailIngestAddress("", "tok_9"), "save+tok_9@audiofeed.app");
});

// ---------------------------------------------------------------------------
// 2. MIME, RFC 2047, Base64, Quoted-Printable, and bounded recursion
// ---------------------------------------------------------------------------

Deno.test("email: decodeRfc2047 handles UTF-8 B/Q, adjacent folded words, split UTF-8, and ISO-8859-1", () => {
  assertEquals(
    decodeRfc2047("=?UTF-8?B?VGhlIEZ1dHVyZSBvZiBBSSDigJQgV2Vla2x5?="),
    "The Future of AI — Weekly",
  );
  assertEquals(
    decodeRfc2047("=?utf-8?Q?Caf=C3=A9_Notes:_Q4_Review?="),
    "Café Notes: Q4 Review",
  );
  // RFC 2047 §6.2: whitespace between adjacent encoded-words collapses.
  assertEquals(
    decodeRfc2047("=?UTF-8?B?U3RyYXRlY2hlcnk6IA==?=   =?UTF-8?B?VGhlIE9wZW4gV2Vi?="),
    "Stratechery: The Open Web",
  );
  // Multi-byte UTF-8 emoji split across two adjacent encoded-words of the same charset.
  assertEquals(
    decodeRfc2047("=?UTF-8?Q?=F0=9F?= =?UTF-8?Q?=9A=80?= Launch Update"),
    "🚀 Launch Update",
  );
  // RFC 2231 language tag and ISO-8859-1.
  assertEquals(
    decodeRfc2047("=?UTF-8*en?Q?Hello_World?= & =?ISO-8859-1?Q?Resum=E9?="),
    "Hello World & Resumé",
  );
});

Deno.test("email: decodeQuotedPrintable and decodeBase64Bytes handle RFC 2045 formatting", () => {
  const qp = "Hello =\r\nworld =E2=80=94 caf=C3=A9=21\r\nSecond line =  \njoined";
  const decodedQp = new TextDecoder().decode(decodeQuotedPrintable(qp));
  assertEquals(decodedQp, "Hello world — café!\r\nSecond line joined");

  const b64 = "SGVsbG8g\r\nV29ybGQh\n";
  assertEquals(new TextDecoder().decode(decodeBase64Bytes(b64)), "Hello World!");
});

Deno.test("email: parseMimeEmail handles nested multipart/mixed -> multipart/related -> multipart/alternative with base64, QP, and RFC 2047", () => {
  const htmlBody = [
    "<!doctype html><html><head>",
    '<meta property="og:image" content="https://cdn.example.com/newsletter-hero.jpg">',
    "</head><body>",
    '<div style="display:none">Hidden email preview snippet</div>',
    '<p><a href="https://newsletter.example/web">View in browser</a></p>',
    "<article>",
    "<h1>Distributed Systems in Practice</h1>",
    "<p>Modern web services depend on durable queues and idempotent state machines to survive partial outages gracefully.</p>",
    "<h2>Idempotency Keys</h2>",
    "<p>Every retry must converge on the exact same stored record without duplicating side effects or billing users twice.</p>",
    "<h2>Backpressure &amp; Budgets</h2>",
    "<p>Bounding input sizes before buffering streams stops hostile payloads from exhausting worker memory limits.</p>",
    "</article>",
    '<div class="email-footer">',
    "<p>You received this email because you subscribed to Systems Weekly.</p>",
    '<p><a href="https://newsletter.example/unsub">Unsubscribe</a> | <a href="https://newsletter.example/prefs">Manage preferences</a></p>',
    "</div>",
    "</body></html>",
  ].join("\n");

  const rawEmail = [
    "From: =?UTF-8?Q?Ren=C3=A9_Builder?= <rene@systems.example>",
    "To: save+tok123@audiofeed.app",
    "Subject: Fwd: =?UTF-8?B?RGlzdHJpYnV0ZWQgU3lzdGVtcyDigJQgSXNzdWUgNDI=?=",
    "Message-ID: <issue-42@systems.example>",
    "Date: Thu, 27 Nov 2026 09:30:00 +0000",
    'Content-Type: multipart/mixed; boundary="part"',
    "",
    "--part",
    'Content-Type: multipart/related; boundary="part_related"',
    "",
    "--part_related",
    'Content-Type: multipart/alternative; boundary="part_alt"',
    "",
    "--part_alt",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Distributed Systems =E2=80=94 plain text fallback =\r\nwith soft break.",
    "--part_alt",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(htmlBody).replace(/(.{76})/g, "$1\r\n"),
    "--part_alt--",
    "--part_related",
    "Content-Type: image/png",
    "Content-ID: <inline-img>",
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgo=",
    "--part_related--",
    "--part",
    'Content-Type: text/html; name="attached.html"',
    'Content-Disposition: attachment; filename="attached.html"',
    "",
    "<html><body><p>Attachment HTML that must never replace the inline newsletter body.</p></body></html>",
    "--part--",
    "",
  ].join("\r\n");

  const parsed = parseMimeEmail(rawEmail);
  assertEquals(parsed.subject, "Fwd: Distributed Systems — Issue 42");
  assertEquals(parsed.fromName, "René Builder");
  assertEquals(parsed.fromAddress, "rene@systems.example");
  assertEquals(parsed.messageId, "<issue-42@systems.example>");
  assertEquals(parsed.date, "2026-11-27T09:30:00.000Z");
  assertEquals(parsed.depthLimitReached, false);
  assert(parsed.html !== null, "should extract inline HTML part");
  assert(
    !parsed.html.includes("Attachment HTML"),
    "must skip Content-Disposition: attachment parts",
  );
  assertStringIncludes(parsed.text ?? "", "Distributed Systems — plain text fallback with soft break.");

  const extracted = extractEmailArticle(parsed);
  assertEquals(extracted.title, "Distributed Systems — Issue 42");
  assertEquals(extracted.author, "René Builder");
  assertEquals(extracted.publishedAt, "2026-11-27T09:30:00.000Z");
  assertEquals(extracted.imageUrl, "https://cdn.example.com/newsletter-hero.jpg");
  assertEquals(extracted.headings, [
    "Distributed Systems in Practice",
    "Idempotency Keys",
    "Backpressure & Budgets",
  ]);
  assertStringIncludes(extracted.body, "durable queues and idempotent state machines");
  assert(!extracted.body.includes("View in browser"), "must strip View in browser boilerplate");
  assert(!extracted.body.includes("Unsubscribe"), "must strip Unsubscribe boilerplate");
  assert(!extracted.body.includes("Hidden email preview snippet"), "must strip hidden preheader");
});

Deno.test("email: parseMimeEmail enforces bounded recursion depth (<= 8) and 2 MiB size limit", () => {
  function buildNestedMultipart(depth: number, leafText: string): string {
    let body = [
      "Content-Type: text/plain; charset=utf-8",
      "",
      leafText,
    ].join("\r\n");
    for (let level = depth; level >= 1; level--) {
      const boundary = `b_level_${level}`;
      body = [
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        body,
        `--${boundary}--`,
      ].join("\r\n");
    }
    return `From: nested@example.com\r\nSubject: Deep Nesting\r\n${body}`;
  }

  // Exactly MAX_MIME_DEPTH (8) nested multiparts succeeds cleanly.
  const withinLimit = parseMimeEmail(
    buildNestedMultipart(MAX_MIME_DEPTH, "Readable content sitting right at depth eight."),
  );
  assertEquals(withinLimit.depthLimitReached, false);
  assertStringIncludes(withinLimit.text ?? "", "Readable content sitting right at depth eight.");

  // Beyond MAX_MIME_DEPTH (12 nested multiparts) stops safely at depth 8 without crashing.
  const overLimit = parseMimeEmail(
    buildNestedMultipart(MAX_MIME_DEPTH + 4, "Too deep to parse safely."),
  );
  assertEquals(overLimit.depthLimitReached, true);
  assertEquals(overLimit.text, null);

  // Oversize raw email (> 2 MiB) throws IngestError(413).
  const oversize = new Uint8Array(MAX_EMAIL_BYTES + 1);
  oversize.fill(0x41);
  const err = assertThrows(() => parseMimeEmail(oversize), IngestError);
  assertEquals(err.status, 413);
});

Deno.test("email: extractEmailArticle extracts first non-tracker hero image and falls back cleanly to text/plain", () => {
  // 1. Hero image fallback skips 1x1 tracking pixel, private IP, and cid: images.
  const htmlOnly = [
    "From: Digest <digest@example.com>",
    "Subject: Weekly Tech Roundup",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body>",
    '<img src="https://track.example.com/pixel.gif" width="1" height="1">',
    '<img src="http://127.0.0.1/internal.png" width="800" height="400">',
    '<img src="cid:inline-logo" width="400" height="200">',
    '<img src="https://images.example.com/articles/cover-art.png" width="1200" height="630">',
    "<article>",
    "<h1>Weekly Tech Roundup</h1>",
    "<p>This week we examine why users click unsubscribe links less often when newsletters deliver high-signal technical essays directly to audio feeds.</p>",
    "</article>",
    "</body></html>",
  ].join("\r\n");

  const htmlArticle = extractEmailArticle(parseMimeEmail(htmlOnly));
  assertEquals(htmlArticle.imageUrl, "https://images.example.com/articles/cover-art.png");
  assertStringIncludes(
    htmlArticle.body,
    "why users click unsubscribe links less often",
    "must not strip the word 'unsubscribe' inside real prose sentences",
  );

  // 2. Plain-text-only newsletter with Apple Mail forward headers, tracking URLs, and markdown headings.
  const plainOnly = [
    "From: Stratechery <ben@stratechery.example>",
    "Subject: Fwd: The Economics of Edge Compute",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Begin forwarded message:",
    "",
    "From: Stratechery <ben@stratechery.example>",
    "Subject: The Economics of Edge Compute",
    "Date: November 27, 2026 at 10:00:00 AM GMT",
    "To: subscriber@example.com",
    "",
    "View this post on the web (https://stratechery.example/web)",
    "",
    "## Why Latency Compounds",
    "",
    "Running lightweight compute next to users eliminates round trips [https://click.example/r/123] and keeps interactive interfaces crisp.",
    "",
    "## Storage at the Edge",
    "",
    "Replicated SQLite databases turn global read paths into single-digit millisecond queries.",
    "",
    "You received this email because you subscribed to Stratechery.",
    "Unsubscribe (https://stratechery.example/unsub)",
  ].join("\r\n");

  const plainArticle = extractEmailArticle(parseMimeEmail(plainOnly));
  assertEquals(plainArticle.title, "The Economics of Edge Compute");
  assertEquals(plainArticle.headings, ["Why Latency Compounds", "Storage at the Edge"]);
  assertStringIncludes(plainArticle.body, "eliminates round trips and keeps interactive interfaces crisp.");
  assert(!plainArticle.body.includes("Begin forwarded message"));
  assert(!plainArticle.body.includes("click.example"));
  assert(!plainArticle.body.includes("View this post on the web"));
  assert(!plainArticle.body.includes("You received this email because"));
  assert(!plainArticle.body.includes("Unsubscribe"));
});

Deno.test("email: stripNewsletterBoilerplate removes Gmail forward block and retains real content", () => {
  const input = [
    "---------- Forwarded message ---------",
    "From: TLDR <dan@tldr.example>",
    "Date: Thu, Nov 27, 2026 at 8:00 AM",
    "Subject: TLDR Daily",
    "To: me@example.com",
    "",
    "View in browser",
    "",
    "New WebAssembly GC optimizations cut cold-start latency in half across edge runtimes.",
    "",
    "Click here to unsubscribe from TLDR.",
    "© 2026 TLDR Media Inc. All rights reserved.",
  ].join("\n");

  const cleaned = stripNewsletterBoilerplate(input);
  assertEquals(
    cleaned,
    "New WebAssembly GC optimizations cut cold-start latency in half across edge runtimes.",
  );
});

Deno.test("email: emailCanonicalUrl is deterministic for Message-ID and falls back to content hash", async () => {
  const a = await emailCanonicalUrl({
    messageId: " <ABC-123@substack.example> ",
    from: "a@example.com",
    subject: "S1",
    body: "Body 1",
  });
  const b = await emailCanonicalUrl({
    messageId: "abc-123@substack.example",
    from: "different@example.com",
    subject: "Different",
    body: "Different",
  });
  assertEquals(a, b);
  assert(a.startsWith("email://msgid/"));

  const c1 = await emailCanonicalUrl({
    messageId: null,
    from: "Author@Example.COM ",
    subject: "Hello   World",
    body: "Body   text   here.",
  });
  const c2 = await emailCanonicalUrl({
    messageId: "",
    from: "author@example.com",
    subject: "hello world",
    body: "body text here.",
  });
  assertEquals(c1, c2);
  assert(c1.startsWith("email://content/"));
});

// ---------------------------------------------------------------------------
// 3. End-to-end Cloudflare Worker `worker.email(...)` with real SQLite D1
// ---------------------------------------------------------------------------

Deno.test("worker.email: approved user creates Email Newsletters source, article, episode, and triggers EPISODE_WORKFLOW", async () => {
  const d1 = createTestD1();
  try {
    const store = new D1MetadataStore(d1);
    const user = makeUser({
      id: "u-email-1",
      status: "approved",
      feedToken: "tok_approved_email_12345",
    });
    await store.putUser(user);

    const workflowsCreated: Array<{ id?: string; params?: { episodeId: string; userId: string } }> =
      [];
    const env: WorkerEnv = {
      DB: d1,
      PUBLIC_BASE_URL: "https://audiofeed.app",
      EPISODE_WORKFLOW: {
        async create(opts) {
          workflowsCreated.push({ id: opts?.id, params: opts?.params });
          return { id: opts?.id ?? "wf-1" };
        },
      },
    };
    const ctx = makeExecCtx();

    const rawNewsletter = [
      "From: Stratechery <ben@stratechery.example>",
      "To: save+tok_approved_email_12345@audiofeed.app",
      "Subject: Fwd: The Aggregation Theory Revisited",
      "Message-ID: <agg-2026-11-27@stratechery.example>",
      "Date: Thu, 27 Nov 2026 11:00:00 +0000",
      'Content-Type: multipart/alternative; boundary="alt1"',
      "",
      "--alt1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Fallback plain text version of the newsletter.",
      "--alt1",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><head><meta property="og:image" content="https://cdn.stratechery.example/agg.png"></head>' +
      "<body><article><h1>The Aggregation Theory Revisited</h1>" +
      "<p>AI agents are reshaping how readers discover and consume long-form writing across the open web and paid newsletters.</p>" +
      "<h2>Distribution Shifts</h2>" +
      "<p>Private podcast feeds turn long email essays into commuter-friendly audio episodes with chapter navigation.</p>" +
      "</article><p>Unsubscribe</p></body></html>",
      "--alt1--",
    ].join("\r\n");

    const { message, rejections } = makeEmailMessage({
      to: `save+${user.feedToken}@audiofeed.app`,
      from: "ben@stratechery.example",
      raw: rawNewsletter,
      headers: { "message-id": "<agg-2026-11-27@stratechery.example>" },
    });

    await worker.email(message, env, ctx);
    await ctx.flush();

    assertEquals(rejections, [], "approved email must not call setReject");

    // Source created cleanly with synthetic Email Newsletters metadata.
    const source = await store.getSource(user.id, EMAIL_SOURCE_ID);
    assert(source !== null, "Email Newsletters source must be created");
    assertEquals(source.title, EMAIL_SOURCE_TITLE);
    assertEquals(source.feedUrl, undefined);
    assertEquals(source.modes, ["direct", "deepdive"]);
    assertEquals(source.voices, {});

    // Episode + Article persisted and linked cleanly.
    const episodes = await store.listEpisodes({ userId: user.id });
    assertEquals(episodes.length, 1);
    const ep = episodes[0]!;
    assertEquals(ep.sourceId, EMAIL_SOURCE_ID);
    assertEquals(ep.sourceTitle, EMAIL_SOURCE_TITLE);
    assertEquals(ep.mode, "direct");
    assertEquals(ep.status, "pending");
    assertEquals(ep.title, "The Aggregation Theory Revisited");

    const article = await store.getArticle(user.id, ep.articleId);
    assert(article !== null);
    assertEquals(article.sourceId, EMAIL_SOURCE_ID);
    assertEquals(article.author, "Stratechery");
    assertEquals(article.imageUrl, "https://cdn.stratechery.example/agg.png");
    assertEquals(article.headings, ["Distribution Shifts"]);
    assertStringIncludes(article.content, "Private podcast feeds turn long email essays");
    assert(!article.content.includes("Unsubscribe"));

    // EPISODE_WORKFLOW triggered immediately.
    assertEquals(workflowsCreated.length, 1);
    assertEquals(workflowsCreated[0]?.id, `ep-${ep.id}`);
    assertEquals(workflowsCreated[0]?.params, { episodeId: ep.id, userId: user.id });

    // Duplicate delivery with the same Message-ID deduplicates cleanly!
    const dup = makeEmailMessage({
      to: `save+${user.feedToken}@audiofeed.app`,
      from: "ben@stratechery.example",
      raw: rawNewsletter,
      headers: { "message-id": "<AGG-2026-11-27@STRATECHERY.EXAMPLE>" },
    });
    await worker.email(dup.message, env, ctx);
    assertEquals(dup.rejections, [], "duplicate email must not permanently reject");
    assertEquals((await store.listEpisodes({ userId: user.id })).length, 1);
    assertEquals(workflowsCreated.length, 1, "duplicate must not trigger a second workflow");

    // A second distinct email sent to `+deepdive` reuses the existing Email Newsletters source.
    const deepDiveRaw = [
      "From: TLDR <dan@tldr.example>",
      "Subject: Deep Dive on WebGPU",
      "Message-ID: <webgpu-issue-9@tldr.example>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "WebGPU brings modern compute shaders directly into browsers and enables local inference workloads at interactive speeds.",
    ].join("\r\n");

    const dd = makeEmailMessage({
      to: `in+${user.feedToken}+deepdive@audiofeed.app`,
      from: "dan@tldr.example",
      raw: deepDiveRaw,
    });
    await worker.email(dd.message, env, ctx);
    assertEquals(dd.rejections, []);
    assertEquals((await store.listSources(user.id)).length, 1, "must reuse existing email source");
    const allEps = await store.listEpisodes({ userId: user.id });
    assertEquals(allEps.length, 2);
    assert(allEps.some((e) => e.mode === "deepdive" && e.title === "Deep Dive on WebGPU"));
    assertEquals(workflowsCreated.length, 2);
  } finally {
    d1.close();
  }
});

Deno.test("worker.email: deduplicates emails without Message-ID by normalized content hash", async () => {
  const d1 = createTestD1();
  try {
    const store = new D1MetadataStore(d1);
    const user = makeUser({ id: "u-no-msgid", status: "approved", feedToken: "tok_no_msgid_1" });
    await store.putUser(user);

    const env: WorkerEnv = { DB: d1, PUBLIC_BASE_URL: "https://audiofeed.app" };
    const ctx = makeExecCtx();

    const raw = [
      "From: Daily Notes <notes@example.com>",
      "Subject: Morning Dispatch",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Software reliability starts with deterministic identifiers and atomic compare-and-swap writes.",
    ].join("\r\n");

    const first = makeEmailMessage({ to: `save+${user.feedToken}@audiofeed.app`, raw });
    const second = makeEmailMessage({ to: `save+${user.feedToken}@audiofeed.app`, raw });

    await worker.email(first.message, env, ctx);
    await worker.email(second.message, env, ctx);

    assertEquals(first.rejections, []);
    assertEquals(second.rejections, []);
    assertEquals((await store.listEpisodes({ userId: user.id })).length, 1);
  } finally {
    d1.close();
  }
});

Deno.test("worker.email: enforces 2 MiB rawSize cap BEFORE reading raw stream and rejects lying oversize streams", async () => {
  const d1 = createTestD1();
  try {
    const store = new D1MetadataStore(d1);
    const user = makeUser({ id: "u-size", status: "approved", feedToken: "tok_size_guard_1" });
    await store.putUser(user);

    const env: WorkerEnv = { DB: d1, PUBLIC_BASE_URL: "https://audiofeed.app" };
    const ctx = makeExecCtx();

    // 1. Honest rawSize > 2 MiB: must reject BEFORE ever reading `message.raw`.
    const oversizeHeader = makeEmailMessage({
      to: `save+${user.feedToken}@audiofeed.app`,
      raw: "should never be read",
      rawSize: MAX_EMAIL_BYTES + 1,
    });
    await worker.email(oversizeHeader.message, env, ctx);
    assertEquals(oversizeHeader.rejections.length, 1);
    assertStringIncludes(oversizeHeader.rejections[0]!.toLowerCase(), "2 mib");
    assertEquals(oversizeHeader.wasStreamRead(), false, "must NOT read stream when rawSize > 2 MiB");

    // 2. Spoofed small rawSize while stream actually yields > 2 MiB: readBounded rejects cleanly.
    const giantPayload = new Uint8Array(MAX_EMAIL_BYTES + 1024);
    giantPayload.fill(0x61);
    const spoofed = makeEmailMessage({
      to: `save+${user.feedToken}@audiofeed.app`,
      raw: giantPayload,
      rawSize: 128,
    });
    await worker.email(spoofed.message, env, ctx);
    assertEquals(spoofed.rejections.length, 1);
    assertStringIncludes(spoofed.rejections[0]!.toLowerCase(), "2 mib");
    assertEquals((await store.listEpisodes({ userId: user.id })).length, 0);
  } finally {
    d1.close();
  }
});

Deno.test("worker.email: rejects unknown, pending, rejected, and suspended users without leaking feedToken anywhere", async () => {
  const d1 = createTestD1();
  const capturedLogs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));

  try {
    const store = new D1MetadataStore(d1);
    const canaryUnknown = "CANARY_UNKNOWN_TOKEN_9f8e7d6c";
    const canaryPending = "CANARY_PENDING_TOKEN_1a2b3c4d";
    const canarySuspended = "CANARY_SUSPENDED_TOKEN_5e6f7a8b";
    const canaryInvalid = "CANARY_INVALID_TOKEN_0z9y8x7w";

    await store.putUser(makeUser({ id: "u-pending", status: "pending", feedToken: canaryPending }));
    await store.putUser(
      makeUser({ id: "u-suspended", status: "suspended", feedToken: canarySuspended }),
    );

    let workflowCalls = 0;
    const env: WorkerEnv = {
      DB: d1,
      PUBLIC_BASE_URL: "https://audiofeed.app",
      EPISODE_WORKFLOW: {
        async create() {
          workflowCalls++;
          return { id: "wf-never" };
        },
      },
    };
    const ctx = makeExecCtx();

    const validBody = [
      "From: sender@example.com",
      "Subject: Should Be Rejected",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Long enough body text that would otherwise be ingested if the recipient were approved.",
    ].join("\r\n");

    const cases = [
      { label: "unknown", to: `save+${canaryUnknown}@audiofeed.app`, canary: canaryUnknown },
      { label: "pending", to: `save+${canaryPending}@audiofeed.app`, canary: canaryPending },
      { label: "suspended", to: `save+${canarySuspended}@audiofeed.app`, canary: canarySuspended },
      { label: "invalid-mode", to: `save+${canaryInvalid}+bogus@audiofeed.app`, canary: canaryInvalid },
    ];

    for (const c of cases) {
      const { message, rejections, wasStreamRead } = makeEmailMessage({
        to: c.to,
        raw: validBody,
      });
      await worker.email(message, env, ctx);
      assertEquals(rejections.length, 1, `${c.label} must call setReject exactly once`);
      assertEquals(
        wasStreamRead(),
        false,
        `${c.label} must reject before reading raw message stream`,
      );
      assert(
        !rejections[0]!.includes(c.canary),
        `feedToken canary leaked in setReject reason for ${c.label}`,
      );
    }

    assertEquals(workflowCalls, 0);

    // Verify no canary leaked into console logs or D1 logs.
    const allConsole = capturedLogs.join("\n");
    const dbLogs = await d1.prepare(`SELECT data FROM logs`).all<{ data: string }>();
    const allDbLogs = dbLogs.results.map((r) => r.data).join("\n");
    for (const canary of [canaryUnknown, canaryPending, canarySuspended, canaryInvalid]) {
      assert(!allConsole.includes(canary), `canary ${canary} leaked in console output`);
      assert(!allDbLogs.includes(canary), `canary ${canary} leaked in D1 logs`);
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    d1.close();
  }
});

Deno.test("worker.email: rejects empty or boilerplate-only email body and respects daily budget without bouncing", async () => {
  const d1 = createTestD1();
  try {
    const store = new D1MetadataStore(d1);
    const approved = makeUser({
      id: "u-empty-test",
      status: "approved",
      feedToken: "tok_empty_test_1",
    });
    const zeroBudget = makeUser({
      id: "u-zero-budget",
      status: "approved",
      feedToken: "tok_zero_budget_1",
      dailyEpisodeBudget: 0,
    });
    await store.putUser(approved);
    await store.putUser(zeroBudget);

    const env: WorkerEnv = { DB: d1, PUBLIC_BASE_URL: "https://audiofeed.app" };
    const ctx = makeExecCtx();

    // 1. Boilerplate-only email gets permanent setReject.
    const boilerplateOnly = makeEmailMessage({
      to: `save+${approved.feedToken}@audiofeed.app`,
      raw: [
        "From: news@example.com",
        "Subject: Blank Issue",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "View in browser",
        "Unsubscribe",
      ].join("\r\n"),
    });
    await worker.email(boilerplateOnly.message, env, ctx);
    assertEquals(boilerplateOnly.rejections.length, 1);
    assertEquals((await store.listEpisodes({ userId: approved.id })).length, 0);

    // 2. Daily budget exhausted does NOT create an episode and does NOT call permanent setReject.
    const overBudget = makeEmailMessage({
      to: `save+${zeroBudget.feedToken}@audiofeed.app`,
      raw: [
        "From: news@example.com",
        "Subject: Over Budget Issue",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "This newsletter has plenty of readable prose to ingest, but the subscriber has zero daily episode budget.",
      ].join("\r\n"),
    });
    await worker.email(overBudget.message, env, ctx);
    assertEquals(overBudget.rejections, [], "rate-limited email must not trigger permanent bounce");
    assertEquals((await store.listEpisodes({ userId: zeroBudget.id })).length, 0);
  } finally {
    d1.close();
  }
});

Deno.test("email: parseMimeEmail unwraps forwarded message/rfc822 newsletters", () => {
  const rawForwarded = [
    "From: Subscriber <me@example.com>",
    "Subject: Fwd: Weekly Essay",
    'Content-Type: multipart/mixed; boundary="outer_fwd"',
    "",
    "--outer_fwd",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Short cover note.",
    "--outer_fwd",
    "Content-Type: message/rfc822",
    "",
    "From: Essayist <writer@newsletter.example>",
    "Subject: Compilers at the Edge",
    "Message-ID: <edge-compilers-1@newsletter.example>",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><article><h1>Compilers at the Edge</h1>" +
    "<p>Incremental compilation techniques allow browser and edge toolchains to rebuild modules in single-digit milliseconds without sacrificing optimization quality.</p>" +
    "</article></body></html>",
    "--outer_fwd--",
  ].join("\r\n");

  const parsed = parseMimeEmail(rawForwarded);
  assertEquals(parsed.messageId, "<edge-compilers-1@newsletter.example>");
  const article = extractEmailArticle(parsed);
  assertEquals(article.title, "Weekly Essay");
  assertStringIncludes(article.body, "Incremental compilation techniques");
});
