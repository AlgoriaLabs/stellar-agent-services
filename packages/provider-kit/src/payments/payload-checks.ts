// Local payment checks, run BEFORE calling the facilitator.
//
// TODO:
// - Decode the signed Soroban transaction and require exactly one invokeHostFunction that calls
//   the USDC SAC `transfer(payer, payTo, amount)`, with one address-credential auth entry.
// - Network, asset, amount and payTo must match the challenge exactly.
// - Compute the payment fingerprint (network, payer, signed auth entry). The job store enforces its
//   uniqueness, so one signed payment can buy at most one job.

export {};
