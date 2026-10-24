// x402 resource server side: the 402 challenge and reading the paid request.
//
// The challenge is built from the manifest [P4]: exactly one `accepts` entry equal to the manifest's
// payment option plus `amount` = the service price, and resource.url is the create-job URL [P5]. It
// carries x402's Bazaar discovery extension, built from the service's schemas and first example [P6],
// unless that would make the PAYMENT-REQUIRED header too large for common HTTP clients.

import { createJobUrl, type JsonObject, type ProviderManifest } from "@stellar-agent-services/protocol";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { Service } from "../define-service.js";

/** Many HTTP stacks cap all headers together at 8–16 KiB, so the extension is left out above this. */
const MAX_CHALLENGE_HEADER_BYTES = 8 * 1024;

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
  const discoverable: PaymentRequired = { ...challenge, extensions: { bazaar: bazaar(service) } };
  return encodePaymentRequiredHeader(discoverable).length <= MAX_CHALLENGE_HEADER_BYTES ? discoverable : challenge;
}

/**
 * The Bazaar discovery extension (x402 `extensions.bazaar`, HTTP body form): an example request and
 * response, and a schema whose `body` is the service's inputSchema.
 */
function bazaar(service: Service): JsonObject {
  const example = service.examples?.[0];
  const info: JsonObject = { input: { type: "http", method: "POST", bodyType: "json", body: example?.input ?? {} } };
  const properties: JsonObject = {
    input: {
      type: "object",
      properties: {
        type: { type: "string", const: "http" },
        method: { type: "string", enum: ["POST"] },
        bodyType: { type: "string", enum: ["json"] },
        body: service.inputSchema,
      },
      required: ["type", "method", "bodyType", "body"],
      additionalProperties: false,
    },
  };
  if (example !== undefined) {
    info["output"] = { type: "json", example: example.output };
    properties["output"] = {
      type: "object",
      properties: { type: { type: "string" }, example: service.outputSchema },
      required: ["type"],
    };
  }
  return {
    info,
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, required: ["input"] },
  };
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
