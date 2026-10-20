// Receipts.
//
// TODO:
// - PaymentReceipt (JobView.payment): network, asset, amount (base units), payTo, payer, transaction
//   (Stellar tx hash), settledAt. Names follow x402's SettleResponse where they exist. A receipt is a
//   claim: clients confirm the transaction on chain before showing "paid".
// - VerificationReceipt: what the verifier issues and anchors in the 8004 Validation Registry
//   (docs/verification.md). Fields: standard version, agentId, manifest sha256, network, the
//   conformance level reached, one result per check (C1–C6) with evidence and the ids of any failed
//   rules (e.g. "P4"), payment tx hash, verifier address, timestamps.
//   Its canonical-JSON sha256 becomes `response_hash` on chain.

export {};
