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
}

export type Handler<Ctx> = (c: RouteContext<Ctx>) => Response | Promise<Response>;

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

interface Route<Ctx> {
  method: Method;
  pattern: URLPattern;
  pathname: string;
  handler: Handler<Ctx>;
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

  async handle(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    // `HEAD` is served by the `GET` handler; the runtime drops the body.
    const method = (req.method === "HEAD" ? "GET" : req.method) as Method;

    const pathMatches: Route<Ctx>[] = [];

    for (const route of this.#routes) {
      const match = route.pattern.exec({ pathname: url.pathname });
      if (!match) continue;
      pathMatches.push(route);
      if (route.method !== method) continue;

      try {
        return await route.handler({
          req,
          params: match.pathname.groups,
          url,
          ctx,
        });
      } catch (error) {
        if (error instanceof HttpError) return error.response;
        throw error;
      }
    }

    if (pathMatches.length > 0) {
      const allow = [...new Set(pathMatches.map((r) => r.method))];
      if (allow.includes("GET")) allow.push("HEAD");
      return methodNotAllowed(allow);
    }

    return notFound(`No route for ${req.method} ${url.pathname}`);
  }

  /**
   * Wrap the dispatcher so an unexpected throw becomes a 500 instead of a
   * dropped connection, and is logged once with the request that caused it.
   */
  fetchHandler(ctx: Ctx): (req: Request) => Promise<Response> {
    return async (req) => {
      try {
        return await this.handle(req, ctx);
      } catch (error) {
        console.error(`[audio-feed] unhandled error for ${req.method} ${req.url}:`, error);
        return problem({ status: 500, title: "internal_error" });
      }
    };
  }
}
