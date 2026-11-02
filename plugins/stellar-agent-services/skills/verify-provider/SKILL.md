---
name: verify-provider
description: Check a Provider Standard v1 provider (a paid AI service on Stellar) against the standard with the verifier (checks C1–C7), explain each failing rule and fix it, register the provider in the Stellar 8004 identity registry, and request or issue a verification receipt, badges and a Validation Registry record. Use when the user asks whether a stellar-agent-services provider conforms, wants it verified, badged or registered, or a check fails.
---

# Check and verify a provider

The verifier calls a provider as a careful client would, and every finding cites a rule of the standard. Reference:
`docs/verification.md`, `packages/verifier/README.md` and `docs/provider-setup-guide.md` §5, §8 and §9, in the
repository or at `https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/<path>`.

## Tools

From a built clone (`npm install && npm run build`; the packages are not on npm):

```bash
alias verifier="node $REPO/packages/verifier/dist/cli/index.js"
alias provider-kit="node $REPO/packages/provider-kit/dist/cli/index.js"
```

If the `stellar-agent-services` MCP server is connected, `check_provider` runs `verifier check`,
`validate_manifest` checks a manifest before it is served, and `get_spec_rule` explains a rule id.

## 1. Free checks (no key, no payment)

```bash
verifier check <manifest-url>            # add --dev for http://localhost
provider-kit check --manifest <manifest-url>
```

`verifier check` runs C1 manifest, C2 identity, C3 challenge, C6 hygiene and C7's unpaid burst. C4 and C5 show as
skipped. `provider-kit check` also confirms the facilitator, the `payTo` USDC trustline `[P2]` and the 8004
registration `[I1]`–`[I3]`.

For each failure: read the rule (`get_spec_rule` or `docs/provider-standard.md`), find the cause, fix it, run again.
`docs/standard/README-AI.md` §15 maps common mistakes to rules. A kit or gateway provider that fails usually has a
config problem. Fix the config, not the kit.

## 2. Register on Stellar 8004 and ask for validation (the provider's owner does this)

Ask before running anything that signs. The owner signs in their own wallet, never with a key you handle:

```bash
provider-kit launch --config provider.config.json --dry-run      # what it would sign
provider-kit launch --config provider.config.json --no-open      # gives a link for the user to open
```

`launch` takes the public address from `fly.toml`, `--url` or an `https://` `PUBLIC_ORIGIN`, then opens one page
where the user connects their wallet and approves the USDC trustline, the registration and a validation request to the
verifier (`--validator <G...>`). Tell the user what they will approve. It saves `PAY_TO` and `AGENT_ID` where the
provider reads them. Use `--start '<command>'` for a library provider, or `--manifest <url>` for one already deployed
(then set the printed agent id as `provider.agentId` and redeploy). Run step 1 again: C2 must pass.
`provider-kit status --json` shows each stage. In CI, `register` and `request-validation` take `--source <key>`.

## 3. Paid checks and a receipt (a verifier does this)

A verifier that runs `verifier watch --source <validator key> --public-url <https url>` does this by itself for every
request naming its account: it finds the manifest, checks it, serves the receipt and answers on chain
(`docs/verification.md`, "Self-serve verification"). By hand, it needs a dedicated testnet payer holding a little USDC in
`VERIFIER_PAYER_SECRET`. Never use the user's own wallet. Ask before spending.

```bash
VERIFIER_PAYER_SECRET=S... verifier verify <manifest-url> --pay --validator <verifier G...> --out evidence/receipts
verifier badge evidence/receipts/<sha256>.json --request-hash <hex>
verifier publish evidence/receipts/<sha256>.json --request-hash <hex> --response-uri <https url> --source <key>
```

The payer spends at most 0.10 USDC a job and 1.00 USDC a run by default, and never pays on pubnet without
`--allow-pubnet`. Receipts are never issued in `--dev` mode.

The provider asks for validation with `provider-kit launch` (step 2), or on its own with
`provider-kit request-validation --config provider.config.json --validator <verifier G...>`, approved in the owner's
wallet like the registration. Nothing else is sent: the request, with the manifest URL in it, is on chain.

## Levels

1 Described (C1, C6). 2 Payable (+ C3, C4). 3 Recoverable (+ C5). Registered (C2 and a Validation Registry record) and
Load-safe (C7) are separate badges. Report the level reached and every failing rule with its fix.
