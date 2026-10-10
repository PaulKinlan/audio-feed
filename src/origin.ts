/**
 * Public origin resolution (audio-feed-0k3).
 *
 * The deployed service told visitors to subscribe to
 * `http://localhost:8000/feed/...`, because `PUBLIC_BASE_URL` is unset on Deno
 * Deploy and the config fell back to a localhost guess. Feed `selfUrl` and
 * enclosure `audioUrl` are built from the same value, so a generated feed
 * advertised audio no podcast client could ever fetch.
 *
 * The process does not know its own public origin. The REQUEST does. So the
 * origin is resolved per request rather than guessed at boot.
 *
 * ─── Why this does not simply trust `x-forwarded-host` ────────────────────────
 *
 * `x-forwarded-*` are hop-by-hop headers. Any client can set them and nothing
 * strips them unless a proxy is configured to. Measured against a real
 * `Deno.serve` handler:
 *
 *   x-forwarded-host: evil.example   -> arrives verbatim
 *   raw socket, Host: evil.example   -> request.url becomes http://evil.example/
 *
 * Both are attacker-controlled, so an origin derived from either is
 * attacker-controlled too. That matters because the resolved origin is printed
 * into a page that tells people where to send a feed token — and a feed token
 * is a bearer credential. A spoofed origin in a *cacheable* document would hand
 * every later visitor a URL pointing at someone else's host.
 *
 * So:
 *   - explicit configuration always wins;
 *   - otherwise the origin comes from `request.url`, which on Deploy is the
 *     hostname that actually routed the request;
 *   - `x-forwarded-*` are honoured only when an operator has explicitly said a
 *     trusted proxy is in front (`TRUST_PROXY_HEADERS=1`), because only they
 *     can know that client-supplied values are stripped upstream;
 *   - callers are told WHICH of those happened, so a response whose content
 *     depends on the request host is never stored in a shared cache.
 */

export interface OriginConfig {
  /** Explicit public origin. Wins whenever it is set to something usable. */
  publicBaseUrl?: string;
  /**
   * Opt in to `x-forwarded-proto` / `x-forwarded-host`.
   *
   * Only meaningful behind a proxy that overwrites client-supplied values. Off
   * by default: a default that trusts request headers is a default that lets a
   * client choose the origin.
   */
  trustProxyHeaders?: boolean;
  /**
   * The hosts this deployment is willing to advertise (audio-feed-fp4r).
   *
   * Without it, the advertised origin — and with it feed `selfUrl`, enclosure
   * `audioUrl`, redirects and the WebAuthn RP ID — is derived from the request
   * host, which on any platform that does not validate Host is whatever the
   * client sent. With it, a request arriving on an unlisted host never becomes
   * the advertised origin: the pinned origin is used instead, and the app
   * boundary answers the request `421 Misdirected Request`.
   *
   * The `publicBaseUrl` host is always implicitly allowed. Loopback hosts are
   * always allowed so local development keeps working when the list is set.
   */
  allowedHosts?: string[];
}

export interface ResolvedOrigin {
  /** Absolute origin with no trailing slash, e.g. `https://audio.example.com`. */
  baseUrl: string;
  /**
   * `true` when it came from configuration, `false` when it was derived from
   * the request.
   *
   * Derived origins vary per request, so a response built from one must not be
   * publicly cached — that is the difference between "this page is wrong" and
   * "this page is wrong for everyone who asks after the attacker".
   */
  explicit: boolean;
}

/**
 * The one shape both sides of the comparison use: lowercase, no IPv6 brackets
 * (`URL.hostname` keeps them, an operator writing a list does not), no
 * trailing dot (the same host DNS-wise, a different string).
 */
function bareHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/**
 * Normalise one configured host entry for comparison. Entries are tolerated as
 * hosts ("audio.example.com"), host:port, origins ("https://audio.example.com/")
 * — an operator pasting the PUBLIC_BASE_URL value into ALLOWED_HOSTS has the
 * right idea and possibly the wrong shape — and IPv6 literals. Anything that
 * does not parse as a host at all is dropped rather than compared raw: a
 * mis-shaped entry must not turn the gate on with a value nothing can match.
 */
function normaliseHost(entry: string): string {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return bareHost(url.hostname);
  } catch {
    return "";
  }
}

function isLoopbackHost(host: string): boolean {
  // Exact loopback only. A `*.localhost` suffix arm would let
  // `Host: evil.localhost` walk straight past the gate (fp4r review).
  return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    host === "0.0.0.0";
}

/**
 * The hosts a request may arrive on and still be advertised, or `null` when no
 * allow-list is configured (the request host is then the only source of truth
 * and is used as-is).
 *
 * The list only activates when the operator sets ALLOWED_HOSTS. The
 * `publicBaseUrl` host is folded in so the canonical host never rejects
 * itself, but setting PUBLIC_BASE_URL alone does not turn the gate on — the
 * advertised origin is already pinned in that deployment, and gating would
 * only break its preview URLs.
 */
function allowedHostSet(config: OriginConfig): Set<string> | null {
  if (!config.allowedHosts?.length) return null;
  const hosts = new Set<string>();
  for (const entry of config.allowedHosts) {
    const host = normaliseHost(entry);
    if (host) hosts.add(host);
  }
  if (!isUnusableOrigin(config.publicBaseUrl)) {
    hosts.add(bareHost(new URL(config.publicBaseUrl!).hostname));
  }
  return hosts.size ? hosts : null;
}

/**
 * The host the request is effectively arriving on — the same host
 * `requestOrigin` would derive the origin from, including an honoured
 * `x-forwarded-host` under the explicit proxy opt-in — plus WHETHER it came
 * from that header. A forwarded host is client-supplied text (that is the
 * whole reason the opt-in exists), so it never earns the loopback exemption.
 */
function effectiveRequestHost(
  request: Request,
  trustProxyHeaders?: boolean,
): { host: string; forwarded: boolean } | null {
  if (trustProxyHeaders) {
    const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (forwarded) {
      try {
        // The header is a host[:port], not a URL; parse with a dummy scheme.
        return { host: bareHost(new URL(`https://${forwarded}`).hostname), forwarded: true };
      } catch {
        return null;
      }
    }
  }
  try {
    return { host: bareHost(new URL(request.url).hostname), forwarded: false };
  } catch {
    return null;
  }
}

/**
 * Is this request arriving on a host the deployment is willing to advertise?
 *
 * `true` when no allow-list is configured (preserving the request-derived
 * behaviour that fixed audio-feed-0k3), when the host is on the list, or when
 * it is exact loopback AND the host the request actually arrived on — a local
 * dev machine has nothing to poison but itself, and refusing it would break
 * `deno task dev` the moment anyone sets the list. A client-supplied
 * `x-forwarded-host: localhost` is a bypass, not a developer.
 */
export function requestHostAllowed(config: OriginConfig, request: Request): boolean {
  const allowed = allowedHostSet(config);
  if (!allowed) return true;
  const effective = effectiveRequestHost(request, config.trustProxyHeaders);
  if (!effective) return false;
  if (allowed.has(effective.host)) return true;
  return !effective.forwarded && isLoopbackHost(effective.host);
}

/** Strip trailing slashes so concatenation never produces `//feed`. */
function normalise(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/**
 * A configured origin that cannot be right for public traffic.
 *
 * A deployment left pointing at loopback is the bug this module exists to fix,
 * and it is no more usable when someone set it by hand than when the old
 * fallback guessed it. Locally it is harmless: the request origin is loopback
 * too, so deriving returns the same answer.
 */
export function isUnusableOrigin(value: string | undefined): boolean {
  if (!value) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;

  const host = url.hostname.toLowerCase();
  return host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost");
}

/**
 * The origin this request arrived on.
 *
 * Returns `null` rather than guessing when nothing usable is available, so a
 * caller can decide what to do instead of silently emitting a wrong URL.
 */
export function requestOrigin(
  request: Request,
  opts: { trustProxyHeaders?: boolean } = {},
): string | null {
  if (opts.trustProxyHeaders) {
    // Only reachable when an operator has stated a trusted proxy is in front.
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (host) {
      const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
        "https";
      const candidate = `${proto}://${host}`;
      try {
        // Round-trip through URL so a malformed header cannot produce a
        // syntactically broken origin in a feed document.
        return normalise(new URL(candidate).origin);
      } catch {
        // Fall through to the request URL rather than emitting nonsense.
      }
    }
  }

  try {
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return normalise(url.origin);
  } catch {
    return null;
  }
}

/**
 * Resolve the origin to advertise for this request.
 *
 * Precedence: explicit configuration, then the request, then — only if both
 * fail — a loopback origin that is obviously wrong rather than plausibly wrong.
 */
export function resolveOrigin(config: OriginConfig, request: Request): ResolvedOrigin {
  if (!isUnusableOrigin(config.publicBaseUrl)) {
    return { baseUrl: normalise(config.publicBaseUrl!), explicit: true };
  }

  // A request arriving on a host the operator has not listed must never become
  // the advertised origin: that host is whatever the client chose to send.
  // Pin to the first listed host instead of the attacker's. `explicit: true`
  // because the value no longer varies with the request. The scheme comes from
  // the request (ALLOWED_HOSTS entries are hosts, not origins); through
  // `app.fetch` this branch is unreachable anyway — the 421 gate fires first —
  // so it exists for direct handler callers.
  if (!requestHostAllowed(config, request)) {
    const pinned = [...allowedHostSet(config)!][0];
    let proto = "https";
    try {
      if (new URL(request.url).protocol === "http:") proto = "http";
    } catch { /* keep https */ }
    return { baseUrl: `${proto}://${pinned}`, explicit: true };
  }

  const derived = requestOrigin(request, { trustProxyHeaders: config.trustProxyHeaders });
  if (derived) return { baseUrl: derived, explicit: false };

  // Nothing usable anywhere. Emit the configured value if there was one so the
  // operator sees their own setting reflected back, rather than a silent
  // substitution they then have to go looking for.
  return {
    baseUrl: normalise(config.publicBaseUrl ?? "http://localhost"),
    explicit: Boolean(config.publicBaseUrl),
  };
}

/**
 * `cache-control` for a document built from a resolved origin.
 *
 * A derived origin depends on the request host, so the response must never be
 * held in a shared cache: one spoofed request would otherwise poison the copy
 * served to everybody else.
 */
export function originCacheControl(resolved: ResolvedOrigin, maxAgeSeconds: number): string {
  return `${resolved.explicit ? "public" : "private"}, max-age=${maxAgeSeconds}`;
}
