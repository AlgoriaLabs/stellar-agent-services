// Local payment checks, run BEFORE the facilitator sees the payment.
//
// An x402 `exact` payment on Stellar is an unsigned Soroban transaction with one invokeHostFunction:
// the USDC SAC `transfer(payer, payTo, amount)`, authorized by the payer's signed auth entry. The
// facilitator checks it too, but the provider does not have to trust that: a payment that would pay
// someone else, another amount or another asset is refused here with a 402.
//
// What these checks can't see is left to the facilitator, which simulates the transaction: whether the
// signature is valid, for this network, under the payer's account signers or smart-wallet contract.
//
// The checks also read the payer's auth-entry nonce. Soroban accepts one (address, nonce) once, so
// the payment fingerprint is sha256(JCS({ network, payer, nonce })): re-wrapping the same signed auth
// entry in another transaction still gives the same fingerprint, and the job store refuses a second
// job for it [P9].

import { canonicalSha256, type StellarNetwork } from "@stellar-agent-services/protocol";
import { Address, Networks, scValToNative, Transaction, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/** What the checks learned about a payment that passed them. */
export interface CheckedPayment {
  payer: string;
  /** The payer's auth-entry nonce, as a decimal string. */
  nonce: string;
  /** The last ledger at which the payer's signature is valid. Reconciliation needs it. */
  expirationLedger: number;
  /** sha256(JCS({ network, payer, nonce })): one per signed payment [P9]. */
  fingerprint: string;
}

/** A refused payment: an x402 error reason for the 402 (§4.3). */
export interface RefusedPayment {
  reason: string;
}

const PASSPHRASES: Readonly<Record<StellarNetwork, string>> = {
  "stellar:testnet": Networks.TESTNET,
  "stellar:pubnet": Networks.PUBLIC,
};

/** A signed transfer is about 1 KiB; anything far larger is not one. */
const MAX_TRANSACTION_BASE64_LENGTH = 16 * 1024;

const refused = (reason: string): RefusedPayment => ({ reason: `invalid_exact_stellar_payload_${reason}` });

/** Checks a decoded x402 payload against the requirements this provider issued. */
export async function checkPayment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<CheckedPayment | RefusedPayment> {
  const network = requirements.network as StellarNetwork;
  const passphrase = PASSPHRASES[network];
  if (passphrase === undefined) return { reason: "invalid_network" };
  const encoded = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
  if (typeof encoded !== "string" || encoded.length > MAX_TRANSACTION_BASE64_LENGTH) return refused("malformed");

  let transaction: Transaction;
  try {
    transaction = new Transaction(encoded, passphrase);
  } catch {
    return refused("malformed");
  }

  // One operation: invokeHostFunction calling the asset's contract.
  if (transaction.operations.length !== 1) return refused("wrong_operation");
  const operation = transaction.operations[0]!;
  if (operation.type !== "invokeHostFunction") return refused("wrong_operation");
  if (operation.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return refused("wrong_operation");
  const call = operation.func.invokeContract();

  // transfer(payer, payTo, amount) on the USDC contract, for exactly the price.
  let from: string;
  let to: string;
  let amount: unknown;
  try {
    if (Address.fromScAddress(call.contractAddress()).toString() !== requirements.asset) return refused("wrong_asset");
    if (call.functionName().toString() !== "transfer" || call.args().length !== 3) return refused("wrong_function_name");
    [from, to, amount] = call.args().map((arg) => scValToNative(arg)) as [string, string, unknown];
  } catch {
    return refused("malformed");
  }
  if (to !== requirements.payTo) return refused("wrong_recipient");
  if (typeof amount !== "bigint" || amount !== BigInt(requirements.amount)) return refused("wrong_amount");
  if (from === requirements.payTo) return refused("wrong_payer");

  // Exactly one auth entry: the payer's signature over this same transfer and nothing else.
  const auth = operation.auth ?? [];
  if (auth.length === 0) return refused("no_auth_entries");
  if (auth.length > 1) return refused("multiple_auth_entries");
  const entry = auth[0]!;
  const credentials = addressCredentials(entry.credentials());
  if (credentials === undefined) return refused("unsupported_credential_type");
  if (Address.fromScAddress(credentials.address()).toString() !== from) return refused("auth_not_by_payer");
  if (credentials.signature().switch() === xdr.ScValType.scvVoid()) return refused("missing_payer_signature");
  const root = entry.rootInvocation();
  if (root.subInvocations().length > 0) return refused("has_subinvocations");
  const authorized = root.function();
  if (authorized.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) return refused("auth_mismatch");
  if (!authorized.contractFn().toXDR().equals(call.toXDR())) return refused("auth_mismatch");

  const nonce = credentials.nonce().toString();
  return {
    payer: from,
    nonce,
    expirationLedger: credentials.signatureExpirationLedger(),
    fingerprint: await canonicalSha256({ network, payer: from, nonce }),
  };
}

export function isRefused(result: CheckedPayment | RefusedPayment): result is RefusedPayment {
  return "reason" in result;
}

/** Address credentials, in either encoding the x402 facilitator accepts. */
function addressCredentials(credentials: xdr.SorobanCredentials): xdr.SorobanAddressCredentials | undefined {
  switch (credentials.switch()) {
    case xdr.SorobanCredentialsType.sorobanCredentialsAddress():
      return credentials.address();
    case xdr.SorobanCredentialsType.sorobanCredentialsAddressV2():
      return credentials.addressV2();
    default:
      return undefined;
  }
}
