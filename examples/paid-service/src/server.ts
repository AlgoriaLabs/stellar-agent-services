// Sample provider, built ONLY with the public provider-kit API, so it doubles as the template that
// pilot providers copy.
//
// TODO:
// - createProvider({ origin, network: "stellar:testnet", payTo, facilitatorUrl, services:
//   [textStats, delayedReport], store: sqlite })
// - Mount provider.fetch on Hono and serve it with @hono/node-server.
// - Config comes from .env: public values only, never a secret key.

export {};
