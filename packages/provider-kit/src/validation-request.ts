// Asking a verifier for validation (docs/verification.md): the provider's owner names a verifier in the
// Stellar 8004 Validation Registry with validation_request, and the verifier answers with a verification
// receipt, validation_response. `provider-kit request-validation` is the command.
//
// prepareValidationRequest() checks everything the request depends on before anything is signed:
// - a verifier can validate the provider: it is served over HTTPS, and its registration passes [I1]–[I3],
//   as the verifier's C2 will check;
// - the signer may ask: the registry takes a request only from the agent's owner, the address approved for
//   the agent, or an operator of the owner's;
// - the validator is someone else: not the agent's owner, its wallet or the signer. The registry would let a
//   provider name itself, but such an answer would prove nothing.
// The request document is RFC 8785 canonical JSON. request_hash is its SHA-256, and request_uri a data: URI
// holding exactly those bytes, so the request lives on chain and needs no hosting. Nothing here signs: the
// CLI hands the invocation to the Stellar CLI keychain.

import {
  PROVIDER_STANDARD,
  stellarAddressKind,
  VALIDATION_REQUEST_TYPE,
  validationRequestDataUri,
  validationRequestHash,
  type ProviderManifest,
  type ValidationRequest,
} from "@stellar-agent-services/protocol";
import { checkRegistration, type RegistryReader } from "./registration.js";

/** One validation_request, checked and ready to sign. */
export interface PreparedValidationRequest {
  request: ValidationRequest;
  /** sha256 of the request's canonical bytes, 64 hex characters: the on-chain request_hash. */
  requestHash: string;
  /** A data: URI holding exactly those bytes. */
  requestUri: string;
  /** The Validation Registry contract. */
  contractId: string;
}

export class ValidationRequestError extends Error {
  override name = "ValidationRequestError";
  constructor(readonly problems: string[]) {
    super(`no validation is requested:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
}

export interface ValidationRequestOptions {
  /** The verifier's G... account: the only one that may answer. */
  validator: string;
  /** The account that will sign, when it is known. Without it, who may ask is left to the registry. */
  signer?: string;
  registry: RegistryReader;
  /** For a registration file at an https: agent URI. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Checks everything a validation_request depends on, then builds it. Throws a ValidationRequestError listing every problem. */
export async function prepareValidationRequest(
  manifest: ProviderManifest,
  manifestUrl: string,
  options: ValidationRequestOptions,
): Promise<PreparedValidationRequest> {
  const { registry, validator, signer } = options;
  const { network, payTo } = manifest.payment.accepts[0];
  const agentId = manifest.provider.agentId;
  const problems: string[] = [];
  if (!manifestUrl.startsWith("https://")) problems.push("a dev-mode provider (http://localhost) can't be validated: deploy it on HTTPS first");
  if (agentId === undefined) problems.push("provider.agentId is not set [I2]: run provider-kit register, then add the agent id to the config");
  if (stellarAddressKind(validator) !== "account") problems.push("the validator must be a G... account address");
  if (registry.network !== network) problems.push(`the provider is on ${network}, but the registry is on ${registry.network}`);
  if (problems.length > 0 || agentId === undefined) throw new ValidationRequestError(problems);

  try {
    // Without what C2 checks, the verifier's answer could never earn "8004 validated".
    const findings = await checkRegistration(manifest, manifestUrl, { registry, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    for (const finding of findings) if (!finding.ok) problems.push(`[${finding.rule}] ${finding.message}`);
    const owner = await registry.agentOwner(agentId);
    if ([owner, payTo, signer].includes(validator)) {
      problems.push("the validator is the provider itself (its owner, its wallet or the signing key): name an independent verifier's account");
    }
    if (owner !== undefined && signer !== undefined && !(await mayAsk(registry, agentId, owner, signer))) {
      problems.push(`${signer} may not ask for agent ${agentId}'s validation: only its owner ${owner}, the address approved for the agent, or an operator of the owner's may`);
    }
  } catch (error) {
    problems.push(`the Stellar 8004 registries can't be read: ${(error as Error).message}`);
  }
  if (problems.length > 0) throw new ValidationRequestError(problems);

  const request: ValidationRequest = {
    standard: PROVIDER_STANDARD,
    type: VALIDATION_REQUEST_TYPE,
    agentId,
    network,
    manifest: { url: manifestUrl },
    validator,
    requestedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  return {
    request,
    requestHash: await validationRequestHash(request),
    requestUri: validationRequestDataUri(request),
    contractId: registry.contracts.validation,
  };
}

/** The arguments of `stellar` that send the request: a contract invocation of validation_request. `caller` is the --source key's address. */
export function validationRequestArguments(prepared: PreparedValidationRequest, options: { source: string; network: string; caller: string }): string[] {
  return [
    "contract",
    "invoke",
    "--id",
    prepared.contractId,
    "--source-account",
    options.source,
    "--network",
    options.network,
    "--",
    "validation_request",
    "--caller",
    options.caller,
    "--validator_address",
    prepared.request.validator,
    "--agent_id",
    String(prepared.request.agentId),
    "--request_uri",
    prepared.requestUri,
    "--request_hash",
    prepared.requestHash,
  ];
}

/** The registry's rule for who may ask: the agent's owner, the address approved for the agent, or an operator of the owner's. */
async function mayAsk(registry: RegistryReader, agentId: number, owner: string, signer: string): Promise<boolean> {
  if (signer === owner) return true;
  if ((await registry.agentApproved(agentId)) === signer) return true;
  return registry.isOperator(owner, signer);
}
