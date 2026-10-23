// C7 Load: a burst of requests is always answered (docs/provider-standard.md §5.8). Independent of the
// conformance levels, like C2; it earns the "Load-safe" badge.
// - No payment: 20 create-job requests at once, with the service's first example as input. Each one
//   answers within 30 s with a 402, or a 429 or 503 problem carrying Retry-After [Q1]. A 5xx other
//   than 503, a dropped connection or a timeout fails the check.
// - With --pay: pay for capacity.concurrency + 1 jobs at once (default 5). Each is accepted (200 or
//   202, with `queue` while queued [Q5]) or refused with 503 before settlement, and every accepted job
//   finishes. No transfer exists for a refused job.
// - A manifest without `capacity` passes; the check reports a warning for the missing hint.
// TODO: record status counts and the largest Retry-After as evidence.

export {};
