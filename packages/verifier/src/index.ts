// @stellar-agent-services/verifier
//
// Checks a provider against Provider Standard v1 (checks C1–C7, docs/verification.md), issues a
// verification receipt, renders badges from that receipt, and publishes it to the Stellar 8004
// Validation Registry.
//
// The checks are written from the standard, not from the Provider Kit, so a fault the kit shares with
// its providers can't pass unnoticed. They cite the standard's rule ids.
//
// Keys: the paid checks are paid by a dedicated, funded test payer, within the verifier's limits. The
// validator key, which signs validation_response, stays in the Stellar CLI keychain and never enters
// this process. Neither is ever shared with providers, discovery or the payment client.

export * from "./verify.js";
export * from "./receipt.js";
export * from "./badges.js";
export * from "./publish.js";
export * from "./payments.js";
export * from "./chain.js";
export * from "./registry.js";
export { TOOL } from "./tool.js";
