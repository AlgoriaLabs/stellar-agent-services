# Stellar Agent Services

Phase 2 of [Stellar Agent Search](https://github.com/berkingurcan/stellar-agent-search). It makes it easy for
developers to offer paid AI services on Stellar, and easy for users to find, hire and pay them safely.

Stellar Agent Search finds and evaluates agents (read-only, keyless). This repository adds the provider and
payment side:

| Package | Purpose |
| --- | --- |
| [`packages/protocol`](packages/protocol) | Provider Standard v1 as code (manifest, jobs, receipts) |
| [`packages/provider-kit`](packages/provider-kit) | Turn a function, or an existing API in any language (gateway mode), into a paid service: pricing, x402 USDC payments, Job Recovery, capacity and queuing |
| [`packages/payment-client`](packages/payment-client) | Buyer side: approval, spending controls, payment, recovery (proof of concept) |
| [`packages/verifier`](packages/verifier) | Checks a provider against the standard (C1–C7), issues verification receipts and badges, publishes to the Stellar 8004 Validation Registry |
| [`packages/dev-mcp`](packages/dev-mcp) | MCP server for coding agents: spec rules, docs, manifest validation, unpaid provider checks. It never pays. |
| [`packages/create-stellar-service`](packages/create-stellar-service) | `npm create stellar-service`: a new project (an existing API, a TypeScript or a Python service), ready to run, try and deploy |
| [`apps/wallet`](apps/wallet) | Web page where a person approves and pays a service (testnet) |
| [`examples/paid-service`](examples/paid-service) | Sample provider and template for pilot providers |
| [`examples/python-upstream`](examples/python-upstream) | An existing Python API made a paid service with gateway mode |

**Status:** Week 3 of the plan. A paid call works end to end, from a provider (library or gateway mode, with a
durable job queue) to the payment client's CLI and web page. Job Recovery is complete in code: providers decide
uncertain payments from on-chain data ([docs/job-recovery.md](docs/job-recovery.md)). The verifier runs every check
(C1–C7), proves payments on chain, and issues receipts, badges and Validation Registry responses
([docs/verification.md](docs/verification.md)). The plan is in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Development runs on Stellar **testnet**.

To offer a service, follow the [provider setup guide](docs/provider-setup-guide.md), or start with
[`npm create stellar-service`](packages/create-stellar-service), run from a clone until the packages are on npm.

**The standard in short:** [for people](docs/standard/README.md) and [for AI coding agents](docs/standard/README-AI.md).
The full text is [docs/provider-standard.md](docs/provider-standard.md).

## For AI coding agents

- [AGENTS.md](AGENTS.md) picks a path (new service, existing API, another language, paying client, verification,
  contributing) and names its reference, rules and definition of done. `CLAUDE.md` points to it.
- [llms.txt](llms.txt) indexes every document, and [llms-full.txt](llms-full.txt) holds them all in one file.
- The [Claude Code plugin](plugins/stellar-agent-services) adds a skill for each path:
  `/plugin marketplace add AlgoriaLabs/stellar-agent-services`.
- The [MCP server](packages/dev-mcp) answers spec questions and checks manifests and providers.

## Compatibility

We stay compatible with ERC-8126 (agent verification) and ERC-8196 (agent authenticated wallet). See
[docs/erc-compatibility.md](docs/erc-compatibility.md). Copies of both specs are in [docs/references/](docs/references).

## Development

```bash
npm install
npm run typecheck
npm test
```

Requires Node 22.13 or later (`.node-version` pins 24).

## Security

See [SECURITY.md](SECURITY.md). In short:

- discovery and provider servers hold no keys
- only the payment client signs, once, after explicit approval
- nobody pays twice for one job

## License

MIT
