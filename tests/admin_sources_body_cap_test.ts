/**
 * audio-feed-heytf — POST /api/admin/users/:id/sources request body cap.
 *
 * Verifies:
 *  (a) a body just under the cap (MAX_ACCOUNT_BODY_BYTES = 16 KiB) is accepted
 *  (b) a body over the cap is refused with 413 HttpError (payload_too_large)
 *  (c) the refusal does not read/drain the entire body stream
 *  (d) cannot be bypassed by chunked encoding or mismatched content-type
 *  (e) cannot be bypassed by a LYING small declared content-length, which only the read bound catches
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { MAX_ACCOUNT_BODY_BYTES } from "../src/http.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { makeUser } from "./fixtures.ts";

const BASE = "https://audio.example.com";
const ADMIN_TOKEN = "admin-secret";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: ADMIN_TOKEN };

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Sample Feed</title>
  <link>https://example.com</link>
  <item>
    <title>Post 1</title>
    <link>https://example.com/post-1</link>
    <pubDate>Mon, 01 Sep 2026 06:00:00 +0000</pubDate>
    <description>First post description.</description>
  </item>
</channel></rss>`;

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  const handlers = createHandlers(ctx, {
    feedTransport: () =>
      Promise.resolve(
        new Response(RSS_SAMPLE, {
          status: 200,
          headers: { "content-type": "application/rss+xml; charset=utf-8" },
        }),
      ),
    fetchArticle: () =>
      Promise.resolve({
        url: "https://example.com/item1",
        title: "Item 1",
        author: "A. Writer",
        publishedAt: null,
        lead: "A lead.",
        body: "Hello world text content.",
      }),
  });
  return createApp(ctx, handlers);
}

/** A valid JSON body for admin adding a source, padded to just under the 16 KiB cap. */
function nearCapBody(feedUrl = "https://example.com/feed.xml"): string {
  const base = JSON.stringify({ feedUrl, title: "Admin Feed", modes: ["deepdive"] });
  const paddingLen = MAX_ACCOUNT_BODY_BYTES - base.length - 50;
  return JSON.stringify({
    feedUrl,
    title: "Admin Feed",
    modes: ["deepdive"],
    padding: "x".repeat(Math.max(0, paddingLen)),
  });
}

/** A valid JSON body for admin adding a source, padded well over the cap. */
function oversizedBody(feedUrl = "https://example.com/feed.xml"): string {
  return JSON.stringify({
    feedUrl,
    title: "Admin Feed",
    modes: ["deepdive"],
    padding: "x".repeat(MAX_ACCOUNT_BODY_BYTES + 2048),
  });
}

/** A stream that tracks bytes emitted and cancellation. */
function createInstrumentedStream(totalBytes: number, chunkSize = 1024) {
  let bytesRead = 0;
  let cancelled = false;
  const raw = new TextEncoder().encode(
    JSON.stringify({
      feedUrl: "https://example.com/feed.xml",
      title: "Streamed",
      modes: ["deepdive"],
    }),
  );
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytesRead >= totalBytes) {
        controller.close();
        return;
      }
      const remaining = totalBytes - bytesRead;
      const size = Math.min(chunkSize, remaining);
      const chunk = new Uint8Array(size);
      if (bytesRead === 0 && size >= raw.length) {
        chunk.set(raw, 0);
      }
      bytesRead += size;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    stream,
    getBytesRead: () => bytesRead,
    isCancelled: () => cancelled,
  };
}

Deno.test("POST /api/admin/users/:id/sources: body just under cap is accepted (audio-feed-heytf)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  const { fetch } = app(stores);

  const payload = nearCapBody();
  assert(payload.length < MAX_ACCOUNT_BODY_BYTES, "payload must be under cap");
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 201, "a body under the cap is accepted and processed");
  const data = await res.json();
  assertEquals(data.source.title, "Admin Feed");
});

Deno.test("POST /api/admin/users/:id/sources: declared body over cap is refused 413 (audio-feed-heytf)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  const { fetch } = app(stores);

  const payload = oversizedBody();
  assert(payload.length > MAX_ACCOUNT_BODY_BYTES, "payload must exceed cap");
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 413, "oversized body must return 413 payload_too_large");
  const data = await res.json();
  assertEquals(data.error, "payload_too_large");
});

Deno.test("POST /api/admin/users/:id/sources: chunked body over cap is refused 413 (audio-feed-heytf)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  const { fetch } = app(stores);

  const instrumented = createInstrumentedStream(MAX_ACCOUNT_BODY_BYTES * 4);
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: instrumented.stream,
      // @ts-ignore duplex stream
      duplex: "half",
    }),
  );
  assertEquals(res.status, 413, "streamed body exceeding cap must be refused 413");
  const data = await res.json();
  assertEquals(data.error, "payload_too_large");
});

Deno.test("POST /api/admin/users/:id/sources: lying small content-length is refused 413 by the read bound (audio-feed-heytf)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  const { fetch } = app(stores);

  const totalBytes = 100 * 1024; // 100 KiB of application/json behind a 16-byte claim
  const instrumented = createInstrumentedStream(totalBytes);
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "16",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: instrumented.stream,
      // @ts-ignore duplex stream
      duplex: "half",
    }),
  );
  assertEquals(res.status, 413, "a lying small content-length must not hide an oversized body");
  assertEquals((await res.json()).error, "payload_too_large");
  assert(
    instrumented.getBytesRead() < totalBytes,
    `must not drain entire body (read ${instrumented.getBytesRead()} of ${totalBytes})`,
  );
  assert(
    instrumented.getBytesRead() <= MAX_ACCOUNT_BODY_BYTES + 2048,
    `bytes read (${instrumented.getBytesRead()}) must be bounded close to cap (${MAX_ACCOUNT_BODY_BYTES})`,
  );
  assert(instrumented.isCancelled(), "underlying stream must be cancelled on overflow");
});

Deno.test("POST /api/admin/users/:id/sources: non-JSON content-type with declared length over cap refused 413", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  const { fetch } = app(stores);

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": String(MAX_ACCOUNT_BODY_BYTES * 2),
        "x-admin-token": ADMIN_TOKEN,
      },
      body: "x".repeat(MAX_ACCOUNT_BODY_BYTES * 2),
    }),
  );
  assertEquals(res.status, 413, "cannot be bypassed by changing content-type");
});

Deno.test("POST /api/admin/users/:id/sources: refusal does not drain the whole body stream (audio-feed-heytf)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  const { fetch } = app(stores);

  const totalBytes = 100 * 1024; // 100 KiB
  const instrumented = createInstrumentedStream(totalBytes);
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: instrumented.stream,
      // @ts-ignore duplex stream
      duplex: "half",
    }),
  );
  assertEquals(res.status, 413);
  assert(
    instrumented.getBytesRead() < totalBytes,
    `must not drain entire body (read ${instrumented.getBytesRead()} of ${totalBytes})`,
  );
  assert(
    instrumented.getBytesRead() <= MAX_ACCOUNT_BODY_BYTES + 2048,
    `bytes read (${instrumented.getBytesRead()}) must be bounded close to cap (${MAX_ACCOUNT_BODY_BYTES})`,
  );
  assert(instrumented.isCancelled(), "underlying stream must be cancelled on overflow");
});

Deno.test("POST /api/admin/users/:id/sources: works identically via admin session cookie (audio-feed-heytf)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "admin-1", email: "admin@example.com", isAdmin: true, status: "approved" }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  const secret = await createSession(stores.metadata, "admin-1");
  const cookie = `${SESSION_COOKIE}=${secret}`;
  const { fetch } = app(stores);

  // (a) under cap accepted with admin session
  const under = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
      },
      body: nearCapBody(),
    }),
  );
  assertEquals(under.status, 201, "body under cap is accepted via admin session");

  // (b) over cap refused 413 with admin session
  const over = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
      },
      body: oversizedBody(),
    }),
  );
  assertEquals(over.status, 413, "oversized body is refused 413 via admin session");
});
