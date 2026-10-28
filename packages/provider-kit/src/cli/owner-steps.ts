// The owner's actions as approval steps (cli/approval.ts): test XLM for a new testnet account, the USDC
// trustline [P2], the Stellar 8004 registration [I1]–[I3] and the validation request. Each one says in plain
// words what signing it does; the approval page shows that above the transaction itself.

import { USDC_ISSUER } from "@stellar-agent-services/protocol";
import { scValToNative } from "@stellar/stellar-sdk";
import type { PreparedValidationRequest } from "../validation-request.js";
import type { ApprovalStep } from "./approval.js";
import { ApprovalError, explorerUrl, networkName, registerCall, setAgentUriCall, validationRequestCall, type OwnerChain } from "./owner-chain.js";

/**
 * What `address` needs before its own step: test XLM when it is a new testnet account, and with `trustline`
 * a USDC trustline when it has none. A new account on Mainnet can't be funded from here.
 */
export async function accountSteps(chain: OwnerChain, address: string, options: { trustline: boolean }): Promise<ApprovalStep[]> {
  const state = await chain.account(address);
  const steps: ApprovalStep[] = [];
  if (!state.exists) {
    if (chain.network !== "stellar:testnet") {
      throw new ApprovalError(
        `This account isn't on ${networkName(chain.network)} yet`,
        `Send ${address} some XLM first: 2 XLM covers the account and a USDC trustline. Then connect again.`,
        "connect",
      );
    }
    steps.push({
      kind: "auto",
      id: "fund",
      title: "Get test XLM",
      run: async () => {
        await chain.fund(address);
        return "funded by Friendbot";
      },
    });
  }
  if (options.trustline && !state.usdcTrustline) steps.push(trustlineStep(chain, address));
  return steps;
}

/** A USDC trustline for `address`, so it can be paid [P2]. */
export function trustlineStep(chain: OwnerChain, address: string): ApprovalStep {
  const issuer = USDC_ISSUER[chain.network];
  return {
    kind: "sign",
    id: "trustline",
    title: "Add USDC",
    build: async () => ({
      transaction: await chain.trustline(address),
      summary: "Lets this account hold USDC, so clients can pay your service. Stellar keeps 0.5 XLM of its balance in reserve while it holds USDC.",
      details: [
        { label: "Asset", value: "USDC" },
        { label: "Issuer", value: issuer, mono: true, href: explorerUrl(chain.network, "account", issuer) },
        { label: "Operation", value: "change_trust", mono: true },
        { label: "Reserve", value: "0.5 XLM, held while the trustline exists" },
      ],
    }),
    done: () => "USDC trustline added",
  };
}

export interface RegisterStepOptions {
  /** The identity registry contract. */
  identity: string;
  /** The connected account, which signs. */
  caller: string;
  agentUri: string;
  manifestUrl: string;
  providerName: string;
  /** Set to update this agent's registration; unset to register a new agent. */
  agentId?: number;
  /** Called with the new agent's id. */
  onRegistered?(agentId: number): void;
}

/** register_with_uri for a new agent, or set_agent_uri for an existing one [I1]. */
export function registerStep(chain: OwnerChain, options: RegisterStepOptions): ApprovalStep {
  const { identity, caller, agentUri, manifestUrl, agentId } = options;
  const update = agentId !== undefined;
  const call = update ? setAgentUriCall(identity, caller, agentId, agentUri) : registerCall(identity, caller, agentUri);
  return {
    kind: "sign",
    id: "register",
    title: update ? "Update registration" : "Register",
    build: async () => ({
      transaction: await chain.invoke(caller, call),
      summary: update
        ? `Replaces agent ${agentId}'s registration file with one that names your manifest.`
        : "Creates your agent in the Stellar 8004 identity registry. This account becomes its owner and its wallet, so your service is paid here.",
      details: [
        { label: "Service", value: options.providerName },
        { label: "Manifest", value: manifestUrl, href: manifestUrl },
        update ? { label: "Agent", value: String(agentId) } : { label: "Owner and wallet", value: caller, mono: true, href: explorerUrl(chain.network, "account", caller) },
        agentUri.startsWith("data:")
          ? { label: "Registration file", value: `Stored on chain, ${(agentUri.length / 1024).toFixed(1)} KB` }
          : { label: "Registration file", value: agentUri, href: agentUri },
        { label: "Contract", value: identity, mono: true, href: explorerUrl(chain.network, "contract", identity) },
        { label: "Function", value: call.method, mono: true },
      ],
    }),
    done(sent) {
      if (update) return `agent ${agentId} updated`;
      const id: unknown = sent.returnValue === undefined ? undefined : scValToNative(sent.returnValue);
      if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("the registry returned no agent id");
      options.onRegistered?.(id);
      return `agent ${id}`;
    },
  };
}

/** validation_request from `caller`, as prepareValidationRequest() built and checked it. */
export function validationRequestStep(chain: OwnerChain, caller: string, prepared: PreparedValidationRequest): ApprovalStep {
  const { request } = prepared;
  return {
    kind: "sign",
    id: "request-validation",
    title: "Request validation",
    build: async () => ({
      transaction: await chain.invoke(caller, validationRequestCall(caller, prepared)),
      summary:
        "Asks the verifier to check your service and answer in the Stellar 8004 Validation Registry. The request document goes on chain with it, so there is nothing to host.",
      details: [
        { label: "Agent", value: String(request.agentId) },
        { label: "Verifier", value: request.validator, mono: true, href: explorerUrl(chain.network, "account", request.validator) },
        { label: "Manifest", value: request.manifest.url, href: request.manifest.url },
        { label: "Request hash", value: prepared.requestHash, mono: true },
        { label: "Contract", value: prepared.contractId, mono: true, href: explorerUrl(chain.network, "contract", prepared.contractId) },
        { label: "Function", value: "validation_request", mono: true },
      ],
    }),
    done: () => `request ${prepared.requestHash.slice(0, 12)}…`,
  };
}
