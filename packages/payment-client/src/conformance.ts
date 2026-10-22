// Conformance checks for signer and payment-method adapters (docs/payment-client.md, "Strategies").
//
// The core keeps every safety step whatever is plugged in. These checks cover what only an adapter can
// get right: a signer signs as its own address, and a method matches only what it can pay and confirms
// only the payment the user approved. Passing them, plus a review, is what the "verified" trust level
// requires.
//
// They need no test framework. Each check throws on failure, so an adapter's tests run them as:
//
//   for (const check of signerConformance(signer, { network: "stellar:testnet" })) it(check.name, check.run);

import { USDC_ASSET, type StellarNetwork } from "@stellar-agent-services/protocol";
import { Address, hash, Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { getNetworkPassphrase } from "@x402/stellar";
import type { ExpectedPayment, PaymentMethod, Signer } from "./strategies.js";

export interface ConformanceCheck {
  name: string;
  run(): Promise<void>;
}

export function signerConformance(signer: Signer, { network }: { network: StellarNetwork }): ConformanceCheck[] {
  const networkPassphrase = getNetworkPassphrase(network);
  const preimage = authPreimage(signer.address, network);
  const sign = async () => {
    const { signedAuthEntry, signerAddress, error } = await signer.signAuthEntry(preimage, { networkPassphrase, address: signer.address });
    if (error !== undefined) throw new Error(`the wallet reported an error: ${error.message}`);
    return { signature: signedAuthEntry, signerAddress };
  };

  const checks = [
    check("has a Stellar account (G...) or contract (C...) address", async () => {
      assert(StrKey.isValidEd25519PublicKey(signer.address) || StrKey.isValidContract(signer.address), `"${signer.address}" is not a Stellar address`);
    }),
    check("signs an auth entry as its own address", async () => {
      const { signature, signerAddress } = await sign();
      assert(typeof signature === "string" && signature !== "", "signAuthEntry returned no signature");
      assert(signerAddress === undefined || signerAddress === signer.address, `it signed as ${String(signerAddress)}, not ${signer.address}`);
    }),
  ];
  // A contract account's own __check_auth decides what a valid signature is, so only keys are verified here.
  if (StrKey.isValidEd25519PublicKey(signer.address)) {
    checks.push(
      check("its signature verifies against its address", async () => {
        const { signature } = await sign();
        const valid = Keypair.fromPublicKey(signer.address).verify(hash(Buffer.from(preimage, "base64")), Buffer.from(signature, "base64"));
        assert(valid, "the signature does not verify against the signer's address");
      }),
    );
  }
  if (signer.budget !== undefined) {
    const budget = signer.budget.bind(signer);
    checks.push(
      check("reports its budget in base units", async () => {
        const reported = await budget(network, USDC_ASSET[network]);
        assert(reported === undefined || /^\d+$/.test(reported), `budget() returned "${String(reported)}", not base units`);
      }),
    );
  }
  return checks;
}

export interface PaymentMethodFixture {
  /** A challenge entry the method pays. */
  requirements: PaymentRequirements;
  /** A settled transaction the method can see, and exactly what it paid. */
  settled: { transaction: string; expected: ExpectedPayment };
}

export function paymentMethodConformance(method: PaymentMethod, { requirements, settled }: PaymentMethodFixture): ConformanceCheck[] {
  const refuses = (name: string, change: Partial<ExpectedPayment>) =>
    check(`does not confirm ${name}`, async () => {
      const result = await method.confirm(settled.transaction, { ...settled.expected, ...change });
      assert(!result.confirmed, `it confirmed the payment with ${Object.keys(change).join(", ")} changed`);
      assert(typeof result.reason === "string" && result.reason !== "", "it gave no reason for not confirming");
    });

  return [
    check("has a stable id", async () => {
      assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(method.id), `id "${method.id}" is not lowercase words joined by hyphens`);
    }),
    check("matches the challenge entry it pays", async () => {
      assert(method.matches(requirements), "it does not match the fixture's entry");
    }),
    check("does not match an unknown scheme", async () => {
      assert(!method.matches({ ...requirements, scheme: "conformance-unknown" }), "it matched an unknown scheme");
    }),
    check("does not match an unknown network", async () => {
      assert(!method.matches({ ...requirements, network: "conformance:unknown" }), "it matched an unknown network");
    }),
    check("does not match a malformed entry", async () => {
      assert(!method.matches({} as PaymentRequirements), "it matched an empty entry");
    }),
    check("confirms the settled payment", async () => {
      const result = await method.confirm(settled.transaction, settled.expected);
      assert(result.confirmed, `it did not confirm the fixture's payment: ${String(result.reason)}`);
    }),
    refuses("a payment to another payee", { payTo: Keypair.random().publicKey() }),
    refuses("another amount", { amount: (BigInt(settled.expected.amount) + 1n).toString() }),
    refuses("another asset", { asset: StrKey.encodeContract(Keypair.random().rawPublicKey()) }),
    refuses("a payment from another payer", { payer: Keypair.random().publicKey() }),
  ];
}

/** The preimage a signer signs for a 1-unit USDC transfer, as `@x402/stellar` would ask for it. */
function authPreimage(address: string, network: StellarNetwork): string {
  const transfer = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(USDC_ASSET[network]).toScAddress(),
    functionName: "transfer",
    args: [nativeToScVal(address, { type: "address" }), nativeToScVal(Keypair.random().publicKey(), { type: "address" }), nativeToScVal(1n, { type: "i128" })],
  });
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(getNetworkPassphrase(network))),
      nonce: new xdr.Int64(1),
      signatureExpirationLedger: 1000,
      invocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(transfer),
        subInvocations: [],
      }),
    }),
  ).toXDR("base64");
}

function check(name: string, run: () => Promise<void>): ConformanceCheck {
  return { name, run };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
