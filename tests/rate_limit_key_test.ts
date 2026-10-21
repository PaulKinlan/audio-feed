/**
 * audio-feed-u2ve — a caller cannot choose the key their rate limit is kept under.
 *
 * THE BUG
 * `extractClientIp` read the FIRST entry of `x-forwarded-for` when TRUST_PROXY_HEADERS was on. Every
 * hop APPENDS the address it saw, so the first entry is whatever the caller sent: one forged header
 * per request meant one fresh bucket per request, and the per-client bound never applied. Measured
 * before the fix (scripts/repro_u2ve_rate_limit_ff.ts): 20 requests with a rotating forged prefix,
 * zero 429s, against a bound of 5. A second path had the same shape — `cf-connecting-ip` was checked
 * BEFORE the forwarded chain, so a forged single-value header won even when the trusted hop had
 * appended the real address.
 *
 * WHAT IS PINNED HERE
 * 1. The key is the address the last hop appended, so a forged prefix cannot change it or the bucket.
 * 2. Distinct real clients still get distinct buckets — a fix that collapsed everyone into one bucket
 *    would stop the bypass by breaking the limiter for honest callers too.
 * 3. Everything else about the trust model is unchanged: with the opt-in off, headers are ignored and
 *    the socket address wins; with the opt-in on but no header, the socket address wins too.
 * 4. Garbage cannot become an unbounded key (a key is a store row).
 */
import { assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import {
  extractClientIp,
  FailedAuthLimiter,
  SlidingWindowRateLimiter,
  UNADDRESSED_CLIENT_KEY,
} from "../src/auth/rate_limit.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const request = (xff?: string, cf?: string) =>
  new Request("http://localhost/api/request-access", {
    method: "POST",
    headers: {
      ...(xff === undefined ? {} : { "x-forwarded-for": xff }),
      ...(cf === undefined ? {} : { "cf-connecting-ip": cf }),
    },
  });

// -- 1. the key itself ------------------------------------------------------

Deno.test("the rate-limit key is the address the trusted hop appended, not the one the caller sent (audio-feed-u2ve)", () => {
  // The shape the header always has through a proxy: what the client sent, then what the hop saw.
  assertEquals(extractClientIp(request("10.0.0.1, 203.0.113.7"), true), "203.0.113.7");
  assertEquals(extractClientIp(request("10.0.0.1, 10.0.0.2, 203.0.113.7"), true), "203.0.113.7");

  // A proxy that REPLACES the header instead of appending leaves one entry: same answer, which is
  // why "last" was the safe rule without having to know which proxy is in front.
  assertEquals(extractClientIp(request("203.0.113.7"), true), "203.0.113.7");

  // Rotating the forged prefix cannot move the key — this is the whole finding.
  assertEquals(extractClientIp(request("10.0.0.9, 203.0.113.7"), true), "203.0.113.7");
  assertEquals(extractClientIp(request("192.168.1.1, 203.0.113.7"), true), "203.0.113.7");
});

Deno.test("a forged cf-connecting-ip no longer outranks the appended address (audio-feed-u2ve)", () => {
  // It used to be consulted first, so a caller who set it — and nothing upstream manages it on a
  // non-Cloudflare deployment — reset their bucket at will.
  assertEquals(extractClientIp(request("203.0.113.7", "1.2.3.4"), true), "203.0.113.7");
  // Behind Cloudflare, which overwrites it, it is still honoured when there is no chain.
  assertEquals(extractClientIp(request(undefined, "203.0.113.7"), true), "203.0.113.7");
});

Deno.test("with the proxy opt-in off, forwarded headers are ignored (audio-feed-u2ve)", () => {
  assertEquals(
    extractClientIp(request("10.0.0.1, 203.0.113.7", "1.2.3.4"), false, "127.0.0.1"),
    "127.0.0.1",
  );
});

Deno.test("without a forwarded address the socket address wins, and 'direct' is the last resort (audio-feed-u2ve)", () => {
  assertEquals(extractClientIp(request(), true, "127.0.0.1"), "127.0.0.1");
  assertEquals(extractClientIp(request("  ,  "), true, "127.0.0.1"), "127.0.0.1");
  assertEquals(extractClientIp(request(), true), "direct");
  assertEquals(extractClientIp(request("ignored"), false), "direct");
});

Deno.test("a key cannot be made unbounded by forging a long or prose value (audio-feed-u2ve, audio-feed-5vvw)", () => {
  // A key is a store row, so an unbounded key is an unbounded row count — and a rotating key is a
  // fresh bucket per request. Both apply to whichever header is used, not just the chain: bounding
  // only x-forwarded-for left the cf-connecting-ip fallback able to take any string (audio-feed-5vvw).
  const prose = "not-an-address ".repeat(20);
  assertEquals(extractClientIp(request(prose), true, "127.0.0.1"), "127.0.0.1");
  assertEquals(extractClientIp(request(`10.0.0.1, ${prose}`), true, "127.0.0.1"), "127.0.0.1");
  assertEquals(extractClientIp(request(undefined, prose), true, "127.0.0.1"), "127.0.0.1");
  assertEquals(
    extractClientIp(request(undefined, "x".repeat(200)), true, "127.0.0.1"),
    "127.0.0.1",
  );
  assertEquals(
    extractClientIp(request(undefined, "forged-001-...."), true, "127.0.0.1"),
    "127.0.0.1",
  );

  // A full IPv6 address plus a port still fits, in both headers: the rule must not reject real
  // addresses, or a real deployment would collapse into the socket address.
  const v6 = "[2001:0db8:85a3:0000:0000:8a2e:0370:7334]:65535";
  assertEquals(v6.length <= 64, true, "the length bound must not reject real addresses");
  assertEquals(extractClientIp(request(`10.0.0.1, ${v6}`), true), v6);
  assertEquals(extractClientIp(request(undefined, v6), true), v6);
});

Deno.test("the address corpus: every finding's malformed family falls back to the socket (audio-feed-u2ve, 5vvw, hzg1, jqmd)", () => {
  // One table, every family that has been found to rotate the key, each with the finding that found
  // it. This is the test the rule needed from the start: three hand-rolled versions of the check
  // each passed the cases their author thought of, and a corpus of the failures is what makes the
  // fourth attempt verifiable rather than merely plausible.
  const usable = [
    "203.0.113.7", // IPv4
    "203.0.113.7:8443", // IPv4 with a port (v4:port is unambiguous)
    "::1", // IPv6
    "2001:db8::1",
    "[2001:db8::1]:443", // IPv6 with a port (bracketed, the only unambiguous form)
    "::ffff:192.0.2.1", // IPv6 with a dotted-quad tail
    "1:2:3:4:5:6:7:8", // full eight groups
  ];
  for (const value of usable) {
    assertEquals(
      extractClientIp(request(undefined, value), true),
      value,
      `${value} must be usable`,
    );
  }

  const unusable = [
    // A key is a store row, so an unbounded value is an unbounded row count (5vvw).
    "x".repeat(200),
    "not-an-address ".repeat(20),
    // Not an address at all.
    "unknown",
    "",
    "direct",
    // Numerically not addresses.
    "999.0.113.7",
    "203.0.113",
    "203.0.113.7.9",
    "1.2.3.4,",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7:8:9:10",
    "0g:1:2:3:4:5:6:7",
    "12345::1",
    // audio-feed-hzg1: one hex group with a trailing colon, which the alphabet-only check read as an
    // address. A caller rotated `0:` .. `13:` for a bucket each.
    "0:",
    "13:",
    "abc:",
    "2001:db8:",
    ":1:2:3:4:5:6:7",
    "1:2:3",
    "2001:db8::1::2",
    ":::",
    "zz::1",
    "2001:db8::zzzz",
    // audio-feed-jqmd: a dotted-quad tail represents TWO groups, so seven written groups plus a quad
    // is nine, not eight. The structure check counted the quad as one and let this through.
    "1:2:3:4:5:6:7::192.0.2.1",
    "1:2:3:4:5:6:7:8::192.0.2.1",
    "::192.0.2.1:80",
    // A bare IPv6 whose last group could be read as a port: treating it as one let nine groups
    // through as eight-with-a-port, which is the same rotation by another route.
    "1:2:3:4:5:6:7:8:999",
    "999.0.113.7:80",
  ];
  for (const value of unusable) {
    assertEquals(
      extractClientIp(request(undefined, value), true, "127.0.0.1"),
      "127.0.0.1",
      `${JSON.stringify(value)} must fall through to the socket address rather than become a key`,
    );
  }
});

Deno.test("a rotating malformed value in either header cannot change the bucket (audio-feed-5vvw, hzg1, jqmd)", async () => {
  // The bucket-level version of the corpus: every family that rotates in practice, driven through
  // the real limiter. A key that changes per request is a fresh allowance per request, whatever the
  // value looks like, so each family is rotated the way the finding rotated it.
  const families = [
    (i: number) => `forged-${String(i).padStart(3, "0")}-${"x".repeat(200)}`,
    (i: number) => `${i.toString(16)}:`,
    (i: number) => `1:2:3:4:5:6:${i.toString(16)}::192.0.2.1`,
    (i: number) => `1:2:3:4:5:6:7:8:${i}`,
  ];
  for (const [index, forge] of families.entries()) {
    const { fetch } = app();
    const statuses: number[] = [];
    for (let i = 0; i < MAX_REQUESTS * 3; i++) {
      const response = await fetch(
        new Request("http://localhost/api/request-access", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": forge(i) },
          body: JSON.stringify({ email: `family-${index}-${i}@example.com`, reason: "probe" }),
        }),
        // A socket address: the per-client bound these assertions count on is
        // the addressed one; the unaddressed bucket has a deployment-sized
        // quota by design (audio-feed-0t8el).
        { remoteAddr: { hostname: "10.8.8.8" } },
      );
      statuses.push(response.status);
    }
    assertEquals(
      statuses.filter((s) => s === 429).length,
      MAX_REQUESTS * 3 - MAX_REQUESTS,
      `family ${index} rotated the key: ${statuses.filter((s) => s === 429).length} of ${
        MAX_REQUESTS * 3
      } were limited`,
    );
  }

  // And a well-formed address still gets its own allowance, locked out at the bound.
  const { fetch } = app();
  const honest: number[] = [];
  for (let i = 0; i < MAX_REQUESTS + 1; i++) {
    const response = await fetch(
      new Request("http://localhost/api/request-access", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ email: `wellformed-${i}@example.com`, reason: "probe" }),
      }),
    );
    honest.push(response.status);
  }
  assertEquals(honest[MAX_REQUESTS], 429, "a real address still creates one bucket and locks out");
});

// -- 2. the bucket ----------------------------------------------------------

const MAX_REQUESTS = 3;

function app(overrides: Partial<AppConfig> = {}) {
  const stores: Stores = memoryStores();
  const config: AppConfig = {
    port: 8000,
    publicBaseUrl: "http://localhost",
    trustProxyHeaders: true,
    ...overrides,
  };
  const ctx = { config, stores };
  const { fetch } = createApp(
    ctx,
    createHandlers(ctx, {
      requestAccess: { rateLimitConfig: { maxRequests: MAX_REQUESTS, windowMs: 60_000 } },
    }),
  );
  return { fetch };
}

async function post(
  fetch: (req: Request) => Promise<Response>,
  xff: string,
  i: number,
): Promise<number> {
  const response = await fetch(
    new Request("http://localhost/api/request-access", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": xff },
      body: JSON.stringify({ email: `key-probe-${i}@example.com`, reason: "probe" }),
    }),
  );
  return response.status;
}

Deno.test("a spoofed x-forwarded-for cannot change the bucket (audio-feed-u2ve)", async () => {
  const { fetch } = app();
  const statuses: number[] = [];
  for (let i = 0; i < MAX_REQUESTS * 3; i++) {
    // Every request forges a different prefix; the trusted hop appends the same real address.
    statuses.push(await post(fetch, `10.0.0.${i}, 203.0.113.7`, i));
  }

  assertEquals(
    statuses.filter((s) => s === 429).length,
    MAX_REQUESTS * 3 - MAX_REQUESTS,
    "rotating the header must not buy a second bucket: exactly the bound is allowed, then 429",
  );
  assertEquals(statuses.indexOf(429), MAX_REQUESTS, `bound is ${MAX_REQUESTS} then lockout`);
});

Deno.test("two real clients are still limited separately (audio-feed-u2ve)", async () => {
  const { fetch } = app();
  const first: number[] = [];
  for (let i = 0; i < MAX_REQUESTS + 1; i++) {
    first.push(await post(fetch, `10.0.0.1, 203.0.113.7`, i));
  }

  assertEquals(first[MAX_REQUESTS], 429, "the first client is locked out at its bound");
  assertEquals(
    await post(fetch, `10.0.0.1, 198.51.100.4`, 99),
    200,
    "a different client must not inherit another client's lockout — a fix that collapsed everyone into one bucket would pass the test above and fail this one",
  );
});

// -- 3. the unaddressed bucket (audio-feed-0t8el) ----------------------------

Deno.test("the unaddressed bucket is a dedicated row with its own quota, not a shared per-client-sized one (audio-feed-0t8el)", async () => {
  const stores = memoryStores();
  const limiter = new SlidingWindowRateLimiter(
    { maxRequests: 2, windowMs: 60_000 },
    stores.metadata,
    "test",
    { maxRequests: 4, windowMs: 60_000 },
  );

  // An addressed client is bound at the per-client quota.
  assertEquals((await limiter.check("10.1.2.3")).allowed, true);
  assertEquals((await limiter.check("10.1.2.3")).allowed, true);
  assertEquals((await limiter.check("10.1.2.3")).allowed, false, "addressed client locks at 2");

  // The unaddressed bucket is untouched by the addressed client's exhaustion,
  // and is bound at its own (larger) quota — bounded, not permissive.
  for (let i = 0; i < 4; i++) {
    assertEquals(
      (await limiter.check(UNADDRESSED_CLIENT_KEY)).allowed,
      true,
      `unaddressed attempt ${i + 1} within its quota`,
    );
  }
  assertEquals(
    (await limiter.check(UNADDRESSED_CLIENT_KEY)).allowed,
    false,
    "the unaddressed bucket still has a hard bound",
  );

  // And exhausting the unaddressed bucket does not touch addressed clients.
  assertEquals((await limiter.check("10.4.5.6")).allowed, true);
});

Deno.test("unaddressed clients no longer lock each other out at the per-client bound (audio-feed-0t8el)", async () => {
  const stores = memoryStores();
  // 2 failures per window for an addressed client; the derived unaddressed
  // quota is 2 x 25 = 50.
  const limiter = new FailedAuthLimiter(stores.metadata, { maxFailures: 2, windowMs: 60_000 });

  // Two DISTINCT unaddressed clients map to the same key by construction —
  // they cannot be told apart.
  const keyA = extractClientIp(request(), false, undefined);
  const keyB = extractClientIp(request(), false, undefined);
  assertEquals(keyA, UNADDRESSED_CLIENT_KEY);
  assertEquals(keyA, keyB);

  // Client A burns what used to be the shared per-client-sized window.
  await limiter.recordFailure(keyA);
  await limiter.recordFailure(keyA);

  // Before the fix, B — who never made a request — was locked out here.
  const lockedB = await limiter.isLockedOut(keyB);
  assertEquals(
    lockedB.allowed,
    true,
    "an unaddressed client must not inherit the per-client lockout",
  );

  // The unaddressed bucket is still bounded: the deployment-wide quota holds.
  let last;
  for (let i = 0; i < 48; i++) last = await limiter.recordFailure(keyA);
  assertEquals(last!.allowed, true, "attempt 50 is within the derived unaddressed quota");
  assertEquals(
    (await limiter.recordFailure(keyA)).allowed,
    false,
    "attempt 51 exceeds the derived unaddressed quota",
  );

  // An addressed client's own tight bound is unaffected by the unaddressed window.
  assertEquals((await limiter.recordFailure("10.7.7.7")).allowed, true);
  assertEquals((await limiter.recordFailure("10.7.7.7")).allowed, true);
  assertEquals(
    (await limiter.recordFailure("10.7.7.7")).allowed,
    false,
    "addressed clients keep the per-client bound",
  );
});
