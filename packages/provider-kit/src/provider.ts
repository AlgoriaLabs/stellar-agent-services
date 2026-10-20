// createProvider(): wires services, payments, the job store and the HTTP routes into one Fetch-API handler.
//
// TODO:
// - Config: { baseUrl (public HTTPS URL), network, payTo, facilitatorUrl, services, store,
//   provider info, retentionSeconds?, maxTimeoutSeconds?, manifestPath? }.
// - Startup checks, all fail closed: HTTPS baseUrl, a valid payTo, and facilitator getSupported()
//   includes the network with scheme "exact".
// - Returns { fetch(request: Request): Promise<Response> } for Hono, Node, Workers, Deno or Bun.
//   Gateway mode (src/gateway) builds on the same function.
// - Test-only response-loss drill: an explicit flag, off by default (docs/job-recovery.md).

export {};
