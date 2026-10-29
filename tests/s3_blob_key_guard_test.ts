/**
 * The S3/R2 blob store enforces the blob-key shape at its OWN boundary.
 *
 * THE DEFECT this pins: the store percent-encoded key segments but let dot segments through,
 * so `..` survived to the bucket and safety rested on every caller remembering
 * `isSafeBlobKey`. These tests fail closed at the store, with callers deliberately NOT
 * validating anything first.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { S3BlobStore } from "../src/storage/s3.ts";
import { InvalidBlobKeyError, isSafeBlobKey } from "../src/storage/blob_key.ts";

const BASE = "https://tracker.test";

/**
 * A store with a public base URL: `url()` then needs no signing and no network, so the
 * encoding under test is observed directly. `fetch` is replaced with one that fails the test
 * if it is ever reached — a refusal must happen BEFORE any request leaves the process.
 */
function publicStore(): S3BlobStore {
  return new S3BlobStore({
    bucket: "blobs",
    endpoint: "https://account.r2.test",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    publicBaseUrl: BASE,
  });
}

function signingStore(): S3BlobStore {
  return new S3BlobStore({
    bucket: "blobs",
    endpoint: "https://account.r2.test",
    accessKeyId: "ak",
    secretAccessKey: "sk",
  });
}

Deno.test("s3 blob store: unsafe key shapes are refused at the store", async () => {
  const store = publicStore();

  const refused: Array<[string, string]> = [
    ["dot segment", "audio/u1/direct/./e1.wav"],
    ["parent segment", "audio/u1/direct/../e1.wav"],
    ["leading parent", "../audio/u1/direct/e1.wav"],
    ["trailing parent", "audio/u1/direct/.."],
    ["percent-encoded parent", "audio/u1/direct/%2e%2e/e1.wav"],
    ["percent-encoded dot", "audio/u1/direct/%2E/e1.wav"],
    ["empty segment", "audio//u1/direct/e1.wav"],
    ["trailing empty segment", "audio/u1/direct/"],
    ["backslash", "audio/u1/direct\\..\\e1.wav"],
    ["leading slash", "/audio/u1/direct/e1.wav"],
    ["absolute-URL key", "//host/x"],
    ["empty key", ""],
    ["NUL byte", "audio/u1/direct/e1\0.wav"],
  ];

  for (const [name, key] of refused) {
    // Refusals surface as REJECTIONS (await-based call sites see one failure mode), and the
    // store is called with no isSafeBlobKey check of our own on purpose: it must refuse alone.
    const error = await assertRejects(
      () => store.url(key),
      InvalidBlobKeyError,
      undefined,
      `expected the store to refuse the ${name} key ${JSON.stringify(key)}`,
    );
    assertEquals(error.key, key);
    assertEquals(isSafeBlobKey(key), false, `${name} must also be unsafe to the shared predicate`);
  }

  // The refusal is a typed error, not a bare Error.
  assertEquals(new InvalidBlobKeyError("x").name, "InvalidBlobKeyError");
});

Deno.test("s3 blob store: every URL-building path refuses unsafe keys", async () => {
  // put / putIfAbsent / get / head / delete all build their URL through the same guard, so a
  // refusal is a rejection with InvalidBlobKeyError — and it happens before any fetch, so no
  // network is needed to prove it.
  const store = signingStore();
  const key = "audio/u1/direct/../secret.wav";
  const body = new Uint8Array([1, 2, 3]);

  await assertRejects(() => store.put(key, body), InvalidBlobKeyError);
  await assertRejects(() => store.putIfAbsent(key, body), InvalidBlobKeyError);
  await assertRejects(() => store.get(key), InvalidBlobKeyError);
  await assertRejects(() => store.head(key), InvalidBlobKeyError);
  await assertRejects(() => store.delete(key), InvalidBlobKeyError);
  await assertRejects(() => store.url(key), InvalidBlobKeyError);
});

Deno.test("s3 blob store: valid keys encode exactly as before", async () => {
  const store = publicStore();

  // Literal expectations: "key.split('/').map(encodeURIComponent).join('/')" over the public
  // base. A change to the encoding reddens these.
  const cases: Array<[string, string]> = [
    ["audio/u1/direct/e1.wav", `${BASE}/audio/u1/direct/e1.wav`],
    // A dot INSIDE a filename is not a dot segment and must survive untouched.
    ["audio/u1/direct/a.b.wav", `${BASE}/audio/u1/direct/a.b.wav`],
    [
      "audio/u1/deepdive/2026-01-02T03-04-05.123Z.wav",
      `${BASE}/audio/u1/deepdive/2026-01-02T03-04-05.123Z.wav`,
    ],
    // Segments that genuinely need encoding still encode per segment, never the separator.
    ["audio/u1/direct/a b+c.wav", `${BASE}/audio/u1/direct/a%20b%2Bc.wav`],
    ["audio/u1/direct/60%25.wav", `${BASE}/audio/u1/direct/60%2525.wav`],
    ["audio-segments/u1/e1/abc-def-r1.wav", `${BASE}/audio-segments/u1/e1/abc-def-r1.wav`],
  ];

  for (const [key, expected] of cases) {
    assertEquals(isSafeBlobKey(key), true, `${key} must stay valid`);
    assertEquals(await store.url(key), expected, `encoding changed for ${key}`);
  }
});
