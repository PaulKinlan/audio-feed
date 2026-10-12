/**
 * Socket-level verification for S3BlobStore abort behavior (audio-feed-q3d7).
 *
 * Proves that an upload AbortSignal stops the underlying TCP socket and HTTP transfer,
 * verified by ground truth at the receiver (server byte count and stream termination)
 * rather than relying solely on client-side promise rejection.
 */

import { assert, assertEquals } from "@std/assert";
import { S3BlobStore } from "../src/storage/s3.ts";

Deno.test("S3BlobStore.put terminates underlying socket and server stream on abort (audio-feed-q3d7)", async () => {
  let serverReceivedBytes = 0;
  let serverBodyEnded = false;
  let notifyFirstChunk!: () => void;
  const firstChunkReceived = new Promise<void>((resolve) => {
    notifyFirstChunk = resolve;
  });

  const TOTAL_BYTES = 16 * 1024 * 1024; // 16 MB

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    if (req.method === "PUT") {
      const reader = req.body?.getReader();
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          serverReceivedBytes += value.byteLength;
          if (serverReceivedBytes >= 65536) {
            notifyFirstChunk();
          }
          // Throttle reading slightly to ensure upload is actively in-flight
          await new Promise((r) => setTimeout(r, 2));
        }
      } catch {
        // TCP socket reset / connection close on client abort lands here
      } finally {
        serverBodyEnded = true;
      }
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  });

  const port = (server.addr as { port: number }).port;
  const store = new S3BlobStore({
    bucket: "test-bucket",
    endpoint: `http://127.0.0.1:${port}`,
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
  });

  const controller = new AbortController();
  const abortReason = new Error("deadline reached: terminal upload aborted");
  const body = new Uint8Array(TOTAL_BYTES);

  try {
    const putPromise = store.put("test/file.wav", body, {
      contentType: "audio/wav",
      signal: controller.signal,
    });

    // Wait until server has actively received in-flight bytes, then abort
    await firstChunkReceived;
    controller.abort(abortReason);

    let caught: unknown = null;
    try {
      await putPromise;
    } catch (e) {
      caught = e;
    }

    // (a) Client rejection preserves caller's exact abort reason
    assertEquals(caught, abortReason, "put promise must reject with caller's abort reason");

    // (b) Wait for server to observe socket teardown (bounded by 3s timeout)
    const deadline = Date.now() + 3000;
    while (!serverBodyEnded && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // (c) Ground truth: server body stream ended and received materially fewer bytes
    assert(serverBodyEnded, "server body stream must terminate early upon client abort");
    assert(
      serverReceivedBytes > 0,
      `server must have observed in-flight bytes (got ${serverReceivedBytes})`,
    );
    assert(
      serverReceivedBytes < TOTAL_BYTES / 2,
      `server received bytes (${serverReceivedBytes}) must stop materially short of offered size (${TOTAL_BYTES})`,
    );
  } finally {
    controller.abort();
    await server.shutdown();
  }
});

Deno.test("S3BlobStore.putIfAbsent terminates underlying socket and server stream on abort (audio-feed-q3d7)", async () => {
  let serverReceivedBytes = 0;
  let serverBodyEnded = false;
  let notifyFirstChunk!: () => void;
  const firstChunkReceived = new Promise<void>((resolve) => {
    notifyFirstChunk = resolve;
  });

  const TOTAL_BYTES = 16 * 1024 * 1024; // 16 MB

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    if (req.method === "PUT") {
      const reader = req.body?.getReader();
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          serverReceivedBytes += value.byteLength;
          if (serverReceivedBytes >= 65536) {
            notifyFirstChunk();
          }
          await new Promise((r) => setTimeout(r, 2));
        }
      } catch {
        // TCP socket reset / connection close on client abort lands here
      } finally {
        serverBodyEnded = true;
      }
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  });

  const port = (server.addr as { port: number }).port;
  const store = new S3BlobStore({
    bucket: "test-bucket",
    endpoint: `http://127.0.0.1:${port}`,
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
  });

  const controller = new AbortController();
  const abortReason = new Error("deadline reached: putIfAbsent aborted");
  const body = new Uint8Array(TOTAL_BYTES);

  try {
    const putPromise = store.putIfAbsent("test/absent.wav", body, {
      contentType: "audio/wav",
      signal: controller.signal,
    });

    await firstChunkReceived;
    controller.abort(abortReason);

    let caught: unknown = null;
    try {
      await putPromise;
    } catch (e) {
      caught = e;
    }

    assertEquals(caught, abortReason, "putIfAbsent promise must reject with caller's abort reason");

    const deadline = Date.now() + 3000;
    while (!serverBodyEnded && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert(serverBodyEnded, "server body stream must terminate early upon client abort");
    assert(
      serverReceivedBytes > 0,
      `server must have observed in-flight bytes (got ${serverReceivedBytes})`,
    );
    assert(
      serverReceivedBytes < TOTAL_BYTES / 2,
      `server received bytes (${serverReceivedBytes}) must stop materially short of offered size (${TOTAL_BYTES})`,
    );
  } finally {
    controller.abort();
    await server.shutdown();
  }
});
