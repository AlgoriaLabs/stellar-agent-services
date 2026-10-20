// HTTP header names used by the standard. These are drafts until Provider Standard v1 is published.
//
// TODO:
// - IDEMPOTENCY_KEY = "Idempotency-Key": a client-generated UUID that also becomes the job id.
// - JOB_TOKEN = "X-Job-Token": a client-generated 32-byte base64url secret. The provider stores only
//   its sha256 hash, and the token is required for check-status and get-result.
// - The x402 v2 headers (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE) come from @x402/core
//   and are not redefined here.

export {};
