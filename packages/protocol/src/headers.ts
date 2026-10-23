// HTTP header names used by the standard (docs/provider-standard.md §5.2), and reading Retry-After (§5.8).
//
// The x402 v2 headers (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE) come from @x402/core
// and are not redefined here. Location and Retry-After are used as HTTP defines them.

/** IETF Idempotency-Key (draft-07). Its value becomes the job id. */
export const IDEMPOTENCY_KEY = "Idempotency-Key";

/** The job's bearer secret. No "X-" prefix (RFC 6648). */
export const JOB_TOKEN = "Job-Token";

/** A lowercase RFC 9562 UUID of any version. Clients SHOULD use v4 or v7. */
export const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 32 random bytes, base64url without padding. The provider stores only its SHA-256 [J3]. */
export const JOB_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reads Retry-After (RFC 9110 §10.2.3) as whole seconds from `now`: delay-seconds, or an HTTP-date
 * (0 once it has passed). Returns undefined for a missing or malformed value. Providers send
 * delay-seconds (§5.8); the date form is read for HTTP proxies in front of them.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}
