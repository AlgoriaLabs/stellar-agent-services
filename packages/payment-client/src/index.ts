// @stellar-agent-services/payment-client
//
// The buyer side, as designed in docs/payment-client.md: one core (this package), two strategies
// (signers and payment methods, see strategies.ts), and surfaces on top (the CLI here, the web app in
// apps/wallet, an MCP server later). Conformance checks for adapters are in the "./conformance" entry point.
//
// This entry point runs in Node and the browser. Journal storage is per environment: files in "./node",
// IndexedDB in "./browser".
//
// PoC status: the core flow works end to end with a local-key signer. Keys never touch discovery or
// provider code; the client signs once, after approval or inside a budget the user granted.

export * from "./client.js";
export * from "./policy.js";
export * from "./journal.js";
export * from "./manifest.js";
export * from "./onchain.js";
export * from "./strategies.js";
export * from "./local-key-signer.js";
export * from "./x402-exact-stellar.js";
