/**
 * Real-socket tests.
 *
 * These bind an actual port and speak HTTP, unlike `app_test.ts` which calls
 * the fetch handler in-process. Both are needed: in-process tests are fast and
 * cover logic, but they never exercise HTTP serialization — and that is where
 * `Deno.serve` rewrites response headers.
 *
 * This file exists because of a bug that shipped past a green in-process suite:
 * a `HEAD` handler built with `new Response(null, { "content-length": "1000" })`
 * asserted correctly in-process, then served `content-length: 0` over a socket.
 * Podcast clients size a download with `HEAD` first, so that reads as an empty
 * episode. Any future change to audio response construction must pass here.
 */

import { assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { memoryStores } from "../src/config.ts";
import { bytes, makeEpisode, makeUser } from "./fixtures.ts";
import type { AppConfig } from "../src/config.ts";

const KEY = "audio/user-1/direct/episode-1.mp3";
const SIZE = 1000;

/** Boots the real app on an ephemeral port; shuts down even if the test throws. */
async function withServer(
  run: (base: string) => Promise<void>,
): Promise<void> {
  const stores = memoryStores();
  await stores.blobs.put(KEY, bytes(SIZE), { contentType: "audio/mpeg" });
  await stores.metadata.putUser(makeUser());
  await stores.metadata.putEpisode(makeEpisode());

  const config: AppConfig = { port: 0, publicBaseUrl: "http://localhost" };
  const { fetch: handler } = createApp({ config, stores });

  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    handler,
  );

  try {
    await run(`http://localhost:${server.addr.port}`);
  } finally {
    controller.abort();
    await server.finished;
    await stores.metadata.close();
  }
}

Deno.test("HTTP: HEAD reports the real content-length over a socket", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/audio/${KEY}`, { method: "HEAD" });
    await res.body?.cancel();

    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("content-length"),
      String(SIZE),
      "HEAD must report the object size; 0 tells a podcast client there is nothing to play",
    );
    assertEquals(res.headers.get("content-type"), "audio/mpeg");
    assertEquals(res.headers.get("accept-ranges"), "bytes");
  });
});

Deno.test("HTTP: HEAD sends no body", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/audio/${KEY}`, { method: "HEAD" });
    assertEquals((await res.arrayBuffer()).byteLength, 0);
  });
});

Deno.test("HTTP: HEAD and GET agree on size", async () => {
  await withServer(async (base) => {
    const head = await fetch(`${base}/audio/${KEY}`, { method: "HEAD" });
    await head.body?.cancel();
    const get = await fetch(`${base}/audio/${KEY}`);
    const body = await get.arrayBuffer();

    assertEquals(head.headers.get("content-length"), get.headers.get("content-length"));
    assertEquals(body.byteLength, SIZE);
  });
});

Deno.test("HTTP: GET streams the whole object", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/audio/${KEY}`);
    const body = new Uint8Array(await res.arrayBuffer());

    assertEquals(res.status, 200);
    assertEquals(body.byteLength, SIZE);
    // Deterministic fixture: byte i === i % 256.
    assertEquals(body[0], 0);
    assertEquals(body[SIZE - 1], (SIZE - 1) % 256);
  });
});

Deno.test("HTTP: a Range request returns 206 with the exact slice", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/audio/${KEY}`, { headers: { range: "bytes=100-199" } });
    const body = new Uint8Array(await res.arrayBuffer());

    assertEquals(res.status, 206);
    assertEquals(res.headers.get("content-range"), `bytes 100-199/${SIZE}`);
    assertEquals(res.headers.get("content-length"), "100");
    assertEquals(body.byteLength, 100);
    assertEquals(body[0], 100 % 256);
    assertEquals(body[99], 199 % 256);
  });
});

Deno.test("HTTP: a suffix Range returns the tail", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/audio/${KEY}`, { headers: { range: "bytes=-100" } });
    const body = new Uint8Array(await res.arrayBuffer());

    assertEquals(res.status, 206);
    assertEquals(res.headers.get("content-range"), `bytes 900-999/${SIZE}`);
    assertEquals(body[0], 900 % 256);
  });
});

Deno.test("HTTP: an unsatisfiable Range returns 416 with content-range", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/audio/${KEY}`, { headers: { range: "bytes=5000-6000" } });
    await res.body?.cancel();

    assertEquals(res.status, 416);
    assertEquals(res.headers.get("content-range"), `bytes */${SIZE}`);
  });
});

Deno.test("HTTP: health and 404 behave over a socket", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assertEquals(health.status, 200);
    assertEquals((await health.json()).status, "ok");

    const missing = await fetch(`${base}/audio/does-not-exist.mp3`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  });
});
