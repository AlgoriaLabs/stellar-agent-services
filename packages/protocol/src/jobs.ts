// Job model: create-job, check-status, get-result (docs/provider-standard.md §5).
//
// TODO:
// - JobStatus: "queued" | "running" | "succeeded" | "failed" | "payment_uncertain".
// - Charge: "on-success" (verify -> work -> settle; failed work is not charged) |
//   "upfront" (verify -> settle -> work).
// - Charged: true | false | "unknown" ("unknown" exactly when status is payment_uncertain).
// - JobView: the one response shape for all three operations: jobId, service, status, charge,
//   charged, createdAt, updatedAt, expiresAt, output? (create-job and get-result, when succeeded),
//   error? (problem object, when failed), payment? (PaymentReceipt, when charged), jobToken? (only
//   when the provider generated the token for a client that sent none).
// - JOB_TRANSITIONS: (new) -> queued | running | payment_uncertain | failed; queued -> running;
//   running -> succeeded | failed | payment_uncertain; payment_uncertain -> queued | succeeded | failed.
//   succeeded and failed are final.
// - bindingHash(service, input) = hex(sha256(JCS({ service, input }))) [§5.3].
// - JobFailureCode: "service_failed" | "output_invalid" | "timeout" | "payment_failed".

export {};
