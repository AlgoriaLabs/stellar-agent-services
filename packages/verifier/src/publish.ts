// Publishing a receipt to the Stellar 8004 Validation Registry (docs/verification.md):
//
//   validation_response(caller = validator, request_hash, response = score, response_uri = receipt URL,
//                       response_hash = sha256(receipt), tag = "provider-standard-v1")
//
// The provider's owner first asks for it with validation_request, naming this verifier. Before anything
// is signed, checkPublication() makes sure the response would be right:
// - the receipt is valid and recent, and it was issued by this validator for the agent the request names;
// - the request exists on chain, and names this validator and this agent;
// - response_uri is HTTPS and serves exactly the receipt's bytes, so anyone can match it with the chain.
// The validator key signs through the Stellar CLI keychain (cli/publish.ts); this process never holds it.
// Only the validator a request names may respond, and it may update its response later.

import { sha256Hex, stellarAddressKind, VALIDATION_TAG, type StellarNetwork, type VerificationReceipt } from "@stellar-agent-services/protocol";
import { readBounded } from "./http.js";
import { receiptHash, receiptProblems } from "./receipt.js";
import type { Registry, ValidationRecord } from "./registry.js";
import { USER_AGENT } from "./tool.js";

/** Receipts older than this are not published by default: a validation request gets a fresh check. */
export const DEFAULT_MAX_AGE_SECONDS = 24 * 3600;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const RESPONSE_URI_MAX_BYTES = 1024 * 1024;

/** One validation_response, ready to sign. */
export interface Publication {
  network: StellarNetwork;
  /** The Validation Registry contract. */
  contractId: string;
  validator: string;
  agentId: number;
  requestHash: string;
  /** The receipt's score, 0–100. */
  response: number;
  responseUri: string;
  responseHash: string;
  tag: string;
  /** The request already has a response from this validator, which this one replaces. */
  updates: boolean;
}

export class PublicationError extends Error {
  override name = "PublicationError";
  constructor(readonly problems: string[]) {
    super(`the receipt can't be published:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
}

export interface PublicationOptions {
  /** The validation request's hash, 64 hex characters. */
  requestHash: string;
  /** Where the receipt is published: an HTTPS URL serving exactly its bytes. */
  responseUri: string;
  registry: Registry;
  fetch?: typeof fetch;
  /** Default DEFAULT_MAX_AGE_SECONDS. */
  maxAgeSeconds?: number;
  now?: () => number;
}

/** Checks everything a validation_response depends on. Throws a PublicationError listing every problem. */
export async function checkPublication(receipt: VerificationReceipt, options: PublicationOptions): Promise<Publication> {
  const problems: string[] = [];
  const requestHash = options.requestHash.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(requestHash)) problems.push("the request hash must be 64 hex characters");
  problems.push(...receiptProblems(receipt).map((problem) => `the receipt is not valid: ${problem}`));
  if (problems.length > 0) throw new PublicationError(problems);

  const now = (options.now ?? Date.now)();
  const age = now - Date.parse(receipt.checkedAt);
  const maxAge = (options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS) * 1000;
  if (age > maxAge) problems.push(`the receipt was checked ${Math.round(age / 3600_000)} h ago; verify the provider again, or allow an older receipt`);
  if (age < -CLOCK_SKEW_MS) problems.push("the receipt was checked in the future; check this machine's clock");
  if (receipt.agentId === undefined) problems.push("the receipt names no agent, so it answers no validation request");
  if (receipt.network !== options.registry.network) problems.push(`the receipt is for ${receipt.network}, but the registry is on ${options.registry.network}`);
  if (stellarAddressKind(receipt.validator) !== "account") problems.push("the receipt's validator is not a G... account");

  const responseHash = await receiptHash(receipt);
  problems.push(...(await checkResponseUri(options.responseUri, responseHash, options.fetch ?? fetch)));

  let record: ValidationRecord | undefined;
  try {
    record = await options.registry.validation(requestHash);
  } catch (error) {
    problems.push(`the Validation Registry could not be read: ${(error as Error).message}`);
  }
  if (record === undefined && !problems.some((problem) => problem.startsWith("the Validation Registry"))) {
    problems.push(`there is no validation request ${requestHash} on ${options.registry.network}`);
  }
  if (record !== undefined) {
    if (record.validator !== receipt.validator) problems.push(`the request names validator ${record.validator}, not the receipt's ${receipt.validator}`);
    if (receipt.agentId !== undefined && record.agentId !== receipt.agentId) problems.push(`the request is for agent ${record.agentId}, but the receipt is for agent ${receipt.agentId}`);
  }
  if (problems.length > 0) throw new PublicationError(problems);

  return {
    network: receipt.network,
    contractId: options.registry.contracts.validation,
    validator: receipt.validator,
    agentId: receipt.agentId!,
    requestHash,
    response: receipt.score,
    responseUri: options.responseUri,
    responseHash,
    tag: VALIDATION_TAG,
    updates: record!.hasResponse,
  };
}

/**
 * Why a Validation Registry record does not anchor this receipt: empty when it does, by the receipt's
 * validator, for its agent, with its hash, score and tag. The "8004 validated" badge needs it empty.
 */
export function anchorProblems(record: ValidationRecord | undefined, receipt: VerificationReceipt, sha256: string): string[] {
  if (record === undefined) return ["there is no validation request with that hash"];
  const problems: string[] = [];
  if (!record.hasResponse) problems.push("the request has no response yet");
  if (record.responseHash !== sha256) problems.push("the response anchors another receipt");
  if (record.validator !== receipt.validator) problems.push(`the response is from ${record.validator}, not the receipt's validator`);
  if (record.agentId !== receipt.agentId) problems.push(`the request is for agent ${record.agentId}, not the receipt's`);
  if (record.tag !== VALIDATION_TAG) problems.push(`the response's tag is not "${VALIDATION_TAG}"`);
  if (record.hasResponse && record.response !== receipt.score) problems.push(`the response is ${record.response}, not the receipt's score of ${receipt.score}`);
  return problems;
}

/** The arguments of `stellar` that publish: a contract invocation of validation_response. */
export function invokeArguments(publication: Publication, options: { source: string; network: string }): string[] {
  return [
    "contract",
    "invoke",
    "--id",
    publication.contractId,
    "--source-account",
    options.source,
    "--network",
    options.network,
    "--",
    "validation_response",
    "--caller",
    publication.validator,
    "--request_hash",
    publication.requestHash,
    "--response",
    String(publication.response),
    "--response_uri",
    publication.responseUri,
    "--response_hash",
    publication.responseHash,
    "--tag",
    publication.tag,
  ];
}

/** response_uri is HTTPS and serves exactly the receipt's bytes. */
async function checkResponseUri(uri: string, sha256: string, fetchFn: typeof fetch): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return ["the response URI is not a URL"];
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return ["the response URI must be an https:// URL without user info"];
  try {
    const response = await fetchFn(uri, { redirect: "error", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) return [`the response URI answered ${response.status}: publish the receipt there first`];
    const bytes = await readBounded(response.body, RESPONSE_URI_MAX_BYTES);
    if (bytes === undefined) return ["the response URI serves more than a receipt"];
    if ((await sha256Hex(bytes)) !== sha256) return ["the response URI serves other bytes than the receipt: upload the receipt file exactly as written"];
  } catch (error) {
    return [`the response URI could not be fetched: ${(error as Error).message}`];
  }
  return [];
}
