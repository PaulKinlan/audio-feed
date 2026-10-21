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
   * Advertising an origin derived from the request host is the exposure this
   * closes: on any platform that does not validate Host, the request host is
   * whatever the client sent, and it would become feed `selfUrl`, enclosure
   * `audioUrl`, redirects and the WebAuthn RP ID.
   *
   * The `publicBaseUrl` host is always in the set, so `publicBaseUrl` alone
   * activates the gate; this variable only ADDS hosts (audio-feed-7lsy). A
   * request arriving on a host that is not in the set is answered `421
   * Misdirected Request` at the app boundary, and generated links keep using
   * the pinned origin. With neither value set the set is empty, and an empty
   * set refuses every non-loopback host rather than deriving one from the
   * request: the app never falls back to trusting the client's Host.
   *
   * Loopback hosts are always allowed so local development keeps working when
   * the list is set.
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

/** The hosts a request may arrive on and still be advertised.
 *
 * Never `null`: with nothing configured this is an EMPTY set, which refuses
 * every non-loopback host, so a deployment that cannot name its own host fails
 * closed instead of advertising whichever host a client sent (audio-feed-7lsy).
 *
 * The gate is ACTIVE whenever the deployment knows its own host, which
 * `PUBLIC_BASE_URL` is: that host is the accepted one, and ALLOWED_HOSTS adds
 * to it rather than being a prerequisite for it (audio-feed-7lsy, Paul's
 * directive). Treating the variable as required made the check correct AND
 * inert — no behaviour change, exposure open, no error — which is worse than a
 * loud refusal because it is indistinguishable from working.
 *
 * With neither value set the set is EMPTY, and an empty set means loopback
 * only: the gate fails CLOSED rather than trusting whatever `Host` the client
 * sent. A deployment that does not know its own host must not advertise an
 * attacker's.
 */
export function allowedHostSet(config: OriginConfig): Set<string> {
  const hosts = new Set<string>();
  for (const entry of config.allowedHosts ?? []) {
    const host = normaliseHost(entry);
    if (host) hosts.add(host);
  }
  if (!isUnusableOrigin(config.publicBaseUrl)) {
    hosts.add(bareHost(new URL(config.publicBaseUrl!).hostname));
  }
  // Deliberately returned even when empty: an empty set refuses everything but
  // loopback, which is the fail-closed case (audio-feed-7lsy).
  return hosts;
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
 * `true` when the host is one the deployment accepts — its own configured
 * host, a listed one — or when
 * it is exact loopback AND the host the request actually arrived on — a local
 * dev machine has nothing to poison but itself, and refusing it would break
 * `deno task dev` the moment anyone sets the list. A client-supplied
 * `x-forwarded-host: localhost` is a bypass, not a developer.
 */
export function requestHostAllowed(config: OriginConfig, request: Request): boolean {
  const allowed = allowedHostSet(config);
  const effective = effectiveRequestHost(request, config.trustProxyHeaders);
  if (!effective) return false;
  if (allowed.has(effective.host)) return true;
  return !effective.forwarded && isLoopbackHost(effective.host);
}

/**
 * The read paths that are deliberately NOT behind the host gate (audio-feed-2tbv).
 *
 * THE LOG READER MUST NOT SIT BEHIND THE SWITCH WHOSE POSITION YOU ARE TRYING TO DIAGNOSE. During the
 * live 421 incident (audio-feed-du8w) the operator asked how to read the deployment's errors, and the
 * answer we gave - our own observability API - was answering 421 on the very host they were worried
 * about, because the gate refuses before any route runs. The tool for reading the incident was itself
 * refused by the incident. The same is true of any future case where the app is down, misrouted or
 * refusing: "why is this deployment refusing?" must be answerable by talking to the deployment.
 *
 * WHY THIS IS NOT A HOLE, and the four properties that make it one to keep:
 *
 *  1. It is AUTH-GATED, and the gate is unchanged: both paths require the shared key in
 *     `AUDIOFEED_OBSERVABILITY_KEY` (constant-time compare, 401 without it, 503 naming the variable
 *     when it is unset). Exemption from the HOST check is not exemption from authentication, and the
 *     shared key - not the caller's Host - remains the only requirement.
 *  2. It CANNOT DERIVE OR EMIT AN ORIGIN FROM THE REQUEST. Both routes answer JSON built from the log
 *     store: no redirect, no `selfUrl`, no feed or enclosure URL, no `access-control-allow-origin`.
 *     The one place a request host reaches a response header is the CSP `report-uri` in
 *     `applySecurityHeaders`, and that branch is HTML-only - JSON takes the branch that sets no
 *     request-derived header at all. `tests/host_gate_observability_test.ts` pins both halves: the
 *     attacker's host appears in neither the body nor ANY response header.
 *  3. It cannot be widened by accident. Matching is EXACT against the same normalised pathname the
 *     router dispatches on (`new URL(req.url).pathname`), so `/api/observability/errors/x`, a
 *     percent-encoded lookalike, or a doubled slash is refused by the gate and never reaches a route.
 *     Product routes are untouched, and a test asserts every exempt path is a route the router
 *     actually declares, so renaming one cannot silently lose the exemption.
 *  4. What stays behind the gate is deliberate: the homepage, feeds, listen pages, /admin and the
 *     admin observability PAGE all remain gated. Only the two JSON read endpoints the operator can
 *     poll without a browser session are exempt.
 *
 * NOT to be confused with `OBSERVABILITY_ROUTES` in src/log.ts, which excludes these same paths from
 * being recorded as events so the API does not feed itself. They are separate lists on purpose:
 * adding a path to the logging exclusion says "do not record this", adding one here says "serve this
 * even when the Host is refused", and neither should ever imply the other.
 */
export const HOST_GATE_EXEMPT_PATHS: readonly string[] = [
  "/api/observability/errors",
  "/api/observability/summary",
];

/** Whether the host gate applies to this pathname. Exact match, on the router's normalised path. */
export function isHostGateExempt(pathname: string): boolean {
  return HOST_GATE_EXEMPT_PATHS.includes(pathname);
}

/**
 * WHY the host gate is refusing this request, or `null` when it is allowed.
 *
 * Two refusals that used to be one response, and must never be confused
 * (audio-feed-3k2d):
 *
 *  - `"unconfigured"` — the allowed set is EMPTY, i.e. neither PUBLIC_BASE_URL
 *    nor a usable ALLOWED_HOSTS entry exists. Nothing can ever match, so the
 *    fault is the deployment's configuration and the operator must be told
 *    which variable is missing. This is the live incident in audio-feed-du8w:
 *    the deployment answered a bare 421 `misdirected_request` to every visitor,
 *    including the operator, which reads as "you asked for the wrong host" when
 *    the truth was "this server cannot name its own host".
 *  - `"misdirected"` — the deployment DOES know the hosts it serves and this
 *    request arrived on a different one. That is the spoofed-Host case the gate
 *    exists for (audio-feed-fp4r) and it stays a 421.
 *
 * The refusal itself is unchanged and still fail-closed: both cases refuse. Only
 * the diagnosis differs, because a diagnosis the reader cannot act on is not a
 * diagnosis. Do NOT collapse these back into one status: the empty set must
 * never derive a host from the request to make itself look configured.
 */
export function hostGateRefusal(
  config: OriginConfig,
  request: Request,
): "unconfigured" | "misdirected" | null {
  if (requestHostAllowed(config, request)) return null;
  return allowedHostSet(config).size === 0 ? "unconfigured" : "misdirected";
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
    // Pinning to a host the deployment recognises is better than echoing the
    // client's. With nothing configured there is no such host, so fall through
    // to the last-resort branch below — the 421 gate in app.fetch answers this
    // request before it can get here anyway.
    const pinned = [...allowedHostSet(config)][0];
    if (pinned) {
      let proto = "https";
      try {
        if (new URL(request.url).protocol === "http:") proto = "http";
      } catch { /* keep https */ }
      return { baseUrl: `${proto}://${pinned}`, explicit: true };
    }
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
 * The origin a deployment's browsers should send CSP / NEL reports to (audio-feed-s2esl).
 *
 * CONFIGURATION ONLY, AND THAT IS THE POINT. The value used to be built from
 * `req.headers.get("host")` whenever `PUBLIC_BASE_URL` was unset, which made the safety of the
 * resulting header depend on an ORDERING: the 421 host gate had to run first, and it had to be
 * reading the same input. It was not — the gate inspects `new URL(req.url)`, and `deno serve`
 * derives that from the SOCKET — so "allowed request URL, attacker-chosen `Host` header" passed the
 * gate and put the attacker's domain into `report-uri`, `Reporting-Endpoints` and `Report-To`.
 *
 * Ordering the two checks correctly would still leave an attacker-supplied value one refactor away
 * from a response header. Deriving from configuration removes the input entirely:
 *
 *  1. `PUBLIC_BASE_URL`, the operator's canonical origin, wins outright.
 *  2. Otherwise the first `ALLOWED_HOSTS` entry — the same pinned-host policy `resolveOrigin`
 *     applies — keeping any port or scheme the entry states, and taking the request's SCHEME (never
 *     its host) when the entry is a bare host. Reports are cross-origin POSTs from the page, so a
 *     wrong scheme silently drops them; the scheme is the one part of the request that cannot name
 *     somebody else's domain.
 *  3. Otherwise exact loopback, which is the local-dev case: nothing configured and `deno serve` on
 *     `http://localhost:8000` keeps reporting to the port it is actually serving.
 *  4. Otherwise `https://localhost` — obviously wrong rather than plausibly wrong, the same
 *     last-resort shape `resolveOrigin` uses, and never a request-derived host.
 *
 * A deployment serving several allowed hosts should set `PUBLIC_BASE_URL` if per-host reporting
 * matters: pinning to one configured host is the trade for not letting a request choose.
 */
export function cspReportOrigin(
  config: OriginConfig,
  request?: { url?: string; https?: boolean },
): string {
  const fallbackProto: "http" | "https" = request?.https ? "https" : "http";

  if (config.publicBaseUrl) {
    try {
      const configured = new URL(config.publicBaseUrl);
      if (configured.protocol === "http:" || configured.protocol === "https:") {
        return normalise(configured.origin);
      }
    } catch { /* not a URL: fall through to the allow-list */ }
  }

  for (const entry of config.allowedHosts ?? []) {
    const origin = configuredHostOrigin(entry, fallbackProto);
    if (origin) return origin;
  }

  if (request?.url) {
    try {
      const url = new URL(request.url);
      if (isLoopbackHost(bareHost(url.hostname))) return normalise(url.origin);
    } catch { /* unparseable request URL: use the safe default */ }
  }

  return "https://localhost";
}

/** One configured host entry as an origin, or `null` when it names no host at all. */
function configuredHostOrigin(entry: string, fallbackProto: "http" | "https"): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  try {
    // Entries are tolerated as hosts, host:port or full origins — the same tolerance
    // `normaliseHost` shows the gate, so a value that gates correctly also reports correctly.
    const url = new URL(trimmed.includes("://") ? trimmed : `${fallbackProto}://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return normalise(url.origin);
  } catch {
    return null;
  }
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
