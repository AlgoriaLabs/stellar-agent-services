# Provider setup guide

This guide takes you from an idea or an existing API to a paid AI service on Stellar that any client can find,
pay in USDC and recover jobs from, following [Provider Standard v1](provider-standard.md). It uses Stellar
**testnet** throughout.

You never give the provider a Stellar secret key. It knows only the public address it is paid to (`payTo`); an
x402 facilitator verifies and settles payments. The only signing step, registering your identity, runs from your
own machine through the Stellar CLI keychain.

## 1. Pick a path

| Path | Choose it when | You write |
| --- | --- | --- |
| **Gateway** | You already have an HTTP API, in any language | A JSON config file |
| **TypeScript library** | You are writing a new service in TypeScript | A `defineService(...)` per service |
| **Native** | You want no dependency on the kit | The standard, in your own stack ([provider-standard.md](provider-standard.md)) |

Both kit paths give you the same things: the manifest, the `402` challenge, payment checks, job recovery,
capacity limits and a job store that survives restarts.

## 2. Prerequisites

- **Node.js 22.13 or later** for the library and the CLI, or **Docker** for the gateway.
- **The kit.** The packages are not on npm yet, so get them from this repository:

  ```bash
  git clone https://github.com/AlgoriaLabs/stellar-agent-services.git
  cd stellar-agent-services
  npm install && npm run build
  alias provider-kit="node $PWD/packages/provider-kit/dist/cli/index.js"
  ```

- **A `payTo` account on testnet with a USDC trustline** [P2]. With the
  [Stellar CLI](https://developers.stellar.org/docs/tools/cli), which you also need for registration (step 8):

  ```bash
  stellar keys generate payto --network testnet --fund
  stellar tx new change-trust --source-account payto --network testnet \
    --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
  export PAY_TO=$(stellar keys address payto)
  ```

  The key stays in the Stellar CLI keychain. The provider only ever sees `PAY_TO`, the public address.

## 3a. Gateway: an existing API

Your API needs one endpoint per service that takes the input as a JSON body (`POST`) and answers with a JSON
object. It needs to know nothing about payments.

```bash
provider-kit init --upstream http://127.0.0.1:5000/run
```

This writes `provider.config.json`. Edit each service:

- `name`, `title` and `description`. Write the description for an agent deciding whether to call you: what it
  does, when to use it and its limits (spec §3.4).
- `price` in USDC, such as `"0.05"`.
- `charge`: `"on-success"` charges only if the call succeeds, and suits work that finishes in under half a minute.
  `"upfront"` charges first and suits longer or expensive work (spec §3.2).
- `expectedDurationSeconds`, and `timeoutSeconds` if the call may take longer than twice that.
- `inputSchema` and `outputSchema`: JSON Schemas whose root is `"type": "object"`, inline or as file paths. The
  gateway refuses input that doesn't match before anyone pays, and output that doesn't match is a failed job.
- `examples`: an example input and output. Agents and catalogs show them.
- `upstream.url`, and `upstream.headers` for your API's own key, written `"env:NAME"` so it stays out of the file.

Then run your API and the gateway:

```bash
provider-kit serve --config provider.config.json
```

The gateway checks the whole config and refuses to start, listing every problem, if something would fail the
standard. [examples/python-upstream](../examples/python-upstream) is a complete example with a Python API.

**With Docker** instead of Node, from the repository root:

```bash
docker build -f packages/provider-kit/Dockerfile -t provider-kit .
docker run -p 8787:8787 -e PAY_TO -v "$PWD/provider.config.json:/config/provider.config.json:ro" \
  -v provider-jobs:/data provider-kit
```

Set `"store": "/data/jobs.sqlite"` in the config so jobs live on the volume. If the config refers to schema files,
mount them next to it under `/config`.

## 3b. TypeScript library: a new service

Copy [examples/paid-service](../examples/paid-service), the template for new providers, and replace its two
services with yours:

```ts
import { createProvider, defineService, sqliteStore } from "@stellar-agent-services/provider-kit";

export const translate = defineService({
  name: "translate",
  description: "Translates English text to Turkish. Up to 5,000 characters.",
  price: "0.02",
  charge: "on-success",
  expectedDurationSeconds: 5,
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 5000 } }, additionalProperties: false },
  outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  examples: [{ input: { text: "Hello" }, output: { text: "Merhaba" } }],
  handler: async ({ text }, { signal }) => ({ text: await myModel.translate(text, { signal }) }),
});
```

The handler gets only the validated input and `{ signal, jobId }`, never payment data. Stop work when `signal`
aborts. An `upfront` job whose worker died is run again, so use `jobId` to make side effects happen once.

`createProvider(...)` throws at startup if anything would fail the standard; `await provider.ready()` checks the
facilitator and resumes jobs from before a restart. Use `sqliteStore(path)`: the default memory store loses jobs on
restart.

## 4. Set capacity

Each service runs `capacity.concurrency` jobs at once (default 4) and queues the rest. A new job that would wait
longer than `capacity.maxQueueWaitSeconds` (default 60) is turned away with `503` and `Retry-After` **before
payment**, so nobody pays for work you can't do. Set `concurrency` to what your GPU, worker pool or upstream quota
takes, per process. With the SQLite store, several processes on one machine share one queue and one limit; see
[the kit README](../packages/provider-kit/README.md#restarts-several-processes-separate-workers). A native
implementation follows rules Q1–Q9 of spec §5.8.

## 5. Check it locally

```bash
provider-kit check --config provider.config.json                                   # gateway
provider-kit check --manifest http://localhost:8787/.well-known/stellar-agent-services.json --dev   # any provider
```

`check` costs nothing and needs no key. It verifies the manifest against the standard, that the facilitator settles
testnet payments with sponsored fees, that `payTo` exists with a USDC trustline, and your 8004 registration once
you have one. Until step 8 it reports that the agent id is missing; that is expected.

Then check it from outside, the way a verifier will, with the [verifier](../packages/verifier). It calls your
running service: invalid input, the `402` challenge, an oversized body, CORS, and a burst of 20 requests. Kit
providers pass it; it matters most for native implementations.

```bash
alias verifier="node $PWD/packages/verifier/dist/cli/index.js"
verifier check http://localhost:8787/.well-known/stellar-agent-services.json --dev
```

## 6. Make a paid testnet request

Pay your own service with the payment client, from a separate payer wallet:

```bash
npx stellar-pay wallet create
npx stellar-pay wallet fund --usdc 2
MANIFEST=http://localhost:8787/.well-known/stellar-agent-services.json
npx stellar-pay services $MANIFEST --dev
npx stellar-pay pay $MANIFEST <service> '<input JSON>' --dev
```

You see the approval prompt, the payment settles on testnet, and the client confirms the `transfer` on chain. The
web page in [apps/wallet](../apps/wallet) does the same in a browser.

## 7. Deploy on HTTPS

Clients accept `http://` only in development [M6]. Run the provider behind HTTPS at a stable origin:

- set `baseUrl` to the public URL, such as `https://api.example.com/agent`, and remove `dev`;
- keep the SQLite file on persistent disk: paid jobs and recovery depend on it;
- give the provider a Soroban RPC (`rpcUrl` in the gateway config, `rpc` in `createProvider()`). It decides
  `payment_uncertain` jobs from the chain by itself. Testnet uses the public RPC by default; mainnet has none,
  so set yours. `provider-kit reconcile --config provider.config.json --dry-run` shows where uncertain jobs
  stand (see [job-recovery.md](job-recovery.md#reconciliation));
- for `rateLimit`, set `keyHeader` to the header your proxy puts the client address in;
- health checks can use `GET /healthz`.

## 8. Register on Stellar 8004

Your 8004 registration is your on-chain identity. It names your manifest, and its wallet is the address users pay,
so a client can check it is paying the right provider [I1]–[I3].

```bash
provider-kit register --config provider.config.json --source payto --dry-run   # review
provider-kit register --config provider.config.json --source payto
```

Registering with your `payTo` key as `--source` makes it the agent's wallet at once. Then add the agent id the
command prints as `"agentId"` under `provider` in your config (or `AGENT_ID` for the example), restart, and run
`provider-kit check` again: every line should pass.

## 9. Get verified

The verifier checks a provider from outside, issues a verification receipt and badges, and records the result in
the Stellar 8004 Validation Registry (see [verification.md](verification.md)).

1. Once deployed, run `verifier check <your manifest URL>`: every check should pass, and C2 confirms your 8004
   registration.
2. Ask a verifier for validation, naming its address. Sign with the key you registered with:

   ```bash
   provider-kit request-validation --config provider.config.json --validator <verifier G…> --source payto --dry-run   # review
   provider-kit request-validation --config provider.config.json --validator <verifier G…> --source payto
   ```

   It checks your registration first, records the request in the Validation Registry and prints its hash. Send the
   verifier your manifest URL and that hash. [verification.md](verification.md#stellar-8004-validation-registry)
   describes the request.
3. The verifier runs every check, paying for a few jobs from its own test account, publishes the receipt and answers
   your request on chain. Its receipt gives your badges: Standard v1, Payment verified, Recovery verified,
   Load-safe and 8004 validated.
