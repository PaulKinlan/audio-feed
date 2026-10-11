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
import { extractClientIp } from "../src/auth/rate_limit.ts";
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

Deno.test("formed addresses are accepted, and near-misses are not (audio-feed-u2ve)", () => {
  const usable = [
    "203.0.113.7",
    "203.0.113.7:8443",
    "::1",
    "2001:db8::1",
    "[2001:db8::1]:443",
    "::ffff:192.0.2.1",
  ];
  for (const value of usable) {
    assertEquals(
      extractClientIp(request(undefined, value), true),
      value,
      `${value} must be usable`,
    );
  }
  const unusable = [
    "999.0.113.7",
    "203.0.113",
    "203.0.113.7.9",
    "unknown",
    "",
    "1.2.3.4,",
    "2001:db8::1::2",
  ];
  for (const value of unusable) {
    assertEquals(
      extractClientIp(request(undefined, value), true, "127.0.0.1"),
      "127.0.0.1",
      `${JSON.stringify(value)} must fall through to the socket address rather than become a key`,
    );
  }
});

Deno.test("a rotating forged cf-connecting-ip cannot change the bucket (audio-feed-5vvw)", async () => {
  // The reviewer's reproducer: with no forwarded chain, a rotated fallback header bought a bucket
  // per request. The limiter is real; only the client identity is under test.
  const { fetch } = app();
  const statuses: number[] = [];
  for (let i = 0; i < MAX_REQUESTS * 3; i++) {
    const response = await fetch(
      new Request("http://localhost/api/request-access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `forged-${String(i).padStart(3, "0")}-${"x".repeat(200)}`,
        },
        body: JSON.stringify({ email: `cf-${i}@example.com`, reason: "probe" }),
      }),
    );
    statuses.push(response.status);
  }
  assertEquals(
    statuses.filter((s) => s === 429).length,
    MAX_REQUESTS * 3 - MAX_REQUESTS,
    "a rotating fallback header must not buy a second bucket",
  );

  // And a well-formed one is still honoured, so a deployment whose proxy manages it is unchanged.
  const honest: number[] = [];
  for (let i = 0; i < MAX_REQUESTS + 1; i++) {
    const response = await fetch(
      new Request("http://localhost/api/request-access", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ email: `honest-${i}@example.com`, reason: "probe" }),
      }),
    );
    honest.push(response.status);
  }
  assertEquals(honest[MAX_REQUESTS], 429, "a real cf-connecting-ip still creates one bucket");
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
