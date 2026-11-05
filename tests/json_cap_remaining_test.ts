/**
 * audio-feed-3t01u — JSON body cap on remaining routes:
 * 1. POST /api/admin/users/:id/role (createAdminSetRoleHandler)
 * 2. POST /api/admin/users (createCreateUserHandler)
 * 3. POST /api/admin/users/:id/regenerate (createAdminRegenerateFeedHandler)
 * 4. POST /api/account/regenerate (regenerateOutdated)
 *
 * Verifies:
 *  (a) a body just under the cap (MAX_ACCOUNT_BODY_BYTES = 16 KiB) is accepted
 *  (b) a body over the cap is refused with 413 HttpError (payload_too_large)
 *  (c) specific behavior preserved at non-blind substitution sites
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

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  const handlers = createHandlers(ctx, {
    feedTransport: () =>
      Promise.resolve(
        new Response("<rss><channel><title>F</title></channel></rss>", {
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

function nearCapPayload(baseObj: Record<string, unknown>): string {
  const base = JSON.stringify(baseObj);
  const paddingLen = MAX_ACCOUNT_BODY_BYTES - base.length - 50;
  return JSON.stringify({
    ...baseObj,
    padding: "x".repeat(Math.max(0, paddingLen)),
  });
}

function oversizedPayload(baseObj: Record<string, unknown>): string {
  return JSON.stringify({
    ...baseObj,
    padding: "x".repeat(MAX_ACCOUNT_BODY_BYTES + 2048),
  });
}

// ---------------------------------------------------------------------------
// Site 1: POST /api/admin/users/:id/role
// ---------------------------------------------------------------------------

Deno.test("POST /api/admin/users/:id/role: body just under cap is accepted (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  const { fetch } = app(stores);

  const payload = nearCapPayload({ isAdmin: true });
  assert(payload.length < MAX_ACCOUNT_BODY_BYTES, "payload must be under cap");

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/role`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 200, "a body under cap is accepted");
  const data = await res.json();
  assertEquals(data.isAdmin, true);
});

Deno.test("POST /api/admin/users/:id/role: declared body over cap is refused 413 (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  const { fetch } = app(stores);

  const payload = oversizedPayload({ isAdmin: true });
  assert(payload.length > MAX_ACCOUNT_BODY_BYTES, "payload must exceed cap");

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/role`, {
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

// ---------------------------------------------------------------------------
// Site 2: POST /api/admin/users
// ---------------------------------------------------------------------------

Deno.test("POST /api/admin/users: body just under cap is accepted (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  const { fetch } = app(stores);

  const payload = nearCapPayload({ email: "newuser@example.com" });
  assert(payload.length < MAX_ACCOUNT_BODY_BYTES, "payload must be under cap");

  const res = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 201, "a body under cap is accepted and user created");
  const data = await res.json();
  assertEquals(data.email, "newuser@example.com");
});

Deno.test("POST /api/admin/users: declared body over cap is refused 413 (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  const { fetch } = app(stores);

  const payload = oversizedPayload({ email: "newuser@example.com" });
  assert(payload.length > MAX_ACCOUNT_BODY_BYTES, "payload must exceed cap");

  const res = await fetch(
    new Request(`${BASE}/api/admin/users`, {
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

Deno.test("POST /api/admin/users: non-JSON or malformed body preserves fallback 400 (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  const { fetch } = app(stores);

  // Non-JSON content type returns 400 "An email address is required." (not 500 or crash)
  const nonJsonRes = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: "plain text email=foo@example.com",
    }),
  );
  assertEquals(nonJsonRes.status, 400);
  assertEquals((await nonJsonRes.json()).error, "An email address is required.");

  // Malformed JSON returns 400 "An email address is required."
  const malformedRes = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: "{not-valid-json",
    }),
  );
  assertEquals(malformedRes.status, 400);
  assertEquals((await malformedRes.json()).error, "An email address is required.");
});

// ---------------------------------------------------------------------------
// Site 3: POST /api/admin/users/:id/regenerate
// ---------------------------------------------------------------------------

Deno.test("POST /api/admin/users/:id/regenerate: body just under cap is accepted (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  const { fetch } = app(stores);

  const payload = nearCapPayload({ scope: "all" });
  assert(payload.length < MAX_ACCOUNT_BODY_BYTES, "payload must be under cap");

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/regenerate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 200, "a body under cap is accepted");
  const data = await res.json();
  assertEquals(data.ok, true);
  assertEquals(data.scope, "all");
});

Deno.test("POST /api/admin/users/:id/regenerate: declared body over cap is refused 413 (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  const { fetch } = app(stores);

  const payload = oversizedPayload({ scope: "all" });
  assert(payload.length > MAX_ACCOUNT_BODY_BYTES, "payload must exceed cap");

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/regenerate`, {
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

// ---------------------------------------------------------------------------
// Site 4: POST /api/account/regenerate
// ---------------------------------------------------------------------------

Deno.test("POST /api/account/regenerate: body just under cap is accepted (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  const secret = await createSession(stores.metadata, "user-1");
  const cookie = `${SESSION_COOKIE}=${secret}`;
  const { fetch } = app(stores);

  const payload = nearCapPayload({ scope: "all" });
  assert(payload.length < MAX_ACCOUNT_BODY_BYTES, "payload must be under cap");

  const res = await fetch(
    new Request(`${BASE}/api/account/regenerate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 200, "a body under cap is accepted");
  const data = await res.json();
  assertEquals(data.ok, true);
});

Deno.test("POST /api/account/regenerate: declared body over cap is refused 413 (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  const secret = await createSession(stores.metadata, "user-1");
  const cookie = `${SESSION_COOKIE}=${secret}`;
  const { fetch } = app(stores);

  const payload = oversizedPayload({ scope: "all" });
  assert(payload.length > MAX_ACCOUNT_BODY_BYTES, "payload must exceed cap");

  const res = await fetch(
    new Request(`${BASE}/api/account/regenerate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
      },
      body: payload,
    }),
  );
  assertEquals(res.status, 413, "oversized body must return 413 payload_too_large");
  const data = await res.json();
  assertEquals(data.error, "payload_too_large");
});

Deno.test("POST /api/account/regenerate: empty/missing body defaults to outdated; unauth rejected 401 first (audio-feed-3t01u)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  const secret = await createSession(stores.metadata, "user-1");
  const cookie = `${SESSION_COOKIE}=${secret}`;
  const { fetch } = app(stores);

  // 1. Missing body gracefully defaults to scope: "outdated" without failing
  const noBodyRes = await fetch(
    new Request(`${BASE}/api/account/regenerate`, {
      method: "POST",
      headers: {
        origin: BASE,
        cookie,
      },
    }),
  );
  assertEquals(noBodyRes.status, 200);
  assertEquals((await noBodyRes.json()).ok, true);

  // 2. Malformed JSON body also gracefully defaults to scope: "outdated"
  const malformedRes = await fetch(
    new Request(`${BASE}/api/account/regenerate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie,
      },
      body: "{invalid-json",
    }),
  );
  assertEquals(malformedRes.status, 200);
  assertEquals((await malformedRes.json()).ok, true);

  // 3. Auth gate precedes body cap: unauthenticated request with oversized body returns 401, not 413
  const unauthRes = await fetch(
    new Request(`${BASE}/api/account/regenerate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
      },
      body: oversizedPayload({ scope: "all" }),
    }),
  );
  assertEquals(unauthRes.status, 401, "unauthenticated caller rejected 401 before body read");
});
