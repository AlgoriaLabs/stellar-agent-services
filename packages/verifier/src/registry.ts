// Reads from the Stellar 8004 registries, through @trionlabs/stellar8004. Every read is a simulation:
// no key, no transaction.
//
// - Identity: the agent's registration URI and wallet, for the identity check (C2) [I1]–[I3].
// - Validation: a validation request's record, before publishing a response to it and before
//   rendering the "8004 validated" badge.

import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { IdentityClient, MAINNET_CONFIG, TESTNET_CONFIG, ValidationClient, type StellarConfig } from "@trionlabs/stellar8004";

/** A validation request as the registry keeps it. `response` and `responseHash` are set once answered. */
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

/** The registry reads the verifier makes. rpcRegistry() is the real one; tests pass a fake. */
export interface Registry {
  readonly network: StellarNetwork;
  /** The contract ids, for evidence and for the validation_response command. */
  readonly contracts: { identity: string; validation: string };
  /** The agent's registration URI, or undefined when the agent doesn't exist. */
  agentUri(agentId: number): Promise<string | undefined>;
  /** The agent's wallet, or undefined when none is set. */
  agentWallet(agentId: number): Promise<string | undefined>;
  /** The validation request with this hash (64 hex characters), or undefined when there is none. */
  validation(requestHash: string): Promise<ValidationRecord | undefined>;
}

/** The 8004 deployment of a network: contract ids, passphrase and the SDK's default RPC. */
export function registryConfig(network: StellarNetwork): StellarConfig {
  return network === "stellar:pubnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
}

export function rpcRegistry(network: StellarNetwork, rpcUrl?: string): Registry {
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
