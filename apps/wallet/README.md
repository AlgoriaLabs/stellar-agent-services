# Agent Wallet (web approval page)

The page where a person sees the exact payment and approves it before anything is paid: the "web app" surface
of the payment client ([docs/payment-client.md](../../docs/payment-client.md)). It is a static page with no
backend. Every safety step runs in [`packages/payment-client`](../../packages/payment-client), in the browser.

**Status: minimal page (Week 1), Stellar testnet only.** It creates a test wallet, loads any Provider Standard v1
provider, builds the request form from the service's input schema, shows the approval screen, pays once, confirms
the transfer on chain and recovers lost jobs.

## Run it

```bash
npm install && npm run build                                  # builds the packages the page uses

# The sample provider (any public G... address with a USDC trustline receives the payments)
PAY_TO=G... node examples/paid-service/dist/server.js

# The page, on http://localhost:5173
npm run dev --workspace @stellar-agent-services/wallet
```

Then:

1. **Create test wallet.** This makes a key in the browser, gets test XLM from Friendbot and buys 5 test USDC on
   the testnet exchange.
2. **Use localhost:8787.** This loads the sample provider's manifest.
3. **Pick a service and review the payment.** The approval screen shows the price, the full payee address, when you
   are charged, and the challenge and spending-limit checks.
4. **Approve.** The page follows the payment and shows "Paid" only once the `transfer` on chain matches what you
   approved.

To show spending control, set the limit per payment to 0.01 and review `delayed-report` (0.02): the payment is
blocked before anything is signed.

For the Job Recovery demo, start the provider with `DRILL_LOSE_RESPONSE=1 REPORT_DELAY_SECONDS=10` and pay
`delayed-report`. The page says it can't tell whether the payment went through. **Recover job** then collects
the result with no second payment.

`npm run build --workspace @stellar-agent-services/wallet` writes the static page to `apps/wallet/dist`.

## How it keeps payments safe

- **Core.** The page never decides whether something is paid. It calls `quote()`, `pay()`, `decline()` and
  `recover()` on the core, and the core runs every check (docs/payment-client.md, "One payment, step by step").
- **Decline by default.** Closing the approval screen in any way declines: the Decline button, the close button,
  or Escape. The Decline button has the focus, so a stray Enter never pays.
- **Journal.** The journal and job tokens live in IndexedDB (`@stellar-agent-services/payment-client/browser`).
  - Writes use strict durability, so `sending` is on disk before the paid request goes out.
  - The page runs in one tab at a time (a Web Lock), so the journal has one writer.
  - If the journal can't be opened, nothing can be paid.
- **Key.** The test wallet's key is in this browser's site storage. That is fine for test money, never for real
  money: real wallets will plug in as signers (Stellar Wallets Kit, passkey accounts).
- **No outside code.** The page loads no third-party code, and a Content Security Policy blocks inline and outside
  scripts. `'unsafe-eval'` is allowed for Ajv, which compiles the manifest schema.
- **Local providers.** `http://localhost` providers are accepted only while the page itself runs on localhost, as
  with `stellar-pay --dev`.

## Files

| File | Contents |
| --- | --- |
| `src/lib/agent-wallet.svelte.ts` | The page's state and actions on top of the core; follows the journal for progress |
| `src/lib/schema-form.ts` | A service's `inputSchema` → form fields; anything else gets a JSON editor |
| `src/lib/jobs.ts` | Each job's state from the journal, for Recent payments |
| `src/lib/stellar.ts` | Test wallet balances and funding (Horizon, Friendbot, testnet exchange) |
| `src/lib/storage.ts` | The test wallet, the spending policy and service titles in site storage |
| `src/lib/format.ts` | Amounts, addresses and times for people |
| `src/components/` | `PayFlow` (provider, service, request), `ApprovalDialog`, `PaymentCard`, `WalletCard`, `LimitsCard`, `RecentPayments` |

## Not done yet

- Signers other than the test key: Stellar Wallets Kit (Freighter and others) and passkey accounts.
- Approval links from the MCP server, so an agent above its budget can send its human here.
- Verification badges on the approval screen (they need the verifier).
- Paying without a prompt below an amount (`autoApproveUpTo`). The page always asks.
- Precompiling the manifest validator, so the CSP can drop `'unsafe-eval'`.
- Hosting: any static host works, and it should send `frame-ancestors 'none'` as a header.
