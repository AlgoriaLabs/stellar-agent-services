// @stellar-agent-services/payment-client
//
// The buyer side, as designed in docs/payment-client.md: one core (this package), swappable signers,
// and surfaces on top (the CLI here; a web app and an MCP server later).
//
// PoC status: the core flow works end to end with a local-key signer. Keys never touch discovery or
// provider code; the client signs once, after approval or inside a budget the user granted.

export * from "./client.js";
export * from "./policy.js";
export * from "./journal.js";
export * from "./manifest.js";
export * from "./onchain.js";
