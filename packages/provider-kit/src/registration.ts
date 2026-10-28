// Stellar 8004 identity for the provider (docs/provider-standard.md §7).
//
// - registrationFile(): the ERC-8004 registration file that names the manifest [I1], built with the
//   @trionlabs/stellar8004 helpers. `provider-kit register` puts it on chain.
// - checkRegistration(): reads the registry (no key needed) and checks I1–I3: the registration names
//   this manifest, the manifest names the agent, and the agent's wallet is the manifest's payTo.
//   inspectRegistration() also returns the registration file it read, which is what search shows.
// - rpcRegistry(): the identity and validation registry reads, which tests replace with a fake.
// - mayActFor(): who may change an agent's registration or ask for its validation.
// Nothing here signs. Registering is an owner action: the CLI has the owner's wallet sign it on a local
// approval page, or hands it to the Stellar CLI keychain (--source).

import type { ProviderManifest, StellarNetwork } from "@stellar-agent-services/protocol";
import { buildMetadataJson, IdentityClient, MAINNET_CONFIG, TESTNET_CONFIG, toDataUri, ValidationClient, type StellarConfig } from "@trionlabs/stellar8004";

/** The registration's service entry that points to the manifest [I1]. */
export const REGISTRATION_SERVICE_NAME = "stellar-agent-services";

export interface RegistrationOptions {
  /** An image URL for explorers. */
  image?: string;
  /** ERC-8004 trust models, such as "reputation". */
  supportedTrust?: string[];
}

/** The 8004 registration file for a provider whose manifest is served at `manifestUrl` [I1]. */
export function registrationFile(manifest: ProviderManifest, manifestUrl: string, options: RegistrationOptions = {}): Record<string, unknown> {
  return buildMetadataJson({
    name: manifest.provider.name,
    description: manifest.provider.description ?? "",
    imageUrl: options.image ?? "",
    services: [
      { name: REGISTRATION_SERVICE_NAME, endpoint: manifestUrl, version: "1" },
      { name: "web", endpoint: manifest.baseUrl },
    ],
    supportedTrust: options.supportedTrust ?? [],
    x402Enabled: true,
  });
}

/** The file as a data: URI, which the registry stores on chain. Throws above 8 KiB: host the file and register its URL instead. */
export function registrationDataUri(file: Record<string, unknown>): string {
  return toDataUri(file);
}

/** The 8004 contracts and RPC for a network. */
export function registryConfig(network: StellarNetwork): StellarConfig {
  return network === "stellar:pubnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
}

/** A validation request as the Validation Registry keeps it. `response` and `responseHash` are set once answered. */
export interface ValidationRecord {
  validator: string;
  agentId: number;
  hasResponse: boolean;
  /** 0–100, higher is better. */
  response: number;
  /** Lowercase hex. */
  responseHash: string;
  tag: string;
  /** The ledger of the last change. */
  lastUpdate: number;
}

/** The registry reads the kit makes, each a simulation: no key, no transaction. rpcRegistry() is the real one; tests pass a fake. */
export interface RegistryReader {
  readonly network: StellarNetwork;
  /** The contract ids, for the invocations the CLI hands to the Stellar CLI. */
  readonly contracts: { identity: string; validation: string };
  /** The agent's registration URI, or undefined when the agent doesn't exist. */
  agentUri(agentId: number): Promise<string | undefined>;
  /** The agent's wallet, or undefined when none is set. */
  agentWallet(agentId: number): Promise<string | undefined>;
  /** The agent's owner, or undefined when the agent doesn't exist. */
  agentOwner(agentId: number): Promise<string | undefined>;
  /** The one address the owner approved for the agent, if any. */
  agentApproved(agentId: number): Promise<string | undefined>;
  /** Whether the owner made `operator` an operator of all its agents. */
  isOperator(owner: string, operator: string): Promise<boolean>;
  /** The validation request with this hash (64 hex characters), or undefined when there is none. */
  validation(requestHash: string): Promise<ValidationRecord | undefined>;
}

export function rpcRegistry(network: StellarNetwork, rpcUrl?: string): RegistryReader {
  const config = registryConfig(network);
  const options = { networkPassphrase: config.networkPassphrase, rpcUrl: rpcUrl ?? config.rpcUrl };
  const identity = new IdentityClient({ ...options, contractId: config.contracts.identity });
  const validation = new ValidationClient({ ...options, contractId: config.contracts.validation });

  return {
    network,
    contracts: { identity: config.contracts.identity, validation: config.contracts.validation },
    async agentUri(agentId) {
      const result = (await identity.agent_uri({ agent_id: agentId })).result;
      return result.isOk() ? result.unwrap() : undefined;
    },
    async agentWallet(agentId) {
      return (await identity.get_agent_wallet({ agent_id: agentId })).result ?? undefined;
    },
    async agentOwner(agentId) {
      return (await identity.find_owner({ agent_id: agentId })).result ?? undefined;
    },
    async agentApproved(agentId) {
      return (await identity.get_approved({ token_id: agentId })).result ?? undefined;
    },
    async isOperator(owner, operator) {
      return (await identity.is_approved_for_all({ owner, operator })).result;
    },
    async validation(requestHash) {
      const result = (await validation.get_validation_status({ request_hash: Buffer.from(requestHash, "hex") })).result;
      if (!result.isOk()) return undefined;
      const status = result.unwrap();
      return {
        validator: status.validator_address,
        agentId: status.agent_id,
        hasResponse: status.has_response,
        response: status.response,
        responseHash: Buffer.from(status.response_hash).toString("hex"),
        tag: status.tag,
        lastUpdate: Number(status.last_update),
      };
    },
  };
}

/**
 * The registries' rule for who may act for an agent, by changing its registration (set_agent_uri) or asking
 * for its validation (validation_request): its owner, the address approved for it, or an operator of the owner's.
 */
export async function mayActFor(registry: RegistryReader, agentId: number, owner: string, address: string): Promise<boolean> {
  if (address === owner) return true;
  if ((await registry.agentApproved(agentId)) === address) return true;
  return registry.isOperator(owner, address);
}

export interface RegistrationFinding {
  rule: "I1" | "I2" | "I3";
  ok: boolean;
  message: string;
}

/**
 * Checks the provider's 8004 registration against its manifest (I1–I3), reading the identity registry
 * over RPC. Without provider.agentId there is nothing on chain to check, which is an I2 finding.
 */
export async function checkRegistration(
  manifest: ProviderManifest,
  manifestUrl: string,
  options: { rpcUrl?: string; fetch?: typeof fetch; registry?: RegistryReader } = {},
): Promise<RegistrationFinding[]> {
  return (await inspectRegistration(manifest, manifestUrl, options)).findings;
}

/** checkRegistration(), and the registration file it read: undefined when there is none, or it can't be read. */
export async function inspectRegistration(
  manifest: ProviderManifest,
  manifestUrl: string,
  options: { rpcUrl?: string; fetch?: typeof fetch; registry?: RegistryReader } = {},
): Promise<{ findings: RegistrationFinding[]; file?: Record<string, unknown> }> {
  const agentId = manifest.provider.agentId;
  if (agentId === undefined) {
    return { findings: [{ rule: "I2", ok: false, message: "provider.agentId is not set: run `provider-kit register`, then add the agent id to the config" }] };
  }
  const network = manifest.payment.accepts[0].network;
  const registry = options.registry ?? rpcRegistry(network, options.rpcUrl);

  const uri = await registry.agentUri(agentId);
  if (uri === undefined) return { findings: [{ rule: "I2", ok: false, message: `agent ${agentId} does not exist in the ${network} identity registry` }] };
  const findings: RegistrationFinding[] = [{ rule: "I2", ok: true, message: `agent ${agentId} is registered on ${network}` }];

  const file = await readRegistration(uri, options.fetch ?? fetch);
  const services = Array.isArray(file?.["services"]) ? (file["services"] as { name?: unknown; endpoint?: unknown }[]) : [];
  const listed = services.some((service) => service.name === REGISTRATION_SERVICE_NAME && service.endpoint === manifestUrl);
  findings.push(
    file === undefined
      ? { rule: "I1", ok: false, message: "the registration file can't be read from the agent URI" }
      : listed
        ? { rule: "I1", ok: true, message: "the registration file lists this manifest" }
        : { rule: "I1", ok: false, message: `the registration file does not list { name: "${REGISTRATION_SERVICE_NAME}", endpoint: "${manifestUrl}" }` },
  );

  const wallet = await registry.agentWallet(agentId);
  const payTo = manifest.payment.accepts[0].payTo;
  findings.push(
    wallet === payTo
      ? { rule: "I3", ok: true, message: "the agent wallet is the manifest's payTo" }
      : { rule: "I3", ok: false, message: `the agent wallet is ${wallet ?? "not set"}, but payTo is ${payTo}` },
  );
  return file === undefined ? { findings } : { findings, file };
}

/** A registration file from a data: or https: agent URI. Undefined if it can't be read. */
async function readRegistration(uri: string, fetcher: typeof fetch): Promise<Record<string, unknown> | undefined> {
  try {
    let text: string;
    const data = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
    if (data !== null) {
      text = data[1] === undefined ? decodeURIComponent(data[2]!) : Buffer.from(data[2]!, "base64").toString("utf8");
    } else if (uri.startsWith("https://")) {
      const response = await fetcher(uri, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return undefined;
      text = await response.text();
    } else {
      return undefined;
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
