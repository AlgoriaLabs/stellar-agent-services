// Provider manifest: what a provider publishes about itself (docs/provider-standard.md §2–§4).
//
// The SOW requires each service to describe its purpose, input, output, price, network, job status
// and result.
//
// TODO:
// - ProviderManifest: standard, provider { name, description?, homepage?, agentId?, termsUrl?,
//   dataUse? { storesInputs, trainsOnInputs } }, baseUrl, payment { protocol: "x402",
//   x402Version: 2, accepts: [PaymentOption] }, jobs? { retentionSeconds }, services[], extensions?.
// - PaymentOption: the x402 v2 PaymentRequirements field names without `amount`: scheme "exact",
//   network, asset, payTo, maxTimeoutSeconds, extra { areFeesSponsored: true }. Exactly one in v1.
// - ServiceDescriptor: uses MCP tool field names, so a service maps 1:1 to an MCP tool:
//   name, title?, description, price { amount (base units, string) }, charge? ("on-success" |
//   "upfront", default "upfront"), expectedDurationSeconds?, inputSchema, outputSchema,
//   examples?, maxInputBytes?, tags?, extensions?.
//   No sync/async flag: every service uses the same job flow.
// - parseManifest(): strict about what matters and lenient about the rest:
//   - rejects a different major `standard`, non-HTTPS URLs, a baseUrl on another origin,
//     oversized fields, a non-object input schema root and any non-local `$ref`;
//   - ignores unknown fields, so later v1 additions don't break old clients.
// - challengeMatches(manifest, service, paymentRequired): the [P4] field-by-field comparison that
//   the payment client and verifier both use.

export {};
