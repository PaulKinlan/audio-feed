/**
 * The Core Web Vitals beacon (audio-feed-i7vi / obs-4).
 *
 * POST /api/cwv  { metric: "lcp"|"inp"|"cls", value: <number>, page?: <label> }  -> 204
 *
 * Unauthenticated, because it is sent by a browser on a page anyone can load, and bounded because
 * that makes it a public write endpoint: a strict JSON body, a size limit, a metric/value allow-list
 * and a per-client rate limit, so the most a stranger can do is fill the retained window with
 * reports that fail validation and are counted against them.
 *
 * It answers 204 with no body: nothing about the payload is echoed, so there is no reflection surface
 * and nothing for a prober to learn. The record it writes is typed `cwv.report` — see
 * src/observability/cwv.ts for why this never goes through the request log.
 */

import type { AppContext } from "../app.ts";
import type { Handler } from "../router.ts";
import { problem } from "../http.ts";
import { extractClientIp, SlidingWindowRateLimiter } from "../auth/rate_limit.ts";
import { cwvRecord, parseCwvReport } from "../observability/cwv.ts";

/** Enough for the documented payload with room to spare; anything larger is not a CWV beacon. */
export const MAX_CWV_BODY_BYTES = 4 * 1024;

/**
 * Per-client limit. A real page sends three of these over its whole life, so this is far above any
 * legitimate behaviour and exists only to stop a loop filling the store.
 */
export const CWV_RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 } as const;

export interface CwvDeps {
  limiter?: SlidingWindowRateLimiter;
}

/**
 * Copy at most `cap + 1` bytes out of `source`, then fail.
 *
 * The point is that the BOUND IS THE STREAM, not a check afterwards (audio-feed-6q9g). Reading the raw
 * body and comparing the running total means an attacker who sends one oversized chunk has already had
 * that chunk handed to the handler before any check runs; a stream that cannot emit more than `cap + 1`
 * bytes makes the limit a property of the shape of the data instead. `cap + 1` rather than `cap`
 * because one byte past the limit is what distinguishes "exactly the limit" from "over it".
 *
 * What this does and does not bound, stated plainly: nothing beyond `cap + 1` bytes is ever copied into
 * the handler's accumulation, and the source is cancelled on overflow. The platform may still hand the
 * transformer a larger chunk internally - that is the runtime's buffer and not ours to size - but it
 * never reaches the parse, and the bytes we hold are bounded by construction.
 */
export function limitBodyStream(
  source: ReadableStream<Uint8Array>,
  cap: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let emitted = 0;
  let over = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (over) {
        await reader.cancel().catch(() => {});
        controller.error(new Error("body exceeds cap"));
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (!value?.byteLength) return;
      const room = cap + 1 - emitted;
      if (value.byteLength >= room) {
        over = true;
        emitted += room;
        controller.enqueue(value.subarray(0, room));
        return;
      }
      emitted += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      over = true;
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** Read a body that cannot yield more than `cap + 1` bytes; `overflow` means it tried to. */
async function readCappedBody(
  body: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ chunks: Uint8Array[]; total: number; overflow: boolean }> {
  const limited = limitBodyStream(body, cap).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await limited.read();
    } catch {
      return { chunks, total, overflow: true };
    }
    if (read.done) break;
    if (!read.value?.byteLength) continue;
    total += read.value.byteLength;
    if (total > cap) return { chunks, total, overflow: true };
    chunks.push(read.value);
  }
  return { chunks, total, overflow: false };
}

export function createCwvHandler(ctx: AppContext, deps: CwvDeps = {}): Handler<AppContext> {
  // Namespaced so this window cannot collide with the admin or request-access windows on the same
  // client (audio-feed-2zvc).
  const limiter = deps.limiter ??
    new SlidingWindowRateLimiter(CWV_RATE_LIMIT, ctx.stores.metadata, "cwv");

  return async ({ req, remoteAddr }) => {
    if (req.method !== "POST") {
      return problem({ status: 405, title: "method_not_allowed", detail: "POST a CWV beacon." });
    }

    const limit = await limiter.check(
      // The router hands a handler the address as a string, not the runtime's info object.
      extractClientIp(req, Boolean(ctx.config.trustProxyHeaders), remoteAddr),
    );
    if (!limit.allowed) {
      const refused = problem({
        status: 429,
        title: "too_many_reports",
        detail: "Too many CWV reports from this client; retry later.",
      });
      // Same header and the same window-derived value as every other refusal in this tree, and the
      // same one-second floor they all clamp to: the limiter floors its own reset at 0
      // (`#untilOldestExpires`), so an unclamped `Math.ceil` can answer `retry-after: 0` — which
      // reads as "retry now" and is not what a refusal means.
      refused.headers.set(
        "retry-after",
        String(Math.max(1, Math.ceil(limit.resetMs / 1000))),
      );
      return refused;
    }

    // A declared size is a cheap fast path, nothing more: a chunked body declares none, and a
    // declared one can be a lie (audio-feed-6q9g). The real bound is on the READ, below.
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_CWV_BODY_BYTES) {
      return problem({ status: 413, title: "payload_too_large", detail: "CWV beacons are small." });
    }
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return problem({
        status: 415,
        title: "unsupported_media_type",
        detail: "Send the beacon as application/json.",
      });
    }

    let parsed: unknown;
    try {
      // The read is bounded BY CONSTRUCTION (audio-feed-6q9g, round 2): readCappedBody reads a stream
      // that cannot emit more than cap + 1 bytes, so an oversized chunk - however it is chunked, even
      // as one 8MiB slice - is truncated before this handler accumulates anything, and a byte count is
      // used rather than a character count because a multibyte body passes a length check while being
      // several times the size. A declared content-length over the cap is refused before the body is
      // touched at all.
      if (!req.body) {
        return problem({
          status: 400,
          title: "invalid_report",
          detail: "A CWV beacon must have a JSON body.",
        });
      }
      const capped = await readCappedBody(req.body, MAX_CWV_BODY_BYTES);
      if (capped.overflow) {
        return problem({
          status: 413,
          title: "payload_too_large",
          detail: "CWV beacons are small.",
        });
      }
      const chunks = capped.chunks;
      const total = capped.total;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return problem({ status: 400, title: "invalid_body", detail: "Body must be JSON." });
    }

    const result = parseCwvReport(parsed);
    if (!result.ok) {
      // The reason names the field and the allowed values, never the value that was sent.
      return problem({ status: 400, title: "invalid_report", detail: result.reason });
    }

    await ctx.stores.metadata.appendLog(cwvRecord(result.report));
    // No body: nothing is echoed back, so there is nothing here to reflect.
    return new Response(null, { status: 204 });
  };
}
