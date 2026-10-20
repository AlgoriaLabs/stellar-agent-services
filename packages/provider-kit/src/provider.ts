// createProvider(): wires services, payments, the job store and the HTTP routes into one Fetch-API handler.
//
// TODO:
// - Config: { origin (public HTTPS URL), network, payTo, facilitatorUrl, services, store, provider info }.
// - Startup checks, all fail closed: HTTPS origin, a valid payTo G-address, and facilitator
//   getSupported() includes the network with scheme "exact".
// - Returns { fetch(request: Request): Promise<Response> } for Hono, Node, Workers or Deno.
// - Test-only response-loss drill: an explicit flag, off by default (docs/job-recovery.md).

export {};
