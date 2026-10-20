// Error codes shared by provider responses and the client.
//
// TODO:
// - Stable machine-readable codes, e.g. job_conflict (409), job_not_found (404),
//   payment_required (402), payment_uncertain, invalid_input, service_failed.
// - A single error body shape: { error: { code, message } }. It never echoes request headers or
//   payment payloads.

export {};
