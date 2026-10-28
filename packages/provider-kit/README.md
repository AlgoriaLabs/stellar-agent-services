# @stellar-agent-services/provider-kit

Turn a function, or an existing HTTP API in any language, into a paid Stellar service that follows
[Provider Standard v1](../../docs/provider-standard.md). The kit covers:

- the service description (manifest), checked against the standard before the server starts
- pricing and the x402 USDC payment, with the payment checked locally before the facilitator sees it
- job recovery: a client that lost its response collects the result without paying again
- capacity: a queue per service, and `429`/`503` before payment when it is full
- durable jobs: paid jobs survive restarts, and workers can run in separate processes
- Stellar 8004 registration, a self-check and a paid test call, from the CLI

Two ways to use it:

```text
library:  defineService(...)  ->  createProvider(...)  ->  { fetch(request) }  ->  Hono / Node / Workers / Deno / Bun
gateway:  provider-kit serve --config <file>  ->  forwards paid jobs to your existing API (also as a Docker image)
```

- The provider runtime holds **no Stellar secret keys**; it only knows its `payTo` public address.
- Owner operations (the USDC trustline, 8004 registration, validation requests) run from the CLI and are
  approved in your own wallet, on a page the CLI opens on your computer. See [Approving in your wallet](#approving-in-your-wallet).

The step-by-step guide is [docs/provider-setup-guide.md](../../docs/provider-setup-guide.md).

## Library in short

```ts
import { createProvider, defineService, sqliteStore } from "@stellar-agent-services/provider-kit";

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
  store: sqliteStore("./jobs.sqlite"),
});

await provider.ready();          // checks the facilitator, resumes jobs a restart left behind
// Mount provider.fetch on any Fetch-API server, or use the kit's own: await listen(provider, { port: 8787 })
```

`createProvider()` throws if the manifest it builds would fail the standard's checks (the JSON Schema and
rules M1–P11, examples against their schemas), so a broken provider never takes a payment. The manifest is
served at `/.well-known/stellar-agent-services.json`. Create-job, check-status and get-result are under
`baseUrl`, with CORS open for browser clients.

### When the user is charged

| `charge` | Order | If the work fails |
| --- | --- | --- |
| `on-success` | verify payment → work → settle | Not charged. The work must finish before the signed payment expires, so keep it under half of `maxTimeoutSeconds` (default 60). |
| `upfront` (default) | verify → settle → queue → work | Charged. Use it for long or expensive work. |

A handler gets `{ signal, jobId }`. `signal` aborts when the job runs out of time (`timeoutSeconds`, default
twice `expectedDurationSeconds`). An `upfront` job whose worker died is run again, so a handler with side
effects can use `jobId` to do them once.

## Gateway mode

For an API that already exists, in any language, write a config file instead of code:

```json
{
  "$schema": "./node_modules/@stellar-agent-services/provider-kit/schemas/gateway-config.schema.json",
  "baseUrl": "https://api.example.com",
  "network": "stellar:testnet",
  "payTo": "env:PAY_TO",
  "facilitator": "https://x402.org/facilitator",
  "provider": { "name": "Example provider" },
  "store": "./jobs.sqlite",
  "services": [
    {
      "name": "summarize",
      "description": "Summarizes English text up to 20,000 characters.",
      "price": "0.05",
      "charge": "upfront",
      "expectedDurationSeconds": 20,
      "inputSchema": "./schemas/summarize.input.json",
      "outputSchema": "./schemas/summarize.output.json",
      "capacity": { "concurrency": 2, "maxQueueWaitSeconds": 120 },
      "upstream": { "url": "http://127.0.0.1:5000/summarize", "headers": { "Authorization": "env:UPSTREAM_TOKEN" } }
    }
  ]
}
```

```bash
PAY_TO=G... provider-kit serve --config provider.config.json
```

- The gateway POSTs the validated input to `upstream.url` as JSON, with `Idempotency-Key: <job id>`. A 2xx
  JSON object is the output, checked against `outputSchema`. The upstream never sees payment data or job
  tokens.
- Busy upstreams (`429`, `502`–`504`, connection errors) are retried within the job's time, honoring
  `Retry-After`. Set `capacity.concurrency` to what the upstream takes.
- Values written `"env:NAME"` come from the environment: the upstream's API key, `payTo`, `baseUrl`.
- [examples/python-upstream](../../examples/python-upstream) is a Python API behind the gateway.

**Docker:** `docker build -f packages/provider-kit/Dockerfile -t provider-kit .` from the repository root, then
mount the config at `/config/provider.config.json` and a volume at `/data` (set `"store": "/data/jobs.sqlite"`).
`GET /healthz` answers for health checks.

## CLI

| Command | What it does |
| --- | --- |
| `provider-kit serve --config <file>` | Gateway mode. Graceful shutdown on SIGTERM. `--no-workers` for HTTP-only processes. |
| `provider-kit init [--upstream <url>]` | Writes a starter gateway config. |
| `provider-kit check (--config <file> \| --manifest <url>)` | Self-check without paying: manifest, facilitator, `payTo` trustline [P2], 8004 registration [I1]–[I3]. Exits 1 on any failure. `--manifest` works for any provider, library or native. |
| `provider-kit try [<service>] ['<input JSON>' \| @<file>]` | One paid call on testnet, the way any client makes it. See [Trying a paid call](#trying-a-paid-call). |
| `provider-kit trustline [--config \| --manifest \| --network <testnet\|mainnet>]` | Adds a USDC trustline to `payTo` [P2], approved in its wallet. A new testnet account gets test XLM from Friendbot first. Without `--config` or `--manifest`, it sets up the account the wallet connects and prints it as `PAY_TO`. Signs nothing when the trustline exists. |
| `provider-kit register (--config \| --manifest)` | Registers in the Stellar 8004 identity registry from the `payTo` account, or updates the registration from the agent's owner, approved in the wallet. Adds the USDC trustline first when it is missing, and saves the new `agentId` to `--config` [I2]. |
| `provider-kit request-validation (--config \| --manifest) --validator <G…>` | Asks a verifier for validation in the Stellar 8004 Validation Registry. Checks first that a verifier can validate the provider ([I1]–[I3]), that the connected account may ask for the agent, and that the validator is not the provider itself. Puts the request document on chain as a `data:` URI, has the owner's wallet sign it and prints the request hash for the verifier. `--out` writes the request document. |
| `provider-kit reconcile (--config <file> \| --store <file> --network <net>)` | Decides `payment_uncertain` jobs from on-chain data [J13]. `--dry-run` only reports; `--rpc <url>` picks the Soroban RPC. It reads the chain, writes only the job store and signs nothing, so it is safe next to a running provider. Exits 1 while a job is undecided. |

`trustline`, `register` and `request-validation` take `--source <key>` to sign with the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli) keychain instead of a wallet, for scripts and CI. With
`--source`, `--dry-run` prints the Stellar CLI command. `--rpc <url>` picks the Soroban RPC.

### Trying a paid call

`provider-kit try` pays for one job on testnet, as a client would, so you see the whole flow work before anyone
else pays:

```bash
provider-kit try text-stats                         # the service's example input
provider-kit try text-stats '{"text":"Hello"}'      # or your own, or @input.json
```

```text
  ✓ Test XLM from Friendbot
  ✓ Test USDC from the testnet DEX: 0.01 USDC
  ✓ text-stats succeeded: 10.2 s from payment to result
  ✓ Paid 0.01 USDC, confirmed on chain: https://stellar.expert/explorer/testnet/tx/0051061a…cda9

{
  "words": 2,
  "sentences": 1,
  "characters": 12
}

GDJB…XA3O (payTo) received 0.01 USDC.
```

- **The provider:** `--manifest <url>` for any provider, or `--config` for a gateway, read for its `baseUrl` only.
  Without either, `./provider.config.json` when it exists, else `http://localhost:8787`. With several services and
  none named, it lists them.
- **The payer:** a throwaway test account, made for this call. It gets test XLM from Friendbot and exactly the price
  in test USDC from the testnet DEX. Its key stays in memory and is never written anywhere. You need no payer wallet.
- **The payment:** the payment client's own flow, with every check. The exact price, payee and network are shown and
  approved first (`--yes` skips the question, for scripts), and its spending policy allows that one payment only.
  The transfer is confirmed on chain [J16].
- **Testnet only.** A provider on Mainnet is refused before anything is signed.

It exits 0 only when the job succeeded and its payment is confirmed. If the answer to the paid request is lost, it
says the payment may have gone through and never calls it unpaid: your provider decides it from the chain
[J13]. If the testnet DEX has no USDC for sale, nothing is paid: try again later, or pay with `stellar-pay` from a
test wallet of your own, funded at [faucet.circle.com](https://faucet.circle.com) (setup guide §6).

### Approving in your wallet

Without `--source`, an owner command opens a page on this computer, `http://localhost:8790` (or any free port),
where you connect the wallet you already use and approve each transaction:

1. **Connect.** Freighter, xBull, Albedo, Rabet, Hana, MetaMask, Ledger and the other wallets
   [Stellar Wallets Kit](https://stellarwalletskit.dev) supports without extra setup, except LOBSTR: its connector
   is GPL-3.0, and the page ships in this MIT package. The page names the account the command needs, such as
   `payTo`, and refuses another one before anything is built.
2. **Review.** Each transaction in plain words: what it does, every argument, the network, the most it can cost in
   fees and how long it stays valid. The raw hash and XDR are there to compare with what the wallet shows.
3. **Approve** in the wallet. The CLI checks that what came back is that very transaction, signed by the connected
   account for this network, then sends it and waits for the ledger. Your terminal shows each step as it lands.

How it stays safe:

- **No key in the kit.** The wallet signs. The CLI builds, checks and sends, and never sees a key.
- **The page answers only you.** It listens on 127.0.0.1 only. Its API needs a one-time token that reaches the page
  in the link's fragment, and refuses other `Host` and `Origin` headers, so no website and no DNS rebinding can drive
  it. The page runs only its own bundled scripts under a strict Content Security Policy.
- **Nothing is sent twice.** Each transaction is built when it is due. A refused one can be prepared again. One whose
  fate is unknown stops the session with its hash, to look up before trying again.
- **Ctrl+C cancels**, after the step under way finishes. Over SSH, `--no-open` prints the link without opening a
  browser: forward its port. `--port <n>` picks the port.

The page's source is in `approve/` (Svelte), built into `dist/approve` by `npm run build`. `npm run dev:approve`
serves it alone for design work.

## Payment safety

- **Local payment checks.** Before the facilitator sees a payment, the kit decodes it: exactly one USDC
  `transfer(payer, payTo, price)`, authorized by the payer's own signed auth entry and nothing else. A payment
  to another address, amount or asset is refused with a `402`. The signature itself is the facilitator's
  check, since only a simulation can verify it for every kind of account.
- **One payment, one job.** The fingerprint is the payer's auth-entry nonce, which Soroban accepts once, so a
  signed payment can't buy two jobs even re-wrapped in another transaction [P9].
- **Uncertain is never failed.** A settlement counts as failed only when the facilitator says it never
  submitted the transaction. Timeouts, errors and unknown answers make the job `payment_uncertain`, never
  charged again [J13]. A settlement past its deadline (`settleTimeoutSeconds`, default `maxTimeoutSeconds` + 30)
  is uncertain too, and its answer is still recorded if it comes later.
- **Reconciled from the chain.** With a Soroban RPC (`rpc`, the public one by default on testnet; set your own
  on mainnet), the provider decides `payment_uncertain` jobs after every sweep. It looks for the transaction
  that carries the payer's signed auth entry with the job's nonce, so another job's equal transfer is never
  mistaken for it. A paid job then runs or shows its output; one whose payment provably never landed before
  it expired fails uncharged; anything less waits. See [docs/job-recovery.md](../../docs/job-recovery.md#reconciliation).
- **Timed by ledger.** A signed payment expires at a ledger, so `on-success` jobs are timed by their payment's
  expiration ledger, read from the same RPC. Without it they fall back to the claim time plus
  `maxTimeoutSeconds`.
- **Crash-safe.** Every state change is stored before the next step. A settlement interrupted by a crash
  becomes `payment_uncertain`; an `on-success` job whose payment expired fails uncharged.
- **Hardened facilitator client.** HTTPS only, no redirects, deadlines on every call, bounded answers, and a
  startup check that the facilitator settles this network with sponsored fees.

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
  lasts: until its expiration ledger, less the work and 10 s to settle. One that can't start in time fails
  with `timeout` and is not charged.
- Wait estimates start from `expectedDurationSeconds` and then follow the measured durations.
- check-status and get-result are never limited, so paid jobs can always be collected.

### Restarts, several processes, separate workers

The queue lives in the job store. With `sqliteStore(path)`:

- a paid `upfront` job keeps its place across restarts and runs when the provider is back [Q4];
- several processes on one machine can share the file: `concurrency` then counts jobs across all of them;
- workers lease `upfront` jobs, and a job whose worker died is taken over when the lease (30 s) runs out,
  up to 3 starts;
- HTTP-only processes (`runQueuedJobs: false`, or `serve --no-workers`) can take jobs that separate worker
  processes, with the same services and store, run. `on-success` jobs always run in the process that
  verified their payment, because that process settles it.

`memoryStore()`, the default, is for tests and local development only: it loses jobs on restart. A store for
another database implements the `JobStore` contract in `src/jobs/store.ts`; `test/job-store.test.ts` is the
contract test it must pass.

## Testing your provider

`@stellar-agent-services/provider-kit/testing` signs real x402 payments offline, so your tests run the kit's
payment checks without a network:

```ts
import { signTestPayment } from "@stellar-agent-services/provider-kit/testing";
const payment = await signTestPayment(requirements, Keypair.random()); // pair it with a fake facilitator
```

## Files

| File | Contents |
| --- | --- |
| `src/define-service.ts` | `defineService()`: price, charge policy, schemas, capacity; checks at definition time |
| `src/provider.ts` | `createProvider()`: wires everything into one `fetch` handler; startup checks |
| `src/manifest.ts` | Builds the manifest from the same config as the 402 challenge, and checks it |
| `src/http/router.ts` | Manifest, create-job, check-status and get-result routes, in §5.4 order |
| `src/http/node-server.ts` | `listen()`: serves a provider on Node's HTTP server, with `/healthz` and graceful close |
| `src/payments/payload-checks.ts` | Local payment checks and the payment fingerprint |
| `src/payments/facilitator.ts` | The facilitator client and the startup check |
| `src/payments/settlement.ts` | Settlement as `settled`, `failed` or `uncertain` (never charge twice) |
| `src/payments/chain.ts` | Soroban RPC reads and the ledger clock |
| `src/payments/onchain.ts` | Finds a job's payment on chain, by the payer's signed auth entry and nonce |
| `src/payments/x402-server.ts` | The 402 challenge, with the Bazaar discovery extension |
| `src/jobs/runner.ts` | The `on-success` and `upfront` charge policies; leased workers |
| `src/jobs/scheduler.ts` | Capacity: admission before the 402, turns, workers, queue positions |
| `src/jobs/recovery.ts` | Sweeps for what a crash left behind, and retention |
| `src/jobs/reconcile.ts` | Decides `payment_uncertain` jobs from on-chain data |
| `src/jobs/memory-store.ts`, `src/jobs/sqlite-store.ts` | Job stores |
| `src/gateway/config.ts`, `src/gateway/upstream.ts` | Gateway mode |
| `src/registration.ts` | 8004 registration file, the I1–I3 check, and who may act for an agent |
| `src/cli/` | The `provider-kit` command |
| `src/cli/approval.ts` | Approving in a wallet: the session (steps, checks, sending) and the local page's server and API |
| `src/cli/approval-view.ts` | What the page shows: the session as JSON, shared with the page |
| `src/cli/owner-chain.ts` | The owner's transactions: built, checked once signed, sent and followed into a ledger |
| `src/cli/owner-steps.ts` | Test XLM, the USDC trustline, registration and the validation request, as approval steps |
| `src/cli/try.ts` | `provider-kit try`: one paid testnet call through the payment client, from a throwaway payer |
| `approve/` | The approval page (Svelte, Stellar Wallets Kit), built into `dist/approve` |
| `schemas/gateway-config.schema.json` | The gateway config file's JSON Schema |
| `Dockerfile` | The gateway image |
