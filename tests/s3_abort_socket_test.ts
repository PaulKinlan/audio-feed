/**
 * Socket-level verification for S3BlobStore abort behavior (audio-feed-q3d7).
 *
 * Proves that an upload AbortSignal stops the underlying TCP socket and HTTP transfer,
 * verified by ground truth at the receiver (server byte count and stream termination)
 * rather than relying solely on client-side promise rejection.
 *
 * Timing design (audio-feed-t37td, per docs/speed.md "Tests must not assert on elapsed
 * real time"):
 * - The wait for server-side teardown is STATE-GATED on the server's own read-loop
 *   signal (a promise resolved in the read loop's `finally`), not polled against a
 *   wall-clock deadline. The loop exits via socket reset (abort works) or EOF after
 *   the full body (abort broken — caught by the byte asserts below), so the wait
 *   terminates on behaviour, not on the scheduler.
 * - The byte bound is measured from a snapshot taken SYNCHRONOUSLY with the abort
 *   call (no await between the read and `controller.abort()`), so client event-loop
 *   starvation cannot move the measurement window. Post-abort the client sends no
 *   new application bytes; only kernel-buffered bytes flush, which is bounded by
 *   loopback socket buffers, not by time.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { S3BlobStore } from "../src/storage/s3.ts";

// docs/speed.md rule-2 bound: this real-time deadline is a HANG GUARD, not a
// behavioural assertion. The server read loop exits via reset or EOF with no kernel
// timing dependency, so the guard only trips on a genuinely wedged socket (teardown
// never propagates). Observed teardown on this host is milliseconds; 30s is orders
// of magnitude above it, and a trip means the defect under test (socket not
// terminated) is present — a loaded host cannot produce it on correct code.
const HANG_GUARD_MS = 30_000;

// Post-abort flush margin. Measured on the fleet VM (2026-10-24, probe of this exact
// server/client pattern over 28 iterations at 4 MiB and 16 MiB payloads): the flush
// after abort is bounded by loopback kernel buffers at 3,839,957 bytes (~3.7 MiB),
// identical every iteration. The margin is >2x that measured ceiling; exceeding it
// means the client kept sending application bytes after abort, i.e. the signal was
// not honoured — the defect under test.
const POST_ABORT_MARGIN_BYTES = 8 * 1024 * 1024;

// Offered payload. Must comfortably exceed the kernel-buffer ceiling so the server
// cannot have received everything before the abort lands: 16 MiB is >4x the measured
// 3.7 MiB flush ceiling.
const TOTAL_BYTES = 16 * 1024 * 1024;

async function runAbortSocketScenario(
  invoke: (store: S3BlobStore, body: Uint8Array, signal: AbortSignal) => Promise<unknown>,
  abortReason: Error,
  rejectMessage: string,
) {
  let serverReceivedBytes = 0;
  let notifyFirstChunk!: () => void;
  const firstChunkReceived = new Promise<void>((resolve) => {
    notifyFirstChunk = resolve;
  });
  let notifyBodyEnded!: () => void;
  const bodyEnded = new Promise<void>((resolve) => {
    notifyBodyEnded = resolve;
  });

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
        notifyBodyEnded();
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
  const body = new Uint8Array(TOTAL_BYTES);

  try {
    const putPromise = invoke(store, body, controller.signal);

    // Wait until server has actively received in-flight bytes, then abort.
    await firstChunkReceived;
    // Snapshot synchronously with the abort: there is no await between this read and
    // controller.abort(), so event-loop starvation on a loaded host cannot stretch
    // the measurement window — after abort() only kernel-buffered bytes can arrive.
    const bytesAtAbort = serverReceivedBytes;
    controller.abort(abortReason);

    let caught: unknown = null;
    try {
      await putPromise;
    } catch (e) {
      caught = e;
    }

    // (a) Client rejection preserves caller's exact abort reason
    assertEquals(caught, abortReason, rejectMessage);

    // (b) Wait for server to observe socket teardown: state-gated on the read loop's
    // own completion signal, bounded only by the documented hang guard above.
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const hangGuard = new Promise<"timed-out">((resolve) => {
      guardTimer = setTimeout(() => resolve("timed-out"), HANG_GUARD_MS);
    });
    const outcome = await Promise.race([
      bodyEnded.then(() => "ended" as const),
      hangGuard,
    ]);
    clearTimeout(guardTimer);

    // (c) Ground truth: server body stream ended and received materially fewer bytes
    assert(
      outcome === "ended",
      `server body stream must terminate upon client abort ` +
        `(no teardown observed within ${HANG_GUARD_MS}ms hang guard)`,
    );
    assert(
      bytesAtAbort > 0,
      `server must have observed in-flight bytes before the abort (got ${bytesAtAbort})`,
    );
    assert(
      serverReceivedBytes < TOTAL_BYTES,
      `server received bytes (${serverReceivedBytes}) must stop short of offered size (${TOTAL_BYTES})`,
    );
    assert(
      serverReceivedBytes - bytesAtAbort < POST_ABORT_MARGIN_BYTES,
      `post-abort flush (${serverReceivedBytes - bytesAtAbort} bytes) must stay within the ` +
        `measured kernel-buffer margin (${POST_ABORT_MARGIN_BYTES} bytes); ` +
        `exceeding it means the client kept sending after abort`,
    );
  } finally {
    controller.abort();
    await server.shutdown();
  }
}

Deno.test("S3BlobStore.put terminates underlying socket and server stream on abort (audio-feed-q3d7)", () =>
  runAbortSocketScenario(
    (store, body, signal) => store.put("test/file.wav", body, { contentType: "audio/wav", signal }),
    new Error("deadline reached: terminal upload aborted"),
    "put promise must reject with caller's abort reason",
  ));

Deno.test("S3BlobStore.putIfAbsent terminates underlying socket and server stream on abort (audio-feed-q3d7)", () =>
  runAbortSocketScenario(
    (store, body, signal) =>
      store.putIfAbsent("test/absent.wav", body, { contentType: "audio/wav", signal }),
    new Error("deadline reached: putIfAbsent aborted"),
    "putIfAbsent promise must reject with caller's abort reason",
  ));

Deno.test("S3BlobStore.put performs multipart upload with 8 MB parts for payloads > 20 MB (audio-feed-1ib3)", async () => {
  const PAYLOAD_BYTES = 22 * 1024 * 1024; // 22 MB -> 3 parts: 8 MB, 8 MB, 6 MB
  const uploadsInitiated: string[] = [];
  const partsReceived: Array<{ partNumber: string; uploadId: string; bytes: number }> = [];
  let completePayload = "";

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.searchParams.has("uploads")) {
      uploadsInitiated.push(url.pathname);
      return new Response(
        `<InitiateMultipartUploadResult><UploadId>test-upload-123</UploadId></InitiateMultipartUploadResult>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    if (req.method === "PUT" && url.searchParams.has("partNumber")) {
      const partNumber = url.searchParams.get("partNumber")!;
      const uploadId = url.searchParams.get("uploadId")!;
      const bodyBytes = (await req.arrayBuffer()).byteLength;
      partsReceived.push({ partNumber, uploadId, bytes: bodyBytes });
      return new Response(null, {
        status: 200,
        headers: { etag: `"etag-part-${partNumber}"` },
      });
    }
    if (req.method === "POST" && url.searchParams.has("uploadId")) {
      completePayload = await req.text();
      return new Response(
        `<CompleteMultipartUploadResult><ETag>"final-etag"</ETag></CompleteMultipartUploadResult>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
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

  try {
    const body = new Uint8Array(PAYLOAD_BYTES);
    const result = await store.put("test/large.wav", body, { contentType: "audio/wav" });

    assertEquals(result.key, "test/large.wav");
    assertEquals(result.size, PAYLOAD_BYTES);
    assertEquals(result.etag, '"final-etag"');

    assertEquals(uploadsInitiated.length, 1);
    assertEquals(partsReceived.length, 3);
    assertEquals(partsReceived[0], {
      partNumber: "1",
      uploadId: "test-upload-123",
      bytes: 8 * 1024 * 1024,
    });
    assertEquals(partsReceived[1], {
      partNumber: "2",
      uploadId: "test-upload-123",
      bytes: 8 * 1024 * 1024,
    });
    assertEquals(partsReceived[2], {
      partNumber: "3",
      uploadId: "test-upload-123",
      bytes: 6 * 1024 * 1024,
    });

    assertStringIncludes(completePayload, '<PartNumber>1</PartNumber><ETag>"etag-part-1"</ETag>');
    assertStringIncludes(completePayload, '<PartNumber>2</PartNumber><ETag>"etag-part-2"</ETag>');
    assertStringIncludes(completePayload, '<PartNumber>3</PartNumber><ETag>"etag-part-3"</ETag>');
  } finally {
    await server.shutdown();
  }
});
