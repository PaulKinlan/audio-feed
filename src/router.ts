/**
 * Minimal `URLPattern` router. Deliberately small: no dependency, no middleware
 * tower, no plugin lifecycle. Lanes register routes; the dispatcher matches.
 *
 * Owned by: audio-feed-0h8.
 */

import { UNMATCHED_ROUTE } from "./request_route.ts";
import { HttpError, methodNotAllowed, notFound, problem } from "./http.ts";
import { cspReportOrigin, type OriginConfig } from "./origin.ts";
import { screenErrorForLogging } from "./observability/error_screen.ts";

export type Params = Record<string, string | undefined>;

export interface RouteContext<Ctx> {
  req: Request;
  params: Params;
  url: URL;
  ctx: Ctx;
  remoteAddr?: string;
}

export type Handler<Ctx> = (c: RouteContext<Ctx>) => Response | Promise<Response>;

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

interface Route<Ctx> {
  method: Method;
  pattern: URLPattern;
  pathname: string;
  handler: Handler<Ctx>;
}

/**
 * Redact an audio capability key for logging.
 *
 * Owned by: audio-feed-0eae, audio-feed-f9wf.
 */
export function redactAudioKey(_key?: unknown): string {
  return "[redacted]";
}

/**
 * Sanitize a request URL for error logging by redacting capability tokens
 * (e.g. following /feed/ and /listen/) and stripping query parameters.
 *
 * Owned by: audio-feed-n2ha; /audio/ redaction added by audio-feed-0eae:
 * the enclosure key is a multi-segment capability (`/audio/:key+`), so
 * EVERYTHING after /audio/ is redacted, not just the next segment.
 */
export function sanitizeRequestUrl(rawUrl: unknown): string {
  const raw = String(rawUrl ?? "");
  try {
    const url = new URL(raw, "http://localhost");
    url.search = "";
    url.hash = "";
    const segments = url.pathname.split("/");
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === "audio" && i + 1 < segments.length) {
        if (segments.slice(i + 1).some((s) => s !== "")) {
          // Multi-segment key: collapse the whole tail.
          segments.length = i + 1;
          segments.push("[redacted]");
          break;
        }
      }
      if ((segments[i] === "feed" || segments[i] === "listen") && i + 1 < segments.length) {
        if (segments[i + 1] !== "") {
          segments[i + 1] = "[redacted]";
        }
      }
    }
    url.pathname = segments.join("/");
    if (raw.startsWith("/")) {
      return url.pathname;
    }
    return url.href;
  } catch {
    const withoutQuery = raw.split("?")[0]?.split("#")[0] ?? "";
    return withoutQuery
      .replace(/(\/audio\/).+$/g, "$1[redacted]")
      .replace(/(\/(?:feed|listen)\/)[^/]+/g, "$1[redacted]");
  }
}

/** Check if the request arrived over HTTPS directly or through a trusted TLS-terminating reverse proxy. */
export function isHttpsRequest(
  req: Request,
  optsOrTrustProxy?: boolean | { trustProxyHeaders?: boolean },
): boolean {
  try {
    const url = new URL(req.url);
    if (url.protocol === "https:") return true;
  } catch {
    // ignore
  }
  const trustProxy = typeof optsOrTrustProxy === "boolean"
    ? optsOrTrustProxy
    : Boolean(optsOrTrustProxy?.trustProxyHeaders);
  if (trustProxy) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    return proto === "https";
  }
  return false;
}

/**
 * Baseline security headers applied centrally to HTTP responses.
 *
 * Sets Content-Security-Policy (with sensible rules compatible with existing pages),
 * X-Content-Type-Options: nosniff, frame-ancestors 'none' / X-Frame-Options: DENY,
 * and Strict-Transport-Security on HTTPS requests.
 *
 * Owned by: audio-feed-8k19.
 */
export function applySecurityHeaders(
  res: Response,
  req?: Request,
  opts?: OriginConfig,
): Response {
  let headers: Headers;
  let recreated = false;

  try {
    res.headers.set("_test", "1");
    res.headers.delete("_test");
    headers = res.headers;
  } catch {
    headers = new Headers(res.headers);
    recreated = true;
  }

  const contentType = (headers.get("content-type") ?? "").toLowerCase();
  const isHtml = contentType.includes("text/html");
  const isJson = contentType.includes("application/json") ||
    contentType.includes("application/problem+json");

  if (!headers.has("x-content-type-options")) {
    headers.set("x-content-type-options", "nosniff");
  }

  if (isHtml) {
    // audio-feed-s2esl: the report target comes from CONFIGURATION, never from the request's `Host`
    // header. The host gate inspects `new URL(req.url)`, so "allowed URL, attacker-chosen Host"
    // used to pass it and have that host written into three response headers. See
    // `cspReportOrigin` for the precedence and for why the request may contribute a SCHEME only.
    const reportOrigin = cspReportOrigin(opts ?? {}, {
      url: req?.url,
      https: req ? isHttpsRequest(req, opts) : undefined,
    });
    const reportUrl = `${reportOrigin}/api/reports/csp`;

    if (!headers.has("content-security-policy")) {
      // Fallback only: every HTML route attaches the nonce-bearing policy itself via
      // `htmlResponse` (audio-feed-syhu). This default is deliberately strict — no
      // 'unsafe-inline' — so a new HTML route that forgets its nonce fails visibly instead of
      // quietly re-opening inline script. See src/routes/csp.ts.
      headers.set(
        "content-security-policy",
        `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; media-src 'self' blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; report-to csp-endpoint; report-uri ${reportUrl}`,
      );
    } else {
      let csp = headers.get("content-security-policy")!;
      if (!csp.includes("report-to")) {
        csp = `${csp}; report-to csp-endpoint`;
      }
      if (!csp.includes("report-uri")) {
        csp = `${csp}; report-uri ${reportUrl}`;
      }
      headers.set("content-security-policy", csp);
    }

    if (!headers.has("reporting-endpoints")) {
      headers.set("reporting-endpoints", `csp-endpoint="${reportUrl}"`);
    }

    if (!headers.has("report-to")) {
      headers.set(
        "report-to",
        [
          JSON.stringify({
            group: "csp-endpoint",
            max_age: 10886400,
            endpoints: [{ url: reportUrl }],
          }),
          JSON.stringify({
            group: "network-errors",
            max_age: 2592000,
            endpoints: [{ url: reportUrl }],
          }),
        ].join(", "),
      );
    }

    if (!headers.has("nel")) {
      headers.set(
        "nel",
        JSON.stringify({
          report_to: "network-errors",
          max_age: 2592000,
        }),
      );
    }

    if (!headers.has("x-frame-options")) {
      headers.set("x-frame-options", "DENY");
    }
  } else if (isJson) {
    if (!headers.has("content-security-policy")) {
      headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    }
    if (!headers.has("x-frame-options")) {
      headers.set("x-frame-options", "DENY");
    }
  }

  if (req && isHttpsRequest(req, opts)) {
    if (!headers.has("strict-transport-security")) {
      headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
  }

  if (recreated) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
  return res;
}

/**
 * The configuration `applySecurityHeaders` needs, read off an optional ctx config.
 *
 * One place, because every header decision that must not become request-derived (audio-feed-s2esl)
 * depends on this being the SAME set of inputs for every call site.
 */
function securityOptions(ctx: unknown): OriginConfig {
  const config = (ctx as { config?: OriginConfig } | undefined)?.config;
  return {
    trustProxyHeaders: Boolean(config?.trustProxyHeaders),
    publicBaseUrl: config?.publicBaseUrl,
    allowedHosts: config?.allowedHosts,
  };
}

export class Router<Ctx> {
  readonly #routes: Route<Ctx>[] = [];

  add(method: Method, pathname: string, handler: Handler<Ctx>): this {
    this.#routes.push({
      method,
      pathname,
      pattern: new URLPattern({ pathname }),
      handler,
    });
    return this;
  }

  get(pathname: string, handler: Handler<Ctx>): this {
    return this.add("GET", pathname, handler);
  }
  post(pathname: string, handler: Handler<Ctx>): this {
    return this.add("POST", pathname, handler);
  }
  put(pathname: string, handler: Handler<Ctx>): this {
    return this.add("PUT", pathname, handler);
  }
  patch(pathname: string, handler: Handler<Ctx>): this {
    return this.add("PATCH", pathname, handler);
  }
  delete(pathname: string, handler: Handler<Ctx>): this {
    return this.add("DELETE", pathname, handler);
  }

  /** Registered routes, for diagnostics and the route-collision test. */
  list(): ReadonlyArray<{ method: Method; pathname: string }> {
    return this.#routes.map(({ method, pathname }) => ({ method, pathname }));
  }

  /**
   * The registered pattern a URL matches, or the unmatched marker (audio-feed-wzv9).
   *
   * A PURE LOOKUP, deliberately, rather than something recorded on the Request as it is dispatched:
   * the app rebuilds a Request during canonical-host handling, so anything keyed by request identity
   * silently degrades to "unmatched" for exactly those requests — a log field that quietly becomes
   * useless. Looking the URL up in the route table has no such failure mode, and it is the same
   * table the dispatch above uses.
   *
   * The recorded value is therefore always a constant: a pattern from this table, or the marker.
   */
  routePatternFor(url: URL): string {
    for (const route of this.#routes) {
      if (route.pattern.exec({ pathname: url.pathname })) return route.pathname;
    }
    return UNMATCHED_ROUTE;
  }

  async handle(
    req: Request,
    ctx: Ctx,
    info?: { remoteAddr?: { hostname?: string } },
  ): Promise<Response> {
    const url = new URL(req.url);
    // `HEAD` is served by the `GET` handler; the runtime drops the body.
    const method = (req.method === "HEAD" ? "GET" : req.method) as Method;

    const pathMatches: Route<Ctx>[] = [];
    const remoteAddr = info?.remoteAddr?.hostname;
    const secOpts = securityOptions(ctx);

    for (const route of this.#routes) {
      const match = route.pattern.exec({ pathname: url.pathname });
      if (!match) continue;
      pathMatches.push(route);
      if (route.method !== method) continue;

      try {
        const res = await route.handler({
          req,
          params: match.pathname.groups,
          url,
          ctx,
          remoteAddr,
        });
        return applySecurityHeaders(res, req, secOpts);
      } catch (error) {
        if (error instanceof HttpError) return applySecurityHeaders(error.response, req, secOpts);
        throw error;
      }
    }

    if (pathMatches.length > 0) {
      const allow = [...new Set(pathMatches.map((r) => r.method))];
      if (allow.includes("GET")) allow.push("HEAD");
      return applySecurityHeaders(methodNotAllowed(allow), req, secOpts);
    }

    return applySecurityHeaders(
      notFound(`No route for ${req.method} ${sanitizeRequestUrl(url.pathname)}`),
      req,
      secOpts,
    );
  }

  /**
   * Wrap the dispatcher so an unexpected throw becomes a 500 instead of a
   * dropped connection, and is logged once with the request that caused it.
   */
  fetchHandler(
    ctx: Ctx,
    /**
     * audio-feed-sw1r: called with the error on the path where an unhandled throw is ACTUALLY caught - this
     * one, not the server wrapper's. The wrapper's own catch is unreachable for a handler throw because this
     * method catches first and answers 500, so a screen applied only there would guard a record that no
     * request produces; the canary invariant test drives a route that throws and it must reach the store.
     */
    onUnhandledError?: (error: unknown, req: Request) => void | Promise<void>,
  ): (
    req: Request,
    info?: { remoteAddr?: { hostname?: string } },
  ) => Promise<Response> {
    const secOpts = securityOptions(ctx);

    return async (req, info) => {
      try {
        return await this.handle(req, ctx, info);
      } catch (error) {
        await onUnhandledError?.(error, req);
        // audio-feed-ahx5 / audio-feed-067d: Screen error and route before logging to operational stderr.
        // A request path is client-supplied and may contain arbitrary attacker-chosen tokens (audio-feed-067d).
        // Logging this.routePatternFor(url) records a compile-time constant from the route table
        // (or UNMATCHED_ROUTE) rather than user-controlled path segments. Method is validated against
        // standard HTTP methods, and screenErrorForLogging sanitizes error name, message, and stack.
        let route = UNMATCHED_ROUTE;
        try {
          route = this.routePatternFor(new URL(req.url));
        } catch {
          route = UNMATCHED_ROUTE;
        }
        const method = typeof req.method === "string" && /^[A-Z]{3,7}$/.test(req.method)
          ? req.method
          : "UNKNOWN";
        console.error(
          `[audio-feed] unhandled error for ${method} ${route}:`,
          screenErrorForLogging(error),
        );
        return applySecurityHeaders(
          problem({ status: 500, title: "internal_error" }),
          req,
          secOpts,
        );
      }
    };
  }
}
