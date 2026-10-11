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

Deno.test("audio route 404 logs diagnostic warnings with redacted key (audio-feed-e1d, audio-feed-f9wf)", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const { fetch } = await app(perKeyStore);
    const res = await fetch(new Request(`${BASE}/audio/missing-track.wav`));
    assertEquals(res.status, 404);

    const warn = warnings.find((w) =>
      w.includes('audio GET 404: key "[redacted]" not found in storage')
    );
    assert(warn, "console.warn must log the missing key as redacted");
    assert(!warn.includes("missing-track.wav"), "rawKey must not reach the log");
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("a disallowed audio key is 404'd WITHOUT the key reaching the log (audio-feed-0eae)", async () => {
  // The key is attacker-controlled text and a weak capability (it embeds the
  // user id); the disallowed-key warn must not echo it.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const { fetch } = await app();
    // ".txt" fails the extension allowlist, so this hits the disallowed-key branch.
    const res = await fetch(new Request(`${BASE}/audio/audio/user-secret-7/direct/evil.txt`));
    assertEquals(res.status, 404);
    await res.body?.cancel();

    const warn = warnings.find((w) => w.includes("audio 404"));
    assert(warn, "the 404 must still log that it happened");
    assert(
      !warn.includes("user-secret-7") && !warn.includes("evil.txt"),
      `the key must not reach the log: ${warn}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("audio route storage-miss 404s (GET, HEAD, direct-url) redact valid capability keys (audio-feed-f9wf)", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  const VALID_MISSING_KEY = "user-secret-7/direct/never-existed.mp3";

  try {
    // 1. GET storage-miss on default store
    const { fetch: defaultFetch } = await app();
    const getRes = await defaultFetch(
      new Request(`${BASE}/audio/${VALID_MISSING_KEY}`, {
        headers: { Origin: BASE },
      }),
    );
    assertEquals(getRes.status, 404);
    const getWarn = warnings.find((w) => w.includes("audio GET 404"));
    assert(getWarn, "audio GET 404 must log a warning");
    assert(
      getWarn.includes('key "[redacted]" not found in storage'),
      `GET warn must be redacted: ${getWarn}`,
    );
    assert(
      !getWarn.includes("user-secret-7") && !getWarn.includes("never-existed.mp3"),
      `GET warn must not leak key: ${getWarn}`,
    );

    // 2. HEAD storage-miss on default store
    warnings.length = 0;
    const headRes = await defaultFetch(
      new Request(`${BASE}/audio/${VALID_MISSING_KEY}`, {
        method: "HEAD",
        headers: { Origin: BASE },
      }),
    );
    assertEquals(headRes.status, 404);
    const headWarn = warnings.find((w) => w.includes("audio HEAD 404"));
    assert(headWarn, "audio HEAD 404 must log a warning");
    assert(
      headWarn.includes('key "[redacted]" not found'),
      `HEAD warn must be redacted: ${headWarn}`,
    );
    assert(
      !headWarn.includes("user-secret-7") && !headWarn.includes("never-existed.mp3"),
      `HEAD warn must not leak key: ${headWarn}`,
    );

    // 3. direct-url miss on store with uniform direct URLs
    warnings.length = 0;
    const { fetch: directFetch } = await app((inner) => {
      inner.url = (key) => Promise.resolve(`https://cdn.example.com/${key}`);
      inner.head = () => Promise.resolve(null);
      return inner;
    });

    // Non-CORS request without Range triggers direct-url check
    const directRes = await directFetch(
      new Request(`${BASE}/audio/${VALID_MISSING_KEY}`),
    );
    assertEquals(directRes.status, 404);
    const directWarn = warnings.find((w) => w.includes("audio direct-url 404"));
    assert(directWarn, "audio direct-url 404 must log a warning");
    assert(
      directWarn.includes('key "[redacted]" not found'),
      `direct-url warn must be redacted: ${directWarn}`,
    );
    assert(
      !directWarn.includes("user-secret-7") && !directWarn.includes("never-existed.mp3"),
      `direct-url warn must not leak key: ${directWarn}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});
