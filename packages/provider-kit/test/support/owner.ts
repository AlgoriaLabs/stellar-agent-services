// Shared setup for the owner commands (trustline, register, request-validation): a fake chain that builds real,
// signable transactions without an RPC, a fake Stellar 8004 registry, and a wallet that approves on the approval
// page's behalf: it connects its account and signs each transaction the page shows, as a person would.

import { USDC_ISSUER, type StellarNetwork } from "@stellar-agent-services/protocol";
import { Account, Asset, Contract, Keypair, Networks, Operation, TransactionBuilder, type Transaction, type xdr } from "@stellar/stellar-sdk";
import { ApprovalSession, type ApprovalOutcome, type ApprovalPlan } from "../../src/cli/approval.js";
import type { ApprovalView } from "../../src/cli/approval-view.js";
import type { ContractCall, OwnerChain, SendResult } from "../../src/cli/owner-chain.js";
import type { OwnerIo, StellarCli } from "../../src/cli/shared.js";
import { registryConfig, type RegistryReader, type ValidationRecord } from "../../src/registration.js";

export interface FakeChain extends OwnerChain {
  /** The accounts that exist, and whether each holds a USDC trustline. */
  accounts: Map<string, { usdcTrustline: boolean }>;
  /** Accounts funded by "Friendbot". */
  funded: string[];
  /** Contract calls built, in order. */
  invoked: { address: string; call: ContractCall }[];
  /** Transactions sent, in order. */
  sent: Transaction[];
  /** How the next sends end: success unless queued here. */
  answers: ("failed" | "unknown")[];
  /** What a successful contract call returns, such as the new agent's id. */
  returnValue?: xdr.ScVal;
  /** Called for each contract call that lands, to update a fake registry. */
  onLanded?(call: ContractCall): void;
}

export function fakeChain(network: StellarNetwork = "stellar:testnet"): FakeChain {
  const passphrase = network === "stellar:pubnet" ? Networks.PUBLIC : Networks.TESTNET;
  const calls = new Map<string, ContractCall>();
  let sequence = 100n;
  const build = (address: string, operation: xdr.Operation) => {
    sequence += 1n;
    return new TransactionBuilder(new Account(address, sequence.toString()), { fee: "100", networkPassphrase: passphrase })
      .addOperation(operation)
      .setTimeout(300)
      .build();
  };
  const chain: FakeChain = {
    network,
    passphrase,
    accounts: new Map(),
    funded: [],
    invoked: [],
    sent: [],
    answers: [],
    async account(address) {
      const account = chain.accounts.get(address);
      return { exists: account !== undefined, usdcTrustline: account?.usdcTrustline ?? false };
    },
    async fund(address) {
      chain.funded.push(address);
      chain.accounts.set(address, { usdcTrustline: false });
    },
    async trustline(address) {
      return build(address, Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER[network]) }));
    },
    async invoke(address, call) {
      chain.invoked.push({ address, call });
      const transaction = build(address, new Contract(call.contractId).call(call.method, ...call.args));
      calls.set(transaction.hash().toString("hex"), call);
      return transaction;
    },
    async send(transaction): Promise<SendResult> {
      chain.sent.push(transaction);
      const hash = transaction.hash().toString("hex");
      const answer = chain.answers.shift();
      if (answer === "failed") return { status: "failed", hash, reason: "The account sent another transaction first." };
      if (answer === "unknown") return { status: "unknown", hash, reason: "no ledger included it within 30 seconds" };
      if (transaction.operations[0]?.type === "changeTrust") chain.accounts.get(transaction.source)!.usdcTrustline = true;
      const call = calls.get(hash);
      if (call !== undefined) chain.onLanded?.(call);
      return { status: "success", hash, ledger: 1, ...(call === undefined || chain.returnValue === undefined ? {} : { returnValue: chain.returnValue }) };
    },
  };
  return chain;
}

/** The Stellar 8004 registries, in memory. */
export function fakeRegistry(network: StellarNetwork = "stellar:testnet") {
  const agents = new Map<number, { owner: string; uri: string; wallet?: string; approved?: string }>();
  const operators = new Set<string>();
  const validations = new Map<string, ValidationRecord>();
  const { contracts } = registryConfig(network);
  const registry: RegistryReader = {
    network,
    contracts: { identity: contracts.identity, validation: contracts.validation },
    agentUri: async (agentId) => agents.get(agentId)?.uri,
    agentWallet: async (agentId) => agents.get(agentId)?.wallet,
    agentOwner: async (agentId) => agents.get(agentId)?.owner,
    agentApproved: async (agentId) => agents.get(agentId)?.approved,
    isOperator: async (owner, operator) => operators.has(`${owner} ${operator}`),
    validation: async (requestHash) => validations.get(requestHash),
  };
  return { agents, operators, validations, registry };
}

/** A wallet holding `keypair` that approves everything the page shows. `views` keeps how each session ended. */
export function walletApproves(keypair: Keypair, options: { wallet?: string } = {}) {
  const views: ApprovalView[] = [];
  const approve = async (plan: ApprovalPlan, chain: OwnerChain): Promise<ApprovalOutcome> => {
    const session = new ApprovalSession(plan, chain);
    await session.connect(keypair.publicKey(), options.wallet ?? "Test wallet");
    while (session.state === "review") {
      const { review } = session.view();
      // An error the page would show: the person stops here.
      if (review === undefined) break;
      await session.submit(review.stepId, signed(review.xdr, keypair, chain.passphrase));
    }
    views.push(session.view());
    if (!["done", "failed", "cancelled"].includes(session.state)) session.cancel();
    return session.finished;
  };
  return { approve, views };
}

/** What a wallet hands back: the transaction, signed. */
export function signed(transactionXdr: string, keypair: Keypair, passphrase: string): string {
  const transaction = TransactionBuilder.fromXDR(transactionXdr, passphrase) as Transaction;
  transaction.sign(keypair);
  return transaction.toXDR();
}

/** The owner commands' outside world, all fake. `approve` stands for the person on the approval page. */
export function ownerIo(options: {
  chain: FakeChain;
  registry: RegistryReader;
  approve?: OwnerIo["approve"];
  stellar?: StellarCli;
  now?: Date;
}): OwnerIo {
  return {
    stellar: async () => options.stellar,
    registry: () => options.registry,
    chain: () => options.chain,
    approve:
      options.approve ??
      (async () => {
        throw new Error("the approval page was opened, but this test signs nowhere");
      }),
    now: () => options.now ?? new Date("2026-10-28T10:00:00Z"),
  };
}

/** A random account, as an owner, a payTo or a stranger. */
export function account(): Keypair {
  return Keypair.random();
}
