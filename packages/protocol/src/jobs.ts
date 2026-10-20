// Job Recovery model: create-job, check-status, get-result (docs/job-recovery.md).
//
// TODO:
// - JobStatus: "queued" | "running" | "succeeded" | "failed" | "payment_uncertain".
// - JobView (check-status response): jobId, serviceId, status, charged (true | false | "unknown"),
//   paymentReference?, createdAt, updatedAt, expiresAt.
// - JobResult (get-result response): jobId, output, paymentReceipt.
// - SettlementMode: "after-work" (sync default) | "before-work" (async default).
// - The allowed status transitions, so the provider store and the client agree on them.

export {};
