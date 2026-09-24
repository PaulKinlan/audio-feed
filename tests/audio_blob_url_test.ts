/**
 * The audio route's contract with `BlobStore.url()` (audio-feed-gxn).
 *
 * `handleAudio` used to decide once, from the FIRST candidate key, whether the
 * store could serve bytes directly — and then return 404 if its `head()` missed.
 * A store that answers `url()` PER KEY (a CDN mapped over one prefix, for example)
 * broke that: the first candidate looked like a redirecting store, its head()
 * missed, and the handler 404'd an object that existed and that HEAD could see.
 *
 * Nothing in the `BlobStore` interface promises per-key consistency, so the
 * handler must not depend on it. These tests pin the assumption away with a stub
 * that behaves the way a per-key store would.
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { BlobObject } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const LEGACY_KEY = "legacy.wav";

/**
 * A store that serves `audio/*` keys by direct URL and everything else only
 * through the isolate — the exact shape the bead measured. `url()` therefore
 * answers differently for two keys in the same candidate list.
 */
function perKeyStore(inner: Stores["blobs"]): Stores["blobs"] {
  return {
    put: (key, body, opts) => inner.put(key, body, opts),
    head: (key) => inner.head(key),
    delete: (key) => inner.delete(key),
    get: (key, opts): Promise<BlobObject | null> => inner.get(key, opts),
    url: (key) =>
      Promise.resolve(key.startsWith("audio/") ? `https://cdn.example.com/${key}` : null),
  };
}

async function app(blobs?: (inner: Stores["blobs"]) => Stores["blobs"]) {
  const stores: Stores = memoryStores();
  if (blobs) stores.blobs = blobs(stores.blobs);
  await stores.blobs.put(LEGACY_KEY, BYTES, { contentType: "audio/wav" });
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores };
}

Deno.test("an object a per-key store cannot serve directly is still served (audio-feed-gxn)", async () => {
  const { fetch } = await app(perKeyStore);
  // HEAD sees it: so the object unquestionably exists.
  const head = await fetch(new Request(`${BASE}/audio/${LEGACY_KEY}`, { method: "HEAD" }));
  assertEquals(head.status, 200);
  assertEquals(head.headers.get("content-length"), String(BYTES.length));

  // The regression: this returned 404, because the FIRST candidate
  // ("audio/legacy.wav") yielded a CDN URL while the second ("legacy.wav") did not,
  // and the handler had already decided the store redirects.
  const got = await fetch(new Request(`${BASE}/audio/${LEGACY_KEY}`));
  assertEquals(got.status, 200, "an object that HEAD can see must be readable");
  assertEquals((await got.bytes()).length, BYTES.length);
  assertEquals(got.headers.get("content-type"), "audio/wav");
});

Deno.test("a store that can serve a key directly is still used directly", async () => {
  // The 302 path must survive the fix: when url() answers AND head() hits, the
  // client still goes straight to the CDN rather than through the isolate.
  const stores: Stores = memoryStores();
  stores.blobs = perKeyStore(stores.blobs);
  await stores.blobs.put("audio/direct.wav", BYTES, { contentType: "audio/wav" });
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const res = await fetch(new Request(`${BASE}/audio/direct.wav`));
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "https://cdn.example.com/audio/direct.wav");
});

Deno.test("a genuinely missing object is still a 404 against a per-key store", async () => {
  const { fetch } = await app(perKeyStore);
  // The fix costs one get() on a miss instead of a cheap 404; it must still 404.
  const res = await fetch(new Request(`${BASE}/audio/nothing-here.wav`));
  assertEquals(res.status, 404);
});

Deno.test("seeking still works through a per-key store", async () => {
  const { fetch } = await app(perKeyStore);
  const res = await fetch(
    new Request(`${BASE}/audio/${LEGACY_KEY}`, { headers: { range: "bytes=0-3" } }),
  );
  assertEquals(res.status, 206);
  assertEquals(res.headers.get("content-range"), `bytes 0-3/${BYTES.length}`);
  assert((await res.bytes()).length === 4);
});
