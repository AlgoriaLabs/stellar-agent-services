# Contributing

Thanks for helping. This repository is a standard first and code second, so changes follow the order below.
AI coding agents should also read [AGENTS.md](AGENTS.md).

## The order of a change

1. **The spec.** A new behavior, field, error or guarantee starts as a rule in
   [docs/provider-standard.md](docs/provider-standard.md), with an id. v1 is frozen: it only gains optional fields
   and SHOULD rules. A breaking change waits for v2.
2. **The code that implements it:** `packages/protocol` (types, constants, reference checks, test vectors), then
   `packages/provider-kit` and `packages/payment-client`.
3. **The verifier:** a check, or a finding in an existing check, that fails a provider breaking the new rule and
   cites its id.
4. **The docs:** the human summary and the AI reference for the area (`docs/*/README.md`, `docs/*/README-AI.md`),
   the package README's file table, and `llms.txt` if you add a document. Then run `npm run llms`.

A fix inside the existing rules skips step 1.

## Before you open a pull request

```bash
npm install
npm run typecheck
npm test
npm run llms:check
```

- Tests never touch the network. Use the fakes in each package's `test/support/`.
- Pin dependency versions exactly.
- No keys, `.env` files, journals or job databases in commits.
- Money paths fail closed. If a change touches payment, settlement or recovery, say in the pull request how it
  keeps "never charge twice" (`[J13]`, `[P9]`).

## Issues

Pick the template that fits: a question about integrating, a proposal to change the standard, or a request to
verify a provider. Report security problems privately, as [SECURITY.md](SECURITY.md) says.

## Wallet and payment adapters

Adapters for other wallets or payment methods follow
[docs/client-integration/README.md](docs/client-integration/README.md). They live in their own packages and pass
the conformance checks in `@stellar-agent-services/payment-client/conformance`.
