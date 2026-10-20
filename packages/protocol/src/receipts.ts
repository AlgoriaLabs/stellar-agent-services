// Receipts.
//
// TODO:
// - PaymentReceipt: what get-result returns about the payment. Fields: network, asset, amount
//   (base units), payTo, payer, transaction hash, jobId, settledAt.
// - VerificationReceipt: what the verifier issues and anchors in the 8004 Validation Registry
//   (docs/verification.md). Fields: standard version, agentId, manifest sha256, network, one
//   result per check (C1–C6 with evidence), payment tx hash, verifier address, timestamps.
//   Its canonical-JSON sha256 becomes `response_hash` on chain.

export {};
