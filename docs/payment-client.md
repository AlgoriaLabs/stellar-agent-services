# Payment Client: design

> Status: **accepted** (2026-10-21). A proof of concept of the core, the local-key signer and a CLI is in
> [packages/payment-client](../packages/payment-client), and a minimal web page on the same core is in
> [apps/wallet](../apps/wallet) (2026-10-22). IMPLEMENTATION_PLAN.md §5.6 and principle 3 follow this design.

## Who it is for

- **Developers and their agents** in Claude Code, Codex or their own code. The agent finds and pays services
  on its own, inside a budget the human set.
- **Non-technical users** who open a web page, pick a service, fill in a form and pay, with no seed phrase,
  CLI or browser extension required.

The aim is a product people would use after the grant, not just a demo for the SOW: **a wallet for AI
agents, with spending rules set by a human**. It is the demand side of the Provider Standard.

## Fixed requirements

- Wallet separation: keys never touch discovery or provider code.
- Explicit approval of the service, price, recipient, asset, network and when the user is charged (`charge`).
- Spending controls: a per-payment cap and a rolling budget. A failed limit check blocks the payment.
- Challenge validation against the approved manifest (provider-standard.md [P4], [P7]).
- Durable journal before sending: job id, Job-Token and binding hash. Never re-sign the same job.
- Recovery through check-status and get-result only.
- On-chain settlement proof before showing "paid": the `transfer` event matches the approved payment
  (provider-standard.md [J16]).
- No custody: we never hold a user's key on a server (SOW out of scope, and a regulatory burden).

## Decision

### Shape: one core, two strategies, two surfaces

```
   Web app (everyone)              MCP server (agents)
   browse · form · approve ·       find · quote · pay · status ·
   budget · history · recover      result · budget
              │                            │
              └──────────┬─────────────────┘
                         ▼
             payment-client core (TypeScript, no UI)
   manifest → checkChallenge → pick method → policy + budget → approve → sign → journal → send → confirm
                │                                                           │
                ▼                                                           ▼
   PaymentMethod  (how a payment is made)                     Signer  (who holds the key)
   ┌──────────────────────────────┐                ┌──────────────┬──────────────────┬──────────────────┐
   │ x402 exact on Stellar (USDC) │                │ local key    │ Stellar Wallets  │ smart account:   │
   │ later: other schemes/assets  │                │ (dev, CI,    │ Kit: Freighter,  │ passkey owner +  │
   │ once the standard has them   │                │  allowance)  │ xBull, Lobstr, … │ scoped agent key │
   └──────────────────────────────┘                └──────────────┴──────────────────┴──────────────────┘
```

- **Core** (`packages/payment-client`): everything that has to be right for money to be safe. It has no UI and
  no key storage, and the same code runs in Node and the browser.
- **Signers** plug in behind one interface, so the core never sees how a key is held.
- **Payment methods** plug in behind another, so a new way to pay never touches the safety rules. See
  [Strategies](#strategies-signers-and-payment-methods).
- **Web app** (`apps/wallet`, static, no backend): the main UI for everyone, and what the D1 video shows. The
  minimal page is built (2026-10-22): a test wallet, the form from the schema, the approval screen, spending
  limits, recent payments and recovery, with the local-key signer.
  - Turns each service's `inputSchema` into a form, so any provider is usable with no frontend work.
  - Shows price, payee, verification badges and `charge` on one approval screen.
  - Budget settings, history with explorer links, and a "recover job" button.
- **MCP server** (`packages/payment-mcp`): a separate server with its own key, apart from the read-only search
  server. Inside the budget it pays without asking. Above the budget it asks for approval, through MCP
  elicitation or a link to the web app.

### Where keys live

| Key | Who holds it | Can do |
| --- | --- | --- |
| Owner key | The human: a passkey (Face ID / Touch ID) or Freighter | Anything: fund, set and revoke policies, approve large payments |
| Agent key | The MCP server or SDK, on the developer's machine | Only what the policy allows |
| — | Our servers | Nothing. There is no key on any server. |

The agent key is what lets an agent pay without a prompt, so how much damage it can do has to be limited:
- **Weeks 1–2: allowance wallet.** The agent key controls a separate `G…` account that the owner tops up with
  a small amount. The client enforces the policy off chain. The most it can lose is that account's balance.
- **Target: smart account.** The owner's passkey and the agent key are both signers on one Soroban smart
  account, whose `__check_auth` enforces the agent's policy on chain. Even a compromised agent machine can't
  spend beyond the policy. Contract accounts hold USDC without a trustline, which removes a step for
  non-technical users.

### Strategies: signers and payment methods

**Built 2026-10-22**, with the built-ins only (`packages/payment-client/src/strategies.ts`).

The core uses the Strategy pattern on two independent axes. Other Stellar wallets and payment infrastructure
can then be plugged in later without changing the core: ours, existing projects such as Eunomia or an
ERC-8196 wallet, or new ones. Any signer works with any method that supports it.

```ts
/** Who holds the key: the SEP-43 shape @x402/stellar signs with. */
interface Signer {
  address: string;                       // G… or C…
  signAuthEntry: SignAuthEntry;
  signTransaction?: SignTransaction;
  /** A policy wallet's remaining on-chain budget for `asset`, in base units. Undefined: no limit. */
  budget?(network: StellarNetwork, asset: string): Promise<string | undefined>;
}

/** How an x402 challenge entry is paid, and how that payment is proven. */
interface PaymentMethod {
  id: string;                            // "x402-exact-stellar", journaled with each payment
  matches(requirements: PaymentRequirements): boolean;
  createPayload(requirements: PaymentRequirements, signer: Signer): Promise<SignedPayload>;
  confirm(transaction: string, expected: ExpectedPayment): Promise<Confirmation>;
}
```

The built-ins are `localKeySigner(secret, network)` and `x402ExactStellar({ rpcUrl })`.
`new PaymentClient({ signer, methods })` uses `[x402ExactStellar()]` when `methods` is not given.

**The core keeps every safety step; adapters can't skip them.** For every signer and method:

1. `checkChallenge()`: the challenge equals the manifest's payment option [P4].
2. The first installed method whose `matches()` is true pays. If none matches, or `matches()` throws, the
   payment is refused before anything is signed.
3. The terms the user approves (network, asset, amount, payTo) come from the challenge entry, never from an
   adapter, so no adapter can change them.
4. The spending policy applies, and so does a policy wallet's `budget()`. A budget that is too low, can't be
   read, or isn't in base units blocks the payment (fail closed). Both run again inside `pay()`.
5. Approval, then journal `approved`.
6. `createPayload()` signs. Only one `pay()` per job runs at a time, so a slow wallet popup can't lead to a
   second signature. If the wallet does not sign, the core journals `refused`. Nothing was sent, so the user
   can try again.
7. Journal `sending` with the terms, the payer and the method id, and flush it. Only then send.
8. The method recorded in `sending` confirms the payment against the journaled terms. If that method is not
   installed, or it throws, the result is "not confirmed" with a reason, never "paid".

**Conformance checks** (`@stellar-agent-services/payment-client/conformance`). The core enforces the steps
above whatever is plugged in, so these checks cover what only an adapter can get right. They work with any
test framework.

| For | Checks |
| --- | --- |
| Signers: `signerConformance()` | Has a Stellar `G…` or `C…` address. Signs an auth entry as its own address. For a `G…` key, the signature verifies against it. `budget()`, if present, reports base units. |
| Payment methods: `paymentMethodConformance()` | Has a stable id. Matches its own entry, but not an unknown scheme, an unknown network or a malformed entry. Confirms a settled payment, but not the same transaction with another payee, amount, asset or payer. |

The built-ins pass them, and the test suite also checks that they fail broken adapters.

**Adapters and trust levels.** An adapter for another wallet or payment infrastructure lives in its own package
(`signer-<name>` or `method-<name>`). It depends on the core's types, and the core never depends on it. Users
see how far we vouch for each one:

| Level | Meaning | Shown as |
| --- | --- | --- |
| Built-in | Ours, in this package: `localKeySigner`, `x402ExactStellar` | No label |
| Verified | Passes the conformance checks, and we reviewed it | A "verified" badge |
| Community | Anyone's adapter that we have not reviewed | A warning at setup |

A wallet's own security, such as how it stores its key, stays its own responsibility. The core guarantees only
that what leaves through it is what the user approved.

**Integrations, later.** None is built yet. Each will be its own package.

| Integration | Slot | Status and what to check first |
| --- | --- | --- |
| [Stellar Wallets Kit](https://stellarwalletskit.dev): Freighter, xBull, Lobstr, Albedo, Hana, … | Signer | Week 1 spike: which wallets' `signAuthEntry` works with `@x402/stellar` |
| Passkey smart account (OpenZeppelin) | Signer, with `budget()` from its policy | Week 3 spike: a `C…` account paying through the facilitator |
| [Eunomia](https://github.com/eunomia-finance/eunomia) treasury | Signer with `budget()` if its treasury can authorize the SAC `transfer` that x402 `exact` uses; otherwise a payment method, which needs a Provider Standard change | Testnet only. Read its `packages/x402` first. |
| ERC-8196 policy wallet (a parallel project) | Signer with `budget()` | In development. Our policy and journal already use ERC-8196 field names. |
| Other x402 schemes (such as `upto`) or other assets | Payment method | Each needs a Provider Standard change and a provider that offers it |

### Policy (ERC-8196 field names plus Stellar extensions)

| Field | Meaning | Default |
| --- | --- | --- |
| `policyId`, `ownerAddress`, `agentAddress` | ERC-8196 | — |
| `agentId` | The agent's Stellar 8004 id, if it has one | unset |
| `allowedActions` | `["x402.pay"]` | — |
| `allowedContracts` / `blockedContracts` | The asset contract (USDC SAC) | USDC only |
| `maxValuePerTx`, `maxValuePerDay` | In the asset's base units, not a native value | 0.10 / 1.00 USDC |
| `validAfter`, `validUntil` | ERC-8196 | now / +30 days |
| `minVerificationScore` | ERC-8196, read through a risk-source interface once a Stellar ERC-8126 exists | unset |
| `stellar.asset` | The one asset the limits apply to | USDC |
| `stellar.payees` | `{ allow?, block? }` lists of `payTo` addresses, since the real payee is an argument of `transfer` | unset |
| `stellar.minProviderLevel` | The lowest `provider-standard-v1` conformance level a payee must have | unset (pilot) |
| `stellar.autoApproveUpTo` | Payments at or below this amount, and inside the limits, need no prompt | **0: approve every payment** |

`policyHash = sha256(JCS(policy))`. Every journal entry and every approval names the policy hash it ran under.
Out of the box, every payment asks for approval, which is what the SOW requires. Paying without a prompt is
something the owner turns on.

### Journal (ERC-8196 hash-chained audit trail)

- One entry per step: `intent`, `approved` or `refused` (with the policy rule that refused), `sending`,
  `settled` or `uncertain`, `recovered`, `result`.
- Each entry has `seq`, `previousHash`, `policyHash`, `jobId`, `service`, `baseUrl`, `bindingHash`, `amount`,
  `payTo`, the payment method and, when known, the transaction hash. `hash = sha256(JCS(entry))`.
- `sending` is written, and flushed to disk, **before** the paid request goes out. Recovery starts from the
  last `sending` with no `settled` or `result` after it, and never re-signs that job.
- Job tokens are secrets, so they are stored next to the journal, not in it. The journal can then be exported
  or anchored without exposing them.
- Storage is a file in Node (the `./node` entry point) and IndexedDB in the browser (`./browser`, written with
  strict durability). A journal has one writer, so the web app runs in one tab at a time. Anchoring a Merkle root
  on chain is later work.

### One payment, step by step

1. Fetch the manifest and validate it (the protocol package).
2. Build the job: `jobId`, `Job-Token` and binding hash. Journal `intent`.
3. Call create-job without paying and get the 402. `checkChallenge()` against the manifest, and pick the
   payment method that matches it. A violation, or no matching method, refuses.
4. Policy check, plus the wallet's own budget for a policy wallet. If either fails, journal `refused` and
   stop (fail closed). If the amount is above `autoApproveUpTo`, show the approval screen. `decline()` journals
   `refused` and never signs.
5. Journal `approved`, sign, then journal `sending` and send. A busy provider (`429` or `503`, spec §5.8) answers
   before it takes the payment: the client waits out `Retry-After` and sends the same signed request again, while
   the payment is still valid and for at most `busyWaitSeconds`. If the provider stays busy, it journals `failed`
   with `charged: false`. The unpaid request in step 3 is waited out the same way.
6. Get the job view. Confirm the USDC `transfer` on chain before showing "paid", then journal `settled`.
7. On `202`, or if the connection drops: check-status, then get-result, never paying again, at the pace the
   provider's `Retry-After` sets. A job the provider
   marks `payment_uncertain` comes back at once: only the provider's `reconcile` resolves it, so polling doesn't.

## Sprint plan

| Week | Build | Shows |
| --- | --- | --- |
| 1 | Core (policy, journal, x402 flow, recovery skeleton), local-key signer, a minimal approval page. Spike: Stellar Wallets Kit, listing the wallets whose `signAuthEntry` works with `@x402/stellar`. | The first paid testnet transaction; the D1 video of the approval screen |
| 2 | Web app v1: form from schema, approval, budget, history. MCP server: paying inside the budget, approval above it. | Developers and non-technical users can both run the flow |
| 3 | Recovery in both surfaces. Spike: a passkey smart account paying an x402 service through the facilitator. | The recovery demo |
| 4 | Pilot. If the spike passed, non-technical pilot users get passkey wallets. | Five user flows |

The smart account is the flagship, but no SOW deliverable depends on it: the allowance wallet and Freighter
cover the sprint whatever the spike shows.

## Risks and open points

- **Browser calls need CORS.** The web app calls providers straight from the browser. Provider Standard v1
  makes this a SHOULD ([J17]) and Provider Kit turns it on by default. A provider without CORS is reachable
  only through the MCP server or SDK.
- **Browser wallets:** whether each wallet's `signAuthEntry` output fits what `@x402/stellar` expects is
  unverified (Week 1 spike, through Stellar Wallets Kit). Freighter is the first to test. Fallback for the D1
  video: the local-key signer behind the same approval page.
- **Smart account x402 payments** are unverified (erc-compatibility.md, T5). We use an existing audited
  smart-account contract, such as OpenZeppelin's Stellar smart accounts, rather than writing our own. Building
  an ERC-8196 contract stays with the parallel project.
- **Moving money in and out** for non-technical users on mainnet: many exchanges can't send to a `C…` address.
  On testnet we pre-fund pilot wallets.
- **Principle 3** (IMPLEMENTATION_PLAN.md) now reads: the user approves each exact payment, or the payment
  fits a budget the user explicitly granted.

## Options considered

| Option | Why it was not chosen alone |
| --- | --- |
| Node library + CLI with an encrypted keystore | Fine for developers, unusable for non-technical users. It survives as the core plus the local-key signer. |
| Keyed MCP server with elicitation | Agents only. It survives as one of the two surfaces. |
| Browser page with Freighter | Needs an extension, and every payment needs a human, so agents can't act on their own. It survives as one signer, through Stellar Wallets Kit. |
| Payment methods as separate options (`createPayload`, `confirmPayment`, as in the first PoC) | Nothing tied a method's payload to its proof, so a new method could pair them wrongly. Replaced by `PaymentMethod` on 2026-10-22. |
| Hosted wallet that holds keys | Custody, which is out of scope and a regulatory burden. |
