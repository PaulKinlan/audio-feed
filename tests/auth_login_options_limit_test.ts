/**
 * audio-feed-plmhk, audio-feed-xohf6 — the anonymous challenge write on `POST /api/auth/login/options`
 * is rate-limited BEFORE the store write, per client address.
 *
 * The defect this pins: `loginOptions` is unauthenticated by design (it is how a stranger
 * starts signing in), and every request writes a KV challenge row (`authenticationOptions` ->
 * `putChallenge`, TTL 5 minutes). Nothing bounded how often one client could do that, so a
 * direct caller — the Origin wall refuses browser CSRF, not a non-browser client, which can
 * send any Origin it likes — could spend KV write capacity at line rate.
 *
 * Four rows, each a different guarantee:
 *  1. N+1 rapid requests from one address are refused, with a 429 that carries a retry-after.
 *  2. The sign-in ceremony still works from that same address: options mint a challenge and the
 *     verify route consumes it.
 *  3. The limit is per ADDRESS, not per anything an anonymous caller could rotate — a second
 *     address is unaffected by the first one exhausting its window.
 *  4. The limiter runs BEFORE the challenge write: refused requests write no challenge rows (audio-feed-xohf6).
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { makeUser } from "./fixtures.ts";
import { LOGIN_OPTIONS_RATE } from "../src/routes/account_api.ts";
import type { MetadataStore } from "../src/storage/mod.ts";
import type { AuthChallenge } from "../src/types.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

/** One client address, so every request below shares one bucket (the abuse case). */
const CLIENT = { remoteAddr: { hostname: "198.51.100.9" } };
const OTHER_CLIENT = { remoteAddr: { hostname: "198.51.100.10" } };

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  return createApp(ctx, createHandlers(ctx));
}

function optionsRequest(): Request {
  return new Request(`${BASE}/api/auth/login/options`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    body: "{}",
  });
}

function clientData(type: string, challenge: string): string {
  const json = JSON.stringify({ type, challenge, origin: BASE });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.test("login options: N+1 rapid anonymous requests are refused (audio-feed-plmhk)", async () => {
  const { fetch } = app(memoryStores());

  for (let i = 0; i < LOGIN_OPTIONS_RATE.maxRequests; i++) {
    const res = await fetch(optionsRequest(), CLIENT);
    assertEquals(res.status, 200, `request ${i + 1} must be within the bound`);
    const options = await res.json();
    assert(typeof options.challenge === "string" && options.challenge.length > 20);
  }

  const refused = await fetch(optionsRequest(), CLIENT);
  assertEquals(refused.status, 429, "a request past the bound must be refused");
  const retryAfter = refused.headers.get("retry-after");
  assert(
    retryAfter !== null && Number(retryAfter) >= 1,
    "429 must carry a retry-after of at least one second",
  );
  const refusal = await refused.json();
  assert(
    typeof refusal.error === "string" && refusal.error.length > 0,
    "the refusal must carry an error message the sign-in page can show",
  );

  // Per ADDRESS: the bound follows the client, so a different address is not collateral
  // damage from one hammer.
  const elsewhere = await fetch(optionsRequest(), OTHER_CLIENT);
  assertEquals(elsewhere.status, 200, "another address is unaffected by this one's window");
});

Deno.test("login: the ceremony still works from an address inside its window (audio-feed-plmhk)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", email: "reader@example.com" }));
  const { fetch } = app(stores);

  // Two attempts' worth: a person closes the biometric prompt once, then tries again.
  const first = await fetch(optionsRequest(), CLIENT);
  assertEquals(first.status, 200);
  await first.body?.cancel();

  const res = await fetch(optionsRequest(), CLIENT);
  assertEquals(res.status, 200);
  const options = await res.json();
  assert(typeof options.challenge === "string" && options.challenge.length > 20);
  assertEquals(options.rpId, "audio.example.com", "the real options payload is unchanged");

  // The verify route consumes that challenge. An unknown credential is a 404 — the point here
  // is that the challenge EXISTS and is spent by the attempt, which is the whole ceremony.
  const verify = await fetch(
    new Request(`${BASE}/api/auth/login/verify`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({
        id: "unknown-credential",
        rawId: "unknown-credential",
        type: "public-key",
        response: { clientDataJSON: clientData("webauthn.get", options.challenge) },
      }),
    }),
    CLIENT,
  );
  assertEquals(verify.status, 404, "an unregistered credential is refused after the challenge");
  assertEquals(verify.headers.get("set-cookie"), null);
  assertEquals(
    await stores.metadata.consumeChallenge(options.challenge),
    null,
    "the challenge was created by options and consumed by verify",
  );
});

/**
 * Counts challenge writes through `MetadataStore.putChallenge` — the mutation a refusal
 * must not perform. The limiter's own sliding window state (`atomicUpdate`) is deliberately
 * not counted: it is the bound, not the work being bounded (audio-feed-xohf6).
 */
function countingChallenges(store: MetadataStore): {
  store: MetadataStore;
  writes: () => number;
  challenges: () => AuthChallenge[];
} {
  const challenges: AuthChallenge[] = [];
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "putChallenge") {
        return (challenge: AuthChallenge, ...rest: unknown[]) => {
          challenges.push(structuredClone(challenge));
          return (value as (...a: unknown[]) => unknown).call(target, challenge, ...rest);
        };
      }
      return value.bind(target);
    },
  });
  return {
    store: wrapped,
    writes: () => challenges.length,
    challenges: () => [...challenges],
  };
}

Deno.test("login options: the limiter runs BEFORE the challenge write: refused requests write no challenge rows (audio-feed-xohf6)", async () => {
  const inner = memoryStores();
  const { store, writes, challenges } = countingChallenges(inner.metadata);
  const { fetch } = app({ ...inner, metadata: store });

  const admittedChallenges: string[] = [];
  for (let i = 0; i < LOGIN_OPTIONS_RATE.maxRequests; i++) {
    const res = await fetch(optionsRequest(), CLIENT);
    assertEquals(res.status, 200, `request ${i + 1} must be within the bound`);
    const options = await res.json();
    assert(typeof options.challenge === "string" && options.challenge.length > 20);
    admittedChallenges.push(options.challenge);
  }

  const writesBeforeRefusal = writes();
  assertEquals(
    writesBeforeRefusal,
    LOGIN_OPTIONS_RATE.maxRequests,
    "every admitted options request writes exactly one challenge row",
  );
  assertEquals(
    challenges().map((c) => c.challenge),
    admittedChallenges,
    "the recorded challenge writes match the admitted response options",
  );

  // Drive past the limit: refused requests must NOT invoke putChallenge or allocate a challenge.
  const REFUSED_ATTEMPTS = 5;
  for (let i = 0; i < REFUSED_ATTEMPTS; i++) {
    const refused = await fetch(optionsRequest(), CLIENT);
    assertEquals(
      refused.status,
      429,
      `refused request ${i + 1} must be rejected with 429`,
    );
    await refused.body?.cancel();
  }

  assertEquals(
    writes(),
    writesBeforeRefusal,
    "refused requests must not write challenge rows: limiter must run BEFORE putChallenge",
  );
  assertEquals(
    challenges().length,
    writesBeforeRefusal,
    "no challenge records were allocated for refused requests",
  );

  // A different address is inside its window: it gets admitted and writes exactly one challenge.
  const elsewhere = await fetch(optionsRequest(), OTHER_CLIENT);
  assertEquals(elsewhere.status, 200);
  const elsewhereOptions = await elsewhere.json();
  assertEquals(
    writes(),
    writesBeforeRefusal + 1,
    "an admitted request from another address performs its challenge write",
  );
  assertEquals(
    challenges().at(-1)?.challenge,
    elsewhereOptions.challenge,
  );

  // All admitted challenges were written to the real store and can be consumed.
  for (const c of [...admittedChallenges, elsewhereOptions.challenge]) {
    const consumed = await inner.metadata.consumeChallenge(c);
    assert(consumed !== null, "the admitted challenge must exist in store");
  }
});
