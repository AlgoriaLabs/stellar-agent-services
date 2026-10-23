// Test helpers for providers and clients: real x402 `exact` payments, signed offline.
//
//   import { signTestPayment } from "@stellar-agent-services/provider-kit/testing";
//
// The payment is the same transaction the x402 client builds (one SAC transfer authorized by the
// payer's signed auth entry), without the RPC round trips, so the provider's local payment checks run
// on it unchanged. Nothing here touches the network; pair it with a fake facilitator.

import { randomBytes } from "node:crypto";
import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { Account, Address, authorizeEntry, Keypair, nativeToScVal, Networks, Operation, TimeoutInfinite, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/** The all-zero account the x402 client uses as transaction source; the facilitator rebuilds the transaction. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface TestPaymentOptions {
  /** The auth-entry nonce. Default: random. Two payments with the same payer and nonce are one payment. */
  nonce?: bigint;
  /** The last ledger the signature is valid for. Default 1,000,000 (fixtures use fixed values). */
  expirationLedger?: number;
  /** Pay this instead of what the requirements ask, to test refusals. */
  override?: Partial<Pick<PaymentRequirements, "amount" | "payTo" | "asset">>;
}

/** A signed x402 v2 `exact` payment for the requirements, from `payer`. */
export async function signTestPayment(
  requirements: PaymentRequirements,
  payer: Keypair,
  options: TestPaymentOptions = {},
): Promise<PaymentPayload> {
  const passphrase = requirements.network === ("stellar:pubnet" satisfies StellarNetwork) ? Networks.PUBLIC : Networks.TESTNET;
  const paid = { ...requirements, ...options.override };
  const call = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(paid.asset).toScAddress(),
    functionName: "transfer",
    args: [
      nativeToScVal(payer.publicKey(), { type: "address" }),
      nativeToScVal(paid.payTo, { type: "address" }),
      nativeToScVal(BigInt(paid.amount), { type: "i128" }),
    ],
  });
  const unsigned = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(payer.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString((options.nonce ?? randomNonce()).toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    }),
  });
  const signed = await authorizeEntry(unsigned, payer, options.expirationLedger ?? 1_000_000, passphrase);
  const transaction = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: "100", networkPassphrase: passphrase })
    .addOperation(Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeInvokeContract(call), auth: [signed] }))
    // No wall-clock timebounds, so fixtures never expire.
    .setTimeout(TimeoutInfinite)
    .build();
  return { x402Version: 2, accepted: requirements, payload: { transaction: transaction.toXDR() } };
}

function randomNonce(): bigint {
  return randomBytes(8).readBigInt64BE() & 0x7fffffffffffffffn;
}
