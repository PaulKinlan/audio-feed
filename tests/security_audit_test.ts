/**
 * Focused tests for security audit fixes:
 * 1. audio-feed-8k19: Baseline security headers (CSP, nosniff, frame-ancestors / X-Frame-Options, HSTS)
 * 2. audio-feed-n2ha: Redact capability tokens from req.url in router 500 error logging
 * 3. audio-feed-5iue: Enforce prefix allowlist and user approval check on /audio/ enclosure route
 * 4. audio-feed-0eae: Redact /audio/ capability tokens in sanitizeRequestUrl and audio 404 warning logs
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { isHttpsRequest, Router, sanitizeRequestUrl } from "../src/router.ts";
import { AUDIO_RATE_LIMIT, isAllowedAudioKey, MAX_FANOUT_CANDIDATES } from "../src/routes/audio.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { SUPPRESSED_MESSAGE } from "../src/observability/error_screen.ts";
import { bytes, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const HTTP_BASE = "http://localhost:8000";
const config: AppConfig = {
  port: 8000,
  publicBaseUrl: BASE,
  adminToken: "admin-secret-token",
};

function setupTestApp(
  customStores?: Stores,
  handlers = {},
  customConfig?: Partial<AppConfig>,
) {
  const stores = customStores ?? memoryStores();
  const cfg = { ...config, ...customConfig };
  const ctx = { config: cfg, stores };
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
    // audio-feed-syhu: the policy carries a per-response nonce; 'unsafe-inline' would defeat
    // CSP as a last line of defence on these credentialed documents.
    assertEquals(
      csp!.includes("'unsafe-inline'"),
      false,
      `${path} CSP still allows 'unsafe-inline': ${csp}`,
    );
    assertStringIncludes(
      csp!,
      "script-src 'self' 'nonce-",
      `${path} CSP missing script-src nonce`,
    );
    assertStringIncludes(
      csp!,
      "style-src 'self' 'nonce-",
      `${path} CSP missing style-src nonce`,
    );
    assertStringIncludes(csp!, "media-src 'self' blob: https:", `${path} CSP missing media-src`);
    assertStringIncludes(csp!, "connect-src 'self'", `${path} CSP missing connect-src`);
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

/**
 * audio-feed-syhu: the nonce in the CSP header must be the nonce on the page's inline
 * `<script>`/`<style>` tags, and there must be no inline style attributes (which no CSP nonce
 * can cover). A mismatch means the browser blocks the page's boot script — the exact failure
 * this guard exists to make loud instead of silent.
 */
function assertNonceConsistency(path: string, csp: string | null, body: string): void {
  assert(csp, `${path} missing Content-Security-Policy`);
  assert(
    !csp.includes("'unsafe-inline'"),
    `${path} CSP still allows 'unsafe-inline': ${csp}`,
  );
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert(nonce, `${path} CSP carries no nonce: ${csp}`);
  assert(
    !body.includes('style="'),
    `${path} carries an inline style attribute; a CSP nonce cannot cover attributes`,
  );
  for (const tag of body.match(/<script\b[^>]*>/gi) ?? []) {
    // External scripts are covered by `'self'`; every inline tag must carry this response's nonce.
    if (/\bsrc\s*=/i.test(tag)) continue;
    assert(
      tag.includes(`nonce="${nonce}"`),
      `${path} inline script without the response nonce: ${tag}`,
    );
  }
  for (const tag of body.match(/<style\b[^>]*>/gi) ?? []) {
    assert(
      tag.includes(`nonce="${nonce}"`),
      `${path} inline style without the response nonce: ${tag}`,
    );
  }
}

Deno.test("security headers: every HTML page's nonce matches its CSP and has no inline style attributes (audio-feed-syhu)", async () => {
  const stores = memoryStores();
  const ctx = { config: { ...config }, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const user = makeUser({ id: "syhu-user", status: "approved", feedToken: "syhu-token" });
  await stores.metadata.putUser(user);
  const token = await createSession(stores.metadata, user.id);

  const pages: Array<[string, RequestInit]> = [
    ["/", {}],
    ["/admin", {}],
    ["/login", {}],
    ["/listen", {}],
    ["/listen/syhu-token", {}],
    ["/account", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }],
  ];
  for (const [path, init] of pages) {
    const res = await fetch(new Request(`${BASE}${path}`, init));
    assertEquals(res.status, 200, `${path} expected 200`);
    const body = await res.text();
    assertNonceConsistency(path, res.headers.get("content-security-policy"), body);
  }

  // The request-access HTML page is composed outside the router's HTML routes (audio-feed-r97);
  // it still has to carry a matching nonce.
  const accessRes = await fetch(
    new Request(`${BASE}/api/request-access`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/html" },
      body: JSON.stringify({ email: "syhu@example.com" }),
    }),
  );
  assert(accessRes.ok, `request-access HTML page expected 2xx, saw ${accessRes.status}`);
  assertNonceConsistency(
    "/api/request-access",
    accessRes.headers.get("content-security-policy"),
    await accessRes.text(),
  );
});

Deno.test("service worker offline fallback carries no inline style attribute (audio-feed-syhu)", async () => {
  // The offline page is synthesised client-side by the service worker, so no server CSP applies
  // to it; it must still carry no inline style attribute, the same rule the server templates hold.
  const stores = memoryStores();
  const ctx = { config: { ...config }, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const res = await fetch(new Request(`${BASE}/sw.js`));
  assertEquals(res.status, 200);
  const body = await res.text();
  assertEquals(
    body.includes('style="'),
    false,
    "the service worker's offline page must not carry an inline style attribute",
  );
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

Deno.test("security headers: HSTS is sent on HTTPS and trusted proxied-HTTPS, omitted on plain HTTP or untrusted proxy", async () => {
  const { fetch } = setupTestApp();

  // Direct HTTPS URL
  const httpsRes = await fetch(new Request(`${BASE}/health`));
  assertEquals(
    httpsRes.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
  await httpsRes.body?.cancel();

  // Untrusted proxy header (trustProxyHeaders not set): x-forwarded-proto ignored
  const untrustedProxiedRes = await fetch(
    new Request(`${HTTP_BASE}/health`, {
      headers: { "x-forwarded-proto": "https" },
    }),
  );
  assertEquals(untrustedProxiedRes.headers.get("strict-transport-security"), null);
  await untrustedProxiedRes.body?.cancel();

  // Trusted proxy with trustProxyHeaders: true
  const { fetch: trustedFetch } = setupTestApp(undefined, {}, { trustProxyHeaders: true });
  const trustedProxiedRes = await trustedFetch(
    new Request(`${HTTP_BASE}/health`, {
      headers: { "x-forwarded-proto": "https" },
    }),
  );
  assertEquals(
    trustedProxiedRes.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
  );
  await trustedProxiedRes.body?.cancel();

  // Plain HTTP request without TLS header: no HSTS
  const httpRes = await fetch(new Request(`${HTTP_BASE}/health`));
  assertEquals(httpRes.headers.get("strict-transport-security"), null);
  await httpRes.body?.cancel();
});

Deno.test("security headers: isHttpsRequest helper checks direct protocol and proxy header only when trusted", () => {
  assertEquals(isHttpsRequest(new Request("https://example.com/test")), true);
  assertEquals(isHttpsRequest(new Request("http://localhost:8000/test")), false);
  // Untrusted proxy header: false
  assertEquals(
    isHttpsRequest(
      new Request("http://localhost:8000/test", { headers: { "x-forwarded-proto": "https" } }),
    ),
    false,
  );
  // Trusted proxy header via boolean or config object
  assertEquals(
    isHttpsRequest(
      new Request("http://localhost:8000/test", { headers: { "x-forwarded-proto": "https" } }),
      true,
    ),
    true,
  );
  assertEquals(
    isHttpsRequest(
      new Request("http://localhost:8000/test", { headers: { "x-forwarded-proto": "https" } }),
      { trustProxyHeaders: true },
    ),
    true,
  );
  assertEquals(
    isHttpsRequest(
      new Request("http://localhost:8000/test", { headers: { "x-forwarded-proto": "http" } }),
      true,
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
  // /audio/ capability keys (audio-feed-0eae)
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/audio/secret-token-xyz.mp3?k=v#hash"),
    "https://audio.example.com/audio/[redacted]",
  );
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/audio/user-1/direct/ep-1.wav?debug=1"),
    "https://audio.example.com/audio/[redacted]",
  );
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/audio/audio/user-1/deepdive/ep-1.mp3"),
    "https://audio.example.com/audio/[redacted]",
  );
  // /listen and /audio landings without token are unchanged
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/listen"),
    "https://audio.example.com/listen",
  );
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/audio"),
    "https://audio.example.com/audio",
  );
  assertEquals(
    sanitizeRequestUrl("https://audio.example.com/audio/"),
    "https://audio.example.com/audio/",
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
  assertEquals(
    sanitizeRequestUrl("/audio/my-audio-tok.mp3?debug=1"),
    "/audio/[redacted]",
  );
  assertEquals(
    sanitizeRequestUrl("/audio/user-1/direct/ep-1.wav"),
    "/audio/[redacted]",
  );
  // unparseable fallback handles feed, listen, and audio
  assertEquals(
    sanitizeRequestUrl("http://[::1/audio/cap-key-123/track.mp3?leak=yes"),
    "http://[::1/audio/[redacted]",
  );
});

Deno.test("token redaction: sanitizeRequestUrl handles non-string inputs safely without throwing", () => {
  const nonStrings: unknown[] = [
    null,
    undefined,
    123,
    true,
    false,
    {},
    [],
    Symbol("test"),
  ];
  for (const input of nonStrings) {
    const res = sanitizeRequestUrl(input);
    assertEquals(typeof res, "string");
  }
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
      "/feed/:token/master.xml",
      "Log line must contain route pattern constant (audio-feed-067d)",
    );

    // Error object / stack must be preserved, with message screened to prevent client leaks (audio-feed-ahx5)
    assert(loggedException instanceof Error, "Logged second argument must be the Error object");
    assertEquals(
      (loggedException as Error).message,
      SUPPRESSED_MESSAGE,
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test("token redaction: 404 response body redacts capability tokens from URL path", async () => {
  const SECRET_FEED_TOKEN = "private-feed-token-987654321";
  const { fetch } = setupTestApp();

  const res = await fetch(new Request(`${BASE}/feed/${SECRET_FEED_TOKEN}/unknown-route`));
  assertEquals(res.status, 404);
  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert(
    !serialized.includes(SECRET_FEED_TOKEN),
    `404 body must not contain feed token: ${serialized}`,
  );
  assertStringIncludes(
    serialized,
    "/feed/[redacted]/unknown-route",
    "404 body detail must contain redacted pathname",
  );

  // 404 for /audio/:key on unknown route (audio-feed-0eae)
  const SECRET_AUDIO_TOKEN = "private-audio-token-123456789";
  const audioRes = await fetch(
    new Request(`${BASE}/service/audio/${SECRET_AUDIO_TOKEN}`),
  );
  assertEquals(audioRes.status, 404);
  const audioBody = await audioRes.json();
  const audioSerialized = JSON.stringify(audioBody);
  assert(
    !audioSerialized.includes(SECRET_AUDIO_TOKEN),
    `404 body must not contain audio capability token: ${audioSerialized}`,
  );
  assertStringIncludes(
    audioSerialized,
    "/audio/[redacted]",
    "404 body detail must contain redacted audio pathname",
  );
});

Deno.test("token redaction: Router 500 error logging redacts audio capability token and preserves error stack (audio-feed-0eae)", async () => {
  const SECRET_AUDIO_TOKEN = "user-1/direct/private-audio-token-987654321.mp3";
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  stores.blobs.get = () => {
    throw new Error("unexpected blob failure during audio fetch");
  };
  const { fetch } = setupTestApp(stores);

  const loggedErrors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    const res = await fetch(
      new Request(`${BASE}/audio/${SECRET_AUDIO_TOKEN}?subscriber=bob`),
    );
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "internal_error");

    assertEquals(loggedErrors.length, 1);
    const logLine = String(loggedErrors[0]?.[0]);
    const loggedException = loggedErrors[0]?.[1];

    // Capability token must NOT appear in the log line
    assert(
      !logLine.includes(SECRET_AUDIO_TOKEN),
      `Log line must not contain audio capability token: ${logLine}`,
    );
    assert(
      !logLine.includes("subscriber=bob"),
      `Log line must not contain query parameters: ${logLine}`,
    );
    assertStringIncludes(
      logLine,
      "/audio/:key+",
      "Log line must contain route pattern constant (audio-feed-067d)",
    );

    // Error object / stack must be preserved, with message screened to prevent client leaks (audio-feed-ahx5)
    assert(loggedException instanceof Error, "Logged second argument must be the Error object");
    assertEquals(
      (loggedException as Error).message,
      SUPPRESSED_MESSAGE,
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test("token redaction: Router 500 error logging screens client canaries across all fields in operational stderr (audio-feed-ahx5, audio-feed-067d)", async () => {
  const PATH_CANARY = "canary-path-segment-112233";
  const QUERY_CANARY = "canary-query-param-445566";
  const MSG_CANARY = "canary-error-message-778899";
  const NAME_CANARY = "canary-error-name-001122";
  const FN_CANARY = "canary-fn-name-334455";
  const LOC_CANARY = "canary-stack-loc-667788";

  const { fetch } = setupTestApp(undefined, {
    masterFeed: () => {
      // Error carrying canaries in message, custom name, dynamic stack frame, and stack location
      const err = new Error(`test throw: ${MSG_CANARY}`);
      err.name = `Custom_${NAME_CANARY}`;
      err.stack = `Custom_${NAME_CANARY}: test throw: ${MSG_CANARY}
        at Object.canaryDynamicFn_${FN_CANARY} (file:///app/${LOC_CANARY}/server.ts:10:2)`;
      const obj = {
        [`canaryDynamicFn_${FN_CANARY}`]() {
          throw err;
        },
      };
      obj[`canaryDynamicFn_${FN_CANARY}`]();
    },
  });

  const loggedErrors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    const res = await fetch(
      new Request(`${BASE}/feed/${PATH_CANARY}/master.xml?subscriber=${QUERY_CANARY}`),
    );
    assertEquals(res.status, 500);

    assertEquals(loggedErrors.length, 1);
    const logLine = String(loggedErrors[0]?.[0]);
    const loggedException = loggedErrors[0]?.[1];

    assert(loggedException instanceof Error);
    assertEquals((loggedException as Error).message, SUPPRESSED_MESSAGE);
    assertEquals((loggedException as Error).name, "Error");
    assertEquals(
      (loggedException as Error).stack,
      `Error: ${SUPPRESSED_MESSAGE}`,
    );

    // Assert that the logLine contains only the route pattern constant
    assertStringIncludes(logLine, "/feed/:token/master.xml");

    // Assert that NONE of the canaries reached stderr in either argument
    const combinedStderr = `${logLine} ${
      (loggedException as Error).stack ?? (loggedException as Error).message
    }`;
    assert(
      !combinedStderr.includes(PATH_CANARY),
      `PATH_CANARY leaked to stderr: ${combinedStderr}`,
    );
    assert(
      !combinedStderr.includes(QUERY_CANARY),
      `QUERY_CANARY leaked to stderr: ${combinedStderr}`,
    );
    assert(!combinedStderr.includes(MSG_CANARY), `MSG_CANARY leaked to stderr: ${combinedStderr}`);
    assert(
      !combinedStderr.includes(NAME_CANARY),
      `NAME_CANARY leaked to stderr: ${combinedStderr}`,
    );
    assert(!combinedStderr.includes(FN_CANARY), `FN_CANARY leaked to stderr: ${combinedStderr}`);
    assert(!combinedStderr.includes(LOC_CANARY), `LOC_CANARY leaked to stderr: ${combinedStderr}`);
  } finally {
    console.error = originalError;
  }
});

Deno.test("token redaction: Router 500 logs constant route pattern without arbitrary request path (audio-feed-067d)", async () => {
  const PATH_CANARY = "canary-probe-param-998877";
  const router = new Router();
  router.get("/probe/:name", () => {
    throw new Error("unhandled probe error");
  });

  const loggedErrors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    const handler = router.fetchHandler({});
    const res = await handler(new Request(`https://example.com/probe/${PATH_CANARY}`));
    assertEquals(res.status, 500);

    assertEquals(loggedErrors.length, 1);
    const logLine = String(loggedErrors[0]?.[0]);
    assertStringIncludes(logLine, "/probe/:name");
    assert(
      !logLine.includes(PATH_CANARY),
      `Operational stderr must not contain arbitrary request path segment: ${logLine}`,
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test("token redaction: audio route 404 logs redacted key on disallowed or unsafe key (audio-feed-0eae)", async () => {
  const SECRET_UNSAFE_KEY = "disallowed-secret-capability-key-998877";
  const { fetch } = setupTestApp();

  const loggedWarnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    loggedWarnings.push(args);
  };

  try {
    const res = await fetch(new Request(`${BASE}/audio/${SECRET_UNSAFE_KEY}`));
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "not_found");

    assertEquals(loggedWarnings.length, 1);
    const warnLine = String(loggedWarnings[0]?.[0]);

    // Unsafe / disallowed key must NOT be logged in cleartext
    assert(
      !warnLine.includes(SECRET_UNSAFE_KEY),
      `Warning line must not contain rawKey: ${warnLine}`,
    );
    assertStringIncludes(
      warnLine,
      'audio 404: disallowed or unsafe key "[redacted]"',
      "Warning line must redact the disallowed/unsafe key",
    );
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("token redaction: audio route storage-miss 404s (GET, HEAD, direct-url) redact valid capability keys (audio-feed-f9wf)", async () => {
  const VALID_MISSING_KEY = "user-secret-7/direct/never-existed.mp3";
  const { fetch } = setupTestApp();

  const loggedWarnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    loggedWarnings.push(args);
  };

  try {
    // 1. GET 404
    const getRes = await fetch(
      new Request(`${BASE}/audio/${VALID_MISSING_KEY}`, { headers: { Origin: BASE } }),
    );
    assertEquals(getRes.status, 404);
    const getWarn = loggedWarnings.map((w) => w.join(" ")).find((w) => w.includes("audio GET 404"));
    assert(getWarn, "audio GET 404 warning must be logged");
    assertStringIncludes(getWarn, 'key "[redacted]" not found in storage');
    assert(!getWarn.includes("user-secret-7") && !getWarn.includes("never-existed.mp3"));

    // 2. HEAD 404
    loggedWarnings.length = 0;
    const headRes = await fetch(
      new Request(`${BASE}/audio/${VALID_MISSING_KEY}`, {
        method: "HEAD",
        headers: { Origin: BASE },
      }),
    );
    assertEquals(headRes.status, 404);
    const headWarn = loggedWarnings.map((w) => w.join(" ")).find((w) =>
      w.includes("audio HEAD 404")
    );
    assert(headWarn, "audio HEAD 404 warning must be logged");
    assertStringIncludes(headWarn, 'key "[redacted]" not found');
    assert(!headWarn.includes("user-secret-7") && !headWarn.includes("never-existed.mp3"));

    // 3. direct-url 404
    loggedWarnings.length = 0;
    const directStore = memoryStores();
    directStore.blobs.url = (key) => Promise.resolve(`https://cdn.example.com/${key}`);
    directStore.blobs.head = () => Promise.resolve(null);
    const { fetch: directFetch } = setupTestApp(directStore);
    const directRes = await directFetch(new Request(`${BASE}/audio/${VALID_MISSING_KEY}`));
    assertEquals(directRes.status, 404);
    const directWarn = loggedWarnings.map((w) => w.join(" ")).find((w) =>
      w.includes("audio direct-url 404")
    );
    assert(directWarn, "audio direct-url 404 warning must be logged");
    assertStringIncludes(directWarn, 'key "[redacted]" not found');
    assert(!directWarn.includes("user-secret-7") && !directWarn.includes("never-existed.mp3"));
  } finally {
    console.warn = originalWarn;
  }
});

// ===========================================================================
// 3. audio-feed-5iue: Enforce prefix allowlist and user approval check on /audio/
// ===========================================================================

Deno.test("audio route: isAllowedAudioKey restricts to canonical audio/ and flat legacy keys, rejecting audio-segments/, voice-samples/, and arbitrary prefixes", () => {
  // Disallowed: intermediate synthesis segments
  assertEquals(isAllowedAudioKey("audio-segments/user-1/ep-1/hash.wav"), false);
  assertEquals(isAllowedAudioKey("audio-segments"), false);
  assertEquals(isAllowedAudioKey("audio/audio-segments/user-1/ep-1/hash.wav"), false);

  // Disallowed: voice samples
  assertEquals(isAllowedAudioKey("voice-samples/v1/Kore.wav"), false);
  assertEquals(isAllowedAudioKey("voice-samples/v1/Puck.wav"), false);
  assertEquals(isAllowedAudioKey("audio/voice-samples/v1/Kore.wav"), false);

  // Disallowed: arbitrary 3-segment or multi-segment prefixes
  assertEquals(isAllowedAudioKey("arbitrary-prefix/v1/sample.wav"), false);
  assertEquals(isAllowedAudioKey("arbitrary/prefix/foo.wav"), false);
  assertEquals(isAllowedAudioKey("internal-cache/temp/file.wav"), false);
  assertEquals(isAllowedAudioKey("tts-secrets/v1/secret.wav"), false);
  assertEquals(isAllowedAudioKey("Voice-Samples/direct/Kore.wav"), false);
  assertEquals(isAllowedAudioKey("Audio-Segments/user-1/direct/e1.wav"), false);

  // Disallowed: path traversal / unsafe keys / non-audio extensions
  assertEquals(isAllowedAudioKey("../secret.wav"), false);
  assertEquals(isAllowedAudioKey("/audio/foo.wav"), false);
  assertEquals(isAllowedAudioKey(""), false);
  assertEquals(isAllowedAudioKey("secret.json"), false);
  assertEquals(isAllowedAudioKey("internal-cache/file.wav"), false);

  // Allowed: canonical keys
  assertEquals(isAllowedAudioKey("audio/user-1/direct/ep-1.wav"), true);
  assertEquals(isAllowedAudioKey("audio/user-1/deepdive/ep-1.mp3"), true);
  assertEquals(isAllowedAudioKey("audio/u1/direct/e1.mp3"), true);
  assertEquals(isAllowedAudioKey("user-1/direct/ep-1.wav"), true); // route-trimmed canonical
  assertEquals(isAllowedAudioKey("u1/deepdive/e1.mp3"), true); // route-trimmed canonical

  // Disallowed: legacy flat keys (audio-feed-whsl: parts.length < 3 rejected to enforce user approval gating)
  assertEquals(isAllowedAudioKey("audio/ready.wav"), false);
  assertEquals(isAllowedAudioKey("legacy.wav"), false);
  assertEquals(isAllowedAudioKey("episode-1.mp3"), false);
});

Deno.test("audio route: candidate fan-out is capped per request (audio-feed-k21s0)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-approved", status: "approved" }));

  let getEpisodeCalls = 0;
  const origGetEpisode = stores.metadata.getEpisode.bind(stores.metadata);
  stores.metadata.getEpisode = (...args: Parameters<typeof origGetEpisode>) => {
    getEpisodeCalls++;
    return origGetEpisode(...args);
  };

  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  // 160 hyphen-separated parts, just under the 512-character isSafeBlobKey cap.
  const id = Array.from({ length: 160 }, () => "aa").join("-");
  const res = await fetch(new Request(`${BASE}/audio/user-approved/direct/${id}.wav`));
  assertEquals(res.status, 404);
  await res.body?.cancel();
  assertEquals(
    getEpisodeCalls <= MAX_FANOUT_CANDIDATES,
    true,
    `one request must cause at most ${MAX_FANOUT_CANDIDATES} candidate lookups, got ${getEpisodeCalls}`,
  );
});

Deno.test("audio route: unauthenticated requests are rate limited per client address (audio-feed-k21s0)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-approved", status: "approved" }));
  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  const addr = { remoteAddr: { hostname: "203.0.113.50" } };
  const key = "audio/user-approved/direct/ep-1.wav";

  // The bound holds: requests up to the limit are answered (404 here — the
  // object does not exist — the point is they are not 429).
  for (let i = 0; i < AUDIO_RATE_LIMIT.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/${key}`), addr);
    assertEquals(res.status, 404, `request ${i + 1} must be within the limit`);
    await res.body?.cancel();
  }

  // The next request from the same client is refused with the same shape as
  // the other rate-limited routes: 429, problem body, retry-after.
  const refused = await fetch(new Request(`${BASE}/${key}`), addr);
  assertEquals(refused.status, 429, "a request past the bound must be refused");
  const retryAfter = refused.headers.get("retry-after");
  assertEquals(retryAfter !== null && Number(retryAfter) >= 1, true, "429 must carry retry-after");
  const body = await refused.json();
  assertEquals(body.error, "too_many_requests");

  // A different client address has its own bucket.
  const other = await fetch(
    new Request(`${BASE}/${key}`),
    { remoteAddr: { hostname: "203.0.113.51" } },
  );
  assertEquals(other.status, 404, "a different client address must not share the exhausted bucket");
  await other.body?.cancel();
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

Deno.test("audio route: canonical audio is served for approved users; suspended/pending/rejected users get the identical 404 as a nonexistent object (audio-feed-7kdhb)", async () => {
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

  // Reference: the status, headers and body of a nonexistent object for the suspended user.
  const refRes = await fetch(new Request(`${BASE}/audio/user-suspended/direct/nonexistent.wav`));
  assertEquals(refRes.status, 404, "Nonexistent object must return 404");
  const refHeaders = [...refRes.headers.entries()].sort();
  const refBody = await refRes.text();

  // Suspended user: GET returns the identical 404 as a nonexistent object
  const suspRes = await fetch(new Request(`${BASE}/${suspendedKey}`));
  assertEquals(
    suspRes.status,
    404,
    "Suspended user audio must be indistinguishable from a nonexistent object",
  );
  assertEquals(
    [...suspRes.headers.entries()].sort(),
    refHeaders,
    "Suspended user audio headers must be identical to the nonexistent-object 404 headers",
  );
  assertEquals(
    await suspRes.text(),
    refBody,
    "Suspended user audio body must be identical to the nonexistent-object 404 body",
  );

  // Suspended user: HEAD returns 404
  const suspHead = await fetch(new Request(`${BASE}/${suspendedKey}`, { method: "HEAD" }));
  assertEquals(suspHead.status, 404, "Suspended user HEAD must return 404");
  await suspHead.body?.cancel();

  // Pending user: GET returns 404
  const pendRes = await fetch(new Request(`${BASE}/${pendingKey}`));
  assertEquals(pendRes.status, 404, "Pending user audio must return 404");
  assertEquals(await pendRes.text(), refBody);

  // Rejected user: GET returns 404
  const rejRes = await fetch(new Request(`${BASE}/${rejectedKey}`));
  assertEquals(rejRes.status, 404, "Rejected user audio must return 404");
  assertEquals(await rejRes.text(), refBody);
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

  // Non-CORS request for suspended user returns the same 404 as a nonexistent object, without redirecting
  const suspRes = await fetch(new Request(`${BASE}/${suspendedKey}`));
  assertEquals(
    suspRes.status,
    404,
    "Suspended user must get a 404 indistinguishable from a nonexistent object, not a 302 redirect",
  );
  assertEquals(suspRes.headers.get("location"), null);
  await suspRes.body?.cancel();
});

Deno.test("audio route: account-status oracle closed (nonexistent object returns 404 even for suspended user)", async () => {
  const stores = memoryStores();
  const suspendedUser = makeUser({ id: "user-suspended", status: "suspended" });
  await stores.metadata.putUser(suspendedUser);

  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  // Nonexistent object for suspended user must answer 404, NOT 403
  const res = await fetch(new Request(`${BASE}/audio/user-suspended/direct/nonexistent.wav`));
  assertEquals(res.status, 404, "Nonexistent object for suspended user must answer 404, not 403");
  await res.body?.cancel();

  const headRes = await fetch(
    new Request(`${BASE}/audio/user-suspended/direct/nonexistent.wav`, { method: "HEAD" }),
  );
  assertEquals(
    headRes.status,
    404,
    "HEAD on nonexistent object for suspended user must answer 404",
  );
  await headRes.body?.cancel();
});

Deno.test("audio route: voice-samples and legacy flat keys return 404, while approved user 200s (audio-feed-whsl)", async () => {
  const stores = memoryStores();

  const approvedUser = makeUser({ id: "user-approved", status: "approved" });
  await stores.metadata.putUser(approvedUser);

  const voiceSampleKey = "voice-samples/v1/Kore.wav";
  const approvedKey = "audio/user-approved/direct/ep-1.wav";
  const legacyWavKey = "legacy-episode.wav";
  const legacyMp3Key = "legacy-track.mp3";

  // Put objects in blob storage
  await stores.blobs.put(voiceSampleKey, bytes(500), { contentType: "audio/wav" });
  await stores.blobs.put(approvedKey, bytes(200), { contentType: "audio/wav" });
  await stores.blobs.put(legacyWavKey, bytes(300), { contentType: "audio/wav" });
  await stores.blobs.put(legacyMp3Key, bytes(400), { contentType: "audio/mpeg" });

  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  // 1. voice-samples bypass repro: MUST return 404 (not 200)
  const vsRes = await fetch(new Request(`${BASE}/audio/${voiceSampleKey}`));
  assertEquals(vsRes.status, 404, "voice-samples/ key must return 404");
  await vsRes.body?.cancel();

  // 1b. HEAD on voice-samples: MUST return 404
  const vsHead = await fetch(new Request(`${BASE}/audio/${voiceSampleKey}`, { method: "HEAD" }));
  assertEquals(vsHead.status, 404, "HEAD on voice-samples/ key must return 404");
  await vsHead.body?.cancel();

  // 2. Canonical approved-user key: returns 200
  const appRes = await fetch(new Request(`${BASE}/audio/user-approved/direct/ep-1.wav`));
  assertEquals(appRes.status, 200, "Canonical approved-user key must return 200");
  await appRes.body?.cancel();

  // 3. Legacy flat .wav: returns 404 (closed legacy approval bypass)
  const legWavRes = await fetch(new Request(`${BASE}/audio/${legacyWavKey}`));
  assertEquals(legWavRes.status, 404, "Legacy flat .wav must return 404");
  await legWavRes.body?.cancel();

  // 4. Legacy flat .mp3: returns 404 (closed legacy approval bypass)
  const legMp3Res = await fetch(new Request(`${BASE}/audio/${legacyMp3Key}`));
  assertEquals(legMp3Res.status, 404, "Legacy flat .mp3 must return 404");
  await legMp3Res.body?.cancel();

  // 5. On direct-URL store as well: voice-samples MUST return 404, not 302
  stores.blobs.url = (key: string) => Promise.resolve(`https://cdn.example.com/${key}`);
  const vsResDirect = await fetch(new Request(`${BASE}/audio/${voiceSampleKey}`));
  assertEquals(vsResDirect.status, 404, "voice-samples/ on direct-URL store must return 404");
  await vsResDirect.body?.cancel();
});

Deno.test("audio route: out-of-range Range checks user approval before returning 416 — unapproved users get the same 404 as a nonexistent object (no existence/size leak)", async () => {
  const stores = memoryStores();

  const approvedUser = makeUser({ id: "user-approved", status: "approved" });
  const suspendedUser = makeUser({ id: "user-suspended", status: "suspended" });
  await stores.metadata.putUser(approvedUser);
  await stores.metadata.putUser(suspendedUser);

  const approvedKey = "audio/user-approved/direct/ep-1.wav";
  const suspendedKey = "audio/user-suspended/direct/ep-2.wav";

  await stores.blobs.put(approvedKey, bytes(200), { contentType: "audio/wav" });
  await stores.blobs.put(suspendedKey, bytes(200), { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores, createHandlers({ config, stores }));

  // Out-of-range Range on suspended user must return the identical 404 as a nonexistent object (not 403, not 416), leaking neither existence nor size
  const suspRes = await fetch(
    new Request(`${BASE}/${suspendedKey}`, {
      headers: { range: "bytes=5000-6000" },
    }),
  );
  assertEquals(
    suspRes.status,
    404,
    "Out-of-range Range for suspended user must return 404 (audio-feed-7kdhb)",
  );
  assertEquals(suspRes.headers.get("content-range"), null, "Must not leak content-range header");
  const suspBody = await suspRes.json();
  assertEquals(suspBody.error, "not_found", "Must return the generic not-found shape");
  assertEquals(
    suspBody.detail,
    "Unknown audio object",
    "Must return the same body as a nonexistent object",
  );

  // Out-of-range Range on approved user returns 416 with content-range
  const appRes = await fetch(
    new Request(`${BASE}/${approvedKey}`, {
      headers: { range: "bytes=5000-6000" },
    }),
  );
  assertEquals(appRes.status, 416, "Out-of-range Range for approved user must return 416");
  assertEquals(appRes.headers.get("content-range"), "bytes */200");
  await appRes.body?.cancel();
});

Deno.test("cache control: authenticated and capability HTML routes set no-store (audio-feed-s3f0)", async () => {
  const stores = memoryStores();
  const user = makeUser({
    id: "user-test",
    isAdmin: true,
    status: "approved",
    feedToken: "feed-tok-test",
  });
  await stores.metadata.putUser(user);
  const cookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, user.id)}`;

  const { fetch } = setupTestApp(stores);

  // 1. /admin
  const adminRes = await fetch(
    new Request(`${BASE}/admin`, { headers: { cookie } }),
  );
  assertEquals(adminRes.status, 200);
  assertStringIncludes(adminRes.headers.get("cache-control") ?? "", "no-store");
  await adminRes.body?.cancel();

  // 2. /account
  const accountRes = await fetch(
    new Request(`${BASE}/account`, { headers: { cookie } }),
  );
  assertEquals(accountRes.status, 200);
  assertStringIncludes(accountRes.headers.get("cache-control") ?? "", "no-store");
  await accountRes.body?.cancel();

  // 3. /listen/:token (capability-bearing)
  const listenRes = await fetch(new Request(`${BASE}/listen/${user.feedToken}`));
  assertEquals(listenRes.status, 200);
  assertStringIncludes(listenRes.headers.get("cache-control") ?? "", "no-store");
  await listenRes.body?.cancel();

  // 4. /login
  const loginRes = await fetch(new Request(`${BASE}/login`));
  assertEquals(loginRes.status, 200);
  assertStringIncludes(loginRes.headers.get("cache-control") ?? "", "no-store");
  await loginRes.body?.cancel();
});

/**
 * csp.ts documents htmlResponse() as the single way an HTML response gets its
 * nonce-bearing policy, and router.ts's fallback comment repeats the claim.
 * The claim went stale once: four HTML routes hand-rolled the same 8-line
 * `new Response(html, { headers: { "content-security-policy": ... } })`
 * construction, and nothing noticed until a weekly review diffed the docs
 * against the code. This test is the thing that notices next time: any
 * content-security-policy header set outside csp.ts (the definition) and
 * router.ts (the strict fallbacks) fails the suite.
 */
Deno.test("no route hand-rolls a content-security-policy header outside csp.ts", async () => {
  const allowed = new Set([
    "src/routes/csp.ts", // the definition: htmlResponse + htmlContentSecurityPolicy
    "src/router.ts", // the strict no-nonce fallbacks for a route that forgot
  ]);
  const offenders: string[] = [];

  async function scan(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await scan(path);
      } else if (entry.name.endsWith(".ts")) {
        const text = await Deno.readTextFile(path);
        if (!allowed.has(path) && /["']content-security-policy["']/i.test(text)) {
          offenders.push(path);
        }
      }
    }
  }
  // The ENTRY read carries the literal root so the read-relation detector resolves this suite as a
  // whole-src/ scanner (audio-feed-sru1b): scan("src") crosses a parameter boundary the resolver provably
  // cannot see through, and a suite that scans all of src/ must be selected for ANY src/ change.
  for await (const entry of Deno.readDir("src")) {
    const path = `src/${entry.name}`;
    if (entry.isDirectory) {
      await scan(path);
    } else if (entry.name.endsWith(".ts")) {
      const text = await Deno.readTextFile(path);
      if (!allowed.has(path) && /["']content-security-policy["']/i.test(text)) {
        offenders.push(path);
      }
    }
  }

  assertEquals(
    offenders,
    [],
    "HTML routes must attach CSP via htmlResponse() (src/routes/csp.ts); " +
      "hand-rolled copies are exactly the drift this bead removed: " + offenders.join(", "),
  );
});
