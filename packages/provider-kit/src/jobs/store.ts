// JobStore: the persistence contract behind Job Recovery.
//
// TODO:
// - claim(job): an atomic insert keyed by jobId, storing the binding hash and sha256(job token).
//   Returns "created", "existing" (same binding and token) or "conflict" (different binding or
//   token, which the router answers with 422).
// - transition(jobId, from, to, patch): compare-and-set. It never moves out of a terminal state.
// - recordPayment(fingerprint, jobId): unique on fingerprint, so one payment pays for one job.
// - get(jobId), plus expiry cleanup driven by manifest.jobs.retentionSeconds.
// - Store only sha256(job token), never the token itself.

export {};
