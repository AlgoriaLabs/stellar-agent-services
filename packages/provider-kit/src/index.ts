// @stellar-agent-services/provider-kit
//
// Turns a function into a paid Stellar service that follows Provider Standard v1:
//   defineService(...) -> createProvider(...) -> { fetch(request) } -> any Fetch-API server.
//
// Security rule: the provider runtime holds NO secret keys. It knows only its `payTo` public address,
// and the x402 facilitator verifies and settles. Owner-key operations (8004 registration, validation
// requests) run only from the CLI, which signs through the Stellar CLI keychain.

export * from "./define-service.js";
export * from "./provider.js";
export * from "./manifest.js";
export * from "./registration.js";
export * from "./jobs/store.js";
export * from "./jobs/memory-store.js";
export * from "./jobs/sqlite-store.js";
