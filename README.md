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
| [`packages/verifier`](packages/verifier) | Provider checks, verification receipts, badges, Stellar 8004 Validation Registry |
| [`apps/wallet`](apps/wallet) | Web page where a person approves and pays a service (testnet) |
| [`examples/paid-service`](examples/paid-service) | Sample provider and template for pilot providers |

**Status:** proof of concept. A paid call works end to end, from the sample provider to the payment client's CLI
and web page; the verifier is still a scaffold. The plan is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
Development runs on Stellar **testnet**.

**The standard in short:** [for people](docs/standard/README.md) and [for AI coding agents](docs/standard/README-AI.md).
The full text is [docs/provider-standard.md](docs/provider-standard.md).

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
