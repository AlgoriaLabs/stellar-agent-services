// HTTP header names used by the standard (docs/provider-standard.md §5.2).
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
