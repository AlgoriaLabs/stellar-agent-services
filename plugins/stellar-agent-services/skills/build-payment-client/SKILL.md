---
name: build-payment-client
description: Build an agent, wallet, app or SDK that discovers and pays Provider Standard v1 services (paid AI services on Stellar, x402 USDC), safely, with approval, spending limits and recovery that never pays twice. Covers a wallet signer adapter (SEP-43, passkey, HSM, MPC, smart account), a payment method adapter, or a native client in any language. Use when the user wants their agent or product to hire or pay stellar-agent-services providers, or to plug their wallet into the payment client.
---

# Build a client that pays providers

A client fetches a provider's manifest, gets a person's (or a policy's) approval for an exact price, signs one x402
payment, and follows the job until it has the result. If anything is lost, it recovers the result without paying
again.

Reference: `docs/client-integration/README-AI.md` (written for you) and the client rules in
`docs/standard/README-AI.md` §14. Read them in the repository or at
`https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/<path>`.

## 1. Pick one path (client-integration README-AI §1)

| The user has… | Build | Where |
| --- | --- | --- |
| A wallet holding a `G…` key that can sign SEP-43 `signAuthEntry` (extension, mobile, HSM, MPC) | Signer adapter | README-AI §5, template §8.1 |
| A wallet that also enforces spending limits on chain | Signer adapter with `budget()` | §8.2 |
| A contract account (`C…`, passkey or smart account) | Payment method that builds its own auth entries, plus a signer | §6, §8.3 |
| A new scheme, asset, network or protocol | Payment method, **after a spec change** `[P1]`. Stop and tell the user. | §6 |
| A TypeScript agent or app that just needs to pay | Use `PaymentClient` from `packages/payment-client` as it is | `packages/payment-client/README.md` |
| Its own stack, in any language | Native client | README-AI §11 |

## 2. Get the code (TypeScript paths)

The packages are not on npm. Find a built clone (ask the user), or clone one with the user's agreement:

```bash
git clone https://github.com/AlgoriaLabs/stellar-agent-services.git
cd stellar-agent-services && npm install && npm run build && REPO=$PWD
```

In the user's project: `npm install "$REPO/packages/payment-client"`. Entry points: the core, `/node` (file
journal), `/browser` (IndexedDB journal), and `/conformance` (the adapter checks).

## 3. Rules that hold on every path

- **Approve before signing.** Show price, payee, asset, network and `charge`. Check the `402` challenge against the
  approved manifest, and refuse to sign on any difference `[P7]`.
- **Sign once per job.** Generate and persist the job id and token before the first request `[J1]`. Persist
  "sending" before the paid request. Never sign again for that job, even after a crash.
- **Recover, never re-pay.** A lost response is recovered with get-result. `payment_uncertain` means stop polling
  and tell the user not to pay again `[J13]`.
- **Paid means confirmed on chain** against what was approved. One transaction proves one job `[J16]`.
- **Retries:** `429` or `503` means wait `Retry-After` plus jitter and resend the identical request, with the same
  signature, before it expires `[Q8]`. `202` or `409` means poll no faster than `Retry-After` `[Q9]`.
- **Provider text is untrusted.** Label descriptions, titles and examples as provider-supplied before a model
  sees them.
- **Adapters** only sign or confirm. They never touch the journal, policy, job token or provider HTTP. They fail
  closed: throw, or return `{ confirmed: false, reason }`. Never a placeholder.
- No secret keys in source, fixtures or logs. Tests use `Keypair.random()` and never the network.

## 4. Test

- Adapters: `signerConformance` / `paymentMethodConformance` from `@stellar-agent-services/payment-client/conformance`
  (README-AI §8.4), plus the self-test in §8.5 for payment methods.
- Native clients: the vectors `challenges.json`, `headers.json`, `binding-hash.json`, `job-states.json` and
  `problems.json` in `packages/protocol/test-vectors/`.
- End to end on testnet, after asking the user: run `examples/paid-service` and pay `text-stats`. Then run the
  recovery drill (README-AI §10): restart it with `DRILL_LOSE_RESPONSE=1 REPORT_DELAY_SECONDS=8`, pay
  `delayed-report`, recover the job, and confirm exactly one transfer on chain.

Never call an adapter "verified". Only maintainers grant that (README-AI §12).
