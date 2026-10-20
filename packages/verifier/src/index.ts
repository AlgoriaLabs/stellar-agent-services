// @stellar-agent-services/verifier
//
// Runs checks C1–C6 against a provider, issues a verification receipt, renders badges from that
// receipt, and publishes the 8004 Validation Registry response (docs/verification.md).
//
// Keys: the verifier key (validation_response) and a dedicated testnet test-payer key (check C4).
// These are never shared with providers, discovery or the payment client.

export * from "./receipt.js";
export * from "./badges.js";
export * from "./publish.js";
