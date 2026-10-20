// Classifies the settlement outcome. This is the core of "never charge twice, never lose a payment".
//
// TODO:
// - "settled": success with a transaction hash whose payer and amount match.
// - "failed": ONLY when the error reason is on an allowlist of definitely-not-submitted reasons and
//   there is no transaction hash.
// - "uncertain": everything else (timeouts, 5xx, 429, mismatches, thrown errors). The job becomes
//   payment_uncertain and is resolved by `reconcile`, never by charging again.

export {};
