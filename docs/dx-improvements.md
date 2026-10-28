# Developer experience improvements

What each phase of the developer-experience work changed for people who build paid AI services with this
repository, why, and how it was checked. A phase is added here when it lands.

| Phase | Change | Status |
| --- | --- | --- |
| 1 | [`provider-kit try`](#phase-1-provider-kit-try): the first paid call in one command | Done |
| 2 | [`provider-kit init --openapi`](#phase-2-provider-kit-init---openapi): the gateway config from an OpenAPI document | Done, in review |
| 3 | `npm create stellar-service`, and showing a provider how agents see it | Planned |

Before these phases, the owner's transactions (the USDC trustline, 8004 registration, validation requests) moved
from a key in the CLI to the developer's own wallet, approved on a page the CLI opens
([provider-kit README](../packages/provider-kit/README.md#approving-in-your-wallet)).

## Phase 1: `provider-kit try`

### Why

A provider wants to see one paid call work before anyone else pays. That used to need a second wallet:

```bash
npx stellar-pay wallet create
npx stellar-pay wallet fund --usdc 2
MANIFEST=http://localhost:8787/.well-known/stellar-agent-services.json
npx stellar-pay pay $MANIFEST text-stats '{"text":"Hello"}' --dev
```

Now it is one command, with no wallet to make or fund:

```bash
provider-kit try text-stats
```

### What it does

1. **Finds the provider:** `--manifest <url>`, or the `baseUrl` of `--config`. Without either, `provider.config.json`
   in the current directory, else `http://localhost:8787`. Only `baseUrl` is read from a config, so the terminal
   needs none of the provider's other settings (`PAY_TO`, upstream keys).
2. **Picks the service and input:** the service named, or the only one. The input is the argument (JSON, or a file
   with `@`), or the service's first example. With several services and none named, it lists them with prices.
3. **Quotes:** an unpaid create-job and its `402` challenge, checked against the manifest [P7]. Nothing is signed.
4. **Asks:** it shows the exact price, payee, network and charge policy, and asks `Pay 0.01 USDC in test money?
   [Y/n]`. `--yes` skips the question, for scripts and coding agents.
5. **Funds a throwaway payer:** a new key in memory gets test XLM from Friendbot, then one transaction adds its USDC
   trustline and buys exactly the price on the testnet DEX.
6. **Pays** through the payment client, once. It follows the job (`200`, or `202` and polling) and confirms the
   `transfer` to `payTo` on chain [J16].
7. **Reports** the result, the payment link, and `payTo received 0.01 USDC`. Exit 0 only when the job succeeded and
   its payment is confirmed.

```text
Pay for one job at Stellar Agent Services example (localhost:8787)

  Service  text-stats: Counts the words, sentences and characters in a text.
  Input    {"text":"Hello world."}  (its example)
  Price    0.01 USDC, charged only if the work succeeds
  Pay to   GDJBKS6DUSE2G2UG4PPI2M5ABD43T73AHGEIOWHWSSCWXLN3LOYVXA3O
  From     GDN3DXCMEMNADAXWSSXDTAHQ5V4EQA6JZWJL25Q5TIAISIS77LYX43AW, a throwaway test account
  Network  Stellar Testnet: test money only

  ✓ Test XLM from Friendbot
  ✓ Test USDC from the testnet DEX: 0.01 USDC
  ✓ text-stats succeeded: 10.2 s from payment to result
  ✓ Paid 0.01 USDC, confirmed on chain: https://stellar.expert/explorer/testnet/tx/0051061ae6bd372d6563880793350cf15796eecb603096360ade5bb10097cda9

{
  "words": 2,
  "sentences": 1,
  "characters": 12
}

GDJB…XA3O (payTo) received 0.01 USDC.
```

### How it stays safe

- **No key is ever stored.** The payer's key lives in memory for one command and is never written anywhere
  ([AGENTS.md](../AGENTS.md) rule 1). It holds test money only.
- **Only the payment client signs a payment** (rule 5), after the exact terms were shown and approved [P7]. Its
  spending policy allows exactly one payment: the manifest's price, to the manifest's `payTo`, on testnet.
- **Testnet only.** A provider on Mainnet is refused before anything is signed (rule 6).
- **Fail closed.** If the answer to the paid request is lost, it says the payment may have gone through and never
  calls it unpaid. The provider decides it from the chain [J13]. A failed purchase of test USDC stops everything
  before the provider is paid.
- **Provider text can't take over the terminal.** Names, descriptions, errors and output are shown without control
  characters or direction overrides.

### Changed files

| File | Change |
| --- | --- |
| `packages/provider-kit/src/cli/try.ts` | New: the command |
| `packages/provider-kit/src/cli/owner-chain.ts` | `buyTestUsdc()` (testnet only), `formatUsdc()`. `describeResult()` names the operation that failed, not the first one, and explains the DEX's answers. |
| `packages/provider-kit/src/gateway/config.ts` | `gatewayManifestUrl()`: a config's manifest URL from `baseUrl` alone |
| `packages/provider-kit/src/cli/main.ts`, `shared.ts`, `init.ts` | The `try` command and `--yes`; `init` names `try` as the next step |
| `packages/payment-client/src/client.ts` | `PaymentUncertainError.reason`: what happened, without the "recover" advice that doesn't apply to `try` |
| `packages/provider-kit/package.json`, `tsconfig.json`, `package-lock.json` | Provider Kit depends on the payment client (one lockfile line) |
| `packages/provider-kit/Dockerfile` | The image ships the payment client, which the CLI loads |
| `packages/provider-kit/test/try.test.ts` | New: 16 tests, offline, with a real provider |
| `packages/provider-kit/test/approval.test.ts`, `test/support/owner.ts` | The failing-operation message, USDC formatting; the fake chain buys test USDC |
| Docs | [Setup guide §6](provider-setup-guide.md#6-make-a-paid-testnet-request), [provider-kit README](../packages/provider-kit/README.md#trying-a-paid-call) (the `reconcile` row is back inside the CLI table), [AGENTS.md](../AGENTS.md) §5, [README-AI §13](standard/README-AI.md#13-testing-and-conformance), the two example READMEs, three skills, the implementation plan, `llms-full.txt` |

### How it was checked

- **Tests:** `npm run typecheck` and `npm test` pass: 876 tests, 16 of them new. They cover the paid flow against a
  real provider with a fake facilitator, a declined prompt, scripts without `--yes`, input from JSON and files,
  service listing, Mainnet refusal, refused input, a failed DEX purchase, an unreachable provider, a failed job, a
  rejected payment, a lost answer after paying, `--config` with `env:` values, and the real `buyTestUsdc()`
  transaction.
- **On testnet**, against `examples/paid-service`:
  - `text-stats` with its example, `--yes`: exit 0 in 24 s,
    [settlement](https://stellar.expert/explorer/testnet/tx/0051061ae6bd372d6563880793350cf15796eecb603096360ade5bb10097cda9).
    Horizon showed `payTo` holding 0.0100000 USDC, and the fee paid by the facilitator.
  - `delayed-report` (upfront, `202` and polling) in a real terminal, approved with Enter:
    [settlement](https://stellar.expert/explorer/testnet/tx/43015a6a913109ac710d376563a68ca09be9051f12569ac00e251481d0ec351d).
  - Declined with `n`: nothing funded or paid, exit 1.
  - Refused input, no provider listening, and no terminal without `--yes`: each stops with its reason.
- **Docker image:** the daemon wasn't available, so the runtime stage was rebuilt by hand. `npm ci --omit=dev` with
  the edited lockfile links the payment client, and the CLI runs with only the files the Dockerfile copies.

### Limits

- The test USDC comes from the testnet DEX. When it has none for sale, `try` stops before paying and points to
  `stellar-pay` with a test wallet funded at [faucet.circle.com](https://faucet.circle.com).
- Each run makes a new testnet account through Friendbot.
- The journal lives in memory, so `try` can't recover a job after it exits. The provider settles any uncertain
  payment by itself, and `provider-kit reconcile --dry-run` shows where it stands.

## Phase 2: `provider-kit init --openapi`

### Why

Gateway mode makes an existing API paid with a config file, but every service's input and output schema had to be
written by hand, in JSON Schema. Most APIs already describe themselves: FastAPI serves an OpenAPI document at
`/openapi.json`, and Django (drf-spectacular), Spring, NestJS and others can write one.

Before:

```bash
provider-kit init --upstream http://127.0.0.1:5000/run   # one placeholder service
# then write each service's name, description, inputSchema and outputSchema by hand
```

After:

```bash
provider-kit init --openapi http://127.0.0.1:8000/openapi.json
```

### What it does

1. **Reads the document:** OpenAPI 3.0, 3.1 or 3.2, JSON or YAML, from a file or a URL (up to 10 MB). Swagger 2.0
   is refused with a pointer to converting it.
2. **Picks the operations the gateway can call:** a `POST` that takes a JSON object (or no body) and answers `2xx`
   with a JSON object, with no path parameters and no required query, header or cookie parameters. Every other
   operation is listed with the reason: `GET`, a path parameter, a required query parameter, a file upload, a form
   body, an array or image answer, no content, deprecated, more than 25 services.
3. **Converts schemas** to what the standard asks [S4]–[S6]: JSON Schema 2020-12, the body's own schema at the root
   with `"type": "object"` first, and the components it uses under `$defs`, recursion included. OpenAPI 3.0's
   `nullable`, `example` and boolean `exclusiveMinimum`/`exclusiveMaximum` are rewritten. `readOnly` properties
   leave the input and `writeOnly` ones the output. `x-` extensions, `xml`, `discriminator` and `externalDocs` are
   dropped.
4. **Fills in the rest from the document:** the provider's name and description from `info`. For each service: a
   name from the path (`/v1/text/summarize` is `text-summarize`), a title from the summary, the description, tags,
   and an example when the document has an input and output that match their schemas [S9].
5. **Finds the API:** `--upstream`, else the operation's, path's or document's server (with its variables'
   defaults), else the address the document was read from. A relative server in a file needs `--upstream`.
6. **Keeps the API's credentials out of the file:** an API key header, bearer or basic becomes an `upstream.headers`
   entry read from the environment, such as `"X-API-Key": "env:UPSTREAM_X_API_KEY"`. Credentials that can't be a
   fixed header (OAuth2, cookies) get a warning.
7. **Checks each service as `serve` would:** `defineService()` and a manifest with it must pass. One that fails, such
   as a Python-only regular expression or a schema over 32 KiB, is skipped with the problem, so the config always
   loads. Then the written file itself is loaded as `serve` loads it.
8. **Says what's next:** prices to set, descriptions to write, environment variables to export, then `serve` and
   `provider-kit try`.

```text
Read Text Tools API 1.4.0 (OpenAPI 3.1.0) from http://127.0.0.1:8000/openapi.json

Wrote provider.config.json with 4 services:
  summarize      POST http://127.0.0.1:8000/summarize
  translate      POST http://127.0.0.1:8000/v1/translate  with X-API-Key
  classify-tree  POST http://127.0.0.1:8000/classify/tree
  random-fact    POST http://127.0.0.1:8000/random-fact

Skipped 7 operations:
  GET   /health                             the gateway calls the API with POST
  POST  /documents/{document_id}/summarize  it has a path parameter ({document_id}); the gateway calls one fixed URL
  POST  /search                             it needs the query parameter "q"; the gateway sends only a JSON body
  POST  /upload                             it takes multipart/form-data, not JSON
  POST  /languages                          it answers with an array, not a JSON object
  POST  /render                             it answers with image/png, not JSON
  POST  /v0/summarize                       it is deprecated

✓ The config passes Provider Standard v1, checked as provider-kit serve checks it.

Next:
  1. Review provider.config.json: each service's price (0.01 USDC for now), charge and description, which agents choose by.
     Write one for classify-tree: the document gives only a summary, or nothing.
  2. export UPSTREAM_X_API_KEY=...   the API's key, sent as X-API-Key
  3. PAY_TO=G... provider-kit serve --config provider.config.json
  4. provider-kit try summarize   one paid testnet call, from another terminal
```

### What it doesn't decide

The price (`0.01`), charge policy (`upfront`), expected duration (5 s) and capacity are the same first guesses as the
starter config's. The output says to set them. It never overwrites a file, and with no callable operation it writes
nothing.

### Changed files

| File | Change |
| --- | --- |
| `packages/provider-kit/src/gateway/openapi.ts` | New: reading the document, choosing operations, converting schemas, credentials, checking each service |
| `packages/provider-kit/src/cli/init.ts` | `--openapi`, the summary and next steps. The starter config is written as before, from the same first guesses. |
| `packages/provider-kit/src/cli/main.ts`, `shared.ts` | The `--openapi` flag and its help |
| `packages/provider-kit/package.json`, `package-lock.json` | `yaml` 2.9.1 (ISC, no dependencies), pinned. The lockfile adds that entry only. |
| `packages/provider-kit/test/openapi.test.ts` | New: 26 tests |
| `packages/provider-kit/test/fixtures/openapi/` | A real FastAPI document and the app that generates it (FastAPI 0.115.12, Pydantic 2.14.1), and an OpenAPI 3.0 YAML document in drf-spectacular style |
| Docs | [Setup guide §3a](provider-setup-guide.md#3a-gateway-an-existing-api), [provider-kit README](../packages/provider-kit/README.md#from-an-openapi-document), [AGENTS.md](../AGENTS.md) §2, the wrap-existing-api skill, the implementation plan, `llms-full.txt` |

### How it was checked

- **Tests:** `npm run typecheck` and `npm test` pass: 902 tests, 26 of them new. They cover the FastAPI document
  (services, skipped operations, `$defs`, recursion, examples, the API key), the OpenAPI 3.0 YAML rewrites, every
  reason to skip, the 25-service limit, names, any-type answers, credential alternatives, server resolution,
  reading files and URLs, and the CLI: output, no overwriting, nothing written when nothing is callable, and the
  unchanged starter config. One test serves the generated config and makes paid calls through the gateway to a
  stand-in API, which receives the right path, body and key.
- **The whole flow, live:** the FastAPI fixture app ran under uvicorn. `init --openapi
  http://127.0.0.1:8000/openapi.json` found the API's address by itself, then `serve` started on the generated
  config, and `provider-kit try` paid on testnet:
  - `summarize` with its example: [settlement](https://stellar.expert/explorer/testnet/tx/6943f507e559a91a7d91feb1f9bc8932a150de4c129e722217c77333482b0863)
  - `translate`, through FastAPI's API key check, with the key from `UPSTREAM_X_API_KEY`:
    [settlement](https://stellar.expert/explorer/testnet/tx/6d968b968594ebca0dd71d3ce0d4a356bb9917a553266776d333fe81c295ccee)
- **A third-party document:** the public Swagger Petstore (`petstore3.swagger.io`, OpenAPI 3.0.4) gave 3 services
  and 16 skipped operations with their reasons. Its relative server was resolved against the document's URL, and
  OAuth2 got its warning.
- **Docker image:** the runtime install was rebuilt by hand again: `npm ci --omit=dev` installs `yaml`, and `init
  --openapi` reads a YAML document with only the files the image ships.

### Limits

- External `$ref`s (`other.yaml#/Thing`) aren't followed: such an operation is skipped and asks for a bundled
  document.
- Endpoints that take path or query parameters, forms or files can't be gateway services. The way to offer one is a
  small JSON route in front of it, as the wrap-existing-api skill says.
- A `readOnly` or `writeOnly` property is found when it is marked on the property itself, not inside a referenced
  component.
