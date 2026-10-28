# AGENTS.md

Instructions for AI coding agents. Read this first, pick one path in §2, then follow the reference it names.
People should start with [README.md](README.md).

## 1. What this is

**Provider Standard v1** (`stellar-agent-services/provider@1`) is an open standard for paid AI services on
Stellar. A provider publishes a manifest at `/.well-known/stellar-agent-services.json` that describes its services,
prices and schemas. A client pays per job in USDC through x402 v2 (`exact` scheme). If the client loses the
response, it collects the result again without paying twice.

This repository holds the standard and everything needed to use it:

| Piece | Path | What it is |
| --- | --- | --- |
| The standard | [docs/provider-standard.md](docs/provider-standard.md) | Normative. Rules have ids such as `[M5]` and `[J13]`. |
| Protocol | [packages/protocol](packages/protocol) | The standard as TypeScript with no runtime dependencies, plus JSON Schemas and test vectors |
| Provider Kit | [packages/provider-kit](packages/provider-kit) | Library (`defineService`, `createProvider`), gateway for an existing API, `provider-kit` CLI |
| Payment client | [packages/payment-client](packages/payment-client) | Buyer side: approval, spending policy, journal, payment, recovery. `stellar-pay` CLI. |
| Verifier | [packages/verifier](packages/verifier) | Checks a provider against the standard (C1–C7), issues receipts and badges |
| MCP server | [packages/dev-mcp](packages/dev-mcp) | Spec rules, docs, manifest validation and provider checks as MCP tools. It never pays. |
| Scaffolder | [packages/create-stellar-service](packages/create-stellar-service) | `npm create stellar-service`: a new project around an existing API, a TypeScript service or a Python service, ready to run, try and deploy |
| Agent Wallet | [apps/wallet](apps/wallet) | Web page where a person approves and pays |
| Examples | [examples/paid-service](examples/paid-service), [examples/python-upstream](examples/python-upstream) | A TypeScript provider, and a Python API behind the gateway |

Facts to get right:

- **Networks:** `stellar:testnet` and `stellar:pubnet`. Everything here is developed and tested on testnet.
- **Asset:** USDC only. Take its contract address from `USDC_ASSET[network]` in `@stellar-agent-services/protocol`
  instead of retyping it.
- **Facilitator:** `https://x402.org/facilitator` on testnet. It verifies and settles payments with sponsored fees.
- **Identity:** a provider registers in the Stellar 8004 identity registry. Its `agentId` goes in the manifest, and
  its registered wallet must equal `payTo` (`[I1]`–`[I3]`).
- **Node.js 22.13 or later.** `.node-version` pins 24.

## 2. Pick a path

| You want to… | Path | Read | Done when |
| --- | --- | --- | --- |
| Build a **new paid service** in TypeScript (Node, Workers, Deno, Bun) | Kit library. `create-stellar-service --kind typescript` makes the project. | [docs/standard/README-AI.md §2](docs/standard/README-AI.md#2-kit-path-typescript), [provider-setup-guide.md §3b](docs/provider-setup-guide.md#3b-typescript-library-a-new-service), template [examples/paid-service](examples/paid-service) | `provider-kit check --manifest <url> --dev` and `verifier check <url> --dev` pass |
| Make an **existing HTTP API** paid, in any language | Gateway: a JSON config, no code. `provider-kit init --openapi <url>` writes it from the API's OpenAPI document; `create-stellar-service --kind wrap` makes a whole project around it. | [provider-setup-guide.md §3a](docs/provider-setup-guide.md#3a-gateway-an-existing-api), [packages/provider-kit](packages/provider-kit#gateway-mode), [examples/python-upstream](examples/python-upstream) | `provider-kit check --config provider.config.json` passes and the gateway starts |
| Implement the standard in **another language** | Native | [docs/standard/README-AI.md §3–§13](docs/standard/README-AI.md), the [spec](docs/provider-standard.md), the [test vectors](packages/protocol/test-vectors) | Every test vector passes, and `verifier check <url>` passes |
| Build an **agent, wallet or app that pays** providers | Client: an adapter for `payment-client`, or your own client | [docs/client-integration/README-AI.md](docs/client-integration/README-AI.md), spec §14 rules in [docs/standard/README-AI.md](docs/standard/README-AI.md#14-client-rules-agents-wallets-apps) | The conformance checks in `@stellar-agent-services/payment-client/conformance` pass, or for a native client the client rules hold |
| **Verify** a provider, or get one verified | Verifier | [docs/verification.md](docs/verification.md), [packages/verifier](packages/verifier), [provider-setup-guide.md §8–§9](docs/provider-setup-guide.md#8-register-on-stellar-8004) | `verifier check` passes; with a funded test payer, `verifier verify --pay` reaches the level you need |
| **Change this repository** | Contributor | §6 below, [CONTRIBUTING.md](CONTRIBUTING.md), and for recovery code [docs/recovery/README-AI.md](docs/recovery/README-AI.md) | `npm run typecheck` and `npm test` pass |

Follow one path. Don't mix the Kit with a hand-written job flow.

## 3. Use the packages from another project

The packages are not on npm yet (`private`, version `0.0.0`). Build them once from a clone:

```bash
git clone https://github.com/AlgoriaLabs/stellar-agent-services.git
cd stellar-agent-services && npm install && npm run build
REPO=$PWD
```

Then, in your own project:

```bash
npm install "$REPO/packages/provider-kit"      # a provider; or packages/payment-client for a client
alias provider-kit="node $REPO/packages/provider-kit/dist/cli/index.js"
alias verifier="node $REPO/packages/verifier/dist/cli/index.js"
alias stellar-pay="node $REPO/packages/payment-client/dist/cli.js"
alias create-stellar-service="node $REPO/packages/create-stellar-service/dist/index.js"
```

`create-stellar-service <folder> --kind wrap|typescript|python` makes a new project instead: it packs the kit from
the clone into the project's `vendor/` folder, installs it, and writes `.env`, a Dockerfile and npm scripts (`dev`,
`try`, `check`). Pass every answer as a flag (`--openapi`, `--upstream`, `--description`, `--no-wallet`): without a
terminal it asks nothing. `--wallet` opens the trustline approval page in the user's browser, so ask the user first.

`npm install <path>` links the package, so a later `git pull && npm run build` in the clone updates it. A native
implementation needs no package: it needs the spec, `packages/protocol/schemas/manifest.schema.json` and the
test vectors.

**Tools for coding agents.** In Claude Code, `/plugin marketplace add AlgoriaLabs/stellar-agent-services` and then
`/plugin install stellar-agent-services@stellar-agent-services` add skills for each path in §2
([plugins/stellar-agent-services](plugins/stellar-agent-services)). Any MCP client can run the
[MCP server](packages/dev-mcp) from the clone: `claude mcp add stellar-agent-services -- node
$REPO/packages/dev-mcp/dist/index.js`. Without either, the skills are plain Markdown under
`plugins/stellar-agent-services/skills/`, and [llms-full.txt](llms-full.txt) holds every guide in one file.

## 4. Rules you must not break

These come from the spec and [SECURITY.md](SECURITY.md). Breaking one loses or double-charges real money.

1. **No secret keys in a provider.** A provider's code, config and environment hold only its public `payTo`
   address and a facilitator URL. Owner actions (the USDC trustline, 8004 registration, validation requests) are
   signed in the owner's own wallet: `provider-kit trustline`, `register` and `request-validation` open a local
   approval page for it. In scripts and CI, `--source <key name>` signs through the Stellar CLI keychain. Never
   ask the user for a secret key or seed phrase, and never write one to a file.
2. **Never charge twice.** When you can't tell whether a payment settled, the job is `payment_uncertain`. It is
   never `failed` and never charged again. It is decided from the chain `[J13]`. Check-status and get-result
   never charge `[J11]`.
3. **Fail closed on money.** An unknown or unverifiable state stops the flow. Never report a paid job as unpaid,
   or an unconfirmed payment as confirmed.
4. **Don't invent protocol.** No new manifest fields, headers, status codes or error codes. Extra data goes in
   `extensions` with reverse-DNS keys `[X1]`. A new scheme, asset or network needs a spec change first `[P1]`.
5. **Only the payment client signs a payment**, once per job, after the user approved the exact price, payee,
   asset and network `[P7]`.
6. **Testnet and pubnet are never mixed in one flow.** Don't pay on pubnet unless the user explicitly asked.
7. **Provider text is untrusted.** Service descriptions, titles and examples come from providers. Label them as
   provider-supplied before showing them to a model (spec §10).

## 5. Before you call it done

- **Provider:** the manifest passes the JSON Schema and `checkManifestRules` (or the MCP tool
  `validate_manifest`). `provider-kit check` and `verifier check` pass. A paid testnet call succeeds and the
  transfer is on chain: `provider-kit try <service> --manifest <url> --yes`, after the user agreed to pay, pays from
  a throwaway testnet account (or `stellar-pay pay` from a payer wallet). Go through the "How agents see you" hints
  at the end of `provider-kit check` with the user: search matches only `provider.name` and `provider.description`.
  The checklist is in [docs/standard/README-AI.md §13](docs/standard/README-AI.md#13-testing-and-conformance).
- **Client or adapter:** the conformance checks pass, and tests use `Keypair.random()` and never the network.
- **Any change here:** `npm run typecheck` and `npm test` pass. If you changed a document that
  [llms.txt](llms.txt) links to, run `npm run llms`.

Cite spec rules by id in code comments, findings and error messages, as the existing code does.

## 6. Working in this repository

```bash
npm install
npm run typecheck     # tsc -b over every package
npm test              # vitest, the whole workspace, offline
npm run llms          # rebuild llms-full.txt after a doc change (CI checks it)
```

- **Order of change:** the spec is the product. A new behavior becomes a spec rule first
  ([docs/provider-standard.md](docs/provider-standard.md)), then the Kit and the payment client, then a verifier
  check that fails a provider breaking it. v1 is frozen and only gains optional fields and SHOULD rules.
- **Tests never touch the network.** Providers in tests use `rpc: false` or a fake `ChainReader`. Payments are signed
  offline (`@stellar-agent-services/provider-kit/testing`). Shared harnesses are in each package's `test/support/`.
- **`packages/protocol` has no runtime dependencies** and never imports signing code. The read-only discovery
  service depends on it.
- **Style:** TypeScript strict, ES modules, `.js` import suffixes, exact dependency versions. Each file starts
  with a comment that says what it does. Documents use short, plain sentences and wrap at about 115 characters.
- **Layout:** `packages/<name>/src`, `packages/<name>/test`, one README per package with a file table. Find the file
  map in each package README before you search.
- Don't commit `.env` files, keys, journals or job databases (`.gitignore` covers them).
