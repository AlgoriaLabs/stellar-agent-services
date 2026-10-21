// Classifies the settlement outcome. This is the core of "never charge twice, never lose a payment".
//
// - "settled": success with a transaction hash.
// - "failed": ONLY when the facilitator answered success: false with no transaction hash. The PoC
//   trusts every such answer.
// - "uncertain": everything else (timeouts, 5xx, thrown errors). The job becomes payment_uncertain
//   and is resolved from on-chain data, never by charging again [J13].
//
// TODO:
// - Narrow "failed" to an allowlist of definitely-not-submitted error reasons.
// - Check that the payer and amount in the response match the challenge.

import type { PaymentReceipt, StellarNetwork } from "@stellar-agent-services/protocol";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

/** The two facilitator calls the provider makes. HTTPFacilitatorClient from @x402/core fits it. */
export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export type Settlement =
  | { outcome: "settled"; receipt: PaymentReceipt; response: SettleResponse }
  | { outcome: "failed"; reason: string }
  | { outcome: "uncertain"; reason: string };

export async function settle(facilitator: Facilitator, payload: PaymentPayload, requirements: PaymentRequirements): Promise<Settlement> {
  let response: SettleResponse;
  try {
    response = await facilitator.settle(payload, requirements);
  } catch (error) {
    return { outcome: "uncertain", reason: error instanceof Error ? error.message : String(error) };
  }
  if (response.success && response.transaction) {
    const receipt: PaymentReceipt = {
      network: requirements.network as StellarNetwork,
      asset: requirements.asset,
      amount: requirements.amount,
      payTo: requirements.payTo,
      payer: response.payer ?? "",
      transaction: response.transaction,
      settledAt: new Date().toISOString(),
    };
    return { outcome: "settled", receipt, response };
  }
  if (!response.success && !response.transaction) return { outcome: "failed", reason: response.errorReason ?? "settlement failed" };
  return { outcome: "uncertain", reason: response.errorReason ?? "unexpected settlement response" };
}
