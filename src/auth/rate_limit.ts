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
 * Uses the platform remote address as the primary key by default.
 * When `trustProxy` (TRUST_PROXY_HEADERS) is enabled, honours cf-connecting-ip
 * and x-forwarded-for from an upstream reverse proxy.
 */
export function extractClientIp(
  req: Request,
  trustProxy = false,
  remoteAddr?: string,
): string {
  if (trustProxy) {
    const cf = req.headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  if (remoteAddr) return remoteAddr;
  return "direct";
}

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
