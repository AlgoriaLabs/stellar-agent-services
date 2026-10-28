# Payment Client Integrations: implementation reference for AI coding agents

Use this file to build, review or submit one of three things:

1. a **Signer** adapter: a wallet plugged into `packages/payment-client`;
2. a **PaymentMethod** adapter: a way to pay and prove a payment, plugged into the same core;
3. a **native client**: another project's own payment client that pays Provider Standard v1 services directly.

- **Sources:** the interfaces are in [strategies.ts](../../packages/payment-client/src/strategies.ts), the core flow
  in [client.ts](../../packages/payment-client/src/client.ts), the design in
  [payment-client.md](../payment-client.md#strategies-signers-and-payment-methods), and the wire protocol in
  [provider-standard.md](../provider-standard.md). The spec wins on the wire protocol. The code is the current
  behavior; if this file disagrees with it, report the mismatch.
- **Rule ids in this file:** `CG` core guarantees, `SG` signer rules, `PM` payment method rules, `AD` adapter
  package rules. They are integration rules, not part of Provider Standard v1. Spec rules keep their own ids
  (`[P7]`, `[J16]`).
- **Human summary:** [README.md](README.md).
- **State (2026-10-25):** only the built-ins exist (`localKeySigner`, `x402ExactStellar`). No third-party adapter exists
  yet. The package is `private`, version `0.0.0`, not on npm.

## 0. Rules for the agent using this file

1. Pick one path in §1. Don't edit `packages/payment-client/src` to make an adapter work. If the core lacks
   something, stop and report it as an issue; don't work around it inside the adapter.
2. An adapter never touches the journal, the policy, the job token or provider HTTP calls. It signs, or it
   confirms. Nothing else.
3. Fail closed. A signer or `createPayload()` that can't do exactly what was asked throws. `confirm()` that
   can't tell returns `{ confirmed: false, reason }`. Never return a placeholder signature or `confirmed: true`.
4. No secret keys in source, fixtures, logs or CI output. Tests use `Keypair.random()`; testnet keys come from the
   environment.
5. Tests never touch the network, except the opt-in testnet runs in §10.
6. Never call an adapter "verified". Only maintainers grant that level (§12).

## 1. Choose a path

| Situation | Path | Slot | Standard change first? |
| --- | --- | --- | --- |
| A wallet holding a `G…` key (browser extension, mobile, HSM, MPC) that signs SEP-43 `signAuthEntry` | Signer adapter | `Signer` | No |
| A wallet that also enforces spending limits on chain (ERC-8196 policy wallet, treasury) | Signer adapter with `budget()` | `Signer` | No |
| A contract account (`C…`) whose `__check_auth` expects its own signature format (passkey/WebAuthn smart account) | Payment method for scheme `exact` that builds its own auth entries, plus a signer for the account | `PaymentMethod` + `Signer` | No |
| A new scheme, asset, network or protocol (`upto`, MPP, another token) | Payment method adapter | `PaymentMethod` | **Yes** (spec §11, `[P1]`). Providers can't offer it before that. |
| Your own client, in any language | Native client | none | No. Follow §11. |

**Why `C…` accounts need their own method.** `x402ExactStellar()` uses `@x402/stellar` 2.28's
`ExactStellarScheme`, which signs through `AssembledTransaction.signAuthEntries`. That path turns the signer's
answer into a bare signature (`Buffer.from(signedAuthEntry, "base64")`), and `authorizeEntry` then verifies it with
`Keypair.fromPublicKey(address)`. That works only for `G…` addresses. A custom account needs `authorizeEntry` to
receive `{ signatureScVal }` in the format its `__check_auth` expects, and only a method that builds the auth entry
itself can supply it. (The design doc's smart-account row, and erc-compatibility.md T5, are still unverified.)

## 2. File map

| File | Role |
| --- | --- |
| `packages/payment-client/src/strategies.ts` | `Signer`, `PaymentMethod`, `SignedPayload`, `ExpectedPayment`, `Confirmation` |
| `packages/payment-client/src/client.ts` | `PaymentClient`: the flow that calls the strategies (`quote`, `pay`, `payOnce`, `confirm`, `methodFor`, `checkLimits`) |
| `packages/payment-client/src/local-key-signer.ts` | Built-in signer: `createEd25519Signer` from `@x402/stellar` |
| `packages/payment-client/src/x402-exact-stellar.ts` | Built-in method, id `x402-exact-stellar` |
| `packages/payment-client/src/onchain.ts` | `rpcConfirmPayment`, `checkTransfer`, `TransactionReader`. Reuse them in your `confirm()`. |
| `packages/payment-client/src/conformance.ts` | `signerConformance`, `paymentMethodConformance` (entry point `./conformance`) |
| `packages/payment-client/test/conformance.test.ts` | How the built-ins run conformance, and the broken adapters it must fail |
| `packages/payment-client/test/support/chain.ts` | `fakeChain`, `transferEvent`. Not exported: copy them (§8.4). |
| `packages/payment-client/test/flow.test.ts`, `describe("strategies")` | The core's behavior around strategies |
| `packages/provider-kit/src/payments/payload-checks.ts` | What a provider checks in your payload before its facilitator sees it |
| `examples/paid-service` | The provider to pay in the testnet runs (§10) |
| `apps/wallet/src/lib/agent-wallet.svelte.ts` | Where the web app builds its `PaymentClient`; swap the signer here to try a browser wallet locally |

## 3. Interfaces

From `strategies.ts`, with the SEP-43 types expanded (`@stellar/stellar-sdk/contract`):

```ts
/** Who holds the key: ClientStellarSigner from @x402/stellar, plus budget(). */
interface Signer {
  address: string;                                  // G… or C…
  signAuthEntry: SignAuthEntry;
  signTransaction?: SignTransaction;                // never called by the core or by x402 exact
  /** A wallet's own on-chain limit for `asset`, in base units. Undefined: no limit. */
  budget?(network: StellarNetwork, asset: string): Promise<string | undefined>;
}

type SignAuthEntry = (
  authEntry: string,                                // base64 xdr.HashIdPreimage (envelopeTypeSorobanAuthorization)
  opts?: { networkPassphrase?: string; address?: string },
) => Promise<{ signedAuthEntry: string; signerAddress?: string } & { error?: { message: string; code: number } }>;

/** How an x402 challenge entry is paid, and how that payment is proven. */
interface PaymentMethod {
  readonly id: string;                              // journaled with each payment
  matches(requirements: PaymentRequirements): boolean;
  createPayload(requirements: PaymentRequirements, signer: Signer): Promise<SignedPayload>;
  confirm(transaction: string, expected: ExpectedPayment): Promise<Confirmation>;
}

type SignedPayload = Pick<PaymentPayload, "x402Version" | "payload">;     // @x402/core/types
interface ExpectedPayment { network: StellarNetwork; asset: string; amount: string; payTo: string; payer: string }
interface Confirmation { confirmed: boolean; reason?: string }
```

Facts the types don't tell you:

- The SDK calls `signAuthEntry(preimage, { address })` **without** `networkPassphrase`. Take the network when the
  signer is built. The preimage already commits to the network id.
- `signedAuthEntry` is the base64 raw 64-byte ed25519 signature over `sha256(preimage bytes)`, not a signed XDR
  entry.
- A returned `error` makes the SDK throw (`handleWalletError`). Either way the core journals `refused`.
- `budget()` and `ExpectedPayment.amount` are base units of the asset (USDC: 7 decimals), matching `^\d+$`.
- `requirements` is the challenge's single `accepts` entry: `scheme`, `network`, `asset`, `amount`, `payTo`,
  `maxTimeoutSeconds`, `extra.areFeesSponsored`.
- The core sends `{ ...signed, x402Version: 2, resource, accepted }`. It sets `resource` and `accepted` itself.
  Any other key you return passes through to the provider unchecked.
- `confirm(transaction, …)` gets the hash from the provider's job view (`job.payment.transaction`). It is
  untrusted input.
- `PaymentClientOptions.methods`: the first method whose `matches()` is true wins. The default is
  `[x402ExactStellar({ rpcUrl })]`. An empty list or duplicate ids throw a `TypeError` in the constructor.

## 4. What the core enforces (CG)

These hold for every adapter. Don't re-implement them in an adapter.

| Id | Guarantee | Code (`client.ts`) | Test (`flow.test.ts`) |
| --- | --- | --- | --- |
| CG1 | The challenge equals the approved manifest's payment option `[P4]`, `[P7]`. Any violation blocks `pay()`. | `quote()`: `checkChallenge` | "refuses to sign a challenge that differs from the manifest" |
| CG2 | The first installed method whose `matches()` is true pays. A throw counts as false. No match refuses before signing. | `methodFor()` | "refuses before signing when no installed method pays the challenge" |
| CG3 | The approved terms (network, asset, amount, payTo) come from the challenge entry, never from an adapter. | `pick()` | "pays with the first installed method that matches, and journals which one" |
| CG4 | Spending policy plus `signer.budget()`, at `quote()` and again in `pay()`. A budget that throws, isn't base units or is below the amount blocks the payment (`wallet.budget`). | `checkLimits()` | "re-checks a policy wallet's on-chain budget when paying", "blocks the payment when the wallet's budget …" |
| CG5 | Approval, or auto-approval within `autoApproveUpTo`, comes before `createPayload()`. Journals `approved`. | `payOnce()` | "pays nothing when the user declines", "declines without signing, even inside the auto-approve budget" |
| CG6 | `createPayload()` runs at most once per job: an in-process `paying` set, plus the journal's `sending` entry. | `pay()` | "signs once when pay() runs twice at the same time" |
| CG7 | `createPayload()` throws: journal `refused`, nothing sent, the same quote can be paid again. | `payOnce()` | "sends nothing when the wallet does not sign, and lets the user try again" |
| CG8 | `sending` with `{ network, asset, amount, payTo, payer: signer.address, method: id }` is durable before the paid request leaves. | `payOnce()` | same as CG3 |
| CG9 | The method named in `sending` confirms, against the journaled terms, never the receipt. A transaction that already confirmed another job, a missing method or a method that throws gives "not confirmed" with a reason `[J16]`. | `confirm()` | "confirms against the approved payment, not the provider's receipt", "does not confirm a job whose receipt reuses another job's transaction", "does not confirm a recovered payment whose method is no longer installed", "does not confirm a payment whose method throws while checking it" |
| CG10 | `recover()` never calls `createPayload()`. | `recover()` | "recovers a lost response without paying again" |

Journal on the happy path: `intent, approved, sending, settled, result`. When the wallet doesn't sign:
`intent, approved, refused`.

**What the core does not enforce.** This is why the `SG` and `PM` rules exist.

- **It doesn't inspect what is signed.** `createPayload()` receives the whole `Signer`, and the core never decodes
  its result. A method that authorizes another amount or payee is refused by an honest provider
  (`payload-checks.ts`) and by its facilitator. But by then a signed authorization has left the process, and anyone
  holding it can submit it until its expiration ledger.
- **It doesn't bind the policy to the signer.** `policy.agentAddress` is never compared with `signer.address`.
- **It reads `signer.address` again after signing**, to journal `payer`. If the address changed during signing,
  confirmation fails. The user sees "not confirmed"; nothing is charged twice.
- **It doesn't time out `createPayload()`.** A wallet popup left open keeps that job's `pay()` pending. A signature
  produced after `maxTimeoutSeconds` is refused by the provider (`402`, journaled `failed`, `charged: false`).

## 5. Signer rules (SG)

| Id | Rule | Checked by |
| --- | --- | --- |
| SG1 | MUST: `address` is a valid `G…` or `C…` strkey (never `M…`), constant for the instance's lifetime. A wallet account switch means a new `Signer` and a new `PaymentClient`. | `signerConformance`: "has a Stellar account (G...) or contract (C...) address". Constancy: review. |
| SG2 | MUST sign only as `address`. A returned `signerAddress` equals `address`. For `G…`, the signature verifies against `address` over `sha256(preimage)`. | "signs an auth entry as its own address", "its signature verifies against its address" |
| SG3 | MUST sign only the preimage it is given. MUST NOT build, submit or broadcast a transaction (never `submit: true`), and MUST NOT sign anything on its own initiative. | Review |
| SG4 | MUST take the network when it is built, not from `opts`. SHOULD throw for a preimage whose `networkId` is not `sha256(its passphrase)`. | Review |
| SG5 | On cancel, refusal or a wallet error, MUST throw or return `error`. MUST NOT return an empty or placeholder signature. | Review. "signs an auth entry as its own address" rejects an empty one. |
| SG6 | `budget()`: only for a wallet that enforces the limit itself, on chain. Returns what `asset` on `network` can still pay, in base units, or `undefined` for "no limit". MUST be read-only: no prompt, no signature, no state change. Throws when it can't tell. | "reports its budget in base units". Read-only: review. |
| SG7 | `budget()` SHOULD answer within about 2 s. It runs on every `quote()` and `pay()`. | Review |
| SG8 | Omit `signTransaction` unless your wallet needs it elsewhere. The core never calls it. | — |
| SG9 | The adapter card declares where the key lives. A signer whose key a server holds for the user can't be Verified. | Review |
| SG10 | A signer that prompts a human SHOULD show the asset, amount, payee and network decoded from the preimage. | Review |

## 6. Payment method rules (PM)

| Id | Rule | Checked by |
| --- | --- | --- |
| PM1 | `id` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, is unique, and is never renamed or reused. Name it after what it pays and who built it: `x402-exact-stellar-<name>`. Recovery finds the method by this id. | `paymentMethodConformance`: "has a stable id". Uniqueness: review, and the core's constructor. |
| PM2 | `matches()` is synchronous and pure: no I/O, no throw. True only for an entry it can pay: known scheme, network and asset, and a well-formed entry. | "matches the challenge entry it pays", "does not match an unknown scheme", "… an unknown network", "… a malformed entry" |
| PM3 | `createPayload()` MUST authorize exactly one payment: `asset.transfer(signer.address, payTo, amount)` on `network`, with no sub-invocations and no other auth entry for the payer. The signature expires no later than the current ledger + `ceil(maxTimeoutSeconds / ledger seconds)`. | **Not checked by conformance yet.** Review, and the self-test in §8.5. |
| PM4 | `createPayload()` MUST NOT submit, broadcast or settle the payment, or send the payload anywhere. It returns it. Only the provider's facilitator settles. If it throws, no signed authorization may have left the process. | Review |
| PM5 | `createPayload()` signs only with the `signer` argument, once per auth entry, and never caches a payload. Its only network calls are Soroban RPC reads and simulation. | Review |
| PM6 | It returns only `{ x402Version: 2, payload }`. For `exact` on Stellar, `payload` is `{ transaction: <base64 transaction XDR> }`, which must pass `payload-checks.ts`. | Review, and the testnet runs |
| PM7 | `confirm()` reads the chain only. It checks against `expected`, never the provider's receipt: the transaction succeeded and has exactly one `transfer` of `expected.asset` from `expected.payer`, to `expected.payTo`, for `expected.amount`. Reuse `rpcConfirmPayment` or `checkTransfer`. | "confirms the settled payment", "does not confirm a payment to another payee", "… another amount", "… another asset", "… a payment from another payer" |
| PM8 | `confirm()` returns `{ confirmed: false, reason }` with a non-empty reason when the transaction is missing, pending or the RPC fails. It is idempotent: recovery may call it again later. | The non-empty reason is asserted. Idempotency: review. |
| PM9 | `confirm()` keeps working for payments already journaled under its id. Changing what it accepts is a major version. | Review |
| PM10 | A method outside v1 (a scheme other than `exact`, another asset, network or protocol) needs a Provider Standard change first (spec §9, §11). Until then it ships as Community. | Maintainers |
| PM11 | A method for `C…` accounts builds auth entries with `authorizeEntry(entry, callback, expiration, passphrase)`, its callback returning `{ signatureScVal }`. It matches only when configured for that account. Install it **instead of** or **before** `x402ExactStellar()`, since the first match wins. | Review, and the testnet runs |

## 7. Package rules (AD)

| Id | Rule |
| --- | --- |
| AD1 | Its own package, named `signer-<name>` or `method-<name>` (under your own npm scope). |
| AD2 | `@stellar-agent-services/payment-client` is a `peerDependency` (and a `devDependency` for tests). Import only its types, `rpcConfirmPayment` / `checkTransfer`, and `./conformance`. Pin `@x402/core` and `@x402/stellar` 2.28.0 and `@stellar/stellar-sdk` 16.3.1 as the core does. The core never imports the adapter. |
| AD3 | ESM. Runs where it says it does: Node ≥ 22.13, the browser, or both. A browser adapter uses no Node-only API (`Buffer`, `fs`). `./conformance` itself uses `Buffer`, so run it in Node. |
| AD4 | CI runs the conformance checks (§8.4) on every change, and they all pass. |
| AD5 | No keys, preimages, signatures, payloads or job tokens in logs, error messages, analytics or telemetry. Errors name the cause, not the data. |
| AD6 | Semver. Changing the method `id`, or what the address, `budget()` or `confirm()` means, is a major version. |
| AD7 | Public source under an open-source license (MIT or Apache-2.0 preferred), and a security contact. |
| AD8 | The package README contains the adapter card (§9). |

## 8. Templates

### 8.1 Signer for a SEP-43 wallet

```ts
import type { StellarNetwork } from "@stellar-agent-services/protocol";
import type { Signer } from "@stellar-agent-services/payment-client";
import { getNetworkPassphrase } from "@x402/stellar";

/** The SEP-43 subset of your wallet's API. Replace it with the real one. */
export interface WalletApi {
  getAddress(): Promise<{ address: string }>;
  signAuthEntry(
    authEntry: string,
    opts: { networkPassphrase: string; address: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string; error?: { message: string; code: number } }>;
}

export async function walletSigner(wallet: WalletApi, network: StellarNetwork): Promise<Signer> {
  const { address } = await wallet.getAddress(); // read once [SG1]
  const networkPassphrase = getNetworkPassphrase(network); // from construction, not opts [SG4]
  return {
    address,
    async signAuthEntry(authEntry) {
      const result = await wallet.signAuthEntry(authEntry, { networkPassphrase, address });
      if (result.error !== undefined) throw new Error(`the wallet did not sign: ${result.error.message}`); // [SG5]
      if (result.signedAuthEntry === "") throw new Error("the wallet returned no signature");
      if (result.signerAddress !== undefined && result.signerAddress !== address) {
        throw new Error("the wallet signed with another account"); // [SG2]
      }
      return { signedAuthEntry: result.signedAuthEntry, signerAddress: address };
    },
  };
}
```

### 8.2 A wallet with an on-chain budget

```ts
// Inside the object walletSigner returns. `policyWallet.remaining` is your wallet's own read-only call.
async budget(asked: StellarNetwork, asset: string) {
  if (asked !== network) throw new Error(`this wallet is on ${network}, not ${asked}`);
  const remaining: bigint | null = await policyWallet.remaining(address, asset); // no prompt, no signature [SG6]
  return remaining === null ? undefined : remaining.toString(); // base units
},
```

### 8.3 Payment method

```ts
import { rpcConfirmPayment, type PaymentMethod, type TransactionReader } from "@stellar-agent-services/payment-client";

export const METHOD_ID = "x402-exact-stellar-example"; // [PM1]

export function exampleMethod(options: { rpcUrl?: string; server?: TransactionReader } = {}): PaymentMethod {
  return {
    id: METHOD_ID,
    // Pure and total, including for {} [PM2]. Add your own asset and account conditions.
    matches: (r) => r?.scheme === "exact" && r.network === "stellar:testnet" && typeof r.payTo === "string" && typeof r.amount === "string",
    async createPayload(requirements, signer) {
      // Build ONE asset.transfer(signer.address, payTo, amount) invocation and simulate it. Authorize only the
      // payer's auth entry, expiring within maxTimeoutSeconds. Return { x402Version: 2, payload: { transaction } }.
      // Never submit it [PM3]–[PM6].
      throw new Error("not implemented");
    },
    confirm: rpcConfirmPayment(options), // the on-chain transfer check [PM7]; `server` lets tests pass a fake chain
  };
}
```

Accept a `server?: TransactionReader` option, as `x402ExactStellar` does, so conformance runs offline.

### 8.4 Conformance tests

```ts
import { USDC_ASSET } from "@stellar-agent-services/protocol";
import type { ExpectedPayment } from "@stellar-agent-services/payment-client";
import { paymentMethodConformance, signerConformance } from "@stellar-agent-services/payment-client/conformance";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, it } from "vitest";
import { fakeChain, transferEvent } from "./support/chain.js"; // copied from payment-client/test/support/chain.ts

const network = "stellar:testnet";
// A test double of your wallet that signs with a real key, or the real wallet in a browser test runner.
const signer = await walletSigner(testWallet(), network);

describe("signer conformance", () => {
  for (const check of signerConformance(signer, { network })) it(check.name, check.run);
});

describe("payment method conformance", () => {
  const payer = Keypair.random().publicKey();
  const payTo = Keypair.random().publicKey();
  const expected: ExpectedPayment = { network, asset: USDC_ASSET[network], amount: "100000", payTo, payer };
  const transaction = "ab".repeat(32);
  const server = fakeChain({ [transaction]: [transferEvent({ asset: expected.asset, from: payer, to: payTo })] });
  const requirements = {
    scheme: "exact", network, asset: expected.asset, amount: expected.amount, payTo,
    maxTimeoutSeconds: 60, extra: { areFeesSponsored: true },
  } as PaymentRequirements;
  for (const check of paymentMethodConformance(exampleMethod({ server }), { requirements, settled: { transaction, expected } })) {
    it(check.name, check.run);
  }
});
```

`transferEvent` writes an amount of `100000` by default, so keep `expected.amount` at `"100000"` or pass `data`.

### 8.5 Self-test for what a method signs (PM3)

Conformance doesn't call `createPayload()` yet. Until it does, wrap the signer, record every preimage, run
`createPayload()` against testnet with a funded payer (simulation needs the USDC balance), and check each preimage:

```ts
import { Address, hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { getNetworkPassphrase } from "@x402/stellar";

function assertApprovedTransfer(preimage: string, r: PaymentRequirements, payer: string): void {
  const auth = xdr.HashIdPreimage.fromXDR(preimage, "base64").sorobanAuthorization();
  if (!auth.networkId().equals(hash(Buffer.from(getNetworkPassphrase(r.network))))) throw new Error("wrong network");
  const invocation = auth.invocation();
  if (invocation.subInvocations().length !== 0) throw new Error("sub-invocations");
  const call = invocation.function().contractFn();
  const [from, to, amount] = call.args().map((arg) => scValToNative(arg) as unknown);
  if (Address.fromScAddress(call.contractAddress()).toString() !== r.asset) throw new Error("wrong asset");
  if (call.functionName().toString() !== "transfer") throw new Error("not a transfer");
  if (from !== payer || to !== r.payTo || amount !== BigInt(r.amount)) throw new Error("wrong transfer");
}
```

## 9. Adapter card

Put this under `## Adapter card` in the package README. Every field is required; write `none` where it applies.

```yaml
name: Example Wallet signer
package: "@example/signer-example"        # npm name, or a repo path until published
version: 0.1.0
slot: signer                               # signer | payment-method
methodId: none                             # payment methods: the journaled id
addresses: [G]                             # G, C
networks: [stellar:testnet]                # stellar:testnet, stellar:pubnet
budget: none                               # none | on-chain: <the contract or mechanism that enforces it>
humanPrompt: per-payment                   # never | per-payment | above-a-limit
keyCustody: browser extension on the user's device   # where the key lives; "server" can't be Verified
signs: one SAC transfer(payer, payTo, amount) auth entry per payment
submits: never
dependencies: ["@stellar/stellar-sdk@16.3.1", "@x402/stellar@2.28.0"]
license: MIT
source: https://github.com/example/signer-example
security: security@example.com
audits: none
conformance: <link to a passing CI run>
testnet:
  paid: <transaction hash>
  recovered: <transaction hash>
```

## 10. Testnet runs (evidence for Verified)

Set up a provider wallet, a funded payer and the example service, as in the
[payment-client README](../../packages/payment-client/README.md#try-it-on-testnet):

```bash
npm install && npm run build
STELLAR_PAY_HOME=~/.stellar-pay-provider npx stellar-pay wallet create
STELLAR_PAY_HOME=~/.stellar-pay-provider npx stellar-pay wallet fund --usdc 0
PAY_TO=G... node examples/paid-service/dist/server.js
```

The CLI only uses the built-in signer, so pay with your adapter from a short script:

```ts
import { defaultPolicy, Journal, memoryJournalStorage, memorySecretStore, PaymentClient } from "@stellar-agent-services/payment-client";

const signer = await walletSigner(wallet, "stellar:testnet");
const client = new PaymentClient({
  signer,
  methods: [exampleMethod()],                       // omit for the default x402ExactStellar()
  policy: defaultPolicy(signer.address, "stellar:testnet"),
  journal: await Journal.open(memoryJournalStorage()),
  secrets: memorySecretStore(),
  allowLocalhost: true,
});
const manifest = "http://localhost:8787/.well-known/stellar-agent-services.json";
const quote = await client.quote(manifest, "text-stats", { text: "Hello agents." });
if (!client.payable(quote)) throw new Error(quote.challengeViolations.concat(quote.policyViolations.map((v) => v.message)).join("; "));
const result = await client.pay(quote, { approved: true });
console.log(result.confirmed, result.job.payment?.transaction);   // must be true, with a hash
```

1. **Paid job:** `result.confirmed` is `true`. The explorer shows one USDC `transfer` from the payer to `PAY_TO`
   for the price.
2. **Recovery drill:** restart the provider with `DRILL_LOSE_RESPONSE=1 REPORT_DELAY_SECONDS=8` and pay
   `delayed-report` with `{ "topic": "…" }`. `pay()` throws `PaymentUncertainError`; call
   `client.recover(error.jobId)`. It must return `confirmed: true`, and the explorer must show exactly one transfer
   for that job.

For a browser wallet, run the same flow in [apps/wallet](../../apps/wallet) locally by swapping `localKeySigner`
in `agent-wallet.svelte.ts` for your signer. Don't commit that change.

## 11. Native clients

A native client implements the client side of the spec itself. It gets none of the CG guarantees for free, so it
must provide them. The rules are in [standard/README-AI.md §14](../standard/README-AI.md#14-client-rules-agents-wallets-apps):

| Must | Rules |
| --- | --- |
| Fetch the manifest without redirects, at most 256 KiB, I-JSON. Reject another major `standard`. Never fetch remote schemas. | `[M3]`, `[M8]`, `[S5]` |
| Generate and persist the job id and a 32-byte token before the first request. Send both. | `[J1]` |
| Compare the challenge with the approved manifest. Refuse to sign on any difference. | `[P4]`, `[P7]` |
| Show price, payee, network and `charge` before approval. | `[S3]` |
| Sign once per job. Persist "sending" before the paid request. Never sign again for that job. | `[P9]`; CG6–CG8 |
| `429` / `503`: wait `Retry-After` plus jitter and resend the identical request, with the same `PAYMENT-SIGNATURE`. Stop before the payment expires. | `[Q8]`, `[S2]` |
| `202` / `409`: poll no faster than `Retry-After`. HTTP timeout above 30 s. | `[Q9]`, `[J7]`, `[J9]` |
| `payment_uncertain`: stop polling and tell the user not to pay again. | `[J13]` |
| Show "paid" only after confirming on chain against the approved terms. One transaction proves one job. | `[J16]` |
| Label provider-supplied text when showing it to an LLM. | spec §10 |

Test with the protocol's test vectors (`packages/protocol/test-vectors/`: `challenges.json`, `headers.json`,
`binding-hash.json`, `job-states.json`, `problems.json`) and against `examples/paid-service`, including the
recovery drill in §10. Native clients are not listed or badged yet.

## 12. Review for Verified

Maintainers check, in order:

1. The adapter card is complete and matches the code.
2. The CI conformance run passes against the core version the adapter pins.
3. **The signing path:** every call to `signAuthEntry`, `signTransaction`, `authorizeEntry` and `fetch`
   ([SG2]–[SG5], [PM3]–[PM6]).
4. **The confirmation path** ([PM7]–[PM9]).
5. **The testnet transactions:** one transfer of the right asset, payer, payee and amount; the recovery drill paid
   once.
6. No secrets or payment data in logs or telemetry ([AD5]). Pinned dependencies, no install scripts.
7. The row in [README.md](README.md#listed-adapters) records the reviewed version. A new major version is reviewed
   again.

## 13. Pull request

A PR to this repository adds one row to the [Listed adapters](README.md#listed-adapters) table:

```markdown
| <Name> (`<factory or method id>`) | Signer \| Payment method | Verified | [<package>](<source URL>) <reviewed version> |
```

PR description:

```markdown
## Integration: <name>

Adapter card: <link to the README section>
Issue: #<number>

- [ ] Adapter card in the package README (§9)
- [ ] Conformance checks pass in CI: <link to the run>
- [ ] Testnet paid job: <transaction hash>, `confirmed: true`
- [ ] Testnet recovery drill: one job, one transfer: <transaction hash>
- [ ] Never submits, sends or settles a payment itself ([SG3], [PM4])
- [ ] Signs only the approved transfer ([PM3]); self-test output attached (payment methods)
- [ ] No keys, signed payloads or job tokens in logs or telemetry ([AD5])
- [ ] Security contact: <email or URL>
```

A change to the core itself (a new built-in, or a change to `strategies.ts`) is an ordinary PR. It must keep
CG1–CG10 and their tests, and update this file and [payment-client.md](../payment-client.md).

## 14. Known gaps on our side

| Gap | What it means for you | Plan |
| --- | --- | --- |
| `payment-client` is `private`, `0.0.0`, not on npm | Build the adapter as a workspace package in a fork, or install an `npm pack` tarball | Publish with semver; the strategy interfaces become the stable API |
| The interfaces carry no version | A breaking change could land without notice | Semver once published. Until then, any change is called out in its PR. |
| Conformance doesn't exercise `createPayload()` | [PM3] is checked by review and the §8.5 self-test | A signing check: a recording signer plus preimage decoding |
| The core doesn't check what is signed | A buggy method could sign other terms | A guarded signer: the core wraps the `Signer` it passes to `createPayload()` and refuses any preimage that isn't the approved transfer |
| `policy.agentAddress` isn't compared with `signer.address` | A policy can run under another account | A fail-closed check in the core |
| `matches()` doesn't see the signer | A smart-account method can't pair itself with its signer | Configure methods per signer. Maybe `matches(requirements, signer)`. |
| `fakeChain` and `transferEvent` aren't exported | Copy them (§8.4) | Export them from `./conformance` |
| `C…` accounts can't pay through `x402ExactStellar` | Smart accounts need their own method ([PM11]) | The smart-account spike (erc-compatibility.md T5) |
| `createPayload()` has no timeout | An open wallet popup keeps that job's `pay()` pending | Abort after `maxTimeoutSeconds` |
| No conformance suite for native clients | Test with the vectors and drills (§11) | Planned |
| The web app doesn't show trust levels | — | Planned |

## 15. Common mistakes

- Reading `opts.networkPassphrase` in `signAuthEntry`. The SDK doesn't pass it.
- Returning a signed XDR entry instead of the raw base64 signature.
- Implementing `budget()` for a limit the wallet doesn't enforce itself. It gives users a false guarantee. The
  client's spending policy already covers off-chain limits.
- `matches()` that accepts every `exact` entry, including `stellar:pubnet`, when only testnet was tested.
- Confirming from the provider's receipt or `PAYMENT-RESPONSE` header instead of the chain.
- Submitting the transaction inside `createPayload()` "to help". It breaks settlement and risks a second charge.
- Renaming a method id in a minor release. Earlier payments can no longer be confirmed.
- Installing a smart-account method after `x402ExactStellar()`. The built-in matches first and can't sign.
- Using `Buffer` in a browser adapter.
