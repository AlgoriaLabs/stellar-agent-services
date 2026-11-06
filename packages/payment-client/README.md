# @stellar-agent-services/payment-client

The buyer side: approval, spending policy, a hash-chained journal, payment and job recovery. The design is in
[docs/payment-client.md](../../docs/payment-client.md).

**Status: proof of concept.** The core flow works end to end on Stellar testnet with the built-in signer and
payment method, both in Node (the `stellar-pay` CLI) and in the browser (the minimal web page in
[apps/wallet](../../apps/wallet)). The MCP server, browser-wallet and passkey signers come later and reuse this core.

Signers and payment methods are strategies: the core keeps every safety step, and adapters for other wallets or
payment infrastructure plug in without changing it (docs/payment-client.md, "Strategies"). To build one, see
[docs/client-integration](../../docs/client-integration/README.md).

```ts
const client = new PaymentClient({
  signer: localKeySigner(secret, "stellar:testnet"), // or a wallet adapter
  methods: [x402ExactStellar()],                      // the default
  policy, journal, secrets,
});
```

The main entry point runs in Node and the browser. Journal storage depends on where it runs:

| Entry point | Contents |
| --- | --- |
| `@stellar-agent-services/payment-client` | The core, the built-in signer and payment method |
| `…/node` | `fileJournalStorage`, `fileSecretStore`: files only the owner can read |
| `…/browser` | `indexedDbJournalStorage`, `indexedDbSecretStore`: IndexedDB with strict durability |
| `…/conformance` | The checks every adapter must pass |

| File | Contents |
| --- | --- |
| `src/client.ts` | `PaymentClient`: `quote()` (nothing signed), `pay()` (signs once), `decline()`, `recover()` (never pays) |
| `src/strategies.ts` | The `Signer` and `PaymentMethod` interfaces |
| `src/local-key-signer.ts` | The built-in signer: a secret key in this process |
| `src/x402-exact-stellar.ts` | The built-in payment method: x402 `exact` on Stellar, the only one Provider Standard v1 allows |
| `src/conformance.ts` | Checks that every signer and payment-method adapter must pass (`./conformance` entry point) |
| `src/policy.ts` | Spending policy with ERC-8196 field names; `checkPolicy()` fails closed |
| `src/verification.ts` | Application-trusted verification source; binds evidence to the approved manifest, payee, network and validity window [V1] |
| `src/journal.ts` | Append-only, hash-chained journal; job tokens kept apart in a `SecretStore` |
| `src/file-storage.ts` | Journal and job-token storage in files (`./node` entry point) |
| `src/browser-storage.ts` | Journal and job-token storage in IndexedDB (`./browser` entry point) |
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

## Verification policy

Configured verification limits are checked at `quote()` and again at `pay()`, before signing [V1]. Install a
`verificationSource` in `PaymentClientOptions` to supply authenticated evidence. Without a source, or when it
returns missing, stale, mismatched or unreadable evidence, a payment requiring verification is blocked.

- `minVerificationScore` keeps ERC-8196's name and meaning: the **maximum allowed risk score**, 0–100, lower is
  safer. It compares with the source's `riskScore`, not a receipt's higher-is-better conformance score.
- `stellar.minProviderLevel` is the minimum Provider Standard §8 level, 0–3.
- Even a configured value of zero requires evidence. Leaving both fields unset requires no source.
- Sources are trusted application code. They must authenticate validators and receipt/registry data, bind the
  answer to the requested subject, set `checkedAt` and `expiresAt`, and bound their network calls. Never use a
  provider's own claims as proof. No built-in registry/risk-source adapter is supplied yet.
- Recovery collects an already paid job without consulting the source or signing again [J11], [J13].

See [the design](../../docs/payment-client.md#verification-source) for the interface and trust boundary.

## Not done in the PoC

- No built-in Validation Registry or ERC-8126 risk-source adapter. Configured verification limits fail closed
  until the application supplies its own trusted source.
- The wallet secret is a plain file (mode 600). Testnet only.
- No MCP server yet.
- Only the built-in signer and method. Adapters for other wallets come later, each in its own package.
