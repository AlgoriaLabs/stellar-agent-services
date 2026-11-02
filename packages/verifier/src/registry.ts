// Reads from the Stellar 8004 registries, through @trionlabs/stellar8004. Every read is a simulation:
// no key, no transaction.
//
// - Identity: the agent's registration URI and wallet, for the identity check (C2) [I1]–[I3].
// - Validation: a validation request's record, before publishing a response to it and before
//   rendering the "8004 validated" badge; and, for `verifier watch`, the requests that name a validator.

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

/** The Validation Registry's list of the requests that name one validator, which `verifier watch` follows. */
export interface ValidatorIndex {
  /**
   * The hashes (64 hex characters) of the requests naming `validator`, in the order they were made, from
   * position `start` (0 is the first one), at most `limit`. The list only grows.
   */
  validatorRequests(validator: string, start: number, limit: number): Promise<string[]>;
}

/** The 8004 deployment of a network: contract ids, passphrase and the SDK's default RPC. */
export function registryConfig(network: StellarNetwork): StellarConfig {
  return network === "stellar:pubnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
}

export function rpcRegistry(network: StellarNetwork, rpcUrl?: string): Registry & ValidatorIndex {
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
    async validatorRequests(validator, start, limit) {
      const hashes = (await validation.get_validator_requests_paginated({ validator_address: validator, start, limit })).result;
      return hashes.map((hash) => Buffer.from(hash).toString("hex"));
    },
  };
}
