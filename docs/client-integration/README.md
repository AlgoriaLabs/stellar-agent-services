# Payment Client Integrations, in short

How a wallet, a payment service or another payment client works with Stellar Agent Services. This page is the short
version. If you are an AI coding agent, read [README-AI.md](README-AI.md) instead.

## Why it exists

Our payment client pays AI services that follow the [Provider Standard](../standard/README.md). The part that keeps
money safe, the **core**, is the same for everyone. Two parts plug into it:

- **Signer:** who holds the key. A browser wallet, a passkey smart account, a policy wallet.
- **Payment method:** how a payment is made and proven. Today there is one: x402 `exact`, USDC on Stellar.

When you plug in, your users can pay every service that follows the standard, and they keep every safety rule. You
don't build those rules again.

## Pick a path

| You have | You build | Examples |
| --- | --- | --- |
| A wallet that holds keys | A **signer** adapter, `signer-<name>` | Freighter through Stellar Wallets Kit, an ERC-8196 policy wallet |
| A new way to pay or to prove a payment | A **payment method** adapter, `method-<name>` | A smart account that signs in its own format. A new x402 scheme, which needs a change to the standard first. |
| Your own agent, wallet or app | A **native client** that follows the standard's client rules | Your code, with no adapter |

```
                 Your app or agent
                        │
                        ▼
  payment-client core: price check · limits · approval · journal · recovery
            │                                       │
            ▼                                       ▼
   Signer: who signs                     Payment method: how to pay and prove it
   (your wallet)                         (x402 exact on Stellar, or yours)
```

## What the core does for you

| Promise | How |
| --- | --- |
| The price is checked | The payment request must match the price, payee and network the service published. |
| Limits are checked | Per-payment and daily limits, plus your wallet's own budget, before anything is signed. |
| The user approves | Every payment, or only those above an amount the user chose. |
| One signature per job | Even when a wallet popup is slow or the user clicks twice. |
| Saved before sending | A journal entry is written before the payment leaves, so a crash never leads to paying twice. |
| Recovery never pays | A lost answer is fetched again. Nothing is signed again. |
| "Paid" means proven | The transaction is checked on chain against what the user approved, not against what the service says. |

## What only you can get right

The core can't see inside your adapter. In particular, **it does not read what your code signs.** So:

**A signer must:**
- sign only as its own address, and keep that address for as long as it exists
- sign only what it is asked to sign, and never send a transaction itself
- report a budget only if the wallet enforces it on chain, in base units, without asking the user anything
- throw an error when the user cancels or it can't sign

**A payment method must:**
- have a fixed id that it never renames
- accept only payments it can make
- sign exactly the approved payment: this asset, this amount, this payee, this network, and nothing else
- never send or settle the payment itself
- confirm a payment only when the chain shows what the user approved, never because the service said so

## What we need from you

1. **Your own package** (`signer-<name>` or `method-<name>`). It uses our types. We never depend on it.
2. **The conformance checks passing** in your CI. They ship with the payment client.
3. **Two testnet runs:** one paid job with your adapter, and one interrupted job recovered with exactly one payment.
4. **An adapter card** in your README: what it signs, where keys live, which addresses and networks, whether it has a
   budget, and a security contact. The template is in [README-AI.md §9](README-AI.md#9-adapter-card).
5. **Open source code** that we can review.
6. **No custody:** an adapter whose server holds users' keys can't be verified.

## What you get from us

- The `Signer` and `PaymentMethod` interfaces and the conformance checks
- Every promise above, plus the journal and recovery, with no extra work
- An approval screen, spending limits and payment history, in our web app and CLI
- A code review and a "verified" badge that users see
- A listing on this page, with a link
- An example service and failure drills to test against

## Trust levels

| Level | Meaning | Users see |
| --- | --- | --- |
| Built-in | Ours, inside the payment client | No label |
| Verified | Passes the checks and the testnet runs, and we reviewed the code | A "verified" badge |
| Community | Anyone's adapter that we have not reviewed | A warning at setup |

## How to submit

1. Open an issue called **"Integration: \<name\>"** with your adapter card. We confirm the slot, and whether the
   standard needs a change first.
2. Build and test the adapter in your own repository.
3. Open a pull request here that adds a row to [Listed adapters](#listed-adapters), with the checklist below.
4. We review the signing and confirmation code, run the checks and look at the testnet transactions.
5. You are listed as Verified. Each new major version is reviewed again.

**Pull request checklist** (copy it into the PR description):

```markdown
- [ ] Adapter card in the package README
- [ ] Conformance checks pass in CI: <link to the run>
- [ ] Testnet paid job: <transaction hash>, confirmed by the client
- [ ] Testnet recovery drill: one job, one transfer: <transaction hash>
- [ ] The adapter never submits, sends or settles a payment itself
- [ ] No keys, signed payloads or job tokens in logs or telemetry
- [ ] Security contact: <email or URL>
```

## Listed adapters

| Adapter | Slot | Level | Where |
| --- | --- | --- | --- |
| Local key (`localKeySigner`) | Signer | Built-in | [payment-client](../../packages/payment-client/src/local-key-signer.ts) |
| x402 exact on Stellar (`x402-exact-stellar`) | Payment method | Built-in | [payment-client](../../packages/payment-client/src/x402-exact-stellar.ts) |

Planned, not built: Stellar Wallets Kit, passkey smart accounts, Eunomia, ERC-8196 policy wallets. See
[payment-client.md](../payment-client.md#strategies-signers-and-payment-methods).

## Not ready on our side yet

- The payment client is not on npm yet. Until it is, build your adapter as a package in a fork of this repo.
- The conformance checks don't test what a payment method signs. We check it by hand in review.
- Smart accounts (`C…`) can't pay through the built-in payment method yet. They need their own method.
- There is no conformance suite for native clients yet. Test against the example service and its drills.
- The web app doesn't show trust levels yet.

## Learn more

- [AI-readable version](README-AI.md)
- [Payment client design](../payment-client.md)
- [Provider Standard, in short](../standard/README.md), and its [client rules](../standard/README-AI.md#14-client-rules-agents-wallets-apps)
- [Payment client package](../../packages/payment-client/README.md)
- [Example service](../../examples/paid-service/README.md)
