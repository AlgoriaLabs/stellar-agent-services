// Per-caller rate limit for create-job: 429 rate_limited with Retry-After (docs/provider-standard.md
// §5.8) [Q1].
//
// A fixed window per caller key. The provider decides who a caller is, such as the client IP that a
// trusted proxy puts in a header. The kit has no default, because a header the client controls is
// not an identity. Only create-job is limited: check-status and get-result keep working, so paid jobs
// can always be collected [Q7].

export interface RateLimitConfig {
  /** create-job requests a caller may send per window. A paid job takes two: the 402 and the paid retry. */
  requests: number;
  windowSeconds: number;
  /** Who sent the request. undefined: not limited. */
  key: (request: Request) => string | undefined;
}

/** Returns the seconds to wait when the caller is over the limit, otherwise undefined. */
export type RateLimiter = (request: Request) => number | undefined;

/** Windows kept before expired ones are swept. */
const SWEEP_AT = 10_000;

export function rateLimiter(config: RateLimitConfig): RateLimiter {
  if (!Number.isInteger(config.requests) || config.requests < 1) throw new RangeError("rateLimit.requests must be a whole number of at least 1");
  if (!Number.isInteger(config.windowSeconds) || config.windowSeconds < 1) throw new RangeError("rateLimit.windowSeconds must be a whole number of at least 1");
  const windows = new Map<string, { count: number; resetAt: number }>();

  return (request) => {
    const key = config.key(request);
    if (key === undefined) return undefined;
    const now = Date.now();
    if (windows.size >= SWEEP_AT) {
      for (const [stale, window] of windows) if (window.resetAt <= now) windows.delete(stale);
    }
    let window = windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      window = { count: 0, resetAt: now + config.windowSeconds * 1000 };
      windows.set(key, window);
    }
    window.count++;
    return window.count > config.requests ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : undefined;
  };
}
