// @stellar-agent-services/provider-kit
//
// Turns a function, or an existing HTTP API, into a paid Stellar service that follows Provider
// Standard v1:
//   library:  defineService(...) -> createProvider(...) -> { fetch(request) } -> any Fetch-API server
//   gateway:  provider-kit serve --config <file> -> forwards paid jobs to the upstream API
//
// Security rule: the provider runtime holds NO Stellar secret keys. It knows only its `payTo` public
// address, and the x402 facilitator verifies and settles. Owner-key operations (8004 registration,
// validation requests) run only from the CLI, which signs through the Stellar CLI keychain.

export * from "./define-service.js";
export * from "./provider.js";
export * from "./manifest.js";
export * from "./registration.js";
export * from "./gateway/config.js";
export * from "./gateway/upstream.js";
export * from "./jobs/store.js";
export * from "./jobs/memory-store.js";
export * from "./jobs/sqlite-store.js";
export * from "./jobs/scheduler.js";
export * from "./jobs/reconcile.js";
export * from "./http/rate-limit.js";
export * from "./http/node-server.js";
export * from "./payments/chain.js";
export * from "./payments/facilitator.js";
export * from "./payments/onchain.js";
export * from "./payments/payload-checks.js";
export * from "./payments/settlement.js";
