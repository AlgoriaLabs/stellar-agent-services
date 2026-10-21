// x402 resource server side: the 402 challenge and reading the paid request.
//
// The challenge is built from the manifest [P4]: exactly one `accepts` entry equal to the manifest's
// payment option plus `amount` = the service price, and resource.url is the create-job URL [P5].
//
// TODO:
// - Add x402's Bazaar discovery extension from the service's schemas and first example [P6].
// - Local payload checks before the facilitator (payments/payload-checks.ts).

import { canonicalSha256, createJobUrl, type ProviderManifest } from "@stellar-agent-services/protocol";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { Service } from "../define-service.js";

export function paymentRequirements(manifest: ProviderManifest, service: Service): PaymentRequirements {
  const { scheme, network, asset, payTo, maxTimeoutSeconds, extra } = manifest.payment.accepts[0];
  return { scheme, network, asset, amount: service.amount, payTo, maxTimeoutSeconds, extra };
}

export function paymentRequired(manifest: ProviderManifest, service: Service, error?: string): PaymentRequired {
  const challenge: PaymentRequired = {
    x402Version: 2,
    resource: { url: createJobUrl(manifest.baseUrl, service.name), description: service.description, mimeType: "application/json" },
    accepts: [paymentRequirements(manifest, service)],
  };
  if (error !== undefined) challenge.error = error;
  return challenge;
}

/** Decodes PAYMENT-SIGNATURE. Returns undefined for a header that isn't a v2 payload for these requirements. */
export function readPayment(header: string, requirements: PaymentRequirements): PaymentPayload | undefined {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return undefined;
  }
  const accepted = payload.accepted as Partial<PaymentRequirements> | undefined;
  const fields = ["scheme", "network", "asset", "amount", "payTo"] as const;
  if (payload.x402Version !== 2 || accepted === undefined) return undefined;
  return fields.every((field) => accepted[field] === requirements[field]) ? payload : undefined;
}

/**
 * One signed payment pays for at most one job [P9]. PoC: the hash of the signed payload.
 * TODO: (network, payer, signed auth entry), so re-wrapping the same auth entry is caught too.
 */
export function paymentFingerprint(payload: PaymentPayload): Promise<string> {
  return canonicalSha256({ network: payload.accepted.network, payload: payload.payload });
}
