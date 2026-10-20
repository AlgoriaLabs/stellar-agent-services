// HTTP header names used by the standard (docs/provider-standard.md §5.2).
//
// TODO:
// - IDEMPOTENCY_KEY = "Idempotency-Key" (IETF draft-07): a client-generated lowercase UUID that also
//   becomes the job id.
// - JOB_TOKEN = "Job-Token": a client-generated 32-byte secret, base64url without padding (43 chars).
//   The provider stores only its sha256 hash. No "X-" prefix (RFC 6648).
// - Clients send both or neither. With neither, the provider creates them and returns them once.
// - Standard headers used as-is: Location and Retry-After (202, 409, 429, 503).
// - The x402 v2 headers (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE) come from @x402/core
//   and are not redefined here.

export {};
