/**
 * Tests for WebAuthn RP ID scoping, clash protection, and Related Origin Requests (audio-feed-1o2).
 *
 * Verifies:
 * - Default RP ID is strictly pinned to exact hostname, preventing cross-app clashes on shared domains
 * - Refusal of Public Suffixes / eTLDs (deno.net, pages.dev, github.io, com) as RP IDs
 * - Acceptance of localhost and valid registrable domain suffixes
 * - Support for explicit WEBAUTHN_RP_ID configuration
 * - GET /.well-known/webauthn serves valid ROR JSON with origins list and public cache headers
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isPublicSuffix, PasskeyError, relyingParty } from "../src/auth/passkeys.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";

const BASE = "https://audio-feed.paulkinlan-ea.deno.net";

Deno.test("isPublicSuffix: identifies cloud platform eTLDs and ccTLD suffixes (audio-feed-1o2)", () => {
  const suffixes = [
    "deno.net",
    "deno.dev",
    "pages.dev",
    "workers.dev",
    "github.io",
    "gitlab.io",
    "vercel.app",
    "netlify.app",
    "fly.dev",
    "com",
    "org",
    "net",
    "co.uk",
    "com.au",
  ];
  for (const s of suffixes) {
    assertEquals(isPublicSuffix(s), true, `${s} must be recognized as a public suffix`);
    assertEquals(
      isPublicSuffix(`.${s}.`),
      true,
      `.${s}. must normalize and be recognized as a public suffix`,
    );
  }

  const validDomains = [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "::1",
    "audio-feed.paulkinlan-ea.deno.net",
    "paulkinlan.com",
    "audio.example.co.uk",
  ];
  for (const d of validDomains) {
    assertEquals(isPublicSuffix(d), false, `${d} must not be a public suffix`);
  }
});

Deno.test("relyingParty: default RP ID strictly scopes to exact origin hostname (audio-feed-1o2)", () => {
  // Pinned to exact service hostname to prevent cross-app passkey clashes across *.paulkinlan-ea.deno.net
  const rp = relyingParty("https://audio-feed.paulkinlan-ea.deno.net");
  assertEquals(rp.origin, "https://audio-feed.paulkinlan-ea.deno.net");
  assertEquals(rp.rpID, "audio-feed.paulkinlan-ea.deno.net");

  // Localhost allowed for development
  const local = relyingParty("http://localhost:8000");
  assertEquals(local.origin, "http://localhost:8000");
  assertEquals(local.rpID, "localhost");
});

Deno.test("relyingParty: refuses Public Suffix as RP ID without subdomain (audio-feed-1o2)", () => {
  for (const url of ["https://deno.net", "https://pages.dev", "https://github.io"]) {
    try {
      relyingParty(url);
      assert(false, `Expected ${url} to be refused as public suffix`);
    } catch (err) {
      assert(err instanceof PasskeyError);
      assertEquals(err.status, 400);
      assertStringIncludes(err.message, "cannot be a public suffix");
    }
  }
});

Deno.test("relyingParty: supports valid configuredRpId (audio-feed-1o2)", () => {
  // Valid parent domain suffix for custom domain setup
  const rp = relyingParty("https://audio-feed.paulkinlan.com", "paulkinlan.com");
  assertEquals(rp.origin, "https://audio-feed.paulkinlan.com");
  assertEquals(rp.rpID, "paulkinlan.com");

  // Exact host configured is also valid
  const exact = relyingParty(
    "https://audio-feed.paulkinlan.com",
    "audio-feed.paulkinlan.com",
  );
  assertEquals(exact.rpID, "audio-feed.paulkinlan.com");
});

Deno.test("relyingParty: refuses configuredRpId when public suffix or not a domain suffix (audio-feed-1o2)", () => {
  // Cannot configure public suffix
  try {
    relyingParty("https://audio-feed.paulkinlan-ea.deno.net", "deno.net");
    assert(false, "Expected deno.net to be rejected as public suffix");
  } catch (err) {
    assert(err instanceof PasskeyError);
    assertStringIncludes(err.message, "cannot be a public suffix");
  }

  // Cannot configure unrelated domain
  try {
    relyingParty("https://audio-feed.paulkinlan.com", "otherdomain.com");
    assert(false, "Expected otherdomain.com to be rejected as non-suffix");
  } catch (err) {
    assert(err instanceof PasskeyError);
    assertStringIncludes(err.message, "not a valid suffix of origin host");
  }
});

Deno.test("GET /.well-known/webauthn: serves ROR JSON origins list (audio-feed-1o2)", async () => {
  const config: AppConfig = {
    port: 8080,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
    webAuthnRelatedOrigins: [
      "https://audio.paulkinlan.com",
      "https://audio-feed-preview.deno.dev",
    ],
  };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const res = await fetch(new Request(`${BASE}/.well-known/webauthn`));
  assertEquals(res.status, 200);
  assertStringIncludes(String(res.headers.get("content-type")), "application/json");
  assertStringIncludes(String(res.headers.get("cache-control")), "public");

  const data = await res.json() as { origins: string[] };
  assert(Array.isArray(data.origins));
  assertEquals(data.origins.includes(BASE), true);
  assertEquals(data.origins.includes("https://audio.paulkinlan.com"), true);
  assertEquals(data.origins.includes("https://audio-feed-preview.deno.dev"), true);
});

Deno.test("GET /.well-known/webauthn: unconfigured returns empty origins with no-store (audio-feed-1o2)", async () => {
  const config: AppConfig = {
    port: 8080,
    adminToken: "admin-secret",
  };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const res = await fetch(new Request("http://localhost:8080/.well-known/webauthn"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  const data = await res.json() as { origins: string[] };
  assertEquals(data.origins, []);
});

Deno.test("GET /.well-known/webauthn: behaviourally immune to Host header poisoning with byte-identical responses (audio-feed-1o2)", async () => {
  // publicBaseUrl UNSET (where the Host header fallback path lived)
  const config: AppConfig = {
    port: 8080,
    adminToken: "admin-secret",
  };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  // Request 1 with Host: victim.com
  const res1 = await fetch(
    new Request("https://victim.com/.well-known/webauthn", {
      headers: { host: "victim.com" },
    }),
  );
  const body1 = await res1.text();

  // Request 2 with Host: attacker-evil.com
  const res2 = await fetch(
    new Request("https://attacker-evil.com/.well-known/webauthn", {
      headers: { host: "attacker-evil.com" },
    }),
  );
  const body2 = await res2.text();

  // Both responses are byte-identical and equal to {"origins":[]}, ignoring any client Host header
  assertEquals(body1, body2);
  assertEquals(res1.headers.get("cache-control"), "no-store");
  assertEquals(res2.headers.get("cache-control"), "no-store");
  assertEquals(JSON.parse(body1), { origins: [] });
  assertEquals(JSON.parse(body2), { origins: [] });
});
