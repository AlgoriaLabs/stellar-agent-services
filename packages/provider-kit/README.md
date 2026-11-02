# @stellar-agent-services/provider-kit

Turn a function, or an existing HTTP API in any language, into a paid Stellar service that follows
[Provider Standard v1](../../docs/provider-standard.md). The kit covers:

- the service description (manifest), checked against the standard before the server starts
- pricing and the x402 USDC payment, with the payment checked locally before the facilitator sees it
- job recovery: a client that lost its response collects the result without paying again
- capacity: a queue per service, and `429`/`503` before payment when it is full
- durable jobs: paid jobs survive restarts, and workers can run in separate processes
- the CLI from nothing to live: run it with no wallet, pay it once, then register, verify and deploy it in one go

Two ways to use it:

```text
library:  defineService(...)  ->  createProvider(...)  ->  { fetch(request) }  ->  Hono / Node / Workers / Deno / Bun
gateway:  provider-kit serve --config <file>  ->  forwards paid jobs to your existing API (also as a Docker image)
```

- The provider runtime holds **no Stellar secret keys**; it only knows its `payTo` public address.
- Owner operations (the USDC trustline, 8004 registration, validation requests) run from the CLI and are
  approved in your own wallet, on a page the CLI opens on your computer. See [Approving in your wallet](#approving-in-your-wallet).

The step-by-step guide is [docs/provider-setup-guide.md](../../docs/provider-setup-guide.md).

## From nothing to live

```bash
provider-kit dev --config provider.config.json   # runs it here, paid to a throwaway testnet account: no wallet yet
provider-kit try                                 # pays for one call with test money (starts the provider if needed)
provider-kit launch --config provider.config.json   # one page in your wallet: trustline, registration, verification
provider-kit status                              # where it stands, and the one command to run next
```

- **`dev`** reads `.env`. With `PAY_TO` empty, it makes a [throwaway payout account](#the-throwaway-payout-account),
  so nothing needs a wallet until the service goes live. `--with '<command>'` runs the API a gateway calls next to
  it, and `-- <command>` runs any other provider, such as `provider-kit dev -- node dist/server.js`. `--tunnel` also
  serves it at a temporary public HTTPS address (cloudflared).
- **`launch`** takes the public address from `--url`, `fly.toml` or an `https://` `PUBLIC_ORIGIN`, builds the
  manifest that address will serve, and opens one approval page for every owner step. It saves `PAY_TO` and
  `AGENT_ID`, deploys with `flyctl` when there is a `fly.toml` and you agree, and waits for the public manifest. See
  [Launching](#launching).
- **`status`** reads this computer, the chain and the public address: running here, paid once, registered, live,
  verified. `--json` prints it for scripts and coding agents.

`npm create stellar-service` makes a project with these as npm scripts ([create-stellar-service](../create-stellar-service)).

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

### From an OpenAPI document

An API with an OpenAPI 3.0, 3.1 or 3.2 document doesn't need its config written by hand:

```bash
provider-kit init --openapi http://127.0.0.1:8000/openapi.json    # FastAPI's; or a .json or .yaml file
```

```text
Wrote provider.config.json with 4 services:
  summarize      POST http://127.0.0.1:8000/summarize
  translate      POST http://127.0.0.1:8000/v1/translate  with X-API-Key
  …
Skipped 7 operations:
  GET   /health                             the gateway calls the API with POST
  POST  /documents/{document_id}/summarize  it has a path parameter ({document_id}); the gateway calls one fixed URL
  POST  /upload                             it takes multipart/form-data, not JSON
  …
✓ The config passes Provider Standard v1, checked as provider-kit serve checks it.
```

- **Which operations:** each `POST` that takes a JSON object (or no body) and answers `2xx` with a JSON object, and
  has no path parameters and no required query, header or cookie parameters: what the gateway can call. Every other
  operation is listed with the reason. A provider has at most 25 services.
- **Schemas** become JSON Schema 2020-12 [S4]–[S6]: the body's own schema at the root, the components it uses under
  `$defs`, recursion included. OpenAPI 3.0's `nullable`, `example` and boolean `exclusiveMinimum`/`exclusiveMaximum`
  are rewritten, `readOnly` properties leave the input and `writeOnly` ones the output.
- **From the document:** names from paths (`/v1/text/summarize` is `text-summarize`), titles from summaries,
  descriptions from descriptions (`init` lists the services that have none), tags, and an example when the document
  has a matching input and output.
- **The API's address:** `--upstream`, else the document's server, else where the document was read from.
- **The API's own credentials** (an API key header, bearer or basic) become an `upstream.headers` entry read from
  the environment, such as `"X-API-Key": "env:UPSTREAM_X_API_KEY"`. Credentials that can't be a fixed header
  (OAuth2, cookies) get a warning to set by hand.
- **Checked as `serve` checks it:** a service the kit would refuse, such as a pattern JavaScript can't compile or a
  schema over 32 KiB [S6], is skipped with the problem, so the config always loads.

Price (`0.01`), charge (`upfront`), duration and capacity are first guesses: set them before you serve.

## CLI

| Command | What it does |
| --- | --- |
| `provider-kit dev [--config <file>] [--with '<command>'] [--tunnel] [-- <command> ...]` | Runs a provider on this computer, on testnet: a gateway config (default `./provider.config.json`) in dev mode, or your provider's own command after `--`. Reads `.env`. With `PAY_TO` empty, makes a [throwaway payout account](#the-throwaway-payout-account). `--with` starts the API the gateway calls and waits for it to take connections; `--tunnel` adds a temporary public HTTPS address. |
| `provider-kit launch [--config <file> \| --start '<command>' \| --manifest <url>] [--url <https origin>]` | Takes it live: one approval page for the trustline, the 8004 registration (or its update) and a validation request, then saves `PAY_TO` and `AGENT_ID`, deploys with `flyctl` (`--deploy`, `--no-deploy`) and waits for the public manifest (`--no-wait` skips it). `--validator <G…>` names the verifier, `--no-validation` asks none. See [Launching](#launching). |
| `provider-kit status [--config <file>] [--url <https origin>] [--json]` | Where the provider stands: running here, payTo, paid once, registered [I1]–[I3], live, verified. Names the one command to run next. Reads only. |
| `provider-kit serve --config <file>` | Gateway mode. Graceful shutdown on SIGTERM. `--no-workers` for HTTP-only processes. |
| `provider-kit init [--upstream <url>] [--openapi <file \| url>]` | Writes a starter gateway config. With `--openapi`, writes one from an OpenAPI 3 document: see [From an OpenAPI document](#from-an-openapi-document). `--json` prints what it wrote and skipped as JSON. |
| `provider-kit check (--config <file> \| --manifest <url>)` | Self-check without paying: manifest, facilitator, `payTo` trustline [P2], 8004 registration [I1]–[I3]. A provider on this computer that isn't registered yet passes with a note. Exits 1 on any failure. `--manifest` works for any provider, library or native. Then shows [how agents see you](#how-agents-see-you). `--fix` writes the words search would miss into the config's `provider.description`; `--json` prints the result as JSON. |
| `provider-kit try [<service>] ['<input JSON>' \| @<file>]` | One paid call on testnet, the way any client makes it. Starts the provider for the call when nothing answers. See [Trying a paid call](#trying-a-paid-call). |
| `provider-kit trustline [--config \| --manifest \| --network <testnet\|mainnet>]` | Adds a USDC trustline to `payTo` [P2], approved in its wallet. A new testnet account gets test XLM from Friendbot first. Without `--config` or `--manifest`, it sets up the account the wallet connects and prints it as `PAY_TO`. Signs nothing when the trustline exists. |
| `provider-kit register (--config \| --manifest)` | Registers in the Stellar 8004 identity registry from the `payTo` account, or updates the registration from the agent's owner, approved in the wallet. Adds the USDC trustline first when it is missing, and saves the new `agentId` to `--config` [I2]. |
| `provider-kit request-validation (--config \| --manifest) --validator <G…>` | Asks a verifier for validation in the Stellar 8004 Validation Registry. Checks first that a verifier can validate the provider ([I1]–[I3]), that the connected account may ask for the agent, and that the validator is not the provider itself. Puts the request document on chain as a `data:` URI, has the owner's wallet sign it and prints the request hash for the verifier. `--out` writes the request document. |
| `provider-kit reconcile (--config <file> \| --store <file> --network <net>)` | Decides `payment_uncertain` jobs from on-chain data [J13]. `--dry-run` only reports; `--rpc <url>` picks the Soroban RPC. It reads the chain, writes only the job store and signs nothing, so it is safe next to a running provider. Exits 1 while a job is undecided. |

`launch` runs what `trustline`, `register` and `request-validation` run one at a time. Those three take
`--source <key>` to sign with the [Stellar CLI](https://developers.stellar.org/docs/tools/cli) keychain instead of a
wallet, for scripts and CI. With `--source`, `--dry-run` prints the Stellar CLI command. `--rpc <url>` picks the
Soroban RPC.

### The throwaway payout account

A provider has to be paid to an account that holds a USDC trustline [P2]. During development that needn't be yours:
with `PAY_TO` empty, `provider-kit dev` (and `try`, when it starts a gateway) makes a new testnet account, gets it
test XLM from Friendbot and signs its trustline with a key that lives in memory only. Then the key is dropped. It is
never written to a file or the environment, and the provider never sees it: like any provider, it knows only the
public address.

The address goes in `.env` as `PAY_TO`, and as `DEV_PAY_TO`, so `launch` can tell it from an account of yours and
replace it. What it receives is test money nobody can spend. It is never made on Mainnet.

### Launching

```bash
provider-kit launch --config provider.config.json            # a gateway, its address from fly.toml
provider-kit launch --start 'node dist/server.js' --url https://api.example.com
```

```text
Launching Text Tools on Stellar Testnet
  manifest   https://text-tools.fly.dev/.well-known/stellar-agent-services.json
  services   summarize, translate

Approve in your wallet
  http://localhost:8790/#…
  ✓ Connected GBQX…7KQM (Freighter)
  ✓ Get test XLM: funded by Friendbot
  ✓ Add USDC: USDC trustline added · https://stellar.expert/explorer/testnet/tx/…
  ✓ Register: agent 42 · https://stellar.expert/explorer/testnet/tx/…
  ✓ Request validation: request 3f0a9c41d2e7… · https://stellar.expert/explorer/testnet/tx/…
  ✓ Saved PAY_TO=GBQX…, AGENT_ID=42 in .env
  ✓ Saved PUBLIC_ORIGIN, PAY_TO, AGENT_ID in fly.toml's [env], for every deploy

✓ Text Tools is agent 42 on Stellar Testnet, paid to GBQX…7KQM
✓ Validation requested from GBRP…OX2H (request 3f0a9c41d2e7…): its answer lands in the Validation Registry

Deploy to Fly.io now (fly deploy, app text-tools)? [Y/n]
```

- **The address before the deploy.** `--url`, else `fly.toml`'s app (`https://<app>.fly.dev`), else an `https://`
  `PUBLIC_ORIGIN`. A quick tunnel's address is refused: it changes every run.
- **The manifest that address will serve**, checked against the standard: from the gateway config, from your
  provider's own command (`--start`, run on a free port with `PUBLIC_ORIGIN`, `PAY_TO` and a throwaway job database),
  or from a deployed provider (`--manifest`). Until a wallet connects, a stand-in `payTo` builds it: the registration
  doesn't name `payTo`, and the registry makes the registering account the agent's wallet [I3].
- **One page.** The steps the chain still needs, in order: test XLM, the trustline, `register_with_uri` (or
  `set_agent_uri` when the manifest moved), and `validation_request`, built once the agent id is known. The verifier
  is `--validator`, `STELLAR_VALIDATOR`, or the default in `src/cli/validators.ts`; a provider's own account is never
  asked.
- **Saved.** `PAY_TO` and `AGENT_ID` in `.env` (`DEV_PAY_TO` goes), the agent id where the gateway config reads it,
  and the public settings in `fly.toml`. For a provider started by its own command, that includes `STELLAR_NETWORK`
  (and `FACILITATOR_URL` when set), so it takes payments where it registered. A new agent's id is saved even if a later
  step stops, so running `launch` again never registers a second agent; it signs nothing when everything is in place.
- **Deployed and checked.** `flyctl` creates the app the first time, and what may hold a key is staged as Fly secrets
  from `.env`: every variable a gateway config reads, such as the API's key (one that isn't set is named, since the
  gateway can't start without it), or a command's `FACILITATOR_AUTH` and `SOROBAN_RPC_URL`. `fly deploy` runs with one
  machine. Then `launch` waits until the public manifest serves the agent id, on the network it registered on, and
  checks [I1]–[I3] from outside. A gateway whose `upstream.url` is on 127.0.0.1 isn't deployed: in a container
  that is the container itself, unless the API runs inside it too, as the Python kind's does.
- **Mainnet.** The same steps, on `stellar:pubnet`: the wallet's account needs a few XLM, as no Friendbot funds it.
  Mainnet's facilitator, OpenZeppelin's (`https://channels.openzeppelin.com/x402`), wants an API key: a gateway config
  sends it with `"facilitatorHeaders": { "Authorization": "env:FACILITATOR_AUTH" }`. The provider checks it at start,
  and a 401 says so. `npm create stellar-service -- --network mainnet` sets all of this up
  ([Mainnet](../create-stellar-service/README.md#mainnet)).

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
- **Not running?** When nothing answers, `try` starts the provider for the call and stops it after: the gateway
  config in its own process (with a throwaway `payTo` when `PAY_TO` is empty), or `--start '<command>'`, such as
  `--start 'npm run dev'`.
- **The payer:** a throwaway test account, made for this call. It gets test XLM from Friendbot and exactly the price
  in test USDC from the testnet DEX. Its key stays in memory and is never written anywhere. You need no payer wallet.
- **The payment:** the payment client's own flow, with every check. The exact price, payee and network are shown and
  approved first (`--yes` skips the question, for scripts), and its spending policy allows that one payment only.
  The transfer is confirmed on chain [J16].
- **Testnet only.** A provider on Mainnet is refused before anything is signed.

`--json` prints the outcome as JSON on standard output (the job, its status, the payment and the output) and the
steps on standard error. It exits 0 only when the job succeeded and its payment is confirmed. If the answer to the paid request is lost, it
says the payment may have gone through and never calls it unpaid: your provider decides it from the chain
[J13]. If the testnet DEX has no USDC for sale, nothing is paid: try again later, or pay with `stellar-pay` from a
test wallet of your own, funded at [faucet.circle.com](https://faucet.circle.com) (setup guide §6).

### How agents see you

`provider-kit check` ends with the provider as agents meet it, and hints that never fail the check:

```text
How agents see you
  Search matches this name and description, which provider-kit launch publishes:
    Text Tools API
    Summaries, translations and labels for English text.
  · On testnet it also matches your services' names, titles, descriptions and tags, once the manifest is live
    and names the agent [I1]–[I3].
  ! translate: a 7-word description, no example
  ! classify-tree: a 3-word description, no example
    An agent picks a service by its description: what it does, when to use it, its limits, with no price or
    URL [§3.4]. An example shows it what to send, and provider-kit try pays with it.
  · On mainnet, search reads no service names, titles or tags: agents searching there for "summarize",
    "translate", "classify", "tree", "random" or "fact" wouldn't find you. provider-kit check --fix puts those
    words in provider.description.
  · Ranking counts reviews from distinct paying clients only. Until the first, search lists you as new and
    unrated.
  · Not registered yet: provider-kit launch publishes this name and description.
```

- **Search** (stellar-agent-search's `find_agent`, and 8004 explorers) matches a query against the registration: the
  name and description `launch` publishes from `provider.name` and `provider.description`, and the registration's
  services. On testnet, stellar-agent-search 0.2.0 reads agents straight from the registry and also matches a bound
  manifest's services: their names, titles, descriptions and tags. On mainnet, its explorer lists no services, so
  only the name and description count: there, a word from a service's name, title or tags that the name and
  description miss is a warning, and `check --fix` writes the missing words into a gateway config's description.
  Words are matched the way stellar-agent-search 0.2.0 matches them: folded, its stopwords dropped, a crude stem,
  then a substring test.
- **Once registered,** it shows the name and description the registry has, says when they are older than the
  manifest (`launch` updates them), and prints the stellar-agent-search command that shows the live profile.
- **Each service:** a description too short to say what it does, when to use it and its limits, a price or URL
  in it [§3.4], or no example.

### Approving in your wallet

Without `--source`, an owner command (`launch`, `trustline`, `register`, `request-validation`) opens a page on this
computer, `http://localhost:8790` (or any free port), where you connect the wallet you already use and approve each
transaction:

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
| `src/gateway/openapi.ts` | Gateway services from an OpenAPI document, for `provider-kit init --openapi` |
| `src/registration.ts` | 8004 registration file, the I1–I3 check (with the file it read), and who may act for an agent |
| `src/cli/` | The `provider-kit` command |
| `src/cli/dev.ts`, `src/cli/dev-account.ts` | `provider-kit dev`, and the throwaway payout account it makes when `PAY_TO` is empty |
| `src/cli/launch.ts` | `provider-kit launch`: the public address, the manifest it will serve, one approval page, the settings saved, the deploy and the live check |
| `src/cli/status.ts` | `provider-kit status`: each stage, and the command to run next |
| `src/cli/serve.ts` | `provider-kit serve`, and `serveGateway()` that `dev` and `try` start a gateway with |
| `src/cli/env-file.ts`, `src/cli/fly.ts` | Reading and writing `.env` and `fly.toml`'s `[env]`; deploying with `flyctl` |
| `src/cli/processes.ts`, `src/cli/tunnel.ts` | Starting and stopping a provider's command, waiting for its manifest; the cloudflared quick tunnel |
| `src/cli/validators.ts` | The verifier `launch` asks by default, per network |
| `src/cli/approval.ts` | Approving in a wallet: the session (steps, checks, sending) and the local page's server and API |
| `src/cli/approval-view.ts` | What the page shows: the session as JSON, shared with the page |
| `src/cli/owner-chain.ts` | The owner's transactions: built, checked once signed, sent and followed into a ledger |
| `src/cli/owner-steps.ts` | Test XLM, the USDC trustline, registration and the validation request, as approval steps |
| `src/cli/try.ts` | `provider-kit try`: one paid testnet call through the payment client, from a throwaway payer |
| `src/cli/discovery.ts` | How agents see you, for `provider-kit check`: search text matched as stellar-agent-search matches it, and hints |
| `approve/` | The approval page (Svelte, Stellar Wallets Kit), built into `dist/approve` |
| `schemas/gateway-config.schema.json` | The gateway config file's JSON Schema |
| `Dockerfile` | The gateway image |
