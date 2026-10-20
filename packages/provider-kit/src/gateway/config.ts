// Gateway mode: run the Provider Kit in front of an existing HTTP API, in any language, with no code
// changes to that API (docs/provider-standard.md, "Ways to implement").
//
// TODO:
// - GatewayConfig, loaded from a JSON file (`provider-kit serve --config <file>`):
//   { baseUrl, network, payTo, facilitatorUrl, provider { name, description?, agentId?, ... },
//     store { type: "sqlite", path }, retentionSeconds?,
//     services: [{ name, title?, description, price ("0.05", USDC), charge?, expectedDurationSeconds?,
//                  inputSchema (inline or a file path), outputSchema, examples?, tags?,
//                  upstream { url, timeoutSeconds, headers? } }] }
// - Upstream header values may reference environment variables ("env:NAME") for the upstream's own
//   API credential. Never a Stellar secret key: the gateway, like any provider runtime, holds none.
// - Validated at startup, failing closed, with the same rules as createProvider().

export {};
