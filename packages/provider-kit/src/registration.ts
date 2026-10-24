// Stellar 8004 identity for the provider (docs/provider-standard.md §7).
//
// - registrationFile(): the ERC-8004 registration file that names the manifest [I1], built with the
//   @trionlabs/stellar8004 helpers. `provider-kit register` puts it on chain.
// - checkRegistration(): reads the registry (no key needed) and checks I1–I3: the registration names
//   this manifest, the manifest names the agent, and the agent's wallet is the manifest's payTo.
// Nothing here signs. Registering is an owner action, and the CLI hands it to the Stellar CLI keychain.

import type { ProviderManifest, StellarNetwork } from "@stellar-agent-services/protocol";
import { buildMetadataJson, IdentityClient, MAINNET_CONFIG, TESTNET_CONFIG, toDataUri, type StellarConfig } from "@trionlabs/stellar8004";

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
  options: { rpcUrl?: string; fetch?: typeof fetch } = {},
): Promise<RegistrationFinding[]> {
  const agentId = manifest.provider.agentId;
  if (agentId === undefined) {
    return [{ rule: "I2", ok: false, message: "provider.agentId is not set: run `provider-kit register`, then add the agent id to the config" }];
  }
  const network = manifest.payment.accepts[0].network;
  const config = registryConfig(network);
  const identity = new IdentityClient({
    contractId: config.contracts.identity,
    networkPassphrase: config.networkPassphrase,
    rpcUrl: options.rpcUrl ?? config.rpcUrl,
  });

  const uri = (await identity.agent_uri({ agent_id: agentId })).result;
  if (!uri.isOk()) return [{ rule: "I2", ok: false, message: `agent ${agentId} does not exist in the ${network} identity registry` }];
  const findings: RegistrationFinding[] = [{ rule: "I2", ok: true, message: `agent ${agentId} is registered on ${network}` }];

  const file = await readRegistration(uri.unwrap(), options.fetch ?? fetch);
  const services = Array.isArray(file?.["services"]) ? (file["services"] as { name?: unknown; endpoint?: unknown }[]) : [];
  const listed = services.some((service) => service.name === REGISTRATION_SERVICE_NAME && service.endpoint === manifestUrl);
  findings.push(
    file === undefined
      ? { rule: "I1", ok: false, message: "the registration file can't be read from the agent URI" }
      : listed
        ? { rule: "I1", ok: true, message: "the registration file lists this manifest" }
        : { rule: "I1", ok: false, message: `the registration file does not list { name: "${REGISTRATION_SERVICE_NAME}", endpoint: "${manifestUrl}" }` },
  );

  const wallet = (await identity.get_agent_wallet({ agent_id: agentId })).result;
  const payTo = manifest.payment.accepts[0].payTo;
  findings.push(
    wallet === payTo
      ? { rule: "I3", ok: true, message: "the agent wallet is the manifest's payTo" }
      : { rule: "I3", ok: false, message: `the agent wallet is ${wallet ?? "not set"}, but payTo is ${payTo}` },
  );
  return findings;
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
