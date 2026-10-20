// Stellar 8004 integration for the provider OWNER (offline, from the CLI only).
//
// TODO:
// - buildRegistrationMetadata(manifest, manifestUrl): name, description and services[] with
//   { name: "stellar-agent-services", endpoint: manifestUrl, version: "1" } and
//   { name: "web", endpoint: baseUrl }, the x402 flag, supportedTrust [I1]. Built with
//   @trionlabs/stellar8004 helpers and checked with validateAgentUri.
// - The agent wallet (set_agent_wallet) must equal the manifest payTo [I3]; `check` warns if not.
// - buildValidationRequest(manifest, verifierAddress): the request document plus
//   request_hash = sha256(JCS(document)), using the spec-compliant contentHash mode.
// - Signing is never done here. The CLI hands the call to the Stellar CLI keychain.

export {};
