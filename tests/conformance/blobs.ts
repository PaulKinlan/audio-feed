/**
 * Conformance suite for `BlobStore`.
 *
 * Heavy on ranges on purpose: range handling is where podcast playback breaks,
 * and it breaks silently — the feed validates, the episode downloads, and only
 * seeking misbehaves.
 *
 * Owned by: audio-feed-0h8.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type BlobStore, collect, RangeNotSatisfiableError } from "../../src/storage/mod.ts";
import { bytes } from "../fixtures.ts";

export interface BlobSuiteOptions {
  name: string;
  create: () => Promise<BlobStore> | BlobStore;
}

export function runBlobConformance({ name, create }: BlobSuiteOptions) {
  const test = (label: string, fn: (store: BlobStore) => Promise<void>) => {
    Deno.test(`${name}: ${label}`, async () => {
      await fn(await create());
    });
  };

  test("round-trips bytes with a content type", async (store) => {
    const payload = bytes(256);
    const info = await store.put("audio/u1/direct/e1.mp3", payload, { contentType: "audio/mpeg" });

    assertEquals(info.size, 256);
    assertEquals(info.contentType, "audio/mpeg");

    const got = await store.get("audio/u1/direct/e1.mp3");
    assert(got);
    assertEquals(got.contentType, "audio/mpeg");
    assertEquals(await collect(got.body), payload);
  });

  test("accepts a stream body", async (store) => {
    const payload = bytes(128);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.subarray(0, 64));
        controller.enqueue(payload.subarray(64));
        controller.close();
      },
    });

    const info = await store.put("k", stream, { contentType: "audio/mpeg" });
    assertEquals(info.size, 128);

    const got = await store.get("k");
    assert(got);
    assertEquals(await collect(got.body), payload);
  });

  test("returns null for a missing key", async (store) => {
    assertEquals(await store.get("missing"), null);
    assertEquals(await store.head("missing"), null);
  });

  test("head reports size without transferring the body", async (store) => {
    await store.put("k", bytes(512), { contentType: "audio/mpeg" });
    const info = await store.head("k");
    assertEquals(info?.size, 512);
    assertEquals(info?.contentType, "audio/mpeg");
  });

  test("serves a closed range", async (store) => {
    const payload = bytes(1000);
    await store.put("k", payload);

    const got = await store.get("k", { range: { start: 100, end: 199 } });
    assert(got);
    assertEquals(got.range, { start: 100, end: 199, total: 1000 });
    assertEquals(await collect(got.body), payload.subarray(100, 200));
  });

  test("serves an open-ended range", async (store) => {
    const payload = bytes(1000);
    await store.put("k", payload);

    const got = await store.get("k", { range: { start: 900 } });
    assert(got);
    assertEquals(got.range, { start: 900, end: 999, total: 1000 });
    assertEquals(await collect(got.body), payload.subarray(900));
  });

  test("serves a suffix range", async (store) => {
    const payload = bytes(1000);
    await store.put("k", payload);

    // `bytes=-100` — the last 100 bytes.
    const got = await store.get("k", { range: { start: -100 } });
    assert(got);
    assertEquals(got.range, { start: 900, end: 999, total: 1000 });
    assertEquals(await collect(got.body), payload.subarray(900));
  });

  test("clamps an over-long end to the object size", async (store) => {
    await store.put("k", bytes(100));
    const got = await store.get("k", { range: { start: 50, end: 10_000 } });
    assert(got);
    assertEquals(got.range, { start: 50, end: 99, total: 100 });
  });

  test("rejects a start past the end of the object", async (store) => {
    await store.put("k", bytes(100));
    await assertRejects(
      () => store.get("k", { range: { start: 100 } }),
      RangeNotSatisfiableError,
    );
  });

  test("reports full size on a ranged read", async (store) => {
    await store.put("k", bytes(1000));
    const got = await store.get("k", { range: { start: 0, end: 9 } });
    assert(got);
    assertEquals(got.size, 1000, "size is the object size, not the slice length");
  });

  test("overwrites an existing key", async (store) => {
    await store.put("k", bytes(10));
    await store.put("k", bytes(20));
    assertEquals((await store.head("k"))?.size, 20);
  });

  test("deletes, and delete of a missing key is not an error", async (store) => {
    await store.put("k", bytes(10));
    await store.delete("k");
    assertEquals(await store.head("k"), null);
    await store.delete("k");
  });

  test("handles a zero-length object without crashing", async (store) => {
    await store.put("k", new Uint8Array(0));
    const info = await store.head("k");
    assertEquals(info?.size, 0);
    await assertRejects(() => store.get("k", { range: { start: 0 } }), RangeNotSatisfiableError);
  });
}
