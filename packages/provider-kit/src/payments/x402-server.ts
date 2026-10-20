// x402 resource server: @x402/core with ExactStellarScheme from @x402/stellar.
//
// TODO:
// - Build the 402 challenge from the manifest [P4]: exactly one `accepts` entry equal to the
//   manifest's payment option plus `amount` = the service price.
// - resource.url is the public HTTPS create-job URL [P5]. A provider behind a TLS proxy must not echo
//   http://, which is the Phase 1 P2-08 lesson.
// - Add x402's Bazaar discovery extension from the service's schemas and first example [P6].
// - Called only after input validation and the capacity check [P8], so nobody pays for bad input.
// - On a paid request: payload-checks, then facilitator verify, then hand off to the job runner.

export {};
