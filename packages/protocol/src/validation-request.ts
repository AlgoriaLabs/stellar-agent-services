// The validation request (docs/verification.md): what a provider's owner asks a verifier to check, in a
// Stellar 8004 validation_request.
//
// The request commits to its document. request_hash is the SHA-256 of the document's RFC 8785 canonical
// JSON (the contentHash mode of the 8004 SDK's generateRequestNonce), and request_uri is a data: URI holding
// exactly those bytes, so anyone can decode it, hash it and compare it with the chain, as with a receipt and
// its response_hash. schemas/validation-request.schema.json describes the document, and
// test-vectors/validation-requests.json pins the hash and the URI.

import { canonicalJson, sha256Hex } from "./canonical-json.js";
import type { StellarNetwork } from "./networks.js";
import type { PROVIDER_STANDARD } from "./standard.js";

/** The `type` of a validation request document. */
export const VALIDATION_REQUEST_TYPE = "validation-request";

/**
 * What a provider's owner asks a verifier to check. `standard`, `agentId`, `network`, `validator` and
 * `manifest.url` are also in the verification receipt that answers it.
 */
export interface ValidationRequest {
  standard: typeof PROVIDER_STANDARD;
  type: typeof VALIDATION_REQUEST_TYPE;
  /** The provider's Stellar 8004 agent id. */
  agentId: number;
  network: StellarNetwork;
  /** The manifest to check, at the HTTPS URL the agent's registration names [I1]. */
  manifest: { url: string };
  /** The verifier's G... address: the only account that may answer. */
  validator: string;
  /** RFC 3339. It makes each request unique: the registry refuses a request_hash it already has. */
  requestedAt: string;
}

/** `$id` of schemas/validation-request.schema.json. */
export const VALIDATION_REQUEST_SCHEMA_ID =
  "https://algorialabs.github.io/stellar-agent-services/schemas/provider/1/validation-request.schema.json";

/** The request's bytes: UTF-8 canonical JSON. */
export function validationRequestBytes(request: ValidationRequest): Uint8Array {
  return new TextEncoder().encode(canonicalJson(request));
}

/** sha256 of the request's bytes: the on-chain request_hash. */
export function validationRequestHash(request: ValidationRequest): Promise<string> {
  return sha256Hex(validationRequestBytes(request));
}

/** The request_uri that holds the request itself: its bytes in a base64 data: URI, so nothing needs hosting. */
export function validationRequestDataUri(request: ValidationRequest): string {
  let binary = "";
  for (const byte of validationRequestBytes(request)) binary += String.fromCharCode(byte);
  return `data:application/json;base64,${btoa(binary)}`;
}
