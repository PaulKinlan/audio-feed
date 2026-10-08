import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { SlidingWindowRateLimiter } from "../src/auth/rate_limit.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { approveUser } from "../src/auth/users.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const ADMIN_TOKEN = "admin-secret-test";

function setup(rateLimitMax = 5) {
  const config: AppConfig = {
    port: 8080,
    publicBaseUrl: BASE,
    adminToken: ADMIN_TOKEN,
    trustProxyHeaders: true,
  };
  const stores: Stores = memoryStores();
  const limiter = new SlidingWindowRateLimiter({
    maxRequests: rateLimitMax,
    windowMs: 60 * 1000,
  }, stores.metadata);

  const ctx = { config, stores };
  const handlers = createHandlers(ctx, {
    requestAccess: { rateLimiter: limiter },
    fetchArticle: (url) =>
      Promise.resolve({
        url,
        title: "Test Post",
        author: "Author",
        publishedAt: new Date().toISOString(),
        lead: "Lead",
        body: "Body",
      }),
  });
  const { fetch } = createApp(ctx, handlers);
  return { ctx, fetch, stores, limiter };
}

Deno.test("POST /api/request-access: creates pending user without leaking token (audio-feed-r97)", async () => {
  const { fetch, stores } = setup();

  const res = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        displayName: "Alice In Wonderland",
      }),
    }),
  );

  assertEquals(res.status, 201);
  const data = await res.json();
  assertEquals(data.ok, true);
  assertEquals(data.status, "pending");
  assertStringIncludes(data.message, "administrator will review");
  // CRITICAL: no token or capability URL in response
  assertEquals(data.feedToken, undefined);
  assertEquals(data.token, undefined);
  assertEquals(data.playerUrl, undefined);

  // User is stored with pending status
  const user = await stores.metadata.getUserByEmail("alice@example.com");
  assert(user !== null);
  assertEquals(user.displayName, "Alice In Wonderland");
  assertEquals(user.status, "pending");
  assert(user.feedToken.length > 10);

  // Appears in pending approvals
  const allUsers = await stores.metadata.listUsers();
  assert(allUsers.some((u) => u.email === "alice@example.com" && u.status === "pending"));
});

Deno.test("POST /api/request-access: supports form urlencoded submission (audio-feed-r97)", async () => {
  const { fetch, stores } = setup();

  const formData = new URLSearchParams();
  formData.set("email", "bob@example.com");
  formData.set("displayName", "Bob The Builder");

  const res = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    }),
  );

  assertEquals(res.status, 201);
  const user = await stores.metadata.getUserByEmail("bob@example.com");
  assert(user !== null);
  assertEquals(user.status, "pending");
});

Deno.test("POST /api/request-access: validates email input (audio-feed-r97)", async () => {
  const { fetch } = setup();

  // Missing email
  const res1 = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "No Email" }),
    }),
  );
  assertEquals(res1.status, 400);

  // Invalid email
  const res2 = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    }),
  );
  assertEquals(res2.status, 400);
});

Deno.test("POST /api/request-access: rate limiter returns 429 when abuse threshold exceeded (audio-feed-r97)", async () => {
  // Limiter set to 3 requests per IP
  const { fetch } = setup(3);

  const req = (i: number, ip = "192.168.1.100") =>
    fetch(
      new Request(`${BASE}/api/request-access`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ email: `user${i}@example.com` }),
      }),
    );

  // Requests 1, 2, 3 succeed
  assertEquals((await req(1)).status, 201);
  assertEquals((await req(2)).status, 201);
  assertEquals((await req(3)).status, 201);

  // Request 4 from same IP is refused with 429
  const res4 = await req(4);
  assertEquals(res4.status, 429);
  const retryAfter = res4.headers.get("retry-after");
  assert(retryAfter !== null && Number(retryAfter) > 0);
  const body4 = await res4.json();
  assertStringIncludes(body4.error, "Too many access requests");

  // Request from a different IP is permitted
  const resOtherIp = await req(5, "192.168.1.200");
  assertEquals(resOtherIp.status, 201);
});

Deno.test("POST /api/request-access: idempotent on re-submission without row duplication (audio-feed-r97)", async () => {
  const { fetch, stores } = setup();

  // First request
  const res1 = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "charlie@example.com" }),
    }),
  );
  assertEquals(res1.status, 201);

  // Second request with same email
  const res2 = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "charlie@example.com" }),
    }),
  );
  assertEquals(res2.status, 200);
  const data2 = await res2.json();
  assertEquals(data2.ok, true);
  assertEquals(data2.status, "pending");
  assertStringIncludes(data2.message, "already pending");

  // Only one user exists
  const allUsers = await stores.metadata.listUsers();
  assertEquals(allUsers.filter((u) => u.email === "charlie@example.com").length, 1);
});

Deno.test("POST /api/request-access: approved user resubmission states approval without leaking token (audio-feed-r97)", async () => {
  const { fetch, stores } = setup();

  // Create and approve user
  await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "diana@example.com" }),
    }),
  );
  const user = await stores.metadata.getUserByEmail("diana@example.com");
  await approveUser(stores.metadata, user!.id, "admin");

  // Resubmit
  const res = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "diana@example.com" }),
    }),
  );
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.status, "approved");
  assertStringIncludes(data.message, "already approved");
  assertEquals(data.feedToken, undefined);
});

Deno.test("POST /api/request-access: suspended account resubmission clearly states suspension (audio-feed-r97)", async () => {
  const { fetch, stores } = setup();

  await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "suspended@example.com" }),
    }),
  );
  const user = await stores.metadata.getUserByEmail("suspended@example.com");
  await stores.metadata.putUser({ ...user!, status: "suspended" });

  const res = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "suspended@example.com" }),
    }),
  );
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.status, "suspended");
  assertStringIncludes(data.message, "account is suspended");
});

Deno.test("POST /api/request-access: returns HTML confirmation for browser form post (audio-feed-r97)", async () => {
  const { fetch } = setup();

  const formData = new URLSearchParams();
  formData.set("email", "html-user@example.com");

  const res = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept": "text/html",
      },
      body: formData.toString(),
    }),
  );

  assertEquals(res.status, 201);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, "Access Request Received");
  assertStringIncludes(html, "Return to Audio Feed");
});

Deno.test("SlidingWindowRateLimiter: a window that has passed frees the key again (audio-feed-r97)", async () => {
  const store = memoryStores().metadata;
  const limiter = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 1000 }, store);

  const t0 = 10_000;
  assertEquals((await limiter.check("client", t0)).allowed, true);
  assertEquals((await limiter.check("client", t0)).allowed, true);
  // The third attempt inside the window is refused and does not extend it.
  assertEquals((await limiter.check("client", t0)).allowed, false);

  // Once every recorded hit is older than the window, the key is admitted again.
  assertEquals((await limiter.check("client", t0 + 2000)).allowed, true);
});

Deno.test("SlidingWindowRateLimiter: the bound is shared across limiter instances (audio-feed-2zvc)", async () => {
  const store = memoryStores().metadata;
  // Two instances stand in for two Deno Deploy isolates: separate module memory,
  // one store. Before the store-backed window each held its own count, so an
  // attacker could multiply the bound by the number of live isolates.
  const isolateA = new SlidingWindowRateLimiter({ maxRequests: 3, windowMs: 60_000 }, store);
  const isolateB = new SlidingWindowRateLimiter({ maxRequests: 3, windowMs: 60_000 }, store);
  const now = 50_000;

  assertEquals((await isolateA.check("1.2.3.4", now)).allowed, true);
  assertEquals((await isolateB.check("1.2.3.4", now)).allowed, true);
  assertEquals((await isolateA.check("1.2.3.4", now)).allowed, true);

  const blocked = await isolateB.check("1.2.3.4", now);
  assertEquals(blocked.allowed, false, "the fourth attempt is refused from either isolate");
  assertEquals((await isolateA.peek("1.2.3.4", now)).allowed, false);
  assertEquals((await isolateB.peek("1.2.3.4", now)).allowed, false);
});

Deno.test("SlidingWindowRateLimiter: the bound is global across isolates sharing KV (audio-feed-2zvc)", async () => {
  const kv = await Deno.openKv(":memory:");
  // Two limiters over two adapter objects, as a Deno Deploy deployment has two
  // isolates over one KV. Before this, each isolate held its own Map, so the
  // bound multiplied by the number of live isolates.
  const isolateA = new SlidingWindowRateLimiter(
    { maxRequests: 3, windowMs: 60_000 },
    new KvMetadataStore(kv, { ownsConnection: false }),
  );
  const isolateB = new SlidingWindowRateLimiter(
    { maxRequests: 3, windowMs: 60_000 },
    new KvMetadataStore(kv, { ownsConnection: false }),
  );
  try {
    const now = 100_000;
    for (let i = 0; i < 3; i++) {
      assertEquals((await isolateA.check("9.9.9.9", now)).allowed, true, `attempt ${i + 1}`);
    }
    // The fourth attempt arrives at the OTHER isolate and is still refused:
    // the window is in the store, not in either isolate's memory.
    assertEquals((await isolateB.check("9.9.9.9", now)).allowed, false);
    // A different client is unaffected by the first client's lockout.
    assertEquals((await isolateB.check("8.8.8.8", now)).allowed, true);
  } finally {
    kv.close();
  }
});

Deno.test("POST /api/request-access: HTML error and confirmation paths escape markup against XSS (audio-feed-hn4)", async () => {
  const { fetch, stores } = setup();

  // Simulate concurrent signup race: getUserByEmail misses, but insertUser refuses duplicate
  const maliciousEmail = "<b>probe</b>@example.com";
  stores.metadata.insertUser = () => Promise.resolve(false);

  // Submit via form with Accept: text/html
  const formData = new URLSearchParams();
  formData.set("email", maliciousEmail);

  const res = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept": "text/html",
      },
      body: formData.toString(),
    }),
  );

  assertEquals(res.status, 400);
  const html = await res.text();
  // Must NOT contain raw <b>probe</b> tag
  assertEquals(html.includes("<b>probe</b>"), false, "raw unescaped HTML tag must not appear");
  assertStringIncludes(html, "&lt;b&gt;probe&lt;/b&gt;");
});

Deno.test("POST /api/request-access: HTML 429 response includes Retry-After header (audio-feed-hn4)", async () => {
  const { fetch } = setup(1);

  const req = () =>
    fetch(
      new Request(`${BASE}/api/request-access`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "accept": "text/html",
        },
        body: new URLSearchParams({ email: "user@example.com" }).toString(),
      }),
    );

  const res1 = await req();
  assertEquals(res1.status, 201);

  const res2 = await req();
  assertEquals(res2.status, 429);
  assertStringIncludes(res2.headers.get("content-type") ?? "", "text/html");
  const retryAfter = res2.headers.get("retry-after");
  assert(retryAfter !== null && Number(retryAfter) > 0);
});

Deno.test("POST /api/request-access: spend gate authority & end-to-end access lifecycle (audio-feed-r97)", async () => {
  const { fetch, stores } = setup();

  // 1. Visitor requests access
  const reqRes = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "eve@example.com" }),
    }),
  );
  assertEquals(reqRes.status, 201);

  const pendingUser = await stores.metadata.getUserByEmail("eve@example.com");
  assert(pendingUser !== null);
  const token = pendingUser.feedToken;

  // 2. Pending user CANNOT trigger synthesis via ingest (403 forbidden)
  const ingestPending = await fetch(
    new Request(`${BASE}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": token,
      },
      body: JSON.stringify({ url: "https://example.com/some-article" }),
    }),
  );
  assertEquals(ingestPending.status, 403);
  const ingestErr = await ingestPending.json();
  assertEquals(ingestErr.error, "An approved user is required.");

  // 3. Pending user CANNOT access player (403 forbidden)
  const playerPending = await fetch(new Request(`${BASE}/listen/${token}`));
  assertEquals(playerPending.status, 403);

  // 4. Pending user CANNOT access master feed (403 forbidden)
  const feedPending = await fetch(new Request(`${BASE}/feed/${token}/master.xml`));
  assertEquals(feedPending.status, 403);

  // 5. Admin approves user
  const approveRes = await fetch(
    new Request(`${BASE}/api/admin/users/${pendingUser.id}/approve`, {
      method: "POST",
      headers: { "x-admin-token": ADMIN_TOKEN },
    }),
  );
  assertEquals(approveRes.status, 200);

  // 6. Now the token works end-to-end!
  // Player loads 200
  const playerApproved = await fetch(new Request(`${BASE}/listen/${token}`));
  assertEquals(playerApproved.status, 200);

  // Master feed loads 200
  const feedApproved = await fetch(new Request(`${BASE}/feed/${token}/master.xml`));
  assertEquals(feedApproved.status, 200);

  // Ingest accepts 202
  const ingestApproved = await fetch(
    new Request(`${BASE}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": token,
      },
      body: JSON.stringify({ url: "https://example.com/some-article" }),
    }),
  );
  assertEquals(ingestApproved.status, 202);
});
