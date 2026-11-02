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

## What CI checks

[ci.yml](.github/workflows/ci.yml) runs on every pull request. None of it signs or pays, and it uses no secret.

| Job | What it checks | Run it here |
| --- | --- | --- |
| Typecheck, test, build | The four commands above, the wallet and approval pages, and what each npm package would publish: its files, metadata and shared version | `npm run build && npm run packages:check` |
| New project, 6 jobs | `create-stellar-service` from this clone, each kind on testnet and on mainnet: the project installs with one copy of the Stellar SDK, builds and starts, and the verifier passes it (C1, C3, C6, C7). A mainnet project must refuse to start without the facilitator's API key. On testnet the project's Dockerfile is built too. The facilitator and the verifier's chain lookup are stand-ins. | `npm run scaffold:check -- --kind typescript --network mainnet` |
| npm publish rehearsal | Every package published to a throwaway registry (Verdaccio on the runner), installed from it and used: imports, commands, the MCP server's documents, and projects made by the published scaffolder. It warns when a plain install brings two Stellar SDKs or dependencies `npm audit` flags. | `npm run packages:rehearse` |
| Gateway image | `packages/provider-kit/Dockerfile` builds and runs | `docker build -f packages/provider-kit/Dockerfile .` |

The new-project checks and the rehearsal install from the npm registry. Run them after `npm run build`.

[live.yml](.github/workflows/live.yml) runs every day and from the Actions tab, never on pull requests, since it
depends on services outside this repository:

- **What the packages expect** on testnet and mainnet: the facilitator, Soroban RPC, Horizon, the USDC contract and
  the Stellar 8004 registries (`npm run live:check`). Read-only.
- **A paid call on testnet**: a new project, paid once by `provider-kit try --yes` from a throwaway account with test
  money.
- **A mainnet project against OpenZeppelin's facilitator**, with the repository secret `MAINNET_FACILITATOR_AUTH`
  (`Bearer <key>`, a key from [channels.openzeppelin.com/gen](https://channels.openzeppelin.com/gen)). Nothing is
  paid on mainnet. Without the secret, this job is skipped, and the daily check only confirms the facilitator answers.

## Releasing

Every package is released together at one version, since a project made by `create-stellar-service` x.y.z depends
on `provider-kit` x.y.z. A version tag runs [release.yml](.github/workflows/release.yml): every CI check again, then
the npm packages with provenance, the gateway image at `ghcr.io/algorialabs/provider-kit`, and a GitHub release.

```bash
npm run packages:version 0.2.0      # every package and the dependencies between them, and package-lock.json
git commit -am "Release 0.2.0" && git tag v0.2.0 && git push origin main v0.2.0
```

A version with a suffix, such as `0.2.0-rc.1`, goes to npm under the `next` tag, so `npm install` keeps getting the
last release. Run the workflow from the Actions tab with "dry run" on to go through every step without publishing.

npm publishes through trusted publishing: it trusts `release.yml` itself, so no npm token is stored anywhere.
Each package needs a trusted publisher on npmjs.com, under the package's **Settings** tab → Trusted Publisher →
GitHub Actions, with:

- organization `AlgoriaLabs`, repository `stellar-agent-services`, workflow `release.yml`, environment `npm`;
- under Allowed actions, **npm publish** ticked. Without it, npm only allows `npm stage publish`, and the release
  fails.

A new trusted publisher expires unless it publishes within 2 days. So set them up on the day of the release that
first uses them, before pushing its tag. 0.1.0 went out with a token, so the next release is that day for all six
packages.

A new package can't have a trusted publisher yet, since npm only trusts a workflow for a package that exists. Its
first version goes out with a token: an npm granular access token with read and write access, new packages
included, and "Bypass 2FA" ticked, saved as the repository *secret* `NPM_TOKEN` (not a variable). Delete the secret and the token
after that release, then add the package's trusted publisher on the day of the next one. A new package also needs
`"private": true` removed; `npm run packages:check` lists any still private, and the publish refuses them.

The `npm` environment can require an approval before each publish (Settings → Environments → npm).

## Issues

Pick the template that fits: a question about integrating, a proposal to change the standard, or a request to
verify a provider. Report security problems privately, as [SECURITY.md](SECURITY.md) says.

## Wallet and payment adapters

Adapters for other wallets or payment methods follow
[docs/client-integration/README.md](docs/client-integration/README.md). They live in their own packages and pass
the conformance checks in `@stellar-agent-services/payment-client/conformance`.
