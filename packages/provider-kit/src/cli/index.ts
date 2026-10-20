// provider-kit CLI (operator side). Planned commands:
//
//   init                 scaffold a provider from examples/paid-service
//   check                self-check against Provider Standard v1 (no payment, no keys)
//   register             register or update the 8004 identity (signs through the Stellar CLI keychain)
//   request-validation   call validation_request for a chosen verifier (owner signs via keychain)
//   reconcile            resolve payment_uncertain jobs from on-chain data (read-only)
//
// Keys are never read from env vars or files by this CLI; the Stellar CLI keychain does the signing.
// The `bin` entry is added to package.json once the first command exists.

export {};
