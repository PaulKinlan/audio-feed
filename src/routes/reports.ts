/**
 * CSP and Browser Reporting API endpoint (audio-feed-kxjg).
 *
 * Implements the W3C Reporting API v1 (application/reports+json) and legacy CSP Level 2
 * (application/csp-report) collection endpoint.
 *
 * Browsers flush security violations (CSP, COEP, Permissions-Policy), crashes, interventions,
 * deprecations, and network errors (NEL) to this endpoint.
 *
 * SECURITY:
 * Every field of a report is ATTACKER-CONTROLLED (blockedURL, script-sample, url, user_agent, etc.)
 * because the reporting endpoint is public and unauthenticated.
 * - String values are sanitized by stripping control characters and enforcing strict length caps.
 * - Dangerous object keys (__proto__, constructor, prototype) are discarded.
 * - Bounded stream reading stops at 64KiB + 1 bytes before allocation or JSON parsing (audio-feed-19db).
 * - Per-client rate limit and write budget protects the shared log store from flooding (audio-feed-jbpz).
 * - Reports are persisted into the structured log store (MetadataStore.appendLog) using the
 *   typed event family `report.*` (e.g. `report.csp-violation`, `report.crash`).
 * - Report contents are NEVER rendered unescaped in HTML or admin contexts.
 */

import type { AppContext } from "../app.ts";
import type { Handler } from "../router.ts";
import type { LogSeverity } from "../storage/mod.ts";
import { cleanString, MAX_LOG_MESSAGE_LENGTH, redactContext } from "../storage/log_shape.ts";
import {
  extractClientIp,
  type RateLimitConfig,
  SlidingWindowRateLimiter,
} from "../auth/rate_limit.ts";

/** Maximum payload size accepted on the reporting endpoint (64 KiB). */
export const MAX_REPORT_PAYLOAD_BYTES = 64 * 1024;

/** Maximum number of reports processed from a single request batch (audio-feed-jbpz). */
export const MAX_REPORTS_PER_BATCH = 10;

/** Maximum reports written per window per client (audio-feed-jbpz). */
export const DEFAULT_MAX_REPORTS_PER_WINDOW = 25;

/** Default sliding window rate limit for public reports endpoint (audio-feed-jbpz). */
export const DEFAULT_REPORTS_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 5,
};

export interface RawReportItem {
  type?: unknown;
  age?: unknown;
  url?: unknown;
  user_agent?: unknown;
  body?: unknown;
}

export interface SanitizedReport {
  type: string;
  url?: string;
  userAgent?: string;
  age?: number;
  body: Record<string, unknown>;
}

/** Known report types to log severity mapping. */
export const REPORT_SEVERITY: Record<string, LogSeverity> = {
  "crash": "error",
  "csp-violation": "warn",
  "network-error": "warn",
  "coep": "warn",
  "permissions-policy-violation": "warn",
  "intervention": "warn",
  "deprecation": "info",
};

/**
 * Filter out prototype-pollution vectors and clean primitive values in a report body.
 */
export function sanitizeReportBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 30);

  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const cleanKey = cleanString(key, 64);
    const value = record[key];

    if (typeof value === "string") {
      sanitized[cleanKey] = cleanString(value, 2048);
    } else if (
      typeof value === "number" || typeof value === "boolean" ||
      value === null
    ) {
      sanitized[cleanKey] = value;
    } else if (typeof value === "object") {
      sanitized[cleanKey] = redactContext(value);
    }
  }

  return sanitized;
}

/**
 * Sanitize an individual raw report, capping string lengths and stripping control characters.
 */
export function sanitizeReport(raw: RawReportItem): SanitizedReport {
  const typeStr = typeof raw.type === "string" ? raw.type.toLowerCase().trim() : "unknown";
  const type = cleanString(typeStr.replace(/[^a-z0-9_-]/g, ""), 64) || "unknown";

  const url = typeof raw.url === "string" ? cleanString(raw.url, 1024) : undefined;
  const userAgent = typeof raw.user_agent === "string"
    ? cleanString(raw.user_agent, 512)
    : undefined;
  const age = typeof raw.age === "number" && Number.isFinite(raw.age) && raw.age >= 0
    ? Math.floor(raw.age)
    : undefined;

  const body = sanitizeReportBody(raw.body);

  return {
    type,
    ...(url ? { url } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(age !== undefined ? { age } : {}),
    body,
  };
}

/**
 * Construct a safe, single-line human-readable summary for the log record.
 */
export function buildReportMessage(report: SanitizedReport): string {
  const { type, body, url } = report;

  switch (type) {
    case "csp-violation": {
      const directive = (body["effectiveDirective"] || body["violated-directive"] ||
        body["effective-directive"] || "") as string;
      const blocked = (body["blockedURL"] || body["blocked-uri"] || "") as string;
      const dirPart = directive ? `${directive} ` : "";
      const blockedPart = blocked ? `blocked ${blocked}` : "violation";
      const urlPart = url ? ` on ${url}` : "";
      return cleanString(
        `CSP violation: ${dirPart}${blockedPart}${urlPart}`,
        MAX_LOG_MESSAGE_LENGTH,
      );
    }
    case "crash": {
      const reason = (body["reason"] || "unspecified") as string;
      const urlPart = url ? ` on ${url}` : "";
      return cleanString(`Browser crash: reason=${reason}${urlPart}`, MAX_LOG_MESSAGE_LENGTH);
    }
    case "network-error": {
      const nelType = (body["type"] || "unknown") as string;
      const phase = (body["phase"] || "unknown") as string;
      const status = body["status_code"] !== undefined ? ` status=${body["status_code"]}` : "";
      const urlPart = url ? ` on ${url}` : "";
      return cleanString(
        `Network error (NEL): type=${nelType} phase=${phase}${status}${urlPart}`,
        MAX_LOG_MESSAGE_LENGTH,
      );
    }
    case "deprecation": {
      const id = (body["id"] || "unknown") as string;
      const urlPart = url ? ` on ${url}` : "";
      return cleanString(`Browser feature deprecation: id=${id}${urlPart}`, MAX_LOG_MESSAGE_LENGTH);
    }
    case "intervention": {
      const id = (body["id"] || "unknown") as string;
      const urlPart = url ? ` on ${url}` : "";
      return cleanString(`Browser intervention: id=${id}${urlPart}`, MAX_LOG_MESSAGE_LENGTH);
    }
    case "coep": {
      const blocked = (body["blockedURL"] || "") as string;
      const blockedPart = blocked ? `blocked ${blocked}` : "violation";
      const urlPart = url ? ` on ${url}` : "";
      return cleanString(`COEP violation: ${blockedPart}${urlPart}`, MAX_LOG_MESSAGE_LENGTH);
    }
    case "permissions-policy-violation": {
      const feature = (body["featureId"] || "unknown") as string;
      const urlPart = url ? ` on ${url}` : "";
      return cleanString(
        `Permissions policy violation: feature=${feature}${urlPart}`,
        MAX_LOG_MESSAGE_LENGTH,
      );
    }
    default: {
      const urlPart = url ? ` on ${url}` : "";
      return cleanString(`Browser report: ${type}${urlPart}`, MAX_LOG_MESSAGE_LENGTH);
    }
  }
}

/**
 * Bounded stream reader for request bodies (audio-feed-19db).
 * Stops reading as soon as totalBytes exceeds maxBytes (without buffering the rest).
 */
export async function readBoundedBody(
  req: Request,
  maxBytes: number = MAX_REPORT_PAYLOAD_BYTES,
): Promise<{ ok: true; text: string } | { ok: false; status: 413 | 400 }> {
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      if (req.body) {
        await req.body.cancel("payload_too_large").catch(() => {});
      }
      return { ok: false, status: 413 };
    }
  }

  if (!req.body) {
    return { ok: true, text: "" };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("payload_too_large").catch(() => {});
          return { ok: false, status: 413 };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, status: 400 };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(combined) };
}

/**
 * Handle incoming CSP and Reporting API payloads with rate limiting and bounded reading.
 */
export function createCspReportsHandler(
  ctx: AppContext,
  deps: {
    rateLimiter?: SlidingWindowRateLimiter;
    rateLimitConfig?: RateLimitConfig;
    maxReportsPerBatch?: number;
    maxReportsPerWindow?: number;
  } = {},
): Handler<AppContext> {
  const limiter = deps.rateLimiter ??
    new SlidingWindowRateLimiter(
      deps.rateLimitConfig ?? DEFAULT_REPORTS_RATE_LIMIT,
      ctx.stores.metadata,
      "reports:csp",
    );
  const maxBatch = deps.maxReportsPerBatch ?? MAX_REPORTS_PER_BATCH;
  const maxPerWindow = deps.maxReportsPerWindow ?? DEFAULT_MAX_REPORTS_PER_WINDOW;

  return async ({ req, remoteAddr }) => {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "allow": "POST, OPTIONS",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (req.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { "allow": "POST, OPTIONS" },
      });
    }

    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    const isReportsJson = contentType.includes("application/reports+json");
    const isCspReport = contentType.includes("application/csp-report");
    const isJson = contentType.includes("application/json");

    if (!isReportsJson && !isCspReport && !isJson) {
      // Flush cleanly for unknown or unsupported browser headers
      return new Response(null, { status: 204 });
    }

    // Rate limit check (audio-feed-jbpz): public endpoint must not flood the error store
    const clientKey = extractClientIp(
      req,
      Boolean(ctx.config.trustProxyHeaders),
      remoteAddr,
    );
    const rateResult = await limiter.check(clientKey);
    if (!rateResult.allowed) {
      return new Response(null, {
        status: 429,
        headers: {
          "retry-after": Math.max(1, Math.ceil(rateResult.resetMs / 1000)).toString(),
        },
      });
    }

    // Bounded stream read (audio-feed-19db): stop reading as soon as limit is exceeded
    const bodyResult = await readBoundedBody(req, MAX_REPORT_PAYLOAD_BYTES);
    if (!bodyResult.ok) {
      return new Response(null, {
        status: bodyResult.status,
        headers: { "connection": "close" },
      });
    }

    const text = bodyResult.text;
    if (!text.trim()) {
      return new Response(null, { status: 204 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400 });
    }

    const rawReports: RawReportItem[] = [];

    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(0, maxBatch)) {
        if (item && typeof item === "object") {
          rawReports.push(item as RawReportItem);
        }
      }
    } else if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (
        "csp-report" in record && record["csp-report"] &&
        typeof record["csp-report"] === "object"
      ) {
        // Legacy application/csp-report format
        const csp = record["csp-report"] as Record<string, unknown>;
        rawReports.push({
          type: "csp-violation",
          url: csp["document-uri"],
          user_agent: req.headers.get("user-agent") ?? undefined,
          body: csp,
        });
      } else if (typeof record.type === "string") {
        rawReports.push(record as RawReportItem);
      }
    }

    if (rawReports.length === 0) {
      return new Response(null, { status: 204 });
    }

    // Per-window write budget check (audio-feed-jbpz): cap total reports stored per client window
    const now = Date.now();
    const windowStart = now -
      (deps.rateLimitConfig?.windowMs ?? DEFAULT_REPORTS_RATE_LIMIT.windowMs);
    let budgetAdmitted = false;
    await ctx.stores.metadata.atomicUpdate<number[]>(
      `reports:budget:${clientKey}`,
      (current) => {
        const active = (current ?? []).filter((t) => t > windowStart);
        if (active.length + rawReports.length > maxPerWindow) {
          budgetAdmitted = false;
          return active;
        }
        for (let i = 0; i < rawReports.length; i++) {
          active.push(now);
        }
        budgetAdmitted = true;
        return active;
      },
      (deps.rateLimitConfig?.windowMs ?? DEFAULT_REPORTS_RATE_LIMIT.windowMs) * 2,
    );

    if (!budgetAdmitted) {
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }

    const defaultUserAgent = req.headers.get("user-agent") ?? undefined;

    for (const raw of rawReports) {
      if (!raw.user_agent && defaultUserAgent) {
        raw.user_agent = defaultUserAgent;
      }
      const report = sanitizeReport(raw);
      const severity = REPORT_SEVERITY[report.type] ?? "warn";
      const type = `report.${report.type}`;
      const message = buildReportMessage(report);

      await ctx.stores.metadata.appendLog({
        time: new Date().toISOString(),
        severity,
        type,
        message,
        process: "app",
        route: "/api/reports/csp",
        context: {
          reportType: report.type,
          ...(report.url ? { url: report.url } : {}),
          ...(report.userAgent ? { userAgent: report.userAgent } : {}),
          ...(report.age !== undefined ? { age: report.age } : {}),
          body: report.body,
        },
      });
    }

    return new Response(null, { status: 204 });
  };
}

/** Default singleton handler delegating to createCspReportsHandler. */
export const handleCspReports: Handler<AppContext> = (req) => {
  return createCspReportsHandler(req.ctx)(req);
};
