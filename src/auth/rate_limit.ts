/**
 * Rate limiting for unauthenticated public endpoints (audio-feed-r97).
 *
 * Prevents denial-of-service, row exhaustion, and spam on public endpoints
 * like `POST /api/request-access`.
 *
 * Implements a memory-backed sliding-window counter per client key (typically IP).
 */

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

export class SlidingWindowRateLimiter {
  readonly #config: RateLimitConfig;
  readonly #hits = new Map<string, number[]>();

  constructor(config: RateLimitConfig) {
    this.#config = config;
  }

  /**
   * Check whether a key is within the rate limit, recording the attempt.
   */
  check(key: string, now = Date.now()): RateLimitResult {
    const windowStart = now - this.#config.windowMs;
    const timestamps = this.#hits.get(key) ?? [];

    // Filter out timestamps outside the active window
    const active = timestamps.filter((t) => t > windowStart);

    // Evict expired entries if map grows past 200 keys
    if (this.#hits.size > 200) {
      for (const [k, ts] of this.#hits.entries()) {
        const remaining = ts.filter((t) => t > windowStart);
        if (remaining.length === 0) this.#hits.delete(k);
        else this.#hits.set(k, remaining);
      }
    }

    if (active.length >= this.#config.maxRequests) {
      const oldestActive = active[0] ?? now;
      const resetMs = Math.max(0, oldestActive + this.#config.windowMs - now);
      this.#hits.set(key, active);
      return {
        allowed: false,
        remaining: 0,
        resetMs,
      };
    }

    active.push(now);
    this.#hits.set(key, active);

    return {
      allowed: true,
      remaining: this.#config.maxRequests - active.length,
      resetMs: this.#config.windowMs,
    };
  }

  /** Check whether a key is currently rate-limited without recording a new hit. */
  peek(key: string, now = Date.now()): RateLimitResult {
    const windowStart = now - this.#config.windowMs;
    const timestamps = this.#hits.get(key) ?? [];
    const active = timestamps.filter((t) => t > windowStart);

    if (active.length >= this.#config.maxRequests) {
      const oldestActive = active[0] ?? now;
      const resetMs = Math.max(0, oldestActive + this.#config.windowMs - now);
      return {
        allowed: false,
        remaining: 0,
        resetMs,
      };
    }

    return {
      allowed: true,
      remaining: this.#config.maxRequests - active.length,
      resetMs: this.#config.windowMs,
    };
  }

  /** Reset tracked hits for a key (primarily for tests). */
  reset(key?: string): void {
    if (key) this.#hits.delete(key);
    else this.#hits.clear();
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

export class FailedAuthLimiter {
  readonly #limiter: SlidingWindowRateLimiter;

  constructor(options: FailedAuthLimiterOptions = {}) {
    this.#limiter = new SlidingWindowRateLimiter({
      maxRequests: options.maxFailures ?? 10,
      windowMs: options.windowMs ?? 5 * 60 * 1000,
    });
  }

  /** Check if client key has reached failure threshold without incrementing. */
  isLockedOut(key: string, now = Date.now()): RateLimitResult {
    return this.#limiter.peek(key, now);
  }

  /** Record a failed authentication attempt. */
  recordFailure(key: string, now = Date.now()): RateLimitResult {
    return this.#limiter.check(key, now);
  }

  /** Reset failure count for a key upon successful authentication. */
  reset(key?: string): void {
    this.#limiter.reset(key);
  }
}

const SHARED_ADMIN_AUTH_LIMITER = new FailedAuthLimiter();

export function getSharedAdminAuthLimiter(): FailedAuthLimiter {
  return SHARED_ADMIN_AUTH_LIMITER;
}
