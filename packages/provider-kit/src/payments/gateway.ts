// x402 gateway: the @x402/core resource server with ExactStellarScheme from @x402/stellar.
//
// TODO:
// - Build the 402 challenge from the manifest: exactly one `accepts` entry, scheme "exact", the
//   network, the USDC SAC, the price in base units, payTo, a bounded maxTimeoutSeconds, and fees
//   sponsored.
// - On a paid request: run payload-checks, then facilitator verify, then hand off to the job runner.
//   Settlement happens before or after the work depending on the service's mode (jobs/runner.ts).
// - The `resource.url` must be the public HTTPS URL. A provider behind a TLS proxy must not echo
//   http://, which is the Phase 1 P2-08 lesson.

export {};
