/**
 * audio-feed-xqkes / audio-feed-g9gsi — POST /api/sources request body cap.
 *
 * The finding: `POST /api/sources` buffered an unbounded JSON request body via
 * `await req.json()`, against the repo's bounded-by-construction rule.
 *
 * Verifies:
 *  (a) a body just under the cap (MAX_ACCOUNT_BODY_BYTES = 16 KiB) is accepted
 *  (b) a body over the cap is refused with 413 HttpError (payload_too_large)
 *  (c) the refusal does not read/drain the entire body stream
 *  (d) cannot be bypassed by chunked encoding or mismatched content-type
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { MAX_ACCOUNT_BODY_BYTES } from "../src/http.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import type { User } from "../src/types.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Example Feed</title>
  <link>https://example.com/</link>
  <item>
    <title>Item 1</title>
    <link>https://example.com/item1</link>
    <guid>item1</guid>
  </item>
</channel>
</rss>`;

function makeUser(fields: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "user@example.com",
    displayName: "User One",
    feedToken: "token-user-1",
    status: "approved",
    isAdmin: false,
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  const handlers = createHandlers(ctx, {
    feedTransport: () =>
      Promise.resolve(
        new Response(RSS, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
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

/** A valid JSON body for adding a source, padded to just under the 16 KiB cap. */
function nearCapBody(feedUrl = "https://example.com/feed.xml"): string {
  const base = JSON.stringify({ feedUrl, title: "Test Feed" });
  const paddingLen = MAX_ACCOUNT_BODY_BYTES - base.length - 50;
  return JSON.stringify({
    feedUrl,
    title: "Test Feed",
    padding: "x".repeat(Math.max(0, paddingLen)),
  });
}

/** A valid JSON body for adding a source, padded well over the cap. */
function oversizedBody(feedUrl = "https://example.com/feed.xml"): string {
  return JSON.stringify({
    feedUrl,
    title: "Test Feed",
    padding: "x".repeat(MAX_ACCOUNT_BODY_BYTES + 2048),
  });
}

/** A stream that tracks bytes emitted and cancellation. */
function createInstrumentedStream(totalBytes: number, chunkSize = 1024) {
  let bytesRead = 0;
  let cancelled = false;
  const raw = new TextEncoder().encode(
    JSON.stringify({ feedUrl: "https://example.com/feed.xml", title: "Streamed" }),
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

Deno.test("POST /api/sources: body just under cap is accepted (audio-feed-xqkes, audio-feed-g9gsi)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser());
  const { fetch } = app(stores);

  const payload = nearCapBody();
  assert(payload.length < MAX_ACCOUNT_BODY_BYTES, "payload must be under cap");
  const res = await fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": "token-user-1",
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 201, "a body under the cap is accepted and processed");
});

Deno.test("POST /api/sources: declared body over cap is refused 413 (audio-feed-xqkes, audio-feed-g9gsi)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser());
  const { fetch } = app(stores);

  const payload = oversizedBody();
  assert(payload.length > MAX_ACCOUNT_BODY_BYTES, "payload must exceed cap");
  const res = await fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": "token-user-1",
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 413, "oversized body must return 413 payload_too_large");
  const data = await res.json();
  assertEquals(data.error, "payload_too_large");
});

Deno.test("POST /api/sources: chunked body over cap is refused 413 (audio-feed-xqkes, audio-feed-g9gsi)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser());
  const { fetch } = app(stores);

  const instrumented = createInstrumentedStream(MAX_ACCOUNT_BODY_BYTES * 4);
  const res = await fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": "token-user-1",
      },
      body: instrumented.stream,
      // @ts-ignore duplex stream
      duplex: "half",
    }),
  );
  assertEquals(res.status, 413, "streamed body exceeding cap must be refused 413");
});

Deno.test("POST /api/sources: non-JSON content-type with declared length over cap refused 413", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser());
  const { fetch } = app(stores);

  const res = await fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": String(MAX_ACCOUNT_BODY_BYTES * 2),
        "x-feed-token": "token-user-1",
      },
      body: "x".repeat(MAX_ACCOUNT_BODY_BYTES * 2),
    }),
  );
  assertEquals(res.status, 413, "cannot be bypassed by changing content-type");
});

Deno.test("POST /api/sources: refusal does not drain the whole body stream (audio-feed-xqkes, audio-feed-g9gsi)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser());
  const { fetch } = app(stores);

  const totalBytes = 100 * 1024; // 100 KiB
  const instrumented = createInstrumentedStream(totalBytes);
  const res = await fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": "token-user-1",
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

Deno.test("POST /api/sources: declared content-length over cap does not drain stream", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser());
  const { fetch } = app(stores);

  const totalBytes = 50 * 1024;
  const instrumented = createInstrumentedStream(totalBytes);
  const res = await fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(totalBytes),
        "x-feed-token": "token-user-1",
      },
      body: instrumented.stream,
      // @ts-ignore duplex stream
      duplex: "half",
    }),
  );
  assertEquals(res.status, 413);
  // The declared size triggers 413 immediately without reading the body chunks.
  // Runtime request priming may pull at most 1 initial chunk into the socket buffer.
  assert(
    instrumented.getBytesRead() <= 1024,
    `declared content-length must not drain stream (only primed ${instrumented.getBytesRead()} of ${totalBytes})`,
  );
});

Deno.test("POST /api/account/sources: body cap enforced (accepts under cap, 413 over cap, stream not drained)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser());
  const secret = await createSession(stores.metadata, "user-1");
  const cookie = `${SESSION_COOKIE}=${secret}`;
  const { fetch } = app(stores);

  // (a) under cap is accepted
  const under = await fetch(
    new Request(`${BASE}/api/account/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
      },
      body: nearCapBody(),
    }),
  );
  assertEquals(under.status, 201, "body under cap is accepted");

  // (b) declared over cap is refused 413
  const over = await fetch(
    new Request(`${BASE}/api/account/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
      },
      body: oversizedBody(),
    }),
  );
  assertEquals(over.status, 413, "oversized body is refused 413");

  // (c) stream over cap is not drained
  const totalBytes = 100 * 1024;
  const instrumented = createInstrumentedStream(totalBytes);
  const streamed = await fetch(
    new Request(`${BASE}/api/account/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
      },
      body: instrumented.stream,
      // @ts-ignore duplex stream
      duplex: "half",
    }),
  );
  assertEquals(streamed.status, 413);
  assert(instrumented.getBytesRead() < totalBytes);
  assert(instrumented.isCancelled());
});
