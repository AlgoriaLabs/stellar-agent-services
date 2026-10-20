// Provider manifest: what a provider publishes about itself (docs/provider-standard.md).
//
// The SOW requires each service to describe its purpose, input, output, price, network,
// job status and result.
//
// TODO:
// - ProviderManifest type: standard, provider { name, description, homepage, agentId? }, network,
//   payment { protocol, x402Version, scheme, asset, payTo, feesSponsored }, jobs { createUrl,
//   statusUrl, resultUrl, retentionSeconds }, services[].
// - ServiceDescriptor type: id, title, description (purpose), mode ("sync" | "async"),
//   price { amount (base units, string), display }, input / output (JSON Schema 2020-12),
//   example, expectedDurationSeconds.
// - parseManifest(): strict validation that rejects unknown standards, non-HTTPS or cross-origin
//   URLs, and oversized fields.

export {};
