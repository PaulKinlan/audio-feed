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

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  authenticationOptions,
  finishAuthentication,
  isPublicSuffix,
  PasskeyError,
  registrationOptions,
  relyingParty,
} from "../src/auth/passkeys.ts";
import { base64url } from "../src/auth/sessions.ts";
import { makeUser } from "./fixtures.ts";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
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

// ---------------------------------------------------------------------------
// User verification is required (audio-feed-9ho7)
//
// A passkey is the normal admin sign-in path, so possession of a credential whose
// authenticator never verified the human must not mint a session. `preferred`
// allowed registering one; `requireUserVerification: false` accepted its
// assertions. Both ends are asserted here: the options the browser is handed,
// and the verifier's actual answer to a UV-clear assertion.
// ---------------------------------------------------------------------------

/** base64url -> bytes, for building a COSE key the test can also sign with. */
function b64urlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * A P-256 COSE_Key (RFC 9052): map(5){1:2, 3:-7, -1:1, -2:x, -3:y}, which is the
 * shape `PasskeyCredential.publicKey` stores. Hand-encoded because the test needs
 * a key it can actually sign with and the library only ever consumes it.
 */
function coseP256(x: Uint8Array, y: Uint8Array): Uint8Array {
  return Uint8Array.from([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    0x20,
    ...x,
    0x22,
    0x58,
    0x20,
    ...y,
  ]);
}

/** WebCrypto ECDSA returns raw r||s; a WebAuthn signature is DER-encoded. */
function toDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array): number[] => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const body = [...bytes.slice(i)];
    if ((body[0] ?? 0) & 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

Deno.test("passkey options require user verification (audio-feed-9ho7)", async () => {
  const store = memoryStores().metadata;
  const rp = relyingParty(BASE);
  const user = makeUser({ id: "user-uv", status: "approved" });
  await store.putUser(user);

  const registration = await registrationOptions(store, rp, user);
  assertEquals(
    registration.authenticatorSelection?.userVerification,
    "required",
    "registration must ask the authenticator to verify the human",
  );
  // Discoverable is what makes the account-less sign-in flow work; UV must not
  // have been traded away for it.
  assertEquals(registration.authenticatorSelection?.residentKey, "required");

  const authentication = await authenticationOptions(store, rp);
  assertEquals(
    authentication.userVerification,
    "required",
    "authentication must ask the authenticator to verify the human",
  );
});

Deno.test("a UV-clear assertion is refused; the same assertion with UV signs in (audio-feed-9ho7)", async () => {
  const store = memoryStores().metadata;
  const rp = relyingParty(BASE);
  const user = makeUser({ id: "user-uv", status: "approved" });
  await store.putUser(user);

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  await store.putCredential({
    id: "cred-uv",
    userId: user.id,
    publicKey: base64url(coseP256(b64urlToBytes(jwk.x!), b64urlToBytes(jwk.y!))),
    counter: 0,
    name: "UV test",
    createdAt: "2026-10-08T00:00:00.000Z",
  });

  /**
   * A genuinely signed assertion (real P-256 signature over
   * authenticatorData||SHA-256(clientDataJSON)) whose ONLY variable is the UV
   * flag. If the verifier refused it for any other reason, the UV-set twin below
   * could not succeed — so the pair isolates `requireUserVerification`.
   */
  const assertion = async (userVerified: boolean): Promise<AuthenticationResponseJSON> => {
    const options = await authenticationOptions(store, rp);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: "webauthn.get",
      challenge: options.challenge,
      origin: rp.origin,
      crossOrigin: false,
    }));
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rp.rpID))),
      0,
    );
    // UP (0x01) is always present; UV (0x04) is the bit under test.
    authenticatorData[32] = userVerified ? 0x05 : 0x01;
    const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        Uint8Array.from([...authenticatorData, ...clientDataHash]),
      ),
    );
    return {
      id: "cred-uv",
      rawId: "cred-uv",
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDataJSON),
        authenticatorData: base64url(authenticatorData),
        signature: base64url(toDer(signature)),
      },
    };
  };

  await assertRejects(
    async () => finishAuthentication(store, rp, await assertion(false)),
    PasskeyError,
    "could not be verified",
  );

  const signedIn = await finishAuthentication(store, rp, await assertion(true));
  assertEquals(signedIn.id, user.id, "with UV the identical assertion is accepted");
});
