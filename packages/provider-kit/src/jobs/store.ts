// JobStore: the persistence contract behind Job Recovery.
//
// TODO:
// - claim(job): an atomic insert keyed by jobId. Returns "created", "existing" (same binding) or
//   "conflict" (different binding).
// - transition(jobId, from, to, patch): compare-and-set. It never moves out of a terminal state.
// - recordPayment(fingerprint, jobId): unique on fingerprint.
// - get(jobId), plus expiry cleanup driven by manifest.jobs.retentionSeconds.
// - Store only sha256(job token), never the token itself.

export {};
