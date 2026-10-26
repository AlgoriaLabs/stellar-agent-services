import { signTestPayment } from "@stellar-agent-services/provider-kit/testing";
import { USDC_ASSET } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { findSettlements, PaymentRefused, proveSettlement, usdcTrustline, Wallet, type ChainReader, type Payer } from "../src/index.js";
import { fakeChain, fastSleep, offlinePayer, payer, payerKeys, payTo, type FakeChain } from "./support/harness.js";

// The on-chain proofs and the wallet, on their own.

const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: USDC_ASSET["stellar:testnet"],
  amount: "100000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
} as PaymentRequirements;

const limits = { maxPrice: 1_000_000n, maxSpend: 10_000_000n, allowPubnet: false };

function wallet(chain: FakeChain, payerOverride?: Payer) {
  return new Wallet(payerOverride ?? offlinePayer(chain), chain.chain, limits);
}

describe("proveSettlement [J16]", () => {
  it("confirms the transaction that carries the signed payment", async () => {
    const chain = fakeChain();
    const payment = await wallet(chain).sign(requirements, undefined, "test");
    const transaction = chain.settle(payment.transaction);
    expect(await proveSettlement(chain.chain, payment, transaction, { sleep: fastSleep })).toEqual({ outcome: "confirmed", ledger: expect.any(Number) });
  });

  it.each<[string, (chain: FakeChain, transaction: string) => string, RegExp]>([
    ["a failed transaction", (chain, tx) => chain.settle(tx, { status: "FAILED" }), /failed on chain/],
    ["a transfer of another amount", (chain, tx) => chain.settle(tx, { amount: 1n }), /moved 1 to/],
    ["a transfer to another payee", (chain, tx) => chain.settle(tx, { to: Keypair.random().publicKey() }), /not 100000 to/],
    ["a value that is not a hash", () => "0xABC", /not a 64-character/],
  ])("refutes %s", async (_name, settle, reason) => {
    const chain = fakeChain();
    const payment = await wallet(chain).sign(requirements, undefined, "test");
    const proof = await proveSettlement(chain.chain, payment, settle(chain, payment.transaction), { sleep: fastSleep });
    expect(proof).toMatchObject({ outcome: "refuted", reason: expect.stringMatching(reason) });
  });

  it("refutes another payment's transaction, even for the same payer, payee and amount", async () => {
    const chain = fakeChain();
    const payment = await wallet(chain).sign(requirements, undefined, "test");
    const other = await signTestPayment(requirements, payerKeys, { expirationLedger: 5000 });
    const transaction = chain.settle((other.payload as { transaction: string }).transaction);
    expect(await proveSettlement(chain.chain, payment, transaction, { sleep: fastSleep })).toMatchObject({ outcome: "refuted", reason: expect.stringMatching(/does not carry/) });
  });

  it("looks again for a transaction the RPC hasn't seen yet, then refutes it", async () => {
    const chain = fakeChain();
    const payment = await wallet(chain).sign(requirements, undefined, "test");
    let lookups = 0;
    const counting: ChainReader = { ...chain.chain, getTransaction: (hash) => (lookups++, chain.chain.getTransaction(hash)) };
    const proof = await proveSettlement(counting, payment, "a".repeat(64), { sleep: fastSleep, attempts: 4 });
    expect(proof).toMatchObject({ outcome: "refuted", reason: expect.stringMatching(/not on chain/) });
    expect(lookups).toBe(4);
  });

  it("is unknown, never refuted, when the RPC fails", async () => {
    const chain = fakeChain();
    const payment = await wallet(chain).sign(requirements, undefined, "test");
    chain.state.down = true;
    expect(await proveSettlement(chain.chain, payment, "a".repeat(64), { sleep: fastSleep })).toMatchObject({ outcome: "unknown" });
  });
});

describe("findSettlements", () => {
  it("finds the payments that landed, and proves the others never will once they expired", async () => {
    const chain = fakeChain();
    const signer = wallet(chain);
    const landed = await signer.sign(requirements, undefined, "landed");
    const refused = await signer.sign(requirements, undefined, "refused");
    const transaction = chain.settle(landed.transaction);
    chain.state.latestLedger = Math.max(landed.expirationLedger, refused.expirationLedger) + 1;
    expect(await findSettlements(chain.chain, [landed, refused])).toEqual([{ outcome: "settled", transaction }, { outcome: "not_settled" }]);
  });

  it("is unknown while a payment can still land, or when the chain can't be searched", async () => {
    const chain = fakeChain();
    const payment = await wallet(chain).sign(requirements, undefined, "test");
    expect(await findSettlements(chain.chain, [payment])).toEqual([{ outcome: "unknown", reason: expect.stringMatching(/can still land/) }]);
    chain.state.latestLedger = payment.expirationLedger + 1;
    chain.state.down = true;
    expect(await findSettlements(chain.chain, [payment])).toEqual([{ outcome: "unknown", reason: expect.stringMatching(/could not be searched/) }]);
  });
});

describe("usdcTrustline [P2]", () => {
  it.each(["authorized", "unauthorized", "missing", "no_account"] as const)("reads %s", async (state) => {
    expect(await usdcTrustline(fakeChain({ trustline: state }).chain, "stellar:testnet", payTo)).toBe(state);
  });
});

describe("the wallet", () => {
  it("refuses a payment above its limits, or on pubnet, before signing", async () => {
    const chain = fakeChain();
    const signer = new Wallet(offlinePayer(chain), chain.chain, { maxPrice: 50_000n, maxSpend: 150_000n, allowPubnet: false });
    await expect(signer.sign(requirements, undefined, "too dear")).rejects.toThrow(PaymentRefused);
    await expect(signer.sign({ ...requirements, network: "stellar:pubnet" }, undefined, "real money")).rejects.toThrow(/pubnet/);
    expect(signer.spent).toBe(0n);
    expect(signer.refusal({ amount: "50000", network: "stellar:testnet" }, 4)).toMatch(/above its limit/);
    expect(signer.refusal({ amount: "50000", network: "stellar:testnet" }, 3)).toBeUndefined();
  });

  it("never sends a payment other than the one approved", async () => {
    const chain = fakeChain();
    const rogue: Payer = {
      address: payer,
      async sign(asked) {
        const payload = await signTestPayment(asked, payerKeys, { override: { amount: "999999" }, expirationLedger: 5000 });
        return { transaction: (payload.payload as { transaction: string }).transaction };
      },
    };
    const signer = wallet(chain, rogue);
    await expect(signer.sign(requirements, undefined, "test")).rejects.toThrow(/signed something other than the approved transfer/);
    expect(signer.payments).toEqual([]);
  });

  it("records each payment's nonce, window and header, and counts what it signed", async () => {
    const chain = fakeChain();
    const signer = wallet(chain);
    const payment = await signer.sign(requirements, { url: "https://provider.test/services/x/jobs" }, "test");
    expect(payment).toMatchObject({ network: "stellar:testnet", payer, payTo, amount: "100000", label: "test", asset: requirements.asset });
    expect(payment.nonce).toMatch(/^\d+$/);
    expect(payment.expirationLedger).toBeGreaterThan(payment.signedAfterLedger);
    expect(payment.header.length).toBeGreaterThan(100);
    expect(signer.spent).toBe(100_000n);
  });
});
