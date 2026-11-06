# Developer experience improvements

What each phase of the developer-experience work changed for people who build paid AI services with this
repository, why, and how it was checked. A phase is added here when it lands.

| Phase | Change | Status |
| --- | --- | --- |
| 1 | [`provider-kit try`](#phase-1-provider-kit-try): the first paid call in one command | Done |
| 2 | [`provider-kit init --openapi`](#phase-2-provider-kit-init---openapi): the gateway config from an OpenAPI document | Done |
| 3 | [`npm create stellar-service`, and how agents see you](#phase-3-npm-create-stellar-service-and-how-agents-see-you): a ready project in one command, and what search sees | Released in 0.1.0 |
| 4 | [From nothing to live: `dev`, `launch`, `status`](#phase-4-from-nothing-to-live-dev-launch-status): no wallet until launch, one approval page, verification without a hand-off | Released in 0.1.0 |
| 5 | [Mainnet, and the checks before a release](#phase-5-mainnet-and-the-checks-before-a-release): a mainnet project, CI that rehearses the npm publish, daily live checks, releases from a tag | Released in 0.1.0 |

Release status was checked on 2026-11-06. The sections below retain their implementation-time validation and
limits; [readiness evidence](../evidence/readiness.md) records newer checks. Live SOW evidence and the independent
pilot remain outstanding; see [SOW closeout](sow-closeout.md).

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

## Phase 3: `npm create stellar-service`, and how agents see you

### Why

Starting a provider took a clone, a build, an alias, `init`, a config edited by hand, an exported `PAY_TO`, and a
Dockerfile of your own. Now it is one command:

```bash
npm create stellar-service        # from a clone until the packages are on npm:
                                  # node packages/create-stellar-service/dist/index.js
```

And a provider could describe every service well and still not be found. Search (stellar-agent-search's
`find_agent`, and 8004 explorers) matches a query against the registered name and description only, never the
manifest's services, and nothing said so. `provider-kit check` now shows it.

### `npm create stellar-service`

1. **Asks at most four questions:** the folder; what to make (wrap an API you run, a new TypeScript service, or a
   new Python service); for an API, its OpenAPI document or the URL a paid call goes to; and one sentence on what
   it offers, the words search matches. Flags answer all of them, for scripts and coding agents. Without a terminal
   it asks nothing.
2. **Reads the OpenAPI document first,** so a mistyped URL or a stopped API is caught before anything is written. On
   a terminal it asks again.
3. **Gets the kit:** from a clone, it packs the three packages into the project's `vendor/` folder, so the project
   installs and builds by itself, in Docker too. Once published, the project depends on the released version. Either
   way the project gets the repository's npm `overrides`, which keep one copy of the Stellar SDK.
4. **Makes the kind asked for:**
   - **wrap:** `provider-kit init --openapi` (or the starter config, for one URL). Then the config reads
     `PUBLIC_ORIGIN`, `PAY_TO` and `JOB_DB_PATH` from `.env`, so the same file runs on a laptop and in a container.
     An API key init found goes in `.env`, empty, for you to fill.
   - **typescript:** `src/server.ts` and an example service to replace, `src/services/summarize.ts`.
   - **python:** a FastAPI app, `app.py`, with a gateway config that matches its models, and one container that
     runs both (`start.sh`).
5. **Writes the rest:** `.env` and `.env.example`, a `Dockerfile` with the job database on a volume at `/data`, a
   README, and scripts: `dev`, `try`, `check`, `wallet`, `start`, and `register` for gateways.
6. **Sets up the account clients pay,** if you say yes: `provider-kit trustline` opens its approval page, your wallet
   adds the USDC trustline, and the address goes in `.env` as `PAY_TO`.

```text
Creating text-tools: a gateway in front of your API, paid in USDC on Stellar testnet

  ✓ Packed the Provider Kit from your clone into vendor/
  ✓ Installed packages (npm install)

    Read Text Tools API 1.4.0 (OpenAPI 3.1.0) from http://127.0.0.1:8000/openapi.json

    Wrote provider.config.json with 4 services:
      summarize      POST http://127.0.0.1:8000/summarize
      translate      POST http://127.0.0.1:8000/v1/translate  with X-API-Key
      classify-tree  POST http://127.0.0.1:8000/classify/tree
      random-fact    POST http://127.0.0.1:8000/random-fact

    Skipped 7 operations:
      GET   /health                             the gateway calls the API with POST
      …

    ✓ The config passes Provider Standard v1, checked as provider-kit serve checks it.

  ✓ Wrote provider.config.json, .env, a Dockerfile and a README

✓ Created text-tools in /home/you/text-tools

Next:
  cd text-tools
  npm run wallet     sets up the account clients pay: put the address it prints in .env as PAY_TO
  set UPSTREAM_X_API_KEY in .env   the gateway sends it to your API
  npm run dev        starts the gateway at http://localhost:8787
  npm run try        pays for one call with test money, from another terminal
  npm run check      checks it, and shows how agents see it
```

### How agents see you (`provider-kit check`)

`check` now ends with the provider as agents meet it. These hints never fail the check:

```text
How agents see you
  Search matches only this name and description, which provider-kit register publishes:
    Text Tools API
    Summaries, translations and labels for English text.
  ! Search reads no service names, titles or tags, so agents searching for "summarize", "translate",
    "classify", "tree", "random" or "fact" won't find you. Put those words in provider.description.
  ! translate: a 7-word description, no example
  ! classify-tree: a 3-word description, no example
  ! random-fact: a 9-word description
    An agent picks a service by its description: what it does, when to use it, its limits, with no price or
    URL [§3.4]. An example shows it what to send, and provider-kit try pays with it.
  · Ranking counts reviews from distinct paying clients only. Until the first, search lists you as new and
    unrated.
  · Not registered yet: provider-kit register publishes this name and description.
```

- **Matching** is stellar-agent-search 0.1.0's own: accents and case folded, its stopwords dropped, its crude
  stem, then a substring test on the name and description. A word from a service's name, title or tags that this
  misses is listed. So "summarize" is flagged when the description only says "Summaries", as a real search would
  miss it.
- **Once registered,** it shows the name and description the registry has (what search shows today), says when
  they are older than the manifest, and prints the stellar-agent-search command that shows the live profile.
- **Each service:** the init placeholder, a description under 12 words, a price or URL in it [§3.4], or no example.

### How it stays safe

- **No secret key, anywhere.** The scaffolder never asks for one, makes one or writes one ([AGENTS.md](../AGENTS.md)
  rule 1). The payout account is set up in the developer's own wallet, on `provider-kit trustline`'s approval page,
  and only its public address is saved. `.env` is kept out of git.
- **It never pays.** `npm run try` pays later, when the developer runs it, from a throwaway account with test money.
- **Testnet only** (rule 6). Every project starts on `stellar:testnet`.
- **Nothing is overwritten.** It refuses a folder with files in it. A cancelled question writes nothing.
- **Provider text stays text.** The registered name and description are shown without control characters or
  direction overrides, as `try` shows provider text.

### Changed files

| File | Change |
| --- | --- |
| `packages/create-stellar-service/` | New package: `src/main.ts` (questions, flags, the run), `src/files.ts` (what each kind writes), `src/kit.ts` (clone or npm), `templates/`, README |
| `packages/create-stellar-service/test/create.test.ts` | New: 24 tests |
| `packages/provider-kit/src/cli/discovery.ts` | New: how agents see you |
| `packages/provider-kit/src/cli/check.ts` | Prints it, with the registration file it read |
| `packages/provider-kit/src/registration.ts` | `inspectRegistration()`: `checkRegistration()` and the file it read. `checkRegistration()` is unchanged. |
| `packages/provider-kit/src/cli/shared.ts`, `try.ts` | `plain()` moved to `shared.ts`, for both |
| `packages/provider-kit/src/gateway/openapi.ts`, `cli/init.ts` | The provider description placeholder is exported, so `check` can spot it |
| `packages/provider-kit/test/discovery.test.ts`, `test/validation-request.test.ts` | New: 8 tests, and 1 for `inspectRegistration()` |
| `package.json`, `tsconfig.json`, `package-lock.json` | The new workspace. The lockfile adds its two entries only. |
| Docs | [Setup guide](provider-setup-guide.md) §1, §5 and §8, [provider-kit README](../packages/provider-kit/README.md#how-agents-see-you), [AGENTS.md](../AGENTS.md) §1–§3 and §5, the root README, both build skills, the implementation plan, `llms.txt`, `llms-full.txt` |

### How it was checked

- **Tests:** `npm run typecheck` and `npm test` pass: 935 tests, 33 of them new. The scaffolder's run every kind
  with npm and provider-kit replaced: the files, packing and installing, init's output cut before its own next
  steps, the config made to read `.env`, the fallback starter, the payout account set up or left for later, every
  refused call, the questions on a terminal, a document that can't be read, and cancelling. Two tests tie the
  scaffolder to the kit: one compiles the TypeScript template against the Provider Kit's types, and one checks
  that the real `provider-kit init` still ends its report where the scaffolder cuts it.
- **Live, from a clone, each kind on testnet:** scaffold, `npm run dev`, `npm run check`, `npm run try`:
  - typescript: [settlement](https://stellar.expert/explorer/testnet/tx/c76aa0500d929685d3fb3e1a1a1ccb22feb1c68bb18a1ea351aa93d956687ba5)
  - python, the generated FastAPI app under uvicorn:
    [settlement](https://stellar.expert/explorer/testnet/tx/b656271975e2ee0394f54efa909388a8b13b88bfd64fc03479a0860a6c223170).
    Its config matches what `init --openapi` reads from the app's own document, with `additionalProperties: false`
    added.
  - wrap, the Phase 2 FastAPI fixture: `translate` passed the API's key check with the key from `.env`:
    [settlement](https://stellar.expert/explorer/testnet/tx/2b184ace578e7ca752810e8447cbc83d639af1c09ffc9e453c0788c75a9a07f3)
  - The questions, answered in a real terminal (a pseudo-terminal).
- **Docker:** the daemon wasn't available, so each Dockerfile's steps ran by hand in an empty folder. `npm ci`
  installs from the lockfile and `vendor/`, and each image's command serves with an HTTPS origin and the job
  database in `data/`. For the Python image, `start.sh` stops the gateway and exits 1 when the API dies, and stops
  both and exits 0 on a stop signal.
- **Found and fixed on the way:** the TypeScript template didn't compile (an `interface` isn't a JSON object type),
  which the compile test now catches. A venv made by the scaffolder got x86_64 packages when Node ran under Rosetta,
  so the Python packages are now installed in the developer's own shell. macOS's bash 3.2 has no `wait -n`, so
  `start.sh` is plain POSIX `sh`.
- `npm run build`, both Svelte checks and `npm run llms:check` pass.

### Limits

- **Until the npm publish,** it runs from a clone, and `vendor/` holds the kit as it was then: a `git pull` in the
  clone doesn't update it. The npm path (`npm create stellar-service`) is written but untested until then. Projects
  made any other way need the same `overrides` once the kit is published, or they install two Stellar SDKs.
- **Setting up the payout account** needs a person and a browser wallet. A coding agent passes `--no-wallet`, or
  asks first.
- **wrap in Docker:** 127.0.0.1 is the container, so each `upstream.url` must point at an address it reaches.
- **python:** the scaffolder doesn't make `.venv`. The next steps give the two commands.
- **How agents see you** follows stellar-agent-search 0.1.0's matching. If search changes, the hints may drift.
  It doesn't read reviews: it states the ranking policy, and the live command shows the real profile.
- **Not done:** stellar-agent-search's provider guide (`build-a-discoverable-agent.md`) still tells providers to
  register with their own key script. That change belongs to that repository.

## Phase 4: from nothing to live: `dev`, `launch`, `status`

### Why

Phases 1–3 made the first paid call quick. Going live still took most of the work, and three separate wallet
sessions:

```bash
npm run wallet                                   # 1st wallet session: the USDC trustline, before anything runs
npm run dev && npm run try                       # two terminals
# deploy it yourself: HTTPS, a volume, the environment
PUBLIC_ORIGIN=https://… npm run register         # 2nd wallet session, then "deploy it again" with the agent id
provider-kit request-validation --validator G…   # 3rd wallet session, then send the verifier the hash yourself
# and on testnet, stellar-agent-search couldn't find the provider unless the searcher knew its id
```

Now:

```bash
npm run dev       # no wallet: a throwaway testnet account is paid until launch
npm run try       # starts the service for the call when it isn't running
npm run launch    # one page in your wallet: trustline, registration, verification request; then Fly.io
npm run status    # where it stands, and the one command to run next (--json for agents)
```

### What changed

1. **`provider-kit dev`** runs a provider on this computer: a gateway config in its own process, or any provider by its
   command (`dev -- node dist/server.js`). It reads `.env`. With `PAY_TO` empty, it makes a **throwaway payout
   account**: a new testnet key in memory gets test XLM from Friendbot and signs the account's USDC trustline, then
   the key is dropped. Only the public address reaches the provider and `.env` (as `PAY_TO` and `DEV_PAY_TO`), and what
   it receives is test money nobody can spend. `--with '<command>'` starts the API a gateway calls and waits until it
   takes connections. `--tunnel` adds a temporary public HTTPS address through a Cloudflare quick tunnel.
2. **`provider-kit launch`** takes the provider live:
   - The public address comes first: `--url`, `fly.toml`'s app (`https://<app>.fly.dev`) or an `https://`
     `PUBLIC_ORIGIN`. So the service is registered before its first deploy and deployed once, with its agent id.
   - It builds the manifest that address will serve and checks it: from the gateway config, from the provider's own
     command started with `PUBLIC_ORIGIN` set (`--start`), or from a deployed provider (`--manifest`).
   - One approval page, one wallet: test XLM, the USDC trustline [P2], `register_with_uri` (or `set_agent_uri` when the
     manifest moved) [I1]–[I3], and `validation_request`, which is built once the new agent id is known.
   - It saves `PAY_TO` and `AGENT_ID` in `.env`, the agent id where the gateway config reads it, and the public
     settings in `fly.toml`'s `[env]`. A new agent's id is saved even when a later step stops, so running `launch`
     again never registers a second agent. Run again with everything in place, it signs nothing.
   - With `fly.toml` and a yes, `flyctl` creates the app the first time, the API's key is staged as a Fly secret from
     `.env`, `fly deploy` runs with one machine, and `launch` waits for the public manifest and checks [I1]–[I3] from
     outside.
3. **`provider-kit status`** reads this computer, the chain and the public address: running here, `payTo`, paid
   once, registered, live, verified. It names the one command to run next, and finds the public manifest from the
   registration itself when nothing else names it. `--json` for scripts and coding agents.
4. **`check`:** `--fix` writes the service words search would miss into a gateway config's `provider.description`,
   and `--json` prints the result. A provider on this computer that isn't registered yet passes, with a note that
   `launch` registers it.
5. **`try`:** when nothing answers, it starts the provider for the call and stops it after: the gateway config in its
   own process (with a throwaway `payTo` when `PAY_TO` is empty), or `--start '<command>'`. `--json` prints the
   outcome on standard output and the steps on standard error.
6. **`npm create stellar-service`:** no wallet question; a price question (`--price`); `fly.toml`; the scripts `dev`,
   `try`, `check`, `status`, `launch` and `deploy` (`wallet` and `register` are gone); gateway configs read the agent
   id as `env:AGENT_ID`. The Python kind runs its API with `uv` when it is installed, so there is no virtual
   environment to make, and `npm run dev` starts the API and the gateway together. Every Dockerfile, and the kit's
   gateway image, gives `/data` to the `node` user when it starts as root, so a host's new volume works as it comes.
7. **`provider-kit init`** guesses `on-success` for a call expected to take seconds, instead of `upfront`, and
   `--json` prints what it wrote and skipped.
8. **A gateway config's `provider.agentId`** may read an unset variable (`"env:AGENT_ID"` before launch): the provider
   just isn't registered yet.
9. **`verifier watch`** answers validation requests with no hand-off ([verification.md](verification.md#self-serve-verification-verifier-watch)).
   It reads the Validation Registry's list of requests naming its key, finds each request's document in its
   `validation_request` event (or, once the RPC no longer has it, the agent's registration) and checks only a manifest
   URL the agent's registration lists [I1]. Then it runs C1–C7 with its test payer, serves the receipt and badges over
   HTTP, and answers with `validation_response`, signed by the Stellar CLI keychain. A provider that isn't live yet is
   checked again for 24 hours, so `launch` can ask before the deploy. Its state survives restarts, and a request is
   never answered twice. `/requests/<request hash>.json` shows where a request stands.
10. **stellar-agent-search finds testnet providers** (in that repository, for its 0.2.0 release). With
    `STELLAR_NETWORK=testnet` and nothing else, it reads the newest 50 agents straight from the Identity contract
    (ids are given in order, so `total_agents` names the window; `REGISTRY_SCAN_LIMIT` changes it), with honest
    coverage and short caches, and never mixes in mainnet's explorer. A search there also matches a provider's
    services: when the registration lists one `stellar-agent-services` manifest that is live and bound to the agent
    [I1]–[I3], their names, titles, descriptions and tags count, and each result says which field matched. `check`'s
    "How agents see you" follows it: on testnet the missing service words are a note, on mainnet, where the explorer
    lists no services, still a warning; and it prints the 0.2.0 command that shows the live profile.

### How it stays safe

- **No key is kept.** The throwaway payout account's key lives in memory for one transaction, its own trustline,
  and is never written; the provider, like any provider, knows only the public address ([AGENTS.md](../AGENTS.md)
  rule 1, [SECURITY.md](../SECURITY.md)). It is never made on Mainnet: there, an empty `PAY_TO` stops `dev`.
- **The owner signs, once, in their wallet.** `launch` builds each transaction when it is due, and the page checks
  that what the wallet signed is that very transaction (as in Phase 3's approval page). A provider's own account is
  never asked to validate it.
- **Nothing twice.** A registration that landed is saved before anything else can stop the run. A re-run reads the
  chain: a registration that names the manifest isn't sent again, and a verifier that was asked isn't asked again.
- **Fail closed.** `launch` refuses an `http://` address, a quick tunnel's (it changes every run), an `AGENT_ID` that
  doesn't exist, and a `PAY_TO` that isn't the agent's wallet [I3], before anything is signed.
- **Secrets stay secret.** `fly.toml` gets public values only. The API's key goes to Fly's secrets through `flyctl`'s
  standard input, never on a command line.

### Changed files

| File | Change |
| --- | --- |
| `packages/provider-kit/src/cli/dev.ts`, `dev-account.ts` | New: `provider-kit dev`, and the throwaway payout account |
| `packages/provider-kit/src/cli/launch.ts`, `fly.ts`, `validators.ts` | New: `provider-kit launch`, `fly.toml` and `flyctl`, the default verifier |
| `packages/provider-kit/src/cli/status.ts` | New: `provider-kit status` |
| `packages/provider-kit/src/cli/env-file.ts`, `processes.ts`, `tunnel.ts` | New: `.env` reading and writing, the provider's own command, the quick tunnel |
| `packages/provider-kit/src/cli/serve.ts` | `serveGateway()`, shared by `serve`, `dev` and `try` |
| `packages/provider-kit/src/cli/check.ts`, `discovery.ts` | `--fix`, `--json`, `describedWithServices()`; an unregistered local provider passes |
| `packages/provider-kit/src/cli/try.ts` | Starts the provider when nothing answers; `--start`, `--json` |
| `packages/provider-kit/src/cli/owner-steps.ts` | A validation request step prepared when it is due |
| `packages/provider-kit/src/registration.ts` | `agentValidations()`: an agent's validation requests |
| `packages/provider-kit/src/gateway/config.ts`, `openapi.ts`, `schemas/gateway-config.schema.json` | An unset `env:` agent id; the `baseUrl` override; `on-success` first guess |
| `packages/provider-kit/src/cli/main.ts`, `shared.ts`, `init.ts` | The commands, their flags and usage; `init`'s next steps |
| `packages/provider-kit/Dockerfile` | The `/data` hand-over; the missing `create-stellar-service` workspace manifest |
| `packages/create-stellar-service/` | No wallet question, `--price`, `fly.toml`, the new scripts, `uv`, the Dockerfiles' `/data` hand-over |
| `packages/verifier/src/watch.ts`, `watch-state.ts`, `requests.ts`, `cli/watch.ts`, `cli/serve.ts` | New: `verifier watch`, its state, how a request becomes a manifest URL, and the receipts it serves |
| `packages/verifier/src/registry.ts`, `chain.ts`, `json.ts`, `schemas.ts`, `cli/` | The validator's request list, the payer's balance, the shared `data:` URI reader, the request schema, the command |
| `packages/provider-kit/src/cli/request-validation.ts` | Says that nothing needs sending: a watching verifier finds the request |
| `packages/provider-kit/src/cli/discovery.ts` | Search as stellar-agent-search 0.2.0 does it: services on testnet, the registration's services, the 0.2.0 command |
| stellar-agent-search (its own repository) | The registry scan for testnet, matching manifest services, `match.fields` in results, docs and its changelog |
| Tests | `dev.test.ts`, `launch.test.ts`, `status.test.ts`, `check.test.ts`, `tools.test.ts`, the verifier's `watch.test.ts` and `requests.test.ts` (new); `try`, `openapi`, `create` and the registry fakes |
| Docs | The [setup guide](provider-setup-guide.md) (a quick start, then §5–§10 rewritten), [verification.md](verification.md) (self-serve verification), the provider-kit, create-stellar-service and verifier READMEs, [AGENTS.md](../AGENTS.md), the root README, [SECURITY.md](../SECURITY.md), README-AI §2 and §13, three skills, both examples, `llms-full.txt` |

### How it was checked

- **Tests:** `npm run typecheck` and `npm test` pass: 1,020 tests. `launch` is tested end to end against a fake
  chain, registry, wallet and `flyctl`: one page from a throwaway `PAY_TO` to agent 42 with its validation request; a
  re-run that signs nothing; a page closed after registering, then a re-run that asks only for the validation; a
  provider's own command; the deploy, the staged secret and the live check; a gateway on 127.0.0.1 that isn't
  deployed; and every refusal. `verifier watch` has 50 tests with a fake registry, RPC, Stellar CLI and provider: a
  request found, checked, served and answered; one not live yet, retried, then answered with its failure; a URL the
  registration doesn't list, never checked; a restart in the middle; and no second answer, which mutation checks
  confirmed the tests guard.
- **Live, on testnet,** a Python project made from the clone: `npm run dev` made the throwaway account (Friendbot,
  then its trustline), started the API with `uv` and waited for it, then served the gateway. `npm run status` and
  `npm run check` read the running provider, Horizon and the registry, and `npm run launch -- --dry-run` planned a
  new registration against the testnet registry. Ctrl+C stopped the gateway and the API together.
- **Not run here:** a paid `try` and a live `launch` (they spend test money and register a test agent: they wait
  for the maintainer's go), a Fly.io deploy (no Fly account), the Docker images (no Docker daemon) and `--tunnel` (no
  `cloudflared`). Those parts are tested with fakes only.

### Limits

- **The default verifier is empty** (`src/cli/validators.ts`) until a verifier runs `verifier watch` with a known
  account. Until then, `launch --validator <G…>` or `STELLAR_VALIDATOR` names one, and without either no validation is
  requested.
- **Deploying is Fly.io only.** Elsewhere, `launch --url <https origin> --no-deploy` registers the address and prints
  the settings to deploy with.
- **A hosted gateway**, where `launch` would upload the config and get an address without deploying anything, is not
  built: whoever ran it would hold the API's key and the job database.
- **`launch --start`** runs the provider's command here for a few seconds, so its startup checks (such as the
  facilitator's) must pass on this computer.
- **Search reaches the newest 50 testnet agents** (and any one by id). Of today's newest 50, 35 registrations can't be
  read, as they point at `http://`, `localhost` or pages that are gone. The kit's printed search command needs the
  stellar-agent-search 0.2.0 release; until then it runs from a checkout of that repository
  (`STELLAR_NETWORK=testnet node dist/index.js profile <id>`).
- **`verifier watch` has no container image**: it signs through the Stellar CLI keychain, which would have to be
  installed in the image. Its README describes running it on a small server. It hasn't run against testnet here.

## Phase 5: mainnet, and the checks before a release

### Why

The packages are about to go to npm, for testnet and mainnet. Until now every project started on testnet, and nothing
checked what an npm user would get: the packed packages, a project made by the published scaffolder, or the mainnet
services the packages name.

### What changed

- **`create-stellar-service --network mainnet`** makes a project that takes real USDC: OpenZeppelin's facilitator,
  which wants an API key (`FACILITATOR_AUTH`, sent by the TypeScript template and by a gateway config's
  `facilitatorHeaders`), a Soroban RPC in `.env`, and no `try` script. `launch` writes the network to `fly.toml`,
  stages the key and the RPC as Fly secrets, and won't call a deploy live while it takes payments on another network
  than its registration. `dev` and `status` point to `check` and `launch` on mainnet. A facilitator that refuses the key
  says so.
- **CI** ([CONTRIBUTING.md](../CONTRIBUTING.md#what-ci-checks)) makes a project of each kind on each network, then
  installs, builds and starts it and runs the verifier on it. It checks what every package would publish, and rehearses
  the publish on a throwaway registry: the packages installed and used from it, and projects the published scaffolder
  makes.
- **Daily live checks** read what the packages take for granted on both networks, pay one testnet call with test
  money, and, with the `MAINNET_FACILITATOR_AUTH` secret, start a mainnet project against the real facilitator.
- **Releases** ([CONTRIBUTING.md](../CONTRIBUTING.md#releasing)): a version tag publishes the npm packages with
  provenance, the gateway image at `ghcr.io/algorialabs/provider-kit`, and a GitHub release.

### What the checks found

- **A kit provider could fail the verifier's C7 at random.** `listen()` read each request body with
  `Readable.toWeb()`, which starts reading at once and stops when nobody reads. A body answered before it was read
  (C6's oversized probe, a `404`) stayed half-read on its kept-alive connection, and the next request on it, in C7's
  burst, was reset: in 3 runs of 4 here. The body is now read only when the router reads it, and Node drops the rest
  after the answer.
- **The MCP server, installed from npm, would have crashed on start**: it read `llms.txt` from the clone it was built
  in. Its package now carries the documents (`scripts/pack-docs.mjs`, run before each pack), read when there is no
  clone.
- **Receipts would have named version 0.0.0** after a release: the verifier's version, in its User-Agent and in every
  receipt, was typed in the code. The verifier and the MCP server now read their own `package.json`.
- **Every package would have published its TypeScript build cache** (`dist/.tsbuildinfo`, about 80 kB), and none its
  license text. Each package now has a `LICENSE` and `engines.node`.

### How it stays safe

- No check signs or pays on mainnet, and none holds a Stellar key. The pull-request checks use no secret: the
  facilitator and the verifier's chain lookup are stand-ins on the runner.
- The only payment is the daily testnet call, from a throwaway account with test XLM and test USDC.
- The rehearsal publishes to a registry on the runner, with npm settings of its own, so nothing reaches npm.
- The publish refuses a private package, a tag that doesn't match the version, and packages at different versions.
  npm itself would skip a private workspace and report success.
- Release builds use no dependency cache, and the release's third-party actions are pinned to commits.

### Changed files

| File | Change |
| --- | --- |
| `.github/workflows/ci.yml`, `live.yml`, `release.yml` | The pull-request checks; the daily live checks; the release |
| `scripts/scaffold-check.mjs`, `packages.mjs`, `live-check.mjs` | A new project end to end; packing, versions, the rehearsal and the publish; the live networks |
| `packages/provider-kit/src/http/node-server.ts`, `test/node-server.test.ts` | The request body, read when the router reads it, and its regression test |
| `packages/dev-mcp/src/server.ts`, `scripts/pack-docs.mjs` | The documents packed with the package, and its version |
| `packages/verifier/src/tool.ts` | Its version, from its `package.json` |
| `packages/*/package.json`, `packages/*/LICENSE` | `engines.node`, no build cache, the license text |
| `packages/create-stellar-service/`, `packages/provider-kit/src/cli/`, `src/payments/facilitator.ts` | `--network mainnet`; `launch`, `dev` and `status` on mainnet; the facilitator's `401` |
| Docs | [CONTRIBUTING.md](../CONTRIBUTING.md), [AGENTS.md](../AGENTS.md), README-AI §2, §7 and §15, the five skills, the provider-kit, create-stellar-service and dev-mcp READMEs, the setup guide's mainnet section, `llms.txt` |

### How it was checked

- `npm run typecheck` and `npm test` pass: 1,032 tests. The new test fails without the fix: the request after a
  `413` hangs, or is reset.
- `npm run scaffold:check` passed here for all three kinds on both networks, and `npm run packages:rehearse` passed:
  six packages published to Verdaccio, installed and used, and three projects from the published scaffolder.
- `npm run live:check` passed on both networks: x402.org's and OpenZeppelin's facilitators (the latter without a key:
  it answers `401`), both RPCs, Horizon, the USDC contracts and the 8004 registries.
- actionlint passes the three workflows.
- **Not run here:** the workflows themselves (they run once pushed), the paid testnet call (it spends test money, so it
  waits for the maintainer's go), the mainnet facilitator with a key (no key here), and the Docker builds (no Docker
  daemon here; CI builds them).

### Limits

- **Two Stellar SDKs in a plain install.** `@trionlabs/stellar8004` 0.0.11 asks for the Stellar SDK 15 and the kit
  uses 16, so npm installs a second SDK for it. Everything works: only strings and numbers pass between the two (a
  rehearsal of a plain install read the testnet registry through both). The cost is 18 MB and the second copy's
  axios 1.15.0, which `npm audit` flags. Projects made by `create-stellar-service` carry an override that keeps one
  copy, and `scaffold:check` fails a project with two. Someone installing the kit from npm by hand should add it
  ([provider-kit README](../packages/provider-kit/README.md)). The rehearsal warns while this holds. A `@trionlabs/stellar8004` release that accepts SDK 16 would end it. Its main
  branch moved to SDK 17 on 2026-10-10, unpublished, which would still be a second copy: x402 needs 16.
- **The first release, 0.1.0, publishes with a token,** since npm can only trust the workflow for a package that
  exists. Trusted publishing replaces it after that ([CONTRIBUTING.md](../CONTRIBUTING.md#releasing)).
- **The mainnet start check needs a key.** Without the `MAINNET_FACILITATOR_AUTH` secret it is skipped.
