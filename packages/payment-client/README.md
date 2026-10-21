# @stellar-agent-services/payment-client

The buyer side: approval, spending policy, a hash-chained journal, payment and job recovery. The design is in
[docs/payment-client.md](../../docs/payment-client.md).

**Status: proof of concept.** The core flow works end to end on Stellar testnet with a local-key signer and the
`stellar-pay` CLI. The web app, MCP server, Freighter and passkey signers come later and reuse this core.

| File | Contents |
| --- | --- |
| `src/client.ts` | `PaymentClient`: `quote()` (nothing signed), `pay()` (signs once), `recover()` (never pays) |
| `src/policy.ts` | Spending policy with ERC-8196 field names; `checkPolicy()` fails closed |
| `src/journal.ts` | Append-only, hash-chained journal; job tokens kept apart in a `SecretStore` |
| `src/manifest.ts` | Fetches and validates a provider manifest |
| `src/onchain.ts` | Confirms the settlement transaction on chain |
| `src/cli.ts` | `stellar-pay`, the PoC surface |

## Try it on testnet

```bash
npm install && npm run build

# A provider wallet (it only needs a USDC trustline) and a payer wallet with testnet USDC.
STELLAR_PAY_HOME=~/.stellar-pay-provider npx stellar-pay wallet create
STELLAR_PAY_HOME=~/.stellar-pay-provider npx stellar-pay wallet fund --usdc 0
npx stellar-pay wallet create
npx stellar-pay wallet fund --usdc 2          # buys testnet USDC on the testnet DEX

# The sample provider, paid to the provider wallet's address.
PAY_TO=G... node examples/paid-service/dist/server.js

# Pay, with an approval prompt.
MANIFEST=http://localhost:8787/.well-known/stellar-agent-services.json
npx stellar-pay services $MANIFEST --dev
npx stellar-pay pay $MANIFEST text-stats '{"text":"Hello agents."}' --dev
```

Job Recovery: start the provider with `DRILL_LOSE_RESPONSE=1 REPORT_DELAY_SECONDS=8`, pay `delayed-report`,
then run the `stellar-pay recover <job-id> --dev` command it prints. `stellar-pay jobs` and
`stellar-pay journal verify` show the journal.

## Not done in the PoC

- Confirmation only checks that the transaction succeeded, not its `transfer` event's payer, payee and amount.
- `minVerificationScore` and `stellar.minProviderLevel` are stored but not enforced.
- The wallet secret is a plain file (mode 600). Testnet only.
- No browser storage, web app or MCP server yet.
