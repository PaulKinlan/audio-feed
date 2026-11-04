/**
 * audio-feed-81v7j — the JSON body on the passkey routes is capped BEFORE any credential check.
 *
 * The defect this pins: `body()` read `await req.json()` with no size cap, and the public
 * handlers (`loginVerify`, `registerOptions`) parse a body before they check anything, so a
 * stranger could make the isolate buffer an arbitrarily large body per request. The Origin wall
 * refuses browser CSRF, not a direct caller.
 *
 * The cap reuses the cwv.ts pattern (audio-feed-6q9g) rather than inventing one: a declared
 * `content-length` over the cap is refused without touching the body, and the read itself is
 * bounded by `limitBodyStream`, so a chunked body that declares nothing is truncated before the
 * handler accumulates it.
 *
 * Three rows, each a different guarantee:
 *  1. A body whose declared content-length is over the cap is refused 413.
 *  2. A streamed body that declares nothing but exceeds the cap is refused 413 (the read bound,
 *     not the header check).
 *  3. A normal body behaves exactly as before — the refusal changes nothing for a real request.
 */
import { assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { MAX_ACCOUNT_BODY_BYTES } from "../src/routes/account_api.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  return createApp(ctx, createHandlers(ctx));
}

/** A syntactically valid JSON object that is comfortably past the cap. */
function oversizedBody(): string {
  return JSON.stringify({ padding: "x".repeat(MAX_ACCOUNT_BODY_BYTES) });
}

/** A JSON body of `bytes` bytes, streamed so it declares NO content-length. */
function streamedBody(bytes: number): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(oversizedBody());
  const padded = new Uint8Array(bytes);
  padded.set(encoded.subarray(0, Math.min(encoded.length, bytes)));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(padded);
      controller.close();
    },
  });
}

function loginVerify(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/api/auth/login/verify`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json", ...headers },
    body,
  });
}

Deno.test("login verify: a declared content-length over the cap is refused 413 (audio-feed-81v7j)", async () => {
  const { fetch } = app(memoryStores());
  const res = await fetch(loginVerify(oversizedBody()));
  assertEquals(res.status, 413, "an oversized body must be refused before it is parsed");
  const refusal = await res.json();
  assertEquals(typeof refusal.error, "string");
});

Deno.test("login verify: a streamed body over the cap is refused 413 (audio-feed-81v7j)", async () => {
  const { fetch } = app(memoryStores());
  const res = await fetch(loginVerify(streamedBody(MAX_ACCOUNT_BODY_BYTES * 4)));
  assertEquals(res.status, 413, "the read itself is bounded, not just the header");
});

Deno.test("register options: an oversized body is refused 413 too (audio-feed-81v7j)", async () => {
  const { fetch } = app(memoryStores());
  const res = await fetch(
    new Request(`${BASE}/api/auth/register/options`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: oversizedBody(),
    }),
  );
  assertEquals(res.status, 413);
});

Deno.test("login verify: a normal body behaves exactly as before (audio-feed-81v7j)", async () => {
  const { fetch } = app(memoryStores());

  // A normal-sized body still reaches the handler: the unknown-challenge refusal, not a 413.
  const normal = await fetch(
    loginVerify(JSON.stringify({ id: "unknown", rawId: "unknown", type: "public-key" })),
  );
  assertEquals(normal.status, 400, "a normal body is parsed and refused on its merits");

  // A body just under the cap is accepted by the read as well — the bound is the cap, not a
  // smaller number that would refuse real registration attestations.
  const nearCap = JSON.stringify({ padding: "x".repeat(MAX_ACCOUNT_BODY_BYTES - 100) });
  const under = await fetch(loginVerify(nearCap));
  assertEquals(under.status, 400, "a body under the cap is parsed, not refused for its size");

  // No content-type: `body()` has always answered {} rather than refusing, and still does.
  const ignored = await fetch(
    new Request(`${BASE}/api/auth/login/verify`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "text/plain" },
      body: "not json",
    }),
  );
  assertEquals(ignored.status, 400, "a non-JSON body is unchanged: {} reaches the handler");
});
