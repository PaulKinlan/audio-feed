/**
 * Real-user Core Web Vitals (audio-feed-i7vi / obs-4).
 *
 * ## This input is attacker-controlled
 *
 * A beacon comes from a browser, which means it comes from whoever is holding the browser. It gets
 * the same treatment as a CSP report (`audio-feed-kxjg`) and for the same reason: everything in it
 * is a string a stranger chose until this module says otherwise.
 *
 * Three rules, in order of how much they buy:
 *
 * 1. **Numbers only.** LCP and INP are milliseconds and CLS is a unitless ratio, so a field that is
 *    not a finite number inside a plausible range is not a metric and is refused outright. A
 *    capability or a script cannot survive that, which makes string handling unnecessary rather than
 *    careful. Nothing here is ever rendered unescaped either.
 * 2. **Allow-lists everywhere else.** The metric name and the page label are matched against the
 *    sets below; a page label is additionally rendered by the server, so the tolerated label is one
 *    this app chose rather than one the browser claims.
 * 3. **The typed event, never the request log.** A CWV report becomes a `cwv.report` record of its
 *    own. It is never folded into the request record: the request log normalises everything derived
 *    from a request to constants (`audio-feed-ao4s`), so smuggling a payload through it would either
 *    be a leak or a lie, and this beacon's whole content is a payload.
 *
 * ## Severity is the point
 *
 * A bad LCP and a slow synthesis are the same class of finding, so a metric whose value is in the
 * standard "needs improvement" or "poor" band is recorded at `warn` or `error`. That is what makes
 * it appear in obs-1's errors feed and in obs-3's poller output beside the traces, rather than in a
 * dashboard nobody looks at.
 */

import type { LogRecord } from "../storage/mod.ts";

/** The metrics this endpoint accepts. Anything else is not a metric this app measures. */
export const CWV_METRICS = ["lcp", "inp", "cls"] as const;
export type CwvMetric = typeof CWV_METRICS[number];

/**
 * The pages a report may be attributed to. Server-rendered, and re-validated here rather than
 * trusted: the label is the only string that survives into a record, so it is checked twice.
 */
export const CWV_PAGES = ["home", "listen", "admin", "account", "landing", "unknown"] as const;
export type CwvPage = typeof CWV_PAGES[number];

/**
 * Plausible bounds per metric, and the standard web-vitals bands.
 *
 * The bands are the published ones (good / needs improvement / poor) rather than thresholds invented
 * here, so a `warn` means what the rest of the industry means by it.
 */
const METRIC_RULES: Record<CwvMetric, {
  max: number;
  good: number;
  poor: number;
  unit: string;
}> = {
  // A page that took longer than an hour to paint is not a measurement.
  lcp: { max: 3_600_000, good: 2_500, poor: 4_000, unit: "ms" },
  inp: { max: 3_600_000, good: 200, poor: 500, unit: "ms" },
  // CLS is unitless; a score above 10 is not a layout shift score.
  cls: { max: 10, good: 0.1, poor: 0.25, unit: "" },
};

export interface CwvReport {
  metric: CwvMetric;
  value: number;
  page: CwvPage;
}

export type CwvParseResult = { ok: true; report: CwvReport } | { ok: false; reason: string };

/** The severity a metric value deserves, using the published bands. */
export function cwvSeverity(metric: CwvMetric, value: number): "info" | "warn" | "error" {
  const rule = METRIC_RULES[metric];
  if (value > rule.poor) return "error";
  if (value > rule.good) return "warn";
  return "info";
}

/**
 * Validate one beacon body. Accepts an unknown object and returns either a report or why not.
 *
 * Only the three fields it needs are read, so an oversized or exotic payload has no effect beyond
 * what these checks allow: there is no field for an attacker to smuggle anything through.
 */
export function parseCwvReport(input: unknown): CwvParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const source = input as Record<string, unknown>;

  const metric = source.metric;
  if (typeof metric !== "string" || !CWV_METRICS.includes(metric as CwvMetric)) {
    return { ok: false, reason: `metric must be one of: ${CWV_METRICS.join(", ")}` };
  }
  const name = metric as CwvMetric;

  const value = source.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, reason: "value must be a non-negative finite number" };
  }
  if (value > METRIC_RULES[name].max) {
    return { ok: false, reason: `value is beyond the plausible range for ${name}` };
  }

  // An unusable page label is not a reason to throw a measurement away: it is attributed to
  // "unknown", which is honest, rather than to whatever string arrived.
  const rawPage = source.page;
  const page = typeof rawPage === "string" && CWV_PAGES.includes(rawPage as CwvPage)
    ? rawPage as CwvPage
    : "unknown";

  return { ok: true, report: { metric: name, value, page } };
}

/** The typed record a validated report becomes. */
export function cwvRecord(report: CwvReport): Omit<LogRecord, "seq"> {
  const rule = METRIC_RULES[report.metric];
  const severity = cwvSeverity(report.metric, report.value);
  const shown = `${Math.round(report.value * 1000) / 1000}${rule.unit}`;
  return {
    time: new Date().toISOString(),
    severity,
    type: "cwv.report",
    // `app`: this arrives at the app from a browser, unlike the worker spans.
    process: "app",
    // Built from the validated metric, the rounded number and an allow-listed page: no part of this
    // string is a raw value from the request.
    message: `real-user ${report.metric.toUpperCase()} ${shown} on /${report.page}`,
    context: {
      metric: report.metric,
      value: report.value,
      page: report.page,
      unit: rule.unit || null,
    },
  };
}
