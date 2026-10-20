// @stellar-agent-services/protocol
//
// Provider Standard v1 as code. Every other package (provider-kit, payment-client, verifier) and,
// read-only, stellar-agent-search import their shared definitions from here.
//
// Rule: this package has NO runtime dependencies and never imports signing code, so the read-only
// discovery server can depend on it without breaking its "no signer imports" invariant.

export * from "./standard.js";
export * from "./manifest.js";
export * from "./jobs.js";
export * from "./headers.js";
export * from "./receipts.js";
export * from "./networks.js";
export * from "./canonical-json.js";
export * from "./errors.js";
