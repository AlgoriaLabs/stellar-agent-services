// Builds the Provider Standard v1 manifest from the provider config.
//
// TODO:
// - buildManifest(config) -> ProviderManifest, then validate it with the protocol package's parseManifest().
// - Served at the manifest path (default /.well-known/stellar-agent-services.json) with
//   Cache-Control max-age <= 300. The payment option and every URL come from the same config, so the
//   402 challenge and the manifest can never disagree.

export {};
