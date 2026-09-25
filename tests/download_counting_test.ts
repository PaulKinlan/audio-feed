/**
 * What counts as a download, and what deliberately does not (audio-feed-ndc).
 *
 * This is a counting rule, not a feature, so the tests that matter are the
 * NEGATIVE ones. A podcast client resuming an episode issues several Range
 * requests for one file, and HEAD-then-GET is its normal probe; counting either
 * inflates the figure two- to threefold, and an inflated number is worse than no
 * number because an operator would act on it.
 *
 * Driven through the real route rather than by calling `recordDownload`
 * directly. The store method working proves nothing about whether the route
 * calls it on the right requests — that seam is the whole subject here, and it
 * is the same gap audio-feed-2np was about.
 */
import { assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { userIdFromBlobKey } from "../src/routes/audio.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { BlobObject } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

/** Canonical key shape from audio-feed-3hb: audio/<userId>/<mode>/<id>.<ext> */
const KEY = "audio/user-1/direct/ep-1.wav";
const LEGACY_KEY = "legacy.wav";

async function app(
  blobs?: (inner: Stores["blobs"]) => Stores["blobs"],
): Promise<{ fetch: (req: Request) => Promise<Response>; stores: Stores }> {
  const stores: Stores = memoryStores();
  await stores.blobs.put(KEY, BYTES, { contentType: "audio/wav" });
  await stores.blobs.put(LEGACY_KEY, BYTES, { contentType: "audio/wav" });
  if (blobs) stores.blobs = blobs(stores.blobs);
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores };
}

/** A store that hands out direct URLs for every key, i.e. S3/R2/a CDN. */
function redirectingStore(inner: Stores["blobs"]): Stores["blobs"] {
  return {
    put: (key, body, opts) => inner.put(key, body, opts),
    head: (key) => inner.head(key),
    delete: (key) => inner.delete(key),
    get: (key, opts): Promise<BlobObject | null> => inner.get(key, opts),
    url: (key) => Promise.resolve(`https://cdn.example.com/${key}`),
  };
}

// -- the key parser -------------------------------------------------------

Deno.test("userIdFromBlobKey reads the owner out of a canonical key (audio-feed-ndc)", () => {
  assertEquals(userIdFromBlobKey("audio/user-1/direct/ep-1.wav"), "user-1");
  assertEquals(userIdFromBlobKey("audio/user-2/deepdive/ep-9.mp3"), "user-2");
});

Deno.test("userIdFromBlobKey refuses to guess an owner (audio-feed-ndc)", () => {
  // Every one of these must be null rather than a best effort. A wrongly
  // attributed download is worse than an unattributed one: the per-user figure
  // is the one an operator would act on, and it has no way to show its doubt.
  assertEquals(userIdFromBlobKey("legacy.wav"), null, "a flat legacy key has no owner");
  assertEquals(userIdFromBlobKey("audio/user-1"), null, "too few segments to be canonical");
  assertEquals(userIdFromBlobKey("audio/user-1/direct"), null, "still too few");
  assertEquals(userIdFromBlobKey("other/user-1/direct/ep.wav"), null, "wrong prefix");
  assertEquals(userIdFromBlobKey("audio//direct/ep.wav"), null, "empty user segment");
  assertEquals(userIdFromBlobKey(""), null);
});

// -- what counts ----------------------------------------------------------

Deno.test("a whole-object GET counts once, against its owner (audio-feed-ndc)", async () => {
  const { fetch, stores } = await app();

  const res = await fetch(new Request(`${BASE}/audio/${KEY}`));
  assertEquals(res.status, 200);
  await res.arrayBuffer();

  const counts = await stores.metadata.getDownloadCounts();
  assertEquals(counts.total, 1);
  assertEquals(counts.perUser, [{ userId: "user-1", count: 1 }]);
});

Deno.test("a redirect counts when it is ISSUED (audio-feed-ndc)", async () => {
  // On a redirecting store the bytes never transit the isolate, so the redirect
  // is the last point at which anything is observable. The dashboard says
  // "downloads / redirects" rather than implying a completed download.
  const { fetch, stores } = await app(redirectingStore);

  const res = await fetch(new Request(`${BASE}/audio/${KEY}`));
  assertEquals(res.status, 302);

  const counts = await stores.metadata.getDownloadCounts();
  assertEquals(counts.total, 1);
  assertEquals(counts.perUser, [{ userId: "user-1", count: 1 }]);
});

Deno.test("a legacy flat key counts toward the total only (audio-feed-ndc)", async () => {
  const { fetch, stores } = await app();

  const res = await fetch(new Request(`${BASE}/audio/${LEGACY_KEY}`));
  assertEquals(res.status, 200);
  await res.arrayBuffer();

  const counts = await stores.metadata.getDownloadCounts();
  assertEquals(counts.total, 1, "the request happened, so the total must move");
  assertEquals(counts.perUser, [], "but nobody may be charged with it");
});

// -- what deliberately does not count -------------------------------------

Deno.test("a Range request does NOT count (audio-feed-ndc)", async () => {
  // THE test of this whole feature. A client resuming a download issues several
  // of these for ONE episode. If they counted, a single interrupted listen would
  // read as three or four downloads and the dashboard would be confidently wrong.
  const { fetch, stores } = await app();

  const res = await fetch(
    new Request(`${BASE}/audio/${KEY}`, { headers: { range: "bytes=0-3" } }),
  );
  assertEquals(res.status, 206, "the range must actually have been served");
  await res.arrayBuffer();

  assertEquals(
    (await stores.metadata.getDownloadCounts()).total,
    0,
    "a partial fetch is not a download",
  );
});

Deno.test("several Range requests for one episode still count zero (audio-feed-ndc)", async () => {
  const { fetch, stores } = await app();

  for (const range of ["bytes=0-3", "bytes=4-7", "bytes=8-11"]) {
    const res = await fetch(new Request(`${BASE}/audio/${KEY}`, { headers: { range } }));
    assertEquals(res.status, 206);
    await res.arrayBuffer();
  }

  assertEquals((await stores.metadata.getDownloadCounts()).total, 0);
});

Deno.test("HEAD does NOT count (audio-feed-ndc)", async () => {
  // HEAD-then-GET is a podcast client's normal probe. Counting the HEAD would
  // double every real download.
  const { fetch, stores } = await app();

  const head = await fetch(new Request(`${BASE}/audio/${KEY}`, { method: "HEAD" }));
  assertEquals(head.status, 200);
  assertEquals((await stores.metadata.getDownloadCounts()).total, 0);

  // …and the GET that follows it counts exactly once, not twice.
  const get = await fetch(new Request(`${BASE}/audio/${KEY}`));
  assertEquals(get.status, 200);
  await get.arrayBuffer();
  assertEquals((await stores.metadata.getDownloadCounts()).total, 1);
});

Deno.test("a ranged request against a redirecting store does NOT count (audio-feed-ndc)", async () => {
  // The redirect path has its own `range` check, separate from the 200 path's.
  // Both have to hold or the rule leaks on whichever store is deployed — and
  // production uses the redirecting one.
  const { fetch, stores } = await app(redirectingStore);

  const res = await fetch(
    new Request(`${BASE}/audio/${KEY}`, { headers: { range: "bytes=0-3" } }),
  );
  assertEquals(res.status, 302, "a redirecting store still redirects a ranged request");
  assertEquals((await stores.metadata.getDownloadCounts()).total, 0);
});

Deno.test("a 404 does NOT count (audio-feed-ndc)", async () => {
  const { fetch, stores } = await app();

  const res = await fetch(new Request(`${BASE}/audio/audio/user-1/direct/nope.wav`));
  assertEquals(res.status, 404);
  assertEquals((await stores.metadata.getDownloadCounts()).total, 0);
});

Deno.test("two subscribers are counted separately (audio-feed-ndc)", async () => {
  const stores: Stores = memoryStores();
  await stores.blobs.put("audio/user-1/direct/a.wav", BYTES, { contentType: "audio/wav" });
  await stores.blobs.put("audio/user-2/direct/b.wav", BYTES, { contentType: "audio/wav" });
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  for (
    const key of [
      "audio/user-1/direct/a.wav",
      "audio/user-1/direct/a.wav",
      "audio/user-2/direct/b.wav",
    ]
  ) {
    const res = await fetch(new Request(`${BASE}/audio/${key}`));
    assertEquals(res.status, 200);
    await res.arrayBuffer();
  }

  const counts = await stores.metadata.getDownloadCounts();
  assertEquals(counts.total, 3);
  assertEquals(counts.perUser, [
    { userId: "user-1", count: 2 },
    { userId: "user-2", count: 1 },
  ]);
});

// -- the CORS path to a redirecting store ----------------------------------
//
// audio-feed-csm serves a CORS-constrained request from the isolate instead of
// redirecting it, because the object store the redirect points at does not
// answer CORS. On a redirecting store (production's) that moves the count from
// the 302 to the 200. Each side was tested on its own; these pin the
// combination, which exists only now that both have landed.

Deno.test("a CORS request to a redirecting store is served and counted once (audio-feed-ndc)", async () => {
  const { fetch, stores } = await app(redirectingStore);

  const res = await fetch(new Request(`${BASE}/audio/${KEY}`, { headers: { origin: BASE } }));
  assertEquals(res.status, 200, "served from the isolate, not redirected");
  await res.arrayBuffer();

  // Exactly once: not lost along with the skipped redirect, and not taken twice.
  const counts = await stores.metadata.getDownloadCounts();
  assertEquals(counts.total, 1);
  assertEquals(counts.perUser, [{ userId: "user-1", count: 1 }]);
});

Deno.test("a ranged CORS request to a redirecting store is served but NOT counted (audio-feed-ndc)", async () => {
  // A media element with `crossorigin` requests in CORS mode, normally with a
  // Range header. A partial fetch is not a download on this path either.
  const { fetch, stores } = await app(redirectingStore);

  const res = await fetch(
    new Request(`${BASE}/audio/${KEY}`, { headers: { origin: BASE, range: "bytes=0-3" } }),
  );
  assertEquals(res.status, 206, "the range must actually have been served");
  await res.arrayBuffer();

  assertEquals((await stores.metadata.getDownloadCounts()).total, 0);
});
