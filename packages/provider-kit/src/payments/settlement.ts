// Classifies the settlement outcome. This is the core of "never charge twice, never lose a payment".
//
// - "settled": success with a transaction hash, for the payer and network the provider checked.
// - "failed": ONLY when the facilitator answered success: false, with no transaction hash, for a
//   reason that means the transaction was never submitted (NOT_SUBMITTED). The user is not charged.
// - "uncertain": everything else: timeouts, 5xx, thrown errors, unknown reasons, a transaction hash
//   without success, or a success that names another payer or network. The job becomes
//   payment_uncertain and is decided from on-chain data, never by charging again [J13].

import type { PaymentReceipt, StellarNetwork } from "@stellar-agent-services/protocol";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { Facilitator } from "./facilitator.js";

export type Settlement =
  | { outcome: "settled"; receipt: PaymentReceipt; response: SettleResponse }
  | { outcome: "failed"; reason: string }
  /** `transaction`: a hash the facilitator named, which reconciliation checks first. */
  | { outcome: "uncertain"; reason: string; transaction?: string };

/**
 * Reasons the @x402/stellar facilitator gives before it submits anything: its settle() verifies the
 * payment again first, and these are its verify and pre-submission failures. Any reason starting with
 * "invalid_" is a verify failure too. A reason not listed here is treated as uncertain, so a
 * facilitator with other wording never makes the kit drop a payment that may have landed.
 */
const NOT_SUBMITTED: ReadonlySet<string> = new Set([
  "unsupported_scheme",
  "network_mismatch",
  "verification_failed",
  "unexpected_verify_error",
  "settle_exact_stellar_signer_selection_failed",
  "settle_exact_stellar_transaction_signing_failed",
  "settle_exact_stellar_fee_bump_signing_failed",
  // sendTransaction did not accept it (ERROR, TRY_AGAIN_LATER): it never reached a ledger.
  "settle_exact_stellar_transaction_submission_failed",
]);

/** Whether a settle error reason means the transaction was never submitted. */
export function neverSubmitted(reason: string): boolean {
  return reason.startsWith("invalid_") || NOT_SUBMITTED.has(reason);
}

const TRANSACTION_HASH = /^[0-9a-f]{64}$/;

/** Settles once. `payer` is the address the provider's own payment checks found. */
export async function settle(
  facilitator: Facilitator,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  payer: string,
): Promise<Settlement> {
  let response: SettleResponse;
  try {
    response = await facilitator.settle(payload, requirements);
  } catch (error) {
    return { outcome: "uncertain", reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }

  const transaction = typeof response.transaction === "string" ? response.transaction.toLowerCase() : "";
  const uncertain = (reason: string): Settlement =>
    TRANSACTION_HASH.test(transaction) ? { outcome: "uncertain", reason, transaction } : { outcome: "uncertain", reason };

  if (response.success === true) {
    if (!TRANSACTION_HASH.test(transaction)) return uncertain("settled without a transaction hash");
    if (response.payer !== undefined && response.payer !== payer) return uncertain("the facilitator named another payer");
    if (response.network !== requirements.network) return uncertain("the facilitator named another network");
    const receipt: PaymentReceipt = {
      network: requirements.network as StellarNetwork,
      asset: requirements.asset,
      amount: requirements.amount,
      payTo: requirements.payTo,
      payer,
      transaction,
      settledAt: new Date().toISOString(),
    };
    return { outcome: "settled", receipt, response };
  }

  const reason = response.errorReason ?? "settlement failed";
  if (transaction === "" && neverSubmitted(reason)) return { outcome: "failed", reason };
  return uncertain(reason);
}
