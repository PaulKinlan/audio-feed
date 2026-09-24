/**
 * HTTP helpers shared by every lane's handlers.
 *
 * Owned by: audio-feed-0h8.
 */

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

export function xml(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

export interface ProblemInit {
  status: number;
  title: string;
  detail?: string;
}

/**
 * Error responses carry a stable shape so clients (and tests) can assert on it
 * instead of scraping prose.
 */
export function problem({ status, title, detail }: ProblemInit): Response {
  return json({ error: title, ...(detail ? { detail } : {}) }, { status });
}

export const badRequest = (detail?: string) =>
  problem({ status: 400, title: "bad_request", detail });
export const unauthorized = (detail?: string) =>
  problem({ status: 401, title: "unauthorized", detail });
export const forbidden = (detail?: string) => problem({ status: 403, title: "forbidden", detail });
export const notFound = (detail?: string) => problem({ status: 404, title: "not_found", detail });
export const methodNotAllowed = (allow: string[]) =>
  problem({ status: 405, title: "method_not_allowed", detail: `Allowed: ${allow.join(", ")}` });

/** Thrown by handlers to short-circuit with a specific response. */
export class HttpError extends Error {
  constructor(readonly response: Response) {
    super(`HTTP ${response.status}`);
    this.name = "HttpError";
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(badRequest("Expected content-type: application/json"));
  }
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(badRequest("Malformed JSON body"));
  }
}
