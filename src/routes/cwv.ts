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
      refused.headers.set("retry-after", String(Math.ceil(limit.resetMs / 1000)));
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
      // STOP READING at `cap + 1` BYTES (audio-feed-6q9g). Two earlier mistakes are both avoided
      // here: a character count is not a byte count (a multibyte body passes a length check while
      // being several times the size), and reading the whole body before measuring it means the cap
      // is enforced after the process has already paid for the memory. Nothing past the cap is read,
      // so an oversized body costs one byte more, and refusing it is the only outcome.
      const reader = req.body?.getReader();
      if (!reader) {
        return problem({
          status: 400,
          title: "invalid_report",
          detail: "A CWV beacon must have a JSON body.",
        });
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (total > MAX_CWV_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return problem({
            status: 413,
            title: "payload_too_large",
            detail: "CWV beacons are small.",
          });
        }
        chunks.push(value);
      }
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
