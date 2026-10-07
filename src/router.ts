/**
 * Minimal `URLPattern` router. Deliberately small: no dependency, no middleware
 * tower, no plugin lifecycle. Lanes register routes; the dispatcher matches.
 *
 * Owned by: audio-feed-0h8.
 */

import { HttpError, methodNotAllowed, notFound, problem } from "./http.ts";

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
 * Sanitize a request URL for error logging by redacting capability tokens
 * (e.g. following /feed/ and /listen/) and stripping query parameters.
 *
 * Owned by: audio-feed-n2ha.
 */
export function sanitizeRequestUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "http://localhost");
    url.search = "";
    url.hash = "";
    const segments = url.pathname.split("/");
    for (let i = 0; i < segments.length; i++) {
      if ((segments[i] === "feed" || segments[i] === "listen") && i + 1 < segments.length) {
        if (segments[i + 1] !== "") {
          segments[i + 1] = "[redacted]";
        }
      }
    }
    url.pathname = segments.join("/");
    if (rawUrl.startsWith("/")) {
      return url.pathname;
    }
    return url.href;
  } catch {
    const withoutQuery = rawUrl.split("?")[0]?.split("#")[0] ?? "";
    return withoutQuery.replace(/(\/(?:feed|listen)\/)[^/]+/g, "$1[redacted]");
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
  opts?: { trustProxyHeaders?: boolean },
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
    if (!headers.has("content-security-policy")) {
      headers.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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
    const trustProxyHeaders = Boolean(
      (ctx as { config?: { trustProxyHeaders?: boolean } })?.config?.trustProxyHeaders,
    );
    const secOpts = { trustProxyHeaders };

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
  ): (
    req: Request,
    info?: { remoteAddr?: { hostname?: string } },
  ) => Promise<Response> {
    const trustProxyHeaders = Boolean(
      (ctx as { config?: { trustProxyHeaders?: boolean } })?.config?.trustProxyHeaders,
    );
    const secOpts = { trustProxyHeaders };

    return async (req, info) => {
      try {
        return await this.handle(req, ctx, info);
      } catch (error) {
        console.error(
          `[audio-feed] unhandled error for ${req.method} ${sanitizeRequestUrl(req.url)}:`,
          error,
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
