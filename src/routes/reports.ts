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
 * - Reports are persisted into the structured log store (MetadataStore.appendLog) using the
 *   typed event family `report.*` (e.g. `report.csp-violation`, `report.crash`).
 * - Report contents are NEVER rendered unescaped in HTML or admin contexts.
 */

import type { AppContext } from "../app.ts";
import type { Handler } from "../router.ts";
import type { LogSeverity } from "../storage/mod.ts";
import { cleanString, MAX_LOG_MESSAGE_LENGTH, redactContext } from "../storage/log_shape.ts";

/** Maximum payload size accepted on the reporting endpoint (64 KiB). */
export const MAX_REPORT_PAYLOAD_BYTES = 64 * 1024;

/** Maximum number of reports processed from a single batch. */
export const MAX_REPORTS_PER_BATCH = 50;

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
 * Handle incoming CSP and Reporting API payloads.
 */
export const handleCspReports: Handler<AppContext> = async ({ req, ctx }) => {
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

  // Safe bounded body read
  let text = "";
  try {
    const rawBytes = await req.arrayBuffer();
    if (rawBytes.byteLength > MAX_REPORT_PAYLOAD_BYTES) {
      return new Response(null, { status: 413 });
    }
    text = new TextDecoder().decode(rawBytes);
  } catch {
    return new Response(null, { status: 400 });
  }

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
    for (const item of parsed.slice(0, MAX_REPORTS_PER_BATCH)) {
      if (item && typeof item === "object") {
        rawReports.push(item as RawReportItem);
      }
    }
  } else if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (
      "csp-report" in record && record["csp-report"] && typeof record["csp-report"] === "object"
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
