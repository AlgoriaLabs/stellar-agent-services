// Error responses (docs/provider-standard.md §6).
//
// TODO:
// - Problem: RFC 9457 problem details (application/problem+json): type, title, status, detail?,
//   plus `code` (what clients act on) and, for invalid_input, errors[] { pointer, message }.
// - ProblemCode and its HTTP status: invalid_request 400, invalid_input 400, service_not_found 404,
//   job_not_found 404, request_in_progress 409, payload_too_large 413,
//   idempotency_key_reused 422 (IETF Idempotency-Key draft-07), rate_limited 429, unavailable 503.
// - Problems never echo request headers, payment payloads or job tokens.
// - 402 responses use x402's own format, not this one.

export {};
