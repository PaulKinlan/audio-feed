/**
 * Rate limiting for unauthenticated public endpoints (audio-feed-r97).
 *
 * Prevents denial-of-service, row exhaustion, and spam on public endpoints
 * like `POST /api/request-access`.
 *
 * The sliding window lives in the shared store, not in module memory. That is
 * the whole point (audio-feed-2zvc): Deno Deploy gives each isolate its own
 * memory and runs several of them, so a module-level Map held the bound
 * per-isolate — guesses spread across isolates were effectively unbounded in
 * aggregate. Keying the window in `MetadataStore` (KV in production, memory in
 * tests) makes one bound hold for the deployment.
 */

import { isIP } from "node:net";
import type { AtomicWrite } from "../storage/mod.ts";

/** The one store capability the limiter needs — see `MetadataStore.atomicUpdate`. */
export interface RateLimitStore {
  atomicUpdate<T>(
    key: string,
    mutate: (current: T | null) => T | null,
    ttlMs?: number,
  ): Promise<AtomicWrite<T>>;
}

export interface RateLimitConfig {
  /** Maximum allowed requests within the time window. */
  maxRequests: number;
  /** Sliding window duration in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

/**
 * Sliding-window counter per client key (typically IP), shared across isolates.
 *
 * Keys are namespaced per consumer by the caller: the admin limiter and the
 * request-access limiter must not collide on the same client, or five
 * front-door posts would count toward ten admin guesses. The window is stored
 * at the store row `<namespace>:<key>` (an `["atomic", …]` row in KV).
 */
export class SlidingWindowRateLimiter {
  readonly #config: RateLimitConfig;
  readonly #store: RateLimitStore;
  readonly #namespace: string;

  /**
   * `namespace` keeps unrelated limiters off each other's row. Without it the
   * admin-failure window and the request-access window collide on the same
   * client key, so five front-door posts would count toward the ten admin
   * guesses — and each limiter would filter the other's timestamps by its own
   * window. The caller must state what its window means; defaults here would
   * invite exactly that collision (audio-feed-2zvc).
   */
  constructor(config: RateLimitConfig, store: RateLimitStore, namespace: string) {
    this.#config = config;
    this.#store = store;
    this.#namespace = namespace;
  }

  #row(key: string): string {
    return `${this.#namespace}:${key}`;
  }

  /**
   * Check whether a key is within the rate limit, recording the attempt.
   *
   * The read, the decision, and the write are one `atomicUpdate`, so two
   * isolates cannot both admit the attempt that crosses the bound.
   */
  async check(key: string, now = Date.now()): Promise<RateLimitResult> {
    const windowStart = now - this.#config.windowMs;
    // Set by the mutation that is actually committed. The callback can run more
    // than once when a concurrent writer wins a commit, and the last run is the
    // one the store applied.
    let admitted = false;

    const write = await this.#store.atomicUpdate<number[]>(
      this.#row(key),
      (current) => {
        const active = (current ?? []).filter((t) => t > windowStart);
        if (active.length >= this.#config.maxRequests) {
          // Refused attempts do NOT extend the window: the oldest active hit
          // still decides when the client may try again.
          admitted = false;
          return active;
        }
        active.push(now);
        admitted = true;
        return active;
      },
      // The row is housekeeping once every timestamp has fallen out of the
      // window; twice the window keeps it readable for the whole of one.
      this.#config.windowMs * 2,
    );

    // `committed` is load-bearing (audio-feed-2zvc review): a mutation that lost
    // every CAS race was never recorded, and reporting it as allowed would let
    // uncounted attempts through — the exact bound this exists to hold. A
    // window we could not write fails CLOSED.
    return this.#result(write.value, write.committed && admitted, now);
  }

  /** Check whether a key is currently rate-limited without recording a new hit. */
  async peek(key: string, now = Date.now()): Promise<RateLimitResult> {
    // `null` from the mutation means "leave the row as it is"; the store still
    // returns the current value.
    const write = await this.#store.atomicUpdate<number[]>(this.#row(key), () => null);
    const active = (write.value ?? []).filter((t) => t > now - this.#config.windowMs);
    // A read has no hit to admit, so unlike `check` the refusal rule is simply
    // whether the recorded window is already full.
    const allowed = active.length < this.#config.maxRequests;
    return {
      allowed,
      remaining: allowed ? this.#config.maxRequests - active.length : 0,
      resetMs: allowed ? this.#config.windowMs : this.#untilOldestExpires(active, now),
    };
  }

  #untilOldestExpires(active: number[], now: number): number {
    const oldestActive = active[0] ?? now;
    return Math.max(0, oldestActive + this.#config.windowMs - now);
  }

  /** Shape a `check` result: `admitted` is the mutation's own decision. */
  #result(stored: number[] | null, admitted: boolean, now: number): RateLimitResult {
    const active = (stored ?? []).filter((t) => t > now - this.#config.windowMs);

    if (!admitted) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: this.#untilOldestExpires(active, now),
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.#config.maxRequests - active.length),
      resetMs: this.#config.windowMs,
    };
  }

  /** Reset the window for `key` (a successful auth, or a test). */
  async reset(key: string): Promise<void> {
    // Keep the TTL: `reset` runs on every successful admin auth, and a row
    // written without an expiry would leave a permanent entry per client IP
    // (audio-feed-2zvc review).
    await this.#store.atomicUpdate<number[]>(
      this.#row(key),
      () => [],
      this.#config.windowMs * 2,
    );
  }
}

/**
 * Extract client IP from request.
 *
 * Uses the platform remote address as the primary key by default. When `trustProxy`
 * (TRUST_PROXY_HEADERS) is enabled, honours the address a trusted hop APPENDED — the last entry of
 * `x-forwarded-for` — and then `cf-connecting-ip`.
 *
 * WHY THE LAST ENTRY, AND NOT THE FIRST (audio-feed-u2ve)
 * Forwarding headers are APPENDED to by each hop: a request through one trusted proxy arrives as
 * `x-forwarded-for: <what the client sent>, <what the proxy saw>`. So the FIRST entry is whatever the
 * caller chose, and taking it handed every caller a fresh rate-limit bucket per request — rotate the
 * header, never reach the bound. The LAST entry is the value the hop closest to us added, which no
 * caller can choose.
 *
 * The same rule is right when the proxy REPLACES the header rather than appending: then there is
 * exactly one entry, first and last are the same value, and nothing changes. That is why "last" is
 * the safe choice under both behaviours instead of needing to know which one is in front.
 *
 * `cf-connecting-ip` is consulted only when there is no usable `x-forwarded-for`. It is a
 * single-value header, so if an upstream proxy does not manage it a caller can set it themselves;
 * preferring it, as this did, meant a forged `cf-connecting-ip` won even when the trusted hop had
 * appended the real address. It is still worth honouring behind Cloudflare, which overwrites it.
 *
 * BOTH headers are held to the same rule — see `clientAddressCandidate`: the value must actually look
 * like an address (and not be arbitrarily long), or it is ignored and the next source is consulted.
 * The first version of this bounded only the forwarded chain, which left the fallback able to take
 * any string a caller sent: rotating garbage there was both a fresh bucket per request and an
 * unbounded number of store rows (audio-feed-5vvw).
 *
 * With `trustProxy` on but nothing usable in either header, NOTHING here is trustworthy — which is
 * exactly what the opt-in asserts, in the words of src/origin.ts: "only they can know that
 * client-supplied values are stripped upstream". What this function guarantees is narrower and
 * provable: while the hop appends or manages those headers, a caller cannot choose or rotate their
 * key through them. Against a proxy that does neither, no forwarded header can be trusted at all,
 * which is why the documented topology is a proxy that appends the client address.
 */
export function extractClientIp(
  req: Request,
  trustProxy = false,
  remoteAddr?: string,
): string {
  if (trustProxy) {
    const appended = lastForwardedEntry(req.headers.get("x-forwarded-for"));
    if (appended) return appended;
    const cf = req.headers.get("cf-connecting-ip");
    if (cf) {
      const candidate = clientAddressCandidate(cf);
      if (candidate) return candidate;
    }
  }
  if (remoteAddr) return remoteAddr;
  return "direct";
}

/**
 * The address the last hop appended, or null if the header is absent or has no usable entry.
 */
function lastForwardedEntry(header: string | null): string | null {
  if (!header) return null;
  const entries = header.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  return clientAddressCandidate(entries[entries.length - 1] ?? "");
}

/**
 * A forwarded value, or null when it cannot be an address.
 *
 * The length bound is not cosmetic: a key is a store row, and a caller who can make the key
 * arbitrarily long can make arbitrarily many of them (the row-exhaustion concern behind
 * audio-feed-2zvc). The address check is what stops a caller rotating anything that is not an
 * address through a header their proxy does not manage, which is how the unbounded fallback survived
 * the first fix (audio-feed-5vvw). A proxy that appends a client address appends an address, so
 * rejecting the rest costs a real deployment nothing: the value falls through to the platform's own
 * socket address, a small, real, bounded key.
 *
 * The check is Node's `isIP` (node:net), NOT a hand-rolled one. This was hand-rolled twice and both
 * versions had holes that let a caller rotate the key: the first bounded the value's LENGTH only, so
 * any string was a key; the second bounded its ALPHABET, so `0:` — one hex group and a colon — read
 * as an address (audio-feed-hzg1); the third required the structure of eight groups, and still
 * counted a dotted-quad tail as one group, so `1:2:3:4:5:6:7::192.0.2.1` passed (audio-feed-jqmd).
 * Each version looked sufficient from the inside. A validator that has to be right about IPv6
 * belongs in the platform, and `isIP` returns 4, 6 or 0.
 */
function clientAddressCandidate(value: string): string | null {
  const candidate = value.trim();
  if (candidate === "" || candidate.length > MAX_CLIENT_KEY_LENGTH) return null;
  // `isIP` is strict: `1.2.3.4:80` and `[::1]:443` are not addresses, they are addresses with ports,
  // and a proxy that appends one appends both. Only the two forms where a port is unambiguous are
  // stripped: `[v6]:port` and `v4:port`. A BARE IPv6 with a trailing `:digits` is read two ways —
  // nine groups, or an address with a port — and treating it as the latter let
  // `1:2:3:4:5:6:7:8:9` through as `1:2:3:4:5:6:7:8` with port 9, which is another rotated key.
  // Real proxies bracket an IPv6 port, and an ambiguous value falls back to the socket address.
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(candidate)?.[1];
  const hostPort = /^([\d.]+):\d{1,5}$/.exec(candidate)?.[1];
  const usable = isIP(candidate) !== 0 ||
    (bracketed !== undefined && isIP(bracketed) !== 0) ||
    (hostPort !== undefined && isIP(hostPort) === 4);
  return usable ? candidate : null;
}

/** A full IPv6 address plus a port is 51 characters; 64 leaves room without admitting prose. */
const MAX_CLIENT_KEY_LENGTH = 64;

/**
 * Shared throttle for failed admin authentication attempts (audio-feed-bns).
 *
 * Prevents rapid guessing attacks against ADMIN_TOKEN on both:
 *   - The header path (`x-admin-token`, `authorization: bearer ...` via adminGate)
 *   - The bootstrap path (`POST /api/auth/bootstrap` via account_api)
 */
export interface FailedAuthLimiterOptions {
  /** Maximum failed attempts within window before lockout. Default: 10 */
  maxFailures?: number;
  /** Sliding window duration in milliseconds. Default: 5 minutes */
  windowMs?: number;
}

/** Namespaces the admin-token window so it cannot swap rows with another limiter. */
const ADMIN_AUTH_NAMESPACE = "admin_auth";

export class FailedAuthLimiter {
  readonly #limiter: SlidingWindowRateLimiter;

  constructor(store: RateLimitStore, options: FailedAuthLimiterOptions = {}) {
    this.#limiter = new SlidingWindowRateLimiter(
      {
        maxRequests: options.maxFailures ?? 10,
        windowMs: options.windowMs ?? 5 * 60 * 1000,
      },
      store,
      ADMIN_AUTH_NAMESPACE,
    );
  }

  /** Check if client key has reached failure threshold without incrementing. */
  isLockedOut(key: string, now = Date.now()): Promise<RateLimitResult> {
    return this.#limiter.peek(key, now);
  }

  /** Record a failed authentication attempt. */
  recordFailure(key: string, now = Date.now()): Promise<RateLimitResult> {
    return this.#limiter.check(key, now);
  }

  /** Reset failure count for a key upon successful authentication. */
  reset(key: string): Promise<void> {
    return this.#limiter.reset(key);
  }
}

/**
 * The admin-token failure limiter for a store.
 *
 * Every caller that passes the same store shares one counter — that is what
 * makes the header path and the bootstrap path one bound instead of two, and
 * what makes it survive an isolate being recycled.
 */
export function createAdminAuthLimiter(store: RateLimitStore): FailedAuthLimiter {
  return new FailedAuthLimiter(store);
}
