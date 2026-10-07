/**
 * Focused tests for security audit fixes:
 * 1. audio-feed-8k19: Baseline security headers (CSP, nosniff, frame-ancestors / X-Frame-Options, HSTS)
 * 2. audio-feed-n2ha: Redact capability tokens from req.url in router 500 error logging
 * 3. audio-feed-5iue: Enforce prefix allowlist and user approval check on /audio/ enclosure route
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { isHttpsRequest, sanitizeRequestUrl } from "../src/router.ts";
import { isAllowedAudioKey } from "../src/routes/audio.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { bytes, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const HTTP_BASE = "http://localhost:8000";
const config: AppConfig = {
  port: 8000,
  publicBaseUrl: BASE,
  adminToken: "admin-secret-token",
};

function setupTestApp(customStores?: Stores, handlers = {}) {
  const stores = customStores ?? memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, handlers);
  return { fetch, stores, ctx };
}

// ===========================================================================
// 1. audio-feed-8k19: Baseline security headers
// ===========================================================================

Deno.test("security headers: HTML responses carry baseline headers (CSP, nosniff, frame-ancestors, X-Frame-Options)", async () => {
  const { fetch, stores } = setupTestApp();

  // Test public HTML landing and console pages
  for (const path of ["/", "/admin", "/login", "/listen"]) {
    const res = await fetch(new Request(`${BASE}${path}`));
    const contentType = res.headers.get("content-type") ?? "";
    assert(contentType.includes("text/html"), `${path} must be text/html`);

    // nosniff
    assertEquals(res.headers.get("x-content-type-options"), "nosniff", `${path} missing nosniff`);

    // Clickjacking protection: frame-ancestors 'none' and X-Frame-Options: DENY
    assertEquals(
      res.headers.get("x-frame-options"),
      "DENY",
      `${path} missing X-Frame-Options: DENY`,
    );

    const csp = res.headers.get("content-security-policy");
    assert(csp, `${path} missing Content-Security-Policy`);
    assertStringIncludes(csp!, "default-src 'self'", `${path} CSP missing default-src 'self'`);
    assertStringIncludes(
      csp!,
      "frame-ancestors 'none'",
      `${path} CSP missing frame-ancestors 'none'`,
    );
    assertStringIncludes(
      csp!,
      "script-src 'self' 'unsafe-inline'",
      `${path} CSP missing script-src`,
    );
    assertStringIncludes(csp!, "style-src 'self' 'unsafe-inline'", `${path} CSP missing style-src`);
    assertStringIncludes(csp!, "media-src 'self' blob: https:", `${path} CSP missing media-src`);
    await res.body?.cancel();
  }

  // Test authenticated /account page
  const user = makeUser({ id: "acc-user", status: "approved" });
  await stores.metadata.putUser(user);
  const token = await createSession(stores.metadata, user.id);
  const accountRes = await fetch(
    new Request(`${BASE}/account`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
  );
  assertEquals(accountRes.status, 200);
  const accountCsp = accountRes.headers.get("content-security-policy");
  assert(accountCsp);
  assertStringIncludes(accountCsp!, "frame-ancestors 'none'");
  assertEquals(accountRes.headers.get("x-frame-options"), "DENY");
  assertEquals(accountRes.headers.get("x-content-type-options"), "nosniff");
  await accountRes.body?.cancel();
});

Deno.test("security headers: JSON and problem responses carry restrictive CSP, nosniff, and frame deny", async () => {
  const { fetch } = setupTestApp();

  // /health is a standard JSON response
  const healthRes = await fetch(new Request(`${BASE}/health`));
  assertEquals(healthRes.headers.get("x-content-type-options"), "nosniff");
  assertEquals(healthRes.headers.get("x-frame-options"), "DENY");
  assertEquals(
    healthRes.headers.get("content-security-policy"),
    "default-src 'none'; frame-ancestors 'none'",
  );
  await healthRes.body?.cancel();

  // 404 is a JSON problem response
  const notFoundRes = await fetch(new Request(`${BASE}/does-not-exist`));
  assertEquals(notFoundRes.headers.get("x-content-type-options"), "nosniff");
  assertEquals(notFoundRes.headers.get("x-frame-options"), "DENY");
  assertEquals(
    notFoundRes.headers.get("content-security-policy"),
    "default-src 'none'; frame-ancestors 'none'",
  );
  await notFoundRes.body?.cancel();
});

Deno.test("security headers: HSTS is sent on HTTPS and proxied-HTTPS, omitted on plain HTTP", async () => {
  const { fetch } = setupTestApp();

  // Direct HTTPS URL
  const httpsRes = await fetch(new Request(`${BASE}/health`));
  assertEquals(
    httpsRes.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
  await httpsRes.body?.cancel();

  // Reverse proxy with x-forwarded-proto: https
  const proxiedRes = await fetch(
    new Request(`${HTTP_BASE}/health`, {
      headers: { "x-forwarded-proto": "https" },
    }),
  );
  assertEquals(
    proxiedRes.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
  await proxiedRes.body?.cancel();

  // Plain HTTP request without TLS header: no HSTS
  const httpRes = await fetch(new Request(`${HTTP_BASE}/health`));
  assertEquals(httpRes.headers.get("strict-transport-security"), null);
  await httpRes.body?.cancel();
});

Deno.test("security headers: isHttpsRequest helper checks direct protocol and proxy header", () => {
  assertEquals(isHttpsRequest(new Request("https://example.com/test")), true);
  assertEquals(isHttpsRequest(new Request("http://localhost:8000/test")), false);
  assertEquals(
    isHttpsRequest(
      new Request("http://localhost:8000/test", { headers: { "x-forwarded-proto": "https" } }),
    ),
    true,
  );
  assertEquals(
    isHttpsRequest(
      new Request("http://localhost:8000/test", { headers: { "x-forwarded-proto": "http" } }),
    ),
    false,
  );
});

// ===========================================================================
// 2. audio-feed-n2ha: Capability token redaction in 500 error logs
// ===========================================================================

Deno.test("token redaction: sanitizeRequestUrl redacts feed and listen capability tokens and strips query params", () => {
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/feed/secret-token-123/master.xml?k=v#hash"),
    "https://audio.example.com/feed/[redacted]/master.xml",
  );
  assertEquals(
    sanitizeRequestUrl(
      "https://audio.example.com/feed/sub-tok-abc/source-1/direct.xml?feed=secret",
    ),
    "https://audio.example.com/feed/[redacted]/source-1/direct.xml",
  );
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/listen/bearer-token-xyz"),
    "https://audio.example.com/listen/[redacted]",
  );
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/listen/bearer-token-xyz/status?poll=1"),
    "https://audio.example.com/listen/[redacted]/status",
  );
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/listen/bearer-token-xyz/episodes/ep-1/retry"),
    "https://audio.example.com/listen/[redacted]/episodes/ep-1/retry",
  );
  // /listen landing without token is unchanged
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/listen"),
    "https://audio.example.com/listen",
  );
  // query parameters are stripped on generic paths
  assertEquals(
    sanitizeRequestUrl(
      "https://audio.example.com/api/ingest?token=sensitive&url=https://example.com",
    ),
    "https://audio.example.com/api/ingest",
  );
  // relative URLs
  assertEquals(
    sanitizeRequestUrl("/feed/my-feed-tok/master.xml?debug=1"),
    "/feed/[redacted]/master.xml",
  );
  assertEquals(
    sanitizeRequestUrl("/listen/my-listen-tok"),
    "/listen/[redacted]",
  );
});

Deno.test("token redaction: Router 500 error logging redacts capability token and preserves error stack", async () => {
  const SECRET_FEED_TOKEN = "private-feed-token-987654321";
  const { fetch } = setupTestApp(undefined, {
    masterFeed: () => {
      throw new Error("unexpected KV failure during feed generation");
    },
  });

  const loggedErrors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    const res = await fetch(
      new Request(`${BASE}/feed/${SECRET_FEED_TOKEN}/master.xml?subscriber=alice`),
    );
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "internal_error");

    assertEquals(loggedErrors.length, 1);
    const logLine = String(loggedErrors[0]?.[0]);
    const loggedException = loggedErrors[0]?.[1];

    // Bearer token must NOT appear in the log line
    assert(
      !logLine.includes(SECRET_FEED_TOKEN),
      `Log line must not contain feed token: ${logLine}`,
    );
    assert(
      !logLine.includes("subscriber=alice"),
      `Log line must not contain query parameters: ${logLine}`,
    );
    assertStringIncludes(
      logLine,
      "/feed/[redacted]/master.xml",
      "Log line must contain redacted URL",
    );

    // Error object / stack must be preserved
    assert(loggedException instanceof Error, "Logged second argument must be the Error object");
    assertEquals(
      (loggedException as Error).message,
      "unexpected KV failure during feed generation",
    );
  } finally {
    console.error = originalError;
  }
});

// ===========================================================================
// 3. audio-feed-5iue: Enforce prefix allowlist and user approval check on /audio/
// ===========================================================================

Deno.test("audio route: isAllowedAudioKey restricts to canonical audio/ and flat legacy keys, rejecting audio-segments/", () => {
  // Disallowed: intermediate synthesis segments
  assertEquals(isAllowedAudioKey("audio-segments/user-1/ep-1/hash.wav"), false);
  assertEquals(isAllowedAudioKey("audio-segments"), false);
  assertEquals(isAllowedAudioKey("audio/audio-segments/user-1/ep-1/hash.wav"), false);

  // Disallowed: path traversal / unsafe keys
  assertEquals(isAllowedAudioKey("../secret.wav"), false);
  assertEquals(isAllowedAudioKey("/audio/foo.wav"), false);
  assertEquals(isAllowedAudioKey(""), false);

  // Disallowed: arbitrary non-canonical directory structure without 3+ segments
  assertEquals(isAllowedAudioKey("internal-cache/file.wav"), false);

  // Allowed: canonical keys
  assertEquals(isAllowedAudioKey("audio/user-1/direct/ep-1.wav"), true);
  assertEquals(isAllowedAudioKey("audio/u1/direct/e1.mp3"), true);
  assertEquals(isAllowedAudioKey("user-1/direct/ep-1.wav"), true); // route-trimmed canonical
  assertEquals(isAllowedAudioKey("audio/ready.wav"), true);

  // Allowed: legacy flat keys
  assertEquals(isAllowedAudioKey("legacy.wav"), true);
  assertEquals(isAllowedAudioKey("episode-1.mp3"), true);
});

Deno.test("audio route: intermediate synthesis segments under audio-segments/ return 404", async () => {
  const stores = memoryStores();
  const SEGMENT_KEY = "audio-segments/user-1/ep-1/fnv64-rev1.wav";
  await stores.blobs.put(SEGMENT_KEY, bytes(500), { contentType: "audio/wav" });
  await stores.blobs.put(`audio/${SEGMENT_KEY}`, bytes(500), { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  // 1. Direct audio-segments/ key
  const res1 = await fetch(new Request(`${BASE}/audio/${SEGMENT_KEY}`));
  assertEquals(res1.status, 404, "audio-segments/ key must return 404");
  await res1.body?.cancel();

  // 2. Nested audio/audio-segments/ key
  const res2 = await fetch(new Request(`${BASE}/audio/audio/${SEGMENT_KEY}`));
  assertEquals(res2.status, 404, "audio/audio-segments/ key must return 404");
  await res2.body?.cancel();

  // 3. HEAD request
  const headRes = await fetch(new Request(`${BASE}/audio/${SEGMENT_KEY}`, { method: "HEAD" }));
  assertEquals(headRes.status, 404, "HEAD on audio-segments/ key must return 404");
  await headRes.body?.cancel();
});

Deno.test("audio route: canonical audio is served for approved users, 403 Forbidden for suspended/pending/rejected users", async () => {
  const stores = memoryStores();

  const approvedUser = makeUser({ id: "user-approved", status: "approved" });
  const suspendedUser = makeUser({ id: "user-suspended", status: "suspended" });
  const pendingUser = makeUser({ id: "user-pending", status: "pending" });
  const rejectedUser = makeUser({ id: "user-rejected", status: "rejected" });

  await stores.metadata.putUser(approvedUser);
  await stores.metadata.putUser(suspendedUser);
  await stores.metadata.putUser(pendingUser);
  await stores.metadata.putUser(rejectedUser);

  const approvedKey = "audio/user-approved/direct/ep-1.wav";
  const suspendedKey = "audio/user-suspended/direct/ep-2.wav";
  const pendingKey = "audio/user-pending/direct/ep-3.wav";
  const rejectedKey = "audio/user-rejected/direct/ep-4.wav";

  await stores.blobs.put(approvedKey, bytes(200), { contentType: "audio/wav" });
  await stores.blobs.put(suspendedKey, bytes(200), { contentType: "audio/wav" });
  await stores.blobs.put(pendingKey, bytes(200), { contentType: "audio/wav" });
  await stores.blobs.put(rejectedKey, bytes(200), { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  // Approved user: GET returns 200
  const appRes = await fetch(new Request(`${BASE}/${approvedKey}`));
  assertEquals(appRes.status, 200, "Approved user audio must be served");
  await appRes.body?.cancel();

  // Suspended user: GET returns 403
  const suspRes = await fetch(new Request(`${BASE}/${suspendedKey}`));
  assertEquals(suspRes.status, 403, "Suspended user audio must return 403");
  const suspBody = await suspRes.json();
  assertEquals(suspBody.error, "forbidden");

  // Suspended user: HEAD returns 403
  const suspHead = await fetch(new Request(`${BASE}/${suspendedKey}`, { method: "HEAD" }));
  assertEquals(suspHead.status, 403, "Suspended user HEAD must return 403");
  await suspHead.body?.cancel();

  // Pending user: GET returns 403
  const pendRes = await fetch(new Request(`${BASE}/${pendingKey}`));
  assertEquals(pendRes.status, 403, "Pending user audio must return 403");
  await pendRes.body?.cancel();

  // Rejected user: GET returns 403
  const rejRes = await fetch(new Request(`${BASE}/${rejectedKey}`));
  assertEquals(rejRes.status, 403, "Rejected user audio must return 403");
  await rejRes.body?.cancel();
});

Deno.test("audio route: direct-URL redirect branch checks user approval before issuing 302 redirect", async () => {
  const stores = memoryStores();

  const approvedUser = makeUser({ id: "user-approved", status: "approved" });
  const suspendedUser = makeUser({ id: "user-suspended", status: "suspended" });
  await stores.metadata.putUser(approvedUser);
  await stores.metadata.putUser(suspendedUser);

  const approvedKey = "audio/user-approved/direct/ep-1.wav";
  const suspendedKey = "audio/user-suspended/direct/ep-2.wav";

  await stores.blobs.put(approvedKey, bytes(200), { contentType: "audio/wav" });
  await stores.blobs.put(suspendedKey, bytes(200), { contentType: "audio/wav" });

  // Wrap store with direct URLs (like S3/R2)
  stores.blobs.url = (key: string) => Promise.resolve(`https://cdn.example.com/${key}`);

  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  // Non-CORS request for approved user redirects 302
  const appRes = await fetch(new Request(`${BASE}/${approvedKey}`));
  assertEquals(appRes.status, 302, "Approved user should redirect to direct URL");
  assertEquals(appRes.headers.get("location"), `https://cdn.example.com/${approvedKey}`);

  // Non-CORS request for suspended user returns 403 Forbidden without redirecting
  const suspRes = await fetch(new Request(`${BASE}/${suspendedKey}`));
  assertEquals(suspRes.status, 403, "Suspended user must not receive 302 redirect");
  assertEquals(suspRes.headers.get("location"), null);
  await suspRes.body?.cancel();
});

Deno.test("audio route: legacy flat keys continue to serve without a user ID in the key", async () => {
  const stores = memoryStores();
  await stores.blobs.put("legacy-episode.wav", bytes(300), { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  const res = await fetch(new Request(`${BASE}/audio/legacy-episode.wav`));
  assertEquals(res.status, 200, "Legacy flat key should be served");
  assertEquals(res.headers.get("content-type"), "audio/wav");
  await res.body?.cancel();
});
