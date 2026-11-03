/**
 * The unapproved-owner refusal must cost ZERO blob operations (audio-feed-hqjcy).
 *
 * handleAudio used to fetch the object — and, on a redirecting store, mint a
 * presigned URL — BEFORE checkUserApproval, so a request that could never
 * succeed still drove store reads/egress into the isolate and minted a
 * capability that was then discarded. No bytes ever reached the caller, but
 * the store work was spent on every candidate key. The approval check now
 * runs before any blobs.* call: an unapproved request performs none, while an
 * approved request's bytes and redirects are byte-for-byte unchanged.
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { BlobObject } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const KEY = "user-1/direct/ep-1.wav";

type BlobCounts = { get: number; url: number; head: number };

/** A BlobStore wrapper that counts every blobs.* operation the handler spends. */
function countingStore(
  inner: Stores["blobs"],
  counts: BlobCounts,
  opts: { directUrl?: boolean } = {},
): Stores["blobs"] {
  return {
    put: (key, body, o) => inner.put(key, body, o),
    putIfAbsent: (key, body, o) => inner.putIfAbsent(key, body, o),
    delete: (key) => inner.delete(key),
    head: (key) => {
      counts.head++;
      return inner.head(key);
    },
    get: (key, o): Promise<BlobObject | null> => {
      counts.get++;
      return inner.get(key, o);
    },
    url: (key) => {
      counts.url++;
      return Promise.resolve(
        opts.directUrl ? `https://cdn.example.com/${key}` : inner.url(key),
      );
    },
    directUrlOrigin: () => inner.directUrlOrigin(),
  };
}

async function app(ownerStatus: "approved" | "pending", directUrl = false) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: ownerStatus }));
  await stores.blobs.put(`audio/${KEY}`, BYTES, { contentType: "audio/wav" });
  const counts: BlobCounts = { get: 0, url: 0, head: 0 };
  stores.blobs = countingStore(stores.blobs, counts, { directUrl });
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, counts };
}

Deno.test("an unapproved owner's GET performs zero blob operations (audio-feed-hqjcy)", async () => {
  for (
    const [kind, directUrl] of [["isolate-served", false], ["redirecting", true]] as const
  ) {
    const { fetch, counts } = await app("pending", directUrl);
    const res = await fetch(new Request(`${BASE}/audio/${KEY}`));
    assertEquals(res.status, 404, "the refusal itself is unchanged");
    assertEquals(
      counts,
      { get: 0, url: 0, head: 0 },
      `a ${kind} store must see no blob work for an unapproved owner`,
    );
  }
});

Deno.test("an approved owner still gets the same bytes and redirect (audio-feed-hqjcy)", async () => {
  // Isolate-served: the bytes themselves, unchanged.
  const isolate = await app("approved");
  const got = await isolate.fetch(new Request(`${BASE}/audio/${KEY}`));
  assertEquals(got.status, 200);
  assertEquals(new Uint8Array(await got.bytes()), BYTES);
  assertEquals(got.headers.get("content-type"), "audio/wav");
  assert(isolate.counts.get >= 1, "the isolate path still reads the blob once");

  // Redirecting store: the same 302 to the store's URL, unchanged.
  const redirecting = await app("approved", true);
  const res = await redirecting.fetch(new Request(`${BASE}/audio/${KEY}`));
  assertEquals(res.status, 302);
  assertEquals(
    res.headers.get("location"),
    `https://cdn.example.com/audio/${KEY}`,
  );
});
