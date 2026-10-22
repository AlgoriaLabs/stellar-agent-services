// The built-in payment method, and the only one Provider Standard v1 allows: x402 `exact` on Stellar.
// The signer authorizes one SAC `transfer(payer, payTo, amount)`, the provider's facilitator submits
// it, and the `transfer` event proves it (onchain.ts).

import { STELLAR_NETWORKS, type StellarNetwork } from "@stellar-agent-services/protocol";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { rpcConfirmPayment, type TransactionReader } from "./onchain.js";
import type { PaymentMethod } from "./strategies.js";

export const X402_EXACT_STELLAR = "x402-exact-stellar";

export interface X402ExactStellarOptions {
  /** Soroban RPC for signing and confirmation. Defaults to the public testnet RPC. */
  rpcUrl?: string;
  /** Reads transactions for confirmation. Defaults to an rpc.Server; tests pass a fake chain. */
  server?: TransactionReader;
}

export function x402ExactStellar(options: X402ExactStellarOptions = {}): PaymentMethod {
  const rpcConfig = options.rpcUrl === undefined ? undefined : { url: options.rpcUrl };
  return {
    id: X402_EXACT_STELLAR,
    matches: (requirements) => requirements.scheme === "exact" && STELLAR_NETWORKS.includes(requirements.network as StellarNetwork),
    createPayload: (requirements, signer) => new ExactStellarScheme(signer, rpcConfig).createPaymentPayload(2, requirements),
    confirm: rpcConfirmPayment(options),
  };
}
