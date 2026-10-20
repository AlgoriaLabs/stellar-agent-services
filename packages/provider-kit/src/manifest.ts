// Builds the Provider Standard v1 manifest from the provider config.
//
// TODO:
// - buildManifest(config) -> ProviderManifest, then validate it with the protocol package's parseManifest().
// - Served at the manifest path with short caching. Every URL is derived from `origin`, so the
//   402 challenge and the manifest can never disagree.

export {};
