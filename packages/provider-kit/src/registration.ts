// Stellar 8004 integration for the provider OWNER (offline, from the CLI only).
//
// TODO:
// - buildRegistrationMetadata(manifest): name, description and services[] pointing at the manifest
//   URL, x402 enabled, supportedTrust. Built with @trionlabs/stellar8004 helpers and checked with
//   validateAgentUri.
// - buildValidationRequest(manifest, verifierAddress): the request document plus
//   request_hash = sha256(canonical document), using the spec-compliant contentHash mode.
// - Signing is never done here. The CLI hands the call to the Stellar CLI keychain.

export {};
