# @stellar-agent-services/provider-kit

Turn a function, or an existing HTTP API in any language, into a paid Stellar service that follows Provider
Standard v1. The kit covers:

- the service description (manifest)
- pricing
- the x402 USDC payment
- job recovery
- capacity: a queue per service, and `429`/`503` before payment when it is full

Two ways to use it:

```text
library:  defineService(...)  ->  createProvider(...)  ->  { fetch(request) }  ->  Hono / Node / Workers / Deno / Bun
gateway:  provider-kit serve --config <file>  ->  forwards paid jobs to your existing API (also as a Docker image)
```

- The provider runtime holds **no Stellar secret keys**; it only knows its `payTo` public address.
- Owner operations (8004 registration, validation requests) run from the CLI and sign through the Stellar
  CLI keychain.

**Status: proof of concept.** The library path works end to end on Stellar testnet:
[examples/paid-service](../../examples/paid-service) is paid through the x402.org facilitator and recovers lost
jobs. Gateway mode, the CLI and the durable store are not built yet. The plan is in
[IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md) §5.3.

## Library in short

```ts
import { createProvider, defineService } from "@stellar-agent-services/provider-kit";

const textStats = defineService({
  name: "text-stats",
  description: "Counts the words in a text.",
  price: "0.01",                 // USDC
  charge: "on-success",          // charged only if the handler succeeds
  expectedDurationSeconds: 1,
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  outputSchema: { type: "object", required: ["words"], properties: { words: { type: "integer" } } },
  handler: ({ text }: { text: string }) => ({ words: text.split(/\s+/).filter(Boolean).length }),
});

const provider = createProvider({
  baseUrl: "https://api.example.com",
  network: "stellar:testnet",
  payTo: "G...",                 // public address only
  facilitator: "https://x402.org/facilitator",
  provider: { name: "Example provider" },
  services: [textStats],
});

// Mount provider.fetch on any Fetch-API server (Hono, Workers, Deno, Bun).
```

The manifest is served at `/.well-known/stellar-agent-services.json`. Create-job, check-status and get-result
are under `baseUrl`, with CORS open for browser clients.

## Capacity and load

When ten agents call your service at the same time, nothing fails. Each service runs `concurrency` jobs at
once and queues the rest. When the queue is full, the kit answers `503` with `Retry-After` **before the `402`**,
so nobody pays for a job you can't run (Provider Standard §5.8).

```ts
const imageGen = defineService({
  name: "image-gen",
  // ...
  expectedDurationSeconds: 20,
  capacity: {
    concurrency: 2,            // jobs at once: what one GPU or one upstream quota allows (default 4)
    maxQueued: 50,             // jobs waiting for a slot (default 100)
    maxQueueWaitSeconds: 80,   // longest expected wait before answering 503 instead (default 60; 0 = no queue)
  },
});

const provider = createProvider({
  // ...
  services: [imageGen],
  // Optional: 429 for a caller sending too many create-job requests. You decide who a caller is.
  rateLimit: { requests: 30, windowSeconds: 60, key: (request) => request.headers.get("cf-connecting-ip") ?? undefined },
});
```

With 10 requests at once, 2 jobs run and 8 wait. Each waiting job gets `202` with
`"queue": { "position", "estimatedStartAt" }` and a matching `Retry-After`. The 11th request would wait about
100 s, over the 80 s limit, so it gets `503` with `Retry-After` and is never asked to pay. The client sends the
same request again later.

- The manifest publishes `capacity: { concurrency, maxQueueWaitSeconds }` so discovery and clients can see it.
- `upfront` jobs settle first and then wait for a slot. `on-success` jobs wait only as long as their payment
  lasts: `maxTimeoutSeconds` minus the work and 10 s to settle. One that can't start in time fails with
  `timeout` and is not charged.
- Wait estimates start from `expectedDurationSeconds` and then follow the measured durations.
- check-status and get-result are never limited, so paid jobs can always be collected.
- The lanes live in one process. With several instances behind a load balancer, each one enforces its own
  limits, so set `concurrency` per instance.

| File | Contents |
| --- | --- |
| `src/define-service.ts` | `defineService()`: price, charge policy, schemas; input checked before the 402, output before settling |
| `src/provider.ts` | `createProvider()`: wires everything into one `fetch` handler |
| `src/manifest.ts` | Builds the manifest from the same config as the 402 challenge |
| `src/http/router.ts` | Manifest, create-job, check-status and get-result routes, RFC 9457 errors |
| `src/payments/x402-server.ts` | The 402 challenge and reading the paid request |
| `src/payments/settlement.ts` | Settlement as `settled`, `failed` or `uncertain` (never charge twice) |
| `src/jobs/runner.ts` | The `on-success` and `upfront` charge policies |
| `src/jobs/scheduler.ts` | Capacity: a lane per service, admission before the 402, queue positions |
| `src/http/rate-limit.ts` | Optional per-caller rate limit on create-job (`429`) |
| `src/jobs/memory-store.ts` | In-memory job store with atomic claims and payment fingerprints |

## Not done in the PoC

- Gateway mode (`provider-kit serve --config`) and the Docker image.
- The CLI: `init`, `check`, `register`, `request-validation`, `reconcile`.
- The SQLite store. The memory store loses jobs on restart, including queued ones.
- A shared queue with worker leases, so worker processes scale apart from the HTTP servers and a queued `upfront`
  job survives a restart (spec [Q4]).
- Local payload checks before the facilitator, the startup `getSupported()` check and manifest self-validation.
- 8004 registration metadata.
- The [setup guide](../../docs/provider-setup-guide.md) is an outline.
