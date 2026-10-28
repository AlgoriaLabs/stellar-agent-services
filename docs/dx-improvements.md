# Developer experience improvements

What each phase of the developer-experience work changed for people who build paid AI services with this
repository, why, and how it was checked. A phase is added here when it lands.

| Phase | Change | Status |
| --- | --- | --- |
| 1 | [`provider-kit try`](#phase-1-provider-kit-try): the first paid call in one command | Done, in review |
| 2 | `provider-kit init --openapi`: services from an OpenAPI document | Planned |
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
