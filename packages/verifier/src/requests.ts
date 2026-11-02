// What a validation request asks `verifier watch` to check (docs/verification.md): the manifest URL to
// verify, read from the chain.
//
// The request document. The Validation Registry keeps no request_uri: only the validation_request event
// carries it, so it is read from the RPC's events, at the ledger of the request (its record's last_update,
// while it has no response). RPC nodes keep events for a limited window, 7 days by default, so an older
// request is resolved from the agent's registration alone. The document must be what request_hash commits
// to; one that is, but is not a Provider Standard v1 request for this agent, network and validator, is
// refused.
//
// The registration [I1]. The manifest URL must be the agent registration's stellar-agent-services endpoint.
// A URL the registration does not list is never verified, whatever the request names, so a request can't
// point the verifier's payments and load test at someone else's server. Only an https:// URL without user
// info is verified [M1], [M6].

import { sha256Hex, type StellarNetwork, type ValidationRequest } from "@stellar-agent-services/protocol";
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ChainReader } from "./chain.js";
import { REGISTRATION_MAX_BYTES, REGISTRATION_SERVICE } from "./checks/identity.js";
import { readBounded } from "./http.js";
import { isObject, jsonDataUri } from "./json.js";
import type { Registry } from "./registry.js";
import { schemaErrors, validateRequestSchema } from "./schemas.js";
import { USER_AGENT } from "./tool.js";

/** The largest request document read from an https: request_uri. */
const DOCUMENT_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** A validation request naming this verifier, as the registry keeps it. */
export interface RequestRecord {
  /** 64 hex characters. */
  requestHash: string;
  agentId: number;
  /** The ledger of the request: its record's last_update, while it has no response. */
  ledger: number;
}

export interface ResolveOptions {
  network: StellarNetwork;
  /** This verifier's G... account, which the request names. */
  validator: string;
  registry: Registry;
  /** Reads the validation_request event. */
  chain: Pick<ChainReader, "getEvents">;
  /** For an https: request_uri or agent URI. */
  fetch?: typeof fetch;
}

export type RequestDocument =
  | { document: ValidationRequest }
  /** It can't be read now, or no longer: the registration names the manifest instead. */
  | { unavailable: string }
  /** What request_hash commits to, but not a Provider Standard v1 request to this verifier. */
  | { invalid: string };

export type Resolution =
  /** Verify this manifest. */
  | { manifestUrl: string; from: "request" | "registration" }
  /** Not yet: the registration may still change or become readable. Retried until the deadline, then refused. */
  | { wait: string }
  /** Never: the request asks for something this verifier does not check. */
  | { refuse: string }
  /** The verifier's own problem, such as an RPC outage: retried, and never held against the request. */
  | { retry: string };

/** The manifest to verify for a request: the request document's, when the registration agrees [I1], else the registration's. */
export async function resolveRequest(request: RequestRecord, options: ResolveOptions): Promise<Resolution> {
  const read = await readRequestDocument(request, options);
  if ("invalid" in read) return { refuse: read.invalid };
  const registered = await registeredManifests(request.agentId, options);
  if (!("urls" in registered)) return registered;

  if ("document" in read) {
    const url = read.document.manifest.url;
    if (registered.urls.includes(url)) return { manifestUrl: url, from: "request" };
    return { wait: `the manifest URL the request names is not agent ${request.agentId}'s registered ${REGISTRATION_SERVICE} endpoint [I1]` };
  }
  const usable = registered.urls.filter(isManifestUrl);
  if (usable.length === 1) return { manifestUrl: usable[0]!, from: "registration" };
  if (usable.length === 0) return { wait: `agent ${request.agentId}'s registration lists no https:// ${REGISTRATION_SERVICE} endpoint [I1]` };
  return { wait: `agent ${request.agentId}'s registration lists ${usable.length} manifest URLs, and the request document, which would choose one, is unavailable: ${read.unavailable}` };
}

/** The request document, from the request's validation_request event. */
export async function readRequestDocument(request: RequestRecord, options: ResolveOptions): Promise<RequestDocument> {
  let uri: string | undefined;
  try {
    const { events } = await options.chain.getEvents({
      filters: [{ type: "contract", contractIds: [options.registry.contracts.validation], topics: [requestTopics(request, options.validator)] }],
      startLedger: request.ledger,
      endLedger: request.ledger + 1,
      limit: 10,
    });
    const event = events.find((candidate) => candidate.inSuccessfulContractCall);
    if (event === undefined) return { unavailable: `the RPC has no validation_request event for it in ledger ${request.ledger}` };
    uri = requestUri(event.value);
  } catch {
    // Most often the ledger is older than the RPC's event retention.
    return { unavailable: "its validation_request event can't be read from the RPC, which keeps events for a limited time" };
  }
  if (uri === undefined) return { unavailable: "its validation_request event carries no request_uri" };

  let bytes: Uint8Array;
  if (uri.startsWith("data:")) {
    const data = jsonDataUri(uri);
    if ("problem" in data) return { unavailable: "its request_uri is a data: URI that is not application/json, or can't be decoded" };
    bytes = data.bytes;
  } else if (uri.startsWith("https://")) {
    const fetched = await fetchBounded(uri, options.fetch ?? fetch, DOCUMENT_MAX_BYTES);
    if ("problem" in fetched) return { unavailable: `its request_uri ${fetched.problem}` };
    bytes = fetched.bytes;
  } else {
    return { unavailable: "its request_uri is neither data: nor https:" };
  }
  if ((await sha256Hex(bytes)) !== request.requestHash) return { unavailable: "what its request_uri holds does not hash to request_hash" };
  return checkDocument(bytes, request, options);
}

/** The manifest URLs an agent's registration file lists as its stellar-agent-services endpoint [I1]. */
export async function registeredManifests(agentId: number, options: ResolveOptions): Promise<{ urls: string[] } | { wait: string } | { retry: string }> {
  let uri: string | undefined;
  try {
    uri = await options.registry.agentUri(agentId);
  } catch {
    return { retry: "the identity registry can't be read" };
  }
  if (uri === undefined) return { wait: `agent ${agentId} does not exist in the ${options.network} identity registry [I2]` };

  let bytes: Uint8Array;
  if (uri.startsWith("data:")) {
    const data = jsonDataUri(uri);
    if ("problem" in data) return { wait: "the agent URI is a data: URI that is not application/json, or can't be decoded [I1]" };
    bytes = data.bytes;
  } else if (uri.startsWith("https://")) {
    const fetched = await fetchBounded(uri, options.fetch ?? fetch, REGISTRATION_MAX_BYTES);
    if ("problem" in fetched) return { wait: `the registration file at the agent URI ${fetched.problem} [I1]` };
    bytes = fetched.bytes;
  } else if (uri.startsWith("ipfs://")) {
    return { wait: "the registration file is on IPFS, which this verifier does not read yet: register a data: or https: agent URI [I1]" };
  } else {
    return { wait: "the agent URI is neither data: nor https:, so the registration file's origin can't be trusted [I1]" };
  }

  let file: unknown;
  try {
    file = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    file = undefined;
  }
  if (!isObject(file)) return { wait: "the registration file is not a JSON object [I1]" };
  const services = Array.isArray(file["services"]) ? file["services"].filter(isObject) : [];
  const urls = services.filter((service) => service["name"] === REGISTRATION_SERVICE && typeof service["endpoint"] === "string").map((service) => service["endpoint"] as string);
  return { urls: [...new Set(urls)] };
}

/** An https:// URL without user info: the only kind of manifest URL the verifier checks [M1], [M6]. */
export function isManifestUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

/** The topics of the request's validation_request event: the event name, the validator, the agent and the request hash. */
function requestTopics(request: RequestRecord, validator: string): string[] {
  return [
    xdr.ScVal.scvSymbol("validation_request").toXDR("base64"),
    Address.fromString(validator).toScVal().toXDR("base64"),
    nativeToScVal(request.agentId, { type: "u32" }).toXDR("base64"),
    xdr.ScVal.scvBytes(Buffer.from(request.requestHash, "hex")).toXDR("base64"),
  ];
}

/** The event's data is a map holding request_uri; a bare string is accepted too. */
function requestUri(value: xdr.ScVal): string | undefined {
  let data: unknown;
  try {
    data = scValToNative(value);
  } catch {
    return undefined;
  }
  if (typeof data === "string") return data;
  return isObject(data) && typeof data["request_uri"] === "string" ? data["request_uri"] : undefined;
}

/** The document, which hashed right: it must be a Provider Standard v1 request for this agent, network and validator. */
function checkDocument(bytes: Uint8Array, request: RequestRecord, options: ResolveOptions): RequestDocument {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { invalid: "the request document is not JSON" };
  }
  if (!validateRequestSchema(document)) {
    const [first] = schemaErrors(validateRequestSchema.errors);
    return { invalid: `the request document is not a Provider Standard v1 validation request: ${first?.pointer || "/"} ${first?.message ?? "does not match the schema"}` };
  }
  const valid = document as ValidationRequest;
  if (valid.agentId !== request.agentId) return { invalid: `the request document is for agent ${valid.agentId}, but the request is for agent ${request.agentId}` };
  if (valid.network !== options.network) return { invalid: `the request document is for ${valid.network}, but the request is on ${options.network}` };
  if (valid.validator !== options.validator) return { invalid: `the request document names validator ${valid.validator}, not this verifier` };
  if (!isManifestUrl(valid.manifest.url)) return { invalid: "the manifest URL the request names has user info [M6]" };
  return { document: valid };
}

/** GET with no redirect, a deadline and a size limit: the bytes of a 200, or what went wrong. */
async function fetchBounded(url: string, fetchFn: typeof fetch, maxBytes: number): Promise<{ bytes: Uint8Array } | { problem: string }> {
  try {
    const response = await fetchFn(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { problem: `answered ${response.status}` };
    }
    const bytes = await readBounded(response.body, maxBytes);
    return bytes === undefined ? { problem: `is larger than ${maxBytes} bytes` } : { bytes };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return { problem: `could not be reached${cause}` };
  }
}
