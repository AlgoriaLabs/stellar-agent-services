# Provider setup guide

This guide takes you from an idea or an existing API to a paid AI service on Stellar that any client can find,
pay in USDC and recover jobs from, following [Provider Standard v1](provider-standard.md). It uses Stellar
**testnet** throughout.

You never give the provider a Stellar secret key. It knows only the public address it is paid to (`payTo`); an
x402 facilitator verifies and settles payments. Your own wallet is the payout account, and you need it only when the
service goes live: until then, test payments go to a throwaway testnet account. Going live is one page in your
wallet, which `provider-kit launch` opens on your computer. No key is ever exported, imported or stored by the kit,
and the income lands in the wallet you already use.

## Quick start

```bash
npm create stellar-service my-service      # from a clone until the packages are on npm: see §2
cd my-service
npm run dev       # runs it here, paid to a throwaway testnet account: no wallet needed yet
npm run try       # pays for one call with test money, from another terminal
npm run launch    # goes live: one approval in your wallet, then Fly.io
npm run status    # where it stands, and what to run next
```

The rest of this guide is what those commands do, and how to do each step yourself.

## 1. Pick a path

| Path | Choose it when | You write |
| --- | --- | --- |
| **Gateway** | You already have an HTTP API, in any language | A JSON config file |
| **TypeScript library** | You are writing a new service in TypeScript | A `defineService(...)` per service |
| **Native** | You want no dependency on the kit | The standard, in your own stack ([provider-standard.md](provider-standard.md)) |

Both kit paths give you the same things: the manifest, the `402` challenge, payment checks, job recovery,
capacity limits and a job store that survives restarts.

**Fastest start:** `npm create stellar-service` makes a project for either kit path, or a new Python service behind
the gateway, with the scripts above, a Dockerfile and `fly.toml` ([create-stellar-service](../packages/create-stellar-service)).
Until the packages are on npm, run it from the clone (§2): `node packages/create-stellar-service/dist/index.js my-service`.

## 2. Prerequisites

- **Node.js 22.13 or later** for the library and the CLI, or **Docker** for the gateway.
- **The kit.** The packages are not on npm yet, so get them from this repository:

  ```bash
  git clone https://github.com/AlgoriaLabs/stellar-agent-services.git
  cd stellar-agent-services
  npm install && npm run build
  alias provider-kit="node $PWD/packages/provider-kit/dist/cli/index.js"
  ```

- **A Stellar wallet, to go live** (§7): the one you already use, such as Freighter, xBull, Albedo, Rabet, Hana,
  MetaMask or a Ledger ([Stellar Wallets Kit](https://stellarwalletskit.dev) lists them). Its account becomes your
  payout account, `payTo`. Tip: add a second account in the same wallet just for the service. You don't need it to
  build and try the service.

## 3a. Gateway: an existing API

Your API needs one endpoint per service that takes the input as a JSON body (`POST`) and answers with a JSON
object. It needs to know nothing about payments.

**If your API has an OpenAPI document**, start from it. FastAPI serves one at `/openapi.json`; Django
(drf-spectacular), Spring, NestJS and most frameworks can write one:

```bash
provider-kit init --openapi http://127.0.0.1:8000/openapi.json     # or a .json or .yaml file, with --upstream <url>
```

This writes `provider.config.json` with a service for each `POST` endpoint the gateway can call: its schemas
(converted to JSON Schema 2020-12), title, description, tags and example come from the document. It lists every
other operation with the reason it was skipped, such as a path parameter or a file upload, and checks the config as
`serve` would. If the API needs its own key, it is sent from an environment variable that `init` names. Then
review the guesses below, starting with the price.

**Otherwise**, start from one service and write its schemas yourself:

```bash
provider-kit init --upstream http://127.0.0.1:5000/run
```

This writes `provider.config.json`. Edit each service:

- `name`, `title` and `description`. Write the description for an agent deciding whether to call you: what it
  does, when to use it and its limits (spec §3.4).
- `price` in USDC, such as `"0.05"`.
- `charge`: `"on-success"` charges only if the call succeeds, and suits work that finishes in under half a minute.
  `"upfront"` charges first and suits longer or expensive work (spec §3.2). `init` starts with `on-success`.
- `expectedDurationSeconds`, and `timeoutSeconds` if the call may take longer than twice that.
- `inputSchema` and `outputSchema`: JSON Schemas whose root is `"type": "object"`, inline or as file paths. The
  gateway refuses input that doesn't match before anyone pays, and output that doesn't match is a failed job.
- `examples`: an example input and output. Agents and catalogs show them.
- `upstream.url`, and `upstream.headers` for your API's own key, written `"env:NAME"` so it stays out of the file.

Then run your API and the gateway:

```bash
provider-kit dev --config provider.config.json
```

`dev` reads `.env`, and with `PAY_TO` empty it makes a throwaway testnet account to be paid to (§5). `--with
'<command>'` also starts your API next to the gateway, such as `--with 'uvicorn app:app --port 8000'`, and stops both
together. The gateway checks the whole config and refuses to start, listing every problem, if something would fail
the standard. [examples/python-upstream](../examples/python-upstream) is a complete example with a Python API.

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
restart. Read `baseUrl` from `PUBLIC_ORIGIN` and `payTo` from `PAY_TO`, as the template's `src/server.ts` does, so
`provider-kit dev -- node dist/server.js` and `launch --start 'node dist/server.js'` can run it.

## 4. Set capacity

Each service runs `capacity.concurrency` jobs at once (default 4) and queues the rest. A new job that would wait
longer than `capacity.maxQueueWaitSeconds` (default 60) is turned away with `503` and `Retry-After` **before
payment**, so nobody pays for work you can't do. Set `concurrency` to what your GPU, worker pool or upstream quota
takes, per process. With the SQLite store, several processes on one machine share one queue and one limit; see
[the kit README](../packages/provider-kit/README.md#restarts-several-processes-separate-workers). A native
implementation follows rules Q1–Q9 of spec §5.8.

## 5. Run and check it locally

```bash
provider-kit dev --config provider.config.json      # a gateway
provider-kit dev -- node dist/server.js             # any other provider, by its own command
```

**The throwaway payout account.** With `PAY_TO` empty, `dev` makes a new testnet account, gets it test XLM from
Friendbot and signs its USDC trustline [P2] with a key that lives in memory only. Then the key is dropped. The
provider only ever sees the public address, which goes in `.env` as `PAY_TO` and `DEV_PAY_TO`. Test payments land
there, and nobody can spend them. `launch` replaces it with your own account (§7). It is testnet only.

`--tunnel` also serves the provider at a temporary public HTTPS address (a Cloudflare quick tunnel, which needs
`cloudflared`), so a teammate, an agent on another computer or `verifier check` can reach it. The address changes
every run, so `launch` never registers it.

Then check it:

```bash
provider-kit check --config provider.config.json --dev                                       # gateway
provider-kit check --manifest http://localhost:8787/.well-known/stellar-agent-services.json --dev   # any provider
```

`check` costs nothing and needs no key. It verifies the manifest against the standard, that the facilitator settles
testnet payments with sponsored fees, that `payTo` exists with a USDC trustline, and your 8004 registration once
you have one. Before `launch`, it notes that the provider isn't registered yet; that doesn't fail the check.

It ends with how agents see you. Search matches your provider's name and description and, on testnet, your services'
names, titles, descriptions and tags too, once the manifest is live and bound to the registration. On mainnet it
reads only the name and description, so `check` lists the words from your services' names, titles and tags that a
search there wouldn't find, and `--fix` writes them into a gateway config's `provider.description`. It also flags services whose description is too thin to choose by [§3.4], or that
have no example ([details](../packages/provider-kit/README.md#how-agents-see-you)). These hints never fail the check.
`--json` prints the result for scripts and coding agents.

Then check it from outside, the way a verifier will, with the [verifier](../packages/verifier). It calls your
running service: invalid input, the `402` challenge, an oversized body, CORS, and a burst of 20 requests. Kit
providers pass it; it matters most for native implementations.

```bash
alias verifier="node $PWD/packages/verifier/dist/cli/index.js"
verifier check http://localhost:8787/.well-known/stellar-agent-services.json --dev
```

## 6. Make a paid testnet request

Pay your own service once, the way any client will:

```bash
provider-kit try <service>                    # with the service's example input
provider-kit try <service> '<input JSON>'     # or your own input, or @input.json
```

It shows the exact payment and asks first. Then it pays from a throwaway testnet account it makes for this call,
with test XLM from Friendbot and the price in test USDC from the testnet DEX, and shows the result and the
`transfer` on chain. You need no payer wallet, and the throwaway key is never written anywhere. A gateway is found
from `provider.config.json`, any other provider with `--manifest <url>`, and without either it tries
`http://localhost:8787`. When nothing answers, it starts the provider for the call: the gateway config in its own
process, or `--start '<command>'`, such as `--start 'npm run dev'`. `--json` prints the outcome as JSON.

<details>
<summary>Pay from your own test wallet instead</summary>

The payment client's CLI keeps a payer wallet, a spending policy and a journal, as a real client does, and can
recover a job after a lost response ([job-recovery.md](job-recovery.md)):

```bash
npx stellar-pay wallet create
npx stellar-pay wallet fund --usdc 2
MANIFEST=http://localhost:8787/.well-known/stellar-agent-services.json
npx stellar-pay pay $MANIFEST <service> '<input JSON>' --dev
```

The web page in [apps/wallet](../apps/wallet) does the same in a browser.

</details>

## 7. Go live: `provider-kit launch`

```bash
provider-kit launch --config provider.config.json                        # a gateway
provider-kit launch --start 'node dist/server.js' --url https://api.example.com   # any provider this computer runs
```

1. **The public address.** `--url`, else the app in `fly.toml` (`https://<app>.fly.dev`), else an `https://`
   `PUBLIC_ORIGIN`. It is known before the first deploy, so the service is registered first and deployed once, with
   its agent id in place.
2. **The manifest as that address will serve it**, checked against the standard: built from the gateway config, or
   from your provider's own command, started on this computer with `PUBLIC_ORIGIN` set (`--start`). For a provider
   already deployed, `--manifest <url>` reads it from there.
3. **One page in your wallet.** Connect the wallet you already use and approve, in one go: test XLM for a new testnet
   account, the USDC trustline [P2], the Stellar 8004 registration [I1]–[I3], and a validation request to a verifier
   (§9). The account that connects becomes `payTo` and the agent's owner and wallet, unless `PAY_TO` already names an
   account of yours, which must then connect.
4. **Saved where the provider reads it.** `PAY_TO` and `AGENT_ID` go in `.env`, the agent id where the gateway config
   reads it (`"agentId": "env:AGENT_ID"`, or the config itself), and `PUBLIC_ORIGIN`, `PAY_TO` and `AGENT_ID` in
   `fly.toml`'s `[env]`. A new agent's id is saved even when a later step stops, so nothing is registered twice: run
   `launch` again to finish.
5. **Deploy, then check.** With `fly.toml` and your yes (`--deploy` skips the question), it deploys with `flyctl`:
   it creates the app the first time, stages your API's key from `.env` as a Fly secret, and runs `fly deploy` with
   one machine and the job database on a volume. Then it waits until the public manifest serves the agent id, and
   checks the registration from outside. Elsewhere, it prints the settings to deploy with. A gateway whose
   `upstream.url` is on 127.0.0.1 isn't deployed: in a container that is the container itself, so point it at an
   address the container reaches, such as your API's public URL.

Running `launch` again is safe: it signs nothing when the registration already names the manifest and the verifier
was asked. After you move the manifest, or change the name or description search reads, it updates the registration.

**On a computer without a browser**, such as over SSH, add `--no-open` and open the printed link wherever your
wallet is: the link reaches only this computer, so forward its port (`ssh -L 8790:localhost:8790`).

<details>
<summary>The same steps one by one, and for scripts and CI</summary>

`launch` runs the owner steps that `trustline`, `register` and `request-validation` run one at a time. They also
take `--source <key>` to sign with a key from the [Stellar CLI](https://developers.stellar.org/docs/tools/cli)
keychain instead of a wallet, for scripts and CI, and with it `--dry-run` prints the Stellar CLI command:

```bash
stellar keys generate payto --network testnet --fund --secure-store
provider-kit trustline --config provider.config.json --source payto
provider-kit register --config provider.config.json --source payto
provider-kit request-validation --config provider.config.json --validator <verifier G…> --source payto
```

`register` registers from the `payTo` account, so the registry makes it the agent's owner and wallet [I3]. It saves the
new agent id as `"agentId"` under `provider` in your config, or prints it for a library provider.

</details>

## 8. Run it in production

Clients accept `http://` only in development [M6]. `launch` deploys to Fly.io; on any other host, run the project's
`Dockerfile` (or the gateway image) behind HTTPS at a stable origin:

- set `PUBLIC_ORIGIN` (the gateway config's `baseUrl`) to the public URL, such as `https://api.example.com`, without
  `dev`;
- keep the SQLite file on persistent disk: paid jobs and recovery depend on it. The project's image gives `/data` to
  its `node` user at start, so a host's new volume works as it comes;
- give the provider a Soroban RPC (`rpcUrl` in the gateway config, `rpc` in `createProvider()`). It decides
  `payment_uncertain` jobs from the chain by itself. Testnet uses the public RPC by default; mainnet has none,
  so set yours. `provider-kit reconcile --config provider.config.json --dry-run` shows where uncertain jobs
  stand (see [job-recovery.md](job-recovery.md#reconciliation));
- for `rateLimit`, set `keyHeader` to the header your proxy puts the client address in;
- health checks can use `GET /healthz`.

### On mainnet

Everything above holds on `stellar:pubnet`, where clients pay real USDC. `npm create stellar-service -- --network
mainnet` starts a project there; a testnet project moves by hand
([create-stellar-service](../packages/create-stellar-service/README.md#mainnet)). What is different:

- **The facilitator.** x402.org's settles testnet only. Stellar's docs list OpenZeppelin's for mainnet,
  `https://channels.openzeppelin.com/x402`, which wants an API key from
  [channels.openzeppelin.com/gen](https://channels.openzeppelin.com/gen). A gateway config sends it with
  `"facilitatorHeaders": { "Authorization": "env:FACILITATOR_AUTH" }` and `FACILITATOR_AUTH="Bearer <key>"` in `.env`;
  the library takes `httpFacilitator(url, { headers })`. The provider checks it when it starts, before any payment.
- **The RPC.** Mainnet has no public default: set `rpcUrl` or `rpc`. The Stellar 8004 SDK uses
  `https://mainnet.sorobanrpc.com`; for production traffic, an
  [RPC provider](https://developers.stellar.org/docs/data/apis/rpc/providers)'s is safer.
- **No test money.** `provider-kit try` and the throwaway account are testnet only. `launch` connects an account of
  yours, which needs a few XLM for the trustline's reserve and the fees. It stages the facilitator's key and the RPC
  as Fly secrets.
- **Search.** On mainnet, search matches only the provider's name and description: `provider-kit check --fix` writes
  the missing words in.

## 9. Get verified

A verifier checks a provider from outside, issues a verification receipt and badges, and records the result in
the Stellar 8004 Validation Registry (see [verification.md](verification.md)).

`launch` asks for it: the validation request names a verifier (`--validator <G…>`, `STELLAR_VALIDATOR`, or the kit's
default) and goes on chain with the manifest's URL in it. A verifier that runs `verifier watch` picks the request up by
itself, checks the provider (paying for a few jobs from its own test account), publishes the receipt and answers on
chain. Nothing needs to be sent to anyone. Its receipt gives your badges: Standard v1, Payment verified, Recovery
verified, Load-safe and 8004 validated.

Before that, run `verifier check <your manifest URL>`: every check should pass, and C2 confirms your 8004
registration.

## 10. See where it stands

```bash
provider-kit status            # --json for scripts and coding agents
```

```text
Status on Stellar Testnet
  ✓ local      Text Tools runs at http://localhost:8787/.well-known/stellar-agent-services.json
  ✓ payTo      GC2W…A4DJ, your account, can receive USDC
  ✓ paid       payTo holds 0.0300000 USDC: paid calls reached it
  ✓ registered agent 42: its registration lists https://text-tools.fly.dev/.well-known/stellar-agent-services.json, its wallet is payTo
  ✓ live       https://text-tools.fly.dev/.well-known/stellar-agent-services.json answers
  ✗ verified   requested from GBRP…OX2H, no answer yet

Next: Waiting for the verifier GBRP…OX2H to answer: it checks the service and answers on chain.
```

It reads this computer, the chain and the public address, and names the one command to run next. It finds the
public manifest from `--url`, `fly.toml` or an `https://` `PUBLIC_ORIGIN`, else from the registration itself. It
only reads: no key, no payment, no transaction.
