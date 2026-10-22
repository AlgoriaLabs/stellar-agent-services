import { USDC_ASSET } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { paymentMethodConformance, signerConformance, type ConformanceCheck, type PaymentMethodFixture } from "../src/conformance.js";
import { localKeySigner, x402ExactStellar, type ExpectedPayment, type PaymentMethod, type Signer } from "../src/index.js";
import { fakeChain, transferEvent } from "./support/chain.js";

const network = "stellar:testnet";
const payer = Keypair.random();
const payTo = Keypair.random().publicKey();
const expected: ExpectedPayment = { network, asset: USDC_ASSET[network], amount: "100000", payTo, payer: payer.publicKey() };
const transaction = "ab".repeat(32);
const chain = fakeChain({ [transaction]: [transferEvent({ asset: expected.asset, from: expected.payer, to: payTo })] });
const fixture: PaymentMethodFixture = {
  requirements: {
    scheme: "exact",
    network,
    asset: expected.asset,
    amount: expected.amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  } as PaymentRequirements,
  settled: { transaction, expected },
};

describe("built-in adapters pass conformance", () => {
  describe("localKeySigner", () => {
    for (const check of signerConformance(localKeySigner(payer.secret(), network), { network })) it(check.name, check.run);
  });

  describe("x402ExactStellar", () => {
    for (const check of paymentMethodConformance(x402ExactStellar({ server: chain }), fixture)) it(check.name, check.run);
  });
});

describe("conformance catches broken adapters", () => {
  it("fails a method that confirms any payment", async () => {
    const lenient: PaymentMethod = { ...x402ExactStellar({ server: chain }), confirm: async () => ({ confirmed: true }) };
    expect(await failures(paymentMethodConformance(lenient, fixture))).toEqual([
      "does not confirm a payment to another payee",
      "does not confirm another amount",
      "does not confirm another asset",
      "does not confirm a payment from another payer",
    ]);
  });

  it("fails a method that matches every entry", async () => {
    const greedy: PaymentMethod = { ...x402ExactStellar({ server: chain }), id: "Greedy Method", matches: () => true };
    expect(await failures(paymentMethodConformance(greedy, fixture))).toEqual([
      "has a stable id",
      "does not match an unknown scheme",
      "does not match an unknown network",
      "does not match a malformed entry",
    ]);
  });

  it("fails a signer that signs with another key", async () => {
    const impostor: Signer = { ...localKeySigner(payer.secret(), network), signAuthEntry: localKeySigner(Keypair.random().secret(), network).signAuthEntry };
    expect(await failures(signerConformance(impostor, { network }))).toEqual([
      "signs an auth entry as its own address",
      "its signature verifies against its address",
    ]);
  });

  it("fails a signer whose budget is not in base units", async () => {
    const vague: Signer = { ...localKeySigner(payer.secret(), network), budget: async () => "about 5 USDC" };
    expect(await failures(signerConformance(vague, { network }))).toEqual(["reports its budget in base units"]);
  });
});

async function failures(checks: ConformanceCheck[]): Promise<string[]> {
  const failed: string[] = [];
  for (const check of checks) {
    await check.run().catch(() => failed.push(check.name));
  }
  return failed;
}
