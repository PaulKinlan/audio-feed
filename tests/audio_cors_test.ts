/**
 * The audio route's CORS contract (production bug, found by Paul 2026-09-25).
 *
 * WHAT BROKE, measured against the live deployment before any code changed:
 *
 *   GET  <r2 presigned URL>  with Origin: <app>  -> 200, audio/wav, 16111024 bytes
 *                                                   and NO access-control-allow-origin
 *   OPTIONS <r2 presigned URL> with Origin: <app> -> 403
 *
 * The audio route 302s to R2 to keep bytes out of the isolate (audio-feed-vnb).
 * R2's S3 endpoint answers no CORS, so a browser that followed that redirect
 * received a perfectly good 200 it was not permitted to read. The player's
 * `<audio crossorigin="anonymous">` forced the media load into CORS mode, and the
 * service worker's `fetch()` is CORS by nature, so both paths blocked.
 *
 * The fix is a fork, not a removal: a request the browser will apply CORS rules
 * to is served from the isolate with the headers that make it readable; a podcast
 * client, which sends no Origin and is not subject to CORS at all, still gets the
 * redirect. These tests pin BOTH sides, because deleting the redirect would have
 * been the easy fix and would have quietly undone audio-feed-vnb.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { isCorsConstrained } from "../src/routes/audio.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { BlobObject } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const KEY = "audio/user-1/direct/ep-1.wav";

/** A store that hands out direct URLs for every key — i.e. S3/R2 in production. */
function redirectingStore(inner: Stores["blobs"]): Stores["blobs"] {
  return {
    put: (key, body, opts) => inner.put(key, body, opts),
    head: (key) => inner.head(key),
    delete: (key) => inner.delete(key),
    get: (key, opts): Promise<BlobObject | null> => inner.get(key, opts),
    url: (key) => Promise.resolve(`https://r2.example.com/${key}?X-Amz-Signature=abc`),
  };
}

async function app(blobs?: (inner: Stores["blobs"]) => Stores["blobs"]) {
  const stores: Stores = memoryStores();
  await stores.blobs.put(KEY, BYTES, { contentType: "audio/wav" });
  if (blobs) stores.blobs = blobs(stores.blobs);
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores };
}

const audio = (headers: Record<string, string> = {}, method = "GET") =>
  new Request(`${BASE}/audio/${KEY}`, { method, headers });

// -- which requests are CORS-constrained ----------------------------------

Deno.test("a request carrying Origin is CORS-constrained (audio-feed-cors)", () => {
  assertEquals(isCorsConstrained(audio({ origin: BASE })), true);
});

Deno.test("sec-fetch-mode alone is enough to be CORS-constrained (audio-feed-cors)", () => {
  // A same-origin `fetch()` from the page or the service worker may omit Origin
  // while still being a CORS-mode request — which will follow the cross-origin
  // redirect and then fail. Checking Origin alone would have missed the service
  // worker case, and the service worker is what produced Paul's 503.
  assertEquals(isCorsConstrained(audio({ "sec-fetch-mode": "cors" })), true);
  assertEquals(isCorsConstrained(audio({ "sec-fetch-mode": "same-origin" })), true);
});

Deno.test("a podcast client is NOT CORS-constrained (audio-feed-cors)", () => {
  // No Origin, and `sec-fetch-mode: no-cors` is what a plain media load sends.
  // These must keep the redirect: it is the whole point of audio-feed-vnb, and
  // it is how the bytes stay out of the isolate.
  assertEquals(isCorsConstrained(audio()), false);
  assertEquals(isCorsConstrained(audio({ "sec-fetch-mode": "no-cors" })), false);
  assertEquals(isCorsConstrained(audio({ "user-agent": "Overcast/1.0" })), false);
});

// -- the fork --------------------------------------------------------------

Deno.test("a CORS request is SERVED, not redirected (audio-feed-cors)", async () => {
  // THE production bug. Before the fix this was a 302 to R2, and the browser
  // refused the response R2 sent it.
  const { fetch } = await app(redirectingStore);
  const res = await fetch(audio({ origin: BASE }));

  assertNotEquals(res.status, 302, "a browser cannot follow this redirect and read the result");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(new Uint8Array(await res.arrayBuffer()), BYTES, "the real bytes must arrive");
});

Deno.test("a service worker fetch is served too, even with no Origin (audio-feed-cors)", async () => {
  const { fetch } = await app(redirectingStore);
  const res = await fetch(audio({ "sec-fetch-mode": "cors" }));

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  await res.arrayBuffer();
});

Deno.test("a podcast client STILL gets the redirect (audio-feed-vnb preserved)", async () => {
  // The fix must not become "stop redirecting". audio-feed-vnb exists so audio
  // bytes do not transit the isolate, and a podcast app downloading a 16 MB
  // enclosure is exactly the case it was written for.
  const { fetch } = await app(redirectingStore);
  const res = await fetch(audio());

  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), `https://r2.example.com/${KEY}?X-Amz-Signature=abc`);
});

// -- the headers that make bytes readable ---------------------------------

Deno.test("CORS headers are on every served response (audio-feed-cors)", async () => {
  const { fetch } = await app();

  const whole = await fetch(audio({ origin: BASE }));
  assertEquals(whole.status, 200);
  assertEquals(whole.headers.get("access-control-allow-origin"), "*");
  await whole.arrayBuffer();

  const ranged = await fetch(audio({ origin: BASE, range: "bytes=0-3" }));
  assertEquals(ranged.status, 206);
  assertEquals(ranged.headers.get("access-control-allow-origin"), "*");
  await ranged.arrayBuffer();

  const head = await fetch(audio({ origin: BASE }, "HEAD"));
  assertEquals(head.status, 200);
  assertEquals(head.headers.get("access-control-allow-origin"), "*");
});

Deno.test("seeking headers are EXPOSED to the page, not just sent (audio-feed-cors)", async () => {
  // Without `access-control-expose-headers`, a CORS response hands the page only
  // the safelisted headers — so `content-range` and `accept-ranges` are invisible
  // to JS and a seeking player cannot tell what it received. Sending a header the
  // browser then hides is the same class of failure as not sending it.
  const { fetch } = await app();
  const res = await fetch(audio({ origin: BASE, range: "bytes=0-3" }));

  const exposed = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  assertEquals(res.status, 206);
  for (const header of ["accept-ranges", "content-length", "content-range", "etag"]) {
    assertEquals(exposed.includes(header), true, `${header} must be exposed to the page`);
  }
  await res.arrayBuffer();
});

Deno.test("a 404 is still a 404 for a CORS request (audio-feed-cors)", async () => {
  const { fetch } = await app(redirectingStore);
  const res = await fetch(
    new Request(`${BASE}/audio/audio/user-1/direct/missing.wav`, { headers: { origin: BASE } }),
  );
  assertEquals(res.status, 404);
});

Deno.test("range semantics survive the CORS path (audio-feed-cors)", async () => {
  // The CORS fork routes through the get() path rather than the redirect, so the
  // seeking behaviour audio-feed-0h8 established has to hold on it too.
  const { fetch } = await app(redirectingStore);
  const res = await fetch(audio({ origin: BASE, range: "bytes=2-5" }));

  assertEquals(res.status, 206);
  assertEquals(res.headers.get("content-range"), `bytes 2-5/${BYTES.length}`);
  assertEquals(res.headers.get("content-length"), "4");
  assertEquals(new Uint8Array(await res.arrayBuffer()), BYTES.slice(2, 6));
});
