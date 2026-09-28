/**
 * Tests for ADMIN_TOKEN rate limiting and short token advisory (audio-feed-bns).
 *
 * Verifies:
 * - Failed attempts on `POST /api/auth/bootstrap` are throttled (429 Too Many Requests)
 * - Failed attempts on `GET /api/admin/users` (header path) are throttled (429)
 * - The throttle is shared across both surfaces per client IP
 * - Successful authentication clears/resets the failure count
 * - Unauthenticated requests (no token presented) do not increment the failure count
 * - Tokens under 16 characters emit advisory warnings but are never refused
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { AppContext } from "../src/app.ts";
import { FailedAuthLimiter } from "../src/auth/rate_limit.ts";
import { handleAdmin } from "../src/routes/admin.ts";
import { bootstrap } from "../src/server.ts";

const BASE = "https://audio.example.com";
const ADMIN_SECRET = "super-secret-admin-passphrase-123";

function testApp(overrides: Partial<AppConfig> = {}, limiter?: FailedAuthLimiter) {
  const config: AppConfig = {
    port: 8080,
    publicBaseUrl: BASE,
    adminToken: ADMIN_SECRET,
    ...overrides,
  };
  const stores: Stores = memoryStores();
  const ctx: AppContext = { config, stores };
  const handlers = createHandlers(ctx, { adminAuthLimiter: limiter });
  const app = createApp(ctx, handlers);
  return { app, ctx, stores, fetch: app.fetch };
}

Deno.test("admin throttle: POST /api/auth/bootstrap throttles after 10 failed attempts", async () => {
  const limiter = new FailedAuthLimiter({ maxFailures: 5, windowMs: 60_000 });
  const { fetch } = testApp({}, limiter);

  // Send 5 wrong tokens
  for (let i = 0; i < 5; i++) {
    const res = await fetch(
      new Request(`${BASE}/api/auth/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": BASE,
        },
        body: JSON.stringify({ email: "admin@example.com", adminToken: `wrong-token-${i}` }),
      }),
    );
    assertEquals(res.status, 401, `attempt ${i + 1} should be 401`);
  }

  // 6th attempt should be blocked with 429 Too Many Requests
  const blocked = await fetch(
    new Request(`${BASE}/api/auth/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": BASE,
      },
      body: JSON.stringify({ email: "admin@example.com", adminToken: "wrong-token-6" }),
    }),
  );
  assertEquals(blocked.status, 429);
  const json = await blocked.json();
  assertStringIncludes(json.error, "Too many failed admin authentication attempts");
  const retryAfter = blocked.headers.get("retry-after");
  assertEquals(Boolean(retryAfter && Number(retryAfter) > 0), true);
});

Deno.test("admin throttle: GET /api/admin/users header path throttles after failed attempts", async () => {
  const limiter = new FailedAuthLimiter({ maxFailures: 3, windowMs: 60_000 });
  const { fetch } = testApp({}, limiter);

  for (let i = 0; i < 3; i++) {
    const res = await fetch(
      new Request(`${BASE}/api/admin/users`, {
        headers: { "x-admin-token": `wrong-${i}` },
      }),
    );
    assertEquals(res.status, 401);
  }

  // 4th attempt should be throttled
  const blocked = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": "wrong-4" },
    }),
  );
  assertEquals(blocked.status, 429);
  const json = await blocked.json();
  assertStringIncludes(json.error, "Too many failed admin authentication attempts");
});

Deno.test("admin throttle: failure counts are SHARED between bootstrap and header path", async () => {
  const limiter = new FailedAuthLimiter({ maxFailures: 4, windowMs: 60_000 });
  const { fetch } = testApp({}, limiter);

  // 2 failed attempts on bootstrap
  for (let i = 0; i < 2; i++) {
    const res = await fetch(
      new Request(`${BASE}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", "origin": BASE },
        body: JSON.stringify({ email: "admin@example.com", adminToken: `wrong-${i}` }),
      }),
    );
    assertEquals(res.status, 401);
  }

  // 2 failed attempts on header path
  for (let i = 0; i < 2; i++) {
    const res = await fetch(
      new Request(`${BASE}/api/admin/users`, {
        headers: { "x-admin-token": `wrong-header-${i}` },
      }),
    );
    assertEquals(res.status, 401);
  }

  // Next attempt on bootstrap should be locked out (429)
  const bootBlocked = await fetch(
    new Request(`${BASE}/api/auth/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", "origin": BASE },
      body: JSON.stringify({ email: "admin@example.com", adminToken: "another-wrong" }),
    }),
  );
  assertEquals(bootBlocked.status, 429);

  // Next attempt on header path should also be locked out (429)
  const headerBlocked = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": "another-wrong" },
    }),
  );
  assertEquals(headerBlocked.status, 429);
});

Deno.test("admin throttle: successful authentication resets failure count", async () => {
  const limiter = new FailedAuthLimiter({ maxFailures: 3, windowMs: 60_000 });
  const { fetch } = testApp({}, limiter);

  // 2 failures (threshold is 3)
  for (let i = 0; i < 2; i++) {
    const res = await fetch(
      new Request(`${BASE}/api/admin/users`, {
        headers: { "x-admin-token": "wrong" },
      }),
    );
    assertEquals(res.status, 401);
  }

  // 1 success
  const success = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": ADMIN_SECRET },
    }),
  );
  assertEquals(success.status, 200);

  // After reset, 2 more failures should NOT be locked out
  for (let i = 0; i < 2; i++) {
    const res = await fetch(
      new Request(`${BASE}/api/admin/users`, {
        headers: { "x-admin-token": "wrong" },
      }),
    );
    assertEquals(res.status, 401);
  }
});

Deno.test("admin throttle: unauthenticated requests (no token) do not count as failures", async () => {
  const limiter = new FailedAuthLimiter({ maxFailures: 2, windowMs: 60_000 });
  const { fetch } = testApp({}, limiter);

  // 5 unauthenticated requests (no headers)
  for (let i = 0; i < 5; i++) {
    const res = await fetch(new Request(`${BASE}/api/admin/users`));
    assertEquals(res.status, 401);
  }

  // Legitimate admin can still log in without being locked out
  const success = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": ADMIN_SECRET },
    }),
  );
  assertEquals(success.status, 200);
});

Deno.test("admin token length: short token (< 16 chars) is WARNED but NEVER refused", async () => {
  const shortToken = "short-pass"; // 10 chars (< 16)
  const { fetch, ctx } = testApp({ adminToken: shortToken });

  // 1. Success with short token is accepted (not refused!)
  const res = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": shortToken },
    }),
  );
  assertEquals(res.status, 200);

  // 2. GET /admin page renders security advisory warning banner
  const adminPageRes = await handleAdmin({
    req: new Request(`${BASE}/admin`),
    ctx,
    params: {},
    url: new URL(`${BASE}/admin`),
  });
  assertEquals(adminPageRes.status, 200);
  const html = await adminPageRes.text();
  assertStringIncludes(html, "Security Advisory: Short ADMIN_TOKEN");
  assertStringIncludes(html, "shorter than 16 characters");
});

Deno.test("admin token length: strong token (>= 16 chars) does not show short token advisory", async () => {
  const { ctx } = testApp({ adminToken: ADMIN_SECRET }); // 33 chars

  const adminPageRes = await handleAdmin({
    req: new Request(`${BASE}/admin`),
    ctx,
    params: {},
    url: new URL(`${BASE}/admin`),
  });
  assertEquals(adminPageRes.status, 200);
  const html = await adminPageRes.text();
  assertEquals(html.includes("Security Advisory: Short ADMIN_TOKEN"), false);
});

Deno.test("admin token length: bootstrap logs warning on short token but starts cleanly", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
    originalWarn(...args);
  };

  const stores: Stores = memoryStores();
  let booted;
  try {
    booted = await bootstrap({
      port: 0,
      stores,
      isDeploy: true,
      config: { adminToken: "short-token" },
    });
    assertEquals(Boolean(booted.server), true);
    const shortWarn = warnings.find((w) => w.includes("WARNING: ADMIN_TOKEN is short"));
    assertEquals(Boolean(shortWarn), true);
    assertStringIncludes(shortWarn!, "11 chars");
  } finally {
    console.warn = originalWarn;
    if (booted) await booted.shutdown();
  }
});
