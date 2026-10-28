---
name: wrap-existing-api
description: Put an existing HTTP API, in any language (Python, Go, Rust, Java, Ruby, PHP, TypeScript), behind per-call USDC payments on Stellar without changing its code, using the Provider Kit's gateway mode and a JSON config, generated from the API's OpenAPI document when it has one, such as FastAPI's /openapi.json (Provider Standard v1, x402). Use when the user wants to monetize, sell or charge agents for an API, model server or endpoint they already run. For a new TypeScript service, use build-paid-service.
---

# Make an existing API paid with the gateway

The gateway stands in front of the API. It publishes the manifest, refuses invalid input before anyone pays, asks
for the x402 payment, POSTs only the validated input to the API, checks the answer against the output schema,
settles, and keeps the job so a client can recover it. The API needs no change and never sees payment data.

Reference: `docs/provider-setup-guide.md` §3a and the "Gateway mode" section of `packages/provider-kit/README.md`.
Worked example: `examples/python-upstream` (a Python API and its `provider.config.json`). Read them in the
repository or at `https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/<path>`.

## 1. Check the API fits

Each service needs one endpoint that takes the input as a JSON object body (`POST`) and answers `2xx` with a JSON
object. If an endpoint takes query parameters, form data or files, add a small JSON adapter route to the API first,
and tell the user why. `429`, `502`–`504` and connection errors are retried within the job's time, honoring
`Retry-After`. The gateway sends `Idempotency-Key: <job id>`, so the API can do side effects once.

## 2. Get the kit

The packages are not on npm. Find a built clone (ask the user), or clone one with the user's agreement:

```bash
git clone https://github.com/AlgoriaLabs/stellar-agent-services.git
cd stellar-agent-services && npm install && npm run build && REPO=$PWD
alias provider-kit="node $REPO/packages/provider-kit/dist/cli/index.js"
alias verifier="node $REPO/packages/verifier/dist/cli/index.js"
```

Docker works too: `docker build -f packages/provider-kit/Dockerfile -t provider-kit .` from the clone.

For a new project around the API, the scaffolder does §3 and more:
`node $REPO/packages/create-stellar-service/dist/index.js <folder> --kind wrap --openapi <document> --no-wallet`
(or `--upstream <url>` without a document). It runs `provider-kit init`, makes the config read `PUBLIC_ORIGIN`,
`PAY_TO` and `JOB_DB_PATH` from `.env`, and writes a Dockerfile and npm scripts (`dev`, `try`, `check`,
`register`). Read its output to the user, then review the config as §3 says. Ask the user before `--wallet`: it
opens the trustline approval page in their browser.

## 3. Write the config

If the API has an OpenAPI 3 document (FastAPI serves one at `/openapi.json`; look for `openapi.json`,
`openapi.yaml` or `/v3/api-docs`), generate the config from it:
`provider-kit init --openapi http://127.0.0.1:8000/openapi.json`, or a file path with `--upstream <the API's base
URL>`. It writes a service for each `POST` endpoint the gateway can call, with schemas, descriptions and examples
from the document. It prints every skipped operation with the reason, and checks the config as `serve` does. Read
that output to the user. Then review the result against the list below. The price, charge and duration are guesses.
Descriptions it couldn't find are listed, so write those. Any `env:` header it adds must be set before `serve`.

Without a document, `provider-kit init --upstream http://127.0.0.1:5000/run` writes a starter `provider.config.json`.
Its JSON Schema is `packages/provider-kit/schemas/gateway-config.schema.json`. For each service, set:

- `name` (`^[a-z0-9][a-z0-9_-]{0,63}$`), `title`, and a `description` for an agent deciding whether to call it:
  what it does, when to use it, its limits. No price or URLs in it.
- `price` in USDC, such as `"0.05"`.
- `charge`: `"on-success"` for calls under half a minute (charged only if the call succeeds), `"upfront"` for
  longer or expensive work.
- `expectedDurationSeconds`, and `timeoutSeconds` if a call may take longer than twice that.
- `inputSchema` and `outputSchema`: JSON Schema 2020-12 with root `"type": "object"`, inline or as file paths.
  Derive them from the API's real request and response. Bound every string and array, and set
  `additionalProperties: false` on the input.
- `examples`: one real input and output pair.
- `capacity.concurrency`: what the API can run at once.
- `upstream.url`, and `upstream.headers` for the API's own key, written as `"env:NAME"`.

Top level: `"payTo": "env:PAY_TO"`, `"network": "stellar:testnet"`, `"facilitator": "https://x402.org/facilitator"`,
`"store": "./jobs.sqlite"`, and `baseUrl` (`"env:PUBLIC_ORIGIN"` works). Secrets never go in the file, and a
Stellar secret key never goes anywhere near the gateway.

## 4. Run and check

```bash
provider-kit check --config provider.config.json                 # refuses, listing every problem
PAY_TO=G... PUBLIC_ORIGIN=http://localhost:8787 provider-kit serve --config provider.config.json --dev
verifier check http://localhost:8787/.well-known/stellar-agent-services.json --dev
```

`PAY_TO` is a public testnet address with a USDC trustline, an account in the user's own wallet:
`provider-kit trustline --network testnet` sets it up and prints it (`docs/provider-setup-guide.md` §2). It opens a
page in the user's browser and waits for them to approve in their wallet. Before 8004 registration, `check` reports
a missing agent id. That is expected.

For a paid test call, ask the user first: it spends test money only, but it is a payment. Once they agree, run
`provider-kit try <service> --manifest http://localhost:8787/.well-known/stellar-agent-services.json --yes`. It pays
from a throwaway testnet account it funds itself, so the user needs no payer wallet, and it shows the result and the
transfer on chain (`docs/provider-setup-guide.md` §6). Without `--yes` it asks in the terminal, which you can't
answer.

## 5. Deploy and register

`docs/provider-setup-guide.md` §7–§9: HTTPS `baseUrl`, the SQLite store on a persistent volume, `rpcUrl` for
reconciliation, `provider-kit register --config provider.config.json`, approved by the user in their wallet from the
`payTo` account (it saves the new `agentId` to the config), then the verify-provider skill. Never ask the user for a
secret key. In CI, `--source <key>` signs with the Stellar CLI keychain instead.

## Done when

`provider-kit check` passes, the gateway starts, and `verifier check` passes C1, C3, C6 and C7.
