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

/** Fallback marker recorded when a request host is malformed or looks like a capability token. */
export const OTHER_HOST = "<other>";

/**
 * Normalise the request's effective host before it becomes a log field (audio-feed-4y9v).
 *
 * Derived from the same surface the host gate inspects (`x-forwarded-host` only when
 * `trustProxyHeaders` is enabled, otherwise `new URL(req.url).hostname`), lowercased, stripped of
 * IPv6 brackets and trailing dot, and screened to a bounded syntactic DNS hostname, IPv4/IPv6
 * literal, or `localhost`. Anything malformed, single-label (other than `localhost`), or carrying a
 * capability-shaped / mixed-case token label records `<other>` so a secret or canary placed in a
 * Host or `x-forwarded-host` header can never reach the durable store (audio-feed-sw1r,
 * audio-feed-ao4s).
 */
export function normaliseRequestHost(req: Request, trustProxyHeaders?: boolean): string {
  let raw = "";
  if (trustProxyHeaders) {
    const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (forwarded) {
      if (/[A-Z]/.test(forwarded)) return OTHER_HOST;
      try {
        raw = new URL(`https://${forwarded}`).hostname;
      } catch {
        return OTHER_HOST;
      }
    }
  }
  if (!raw) {
    try {
      raw = new URL(req.url).hostname;
    } catch {
      return OTHER_HOST;
    }
  }
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare || bare.length > 128) return OTHER_HOST;
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "0.0.0.0") {
    return bare;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) {
    const octets = bare.split(".").map(Number);
    return octets.every((n) => n >= 0 && n <= 255) ? bare : OTHER_HOST;
  }
  if (bare.includes(":") && /^[0-9a-f:]+$/.test(bare)) {
    return bare;
  }
  const labels = bare.split(".");
  if (labels.length < 2 || labels.length > 8) return OTHER_HOST;
  const tld = labels[labels.length - 1]!;
  if (!/^[a-z]{2,24}$/.test(tld)) return OTHER_HOST;
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return OTHER_HOST;
    // Reject UUIDs, long hex strings, or unhyphenated mixed-alphanumeric capability tokens.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(label)) {
      return OTHER_HOST;
    }
    if (/^[0-9a-f]{16,}$/.test(label)) return OTHER_HOST;
    if (!label.includes("-") && /[a-z]/.test(label) && /\d/.test(label) && label.length >= 12) {
      return OTHER_HOST;
    }
    if (label.length > 32 && label.split("-").some((part) => part.length > 16)) {
      return OTHER_HOST;
    }
  }
  return bare;
}

/**
 * Bounded stream reader for request bodies (audio-feed-19db; moved here from
 * src/routes/reports.ts so every public body read shares one implementation,
 * audio-feed-oxw5g). Stops reading as soon as totalBytes exceeds maxBytes
 * (without buffering the rest). A declared content-length over the cap is
 * refused before the body is touched at all; a chunked or lying declared
 * length is bounded BY CONSTRUCTION on the read.
 */
export async function readBoundedBody(
  req: Request,
  maxBytes: number,
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
