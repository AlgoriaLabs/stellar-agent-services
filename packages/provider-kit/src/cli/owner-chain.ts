// The owner's transactions: built here, signed in the developer's own wallet, then checked and sent here
// (docs/provider-setup-guide.md §2, §8 and §9). Nothing in this file holds or asks for a key.
//
// - OwnerChain: the reads and writes the owner commands make, plus the test USDC that `provider-kit try`
//   buys for its throwaway payer. rpcOwnerChain() uses Soroban RPC, which takes classic transactions (the
//   USDC trustline) and contract calls (the Stellar 8004 registries) alike. Tests pass a fake.
// - verifySigned(): what a wallet hands back must be the very transaction built here, signed by the
//   connected account for this network. Anything else is refused before it is sent.
// - registerCall(), setAgentUriCall(), validationRequestCall(): the registry invocations, with their
//   arguments in each contract's parameter order.
// Reads fail closed: an account the RPC can't read is an error, never "missing". A transaction whose
// fate is unknown is reported as unknown, never as failed, so nobody sends it twice.

import { USDC_ISSUER, type StellarNetwork } from "@stellar-agent-services/protocol";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { registryConfig } from "../registration.js";
import type { PreparedValidationRequest } from "../validation-request.js";

/** How long a built transaction stays valid: time to review and approve it, even on a hardware wallet. */
export const OWNER_TX_TIMEOUT_SECONDS = 300;
/** The most a classic transaction may cost in fees, in stroops: 0.001 XLM. Without surge pricing it costs 0.00001. */
const CLASSIC_MAX_FEE = "10000";
/** The most test XLM buyTestUsdc() spends: half of what Friendbot gives a new account. */
const TEST_XLM_SPEND = "5000";
const RPC_TIMEOUT_MS = 30_000;
/** send() polls the RPC once a second for this many seconds. A ledger closes about every 5 s. */
const POLL_ATTEMPTS = 30;
const FRIENDBOT_URL = "https://friendbot.stellar.org";

/** A problem the developer can act on. The approval page shows it; `retry` is what the page offers next. */
export class ApprovalError extends Error {
  override name = "ApprovalError";
  constructor(
    readonly title: string,
    message: string,
    readonly retry: "connect" | "rebuild" | "none" = "rebuild",
  ) {
    super(message);
  }
}

export interface AccountState {
  exists: boolean;
  /** Whether the account holds a trustline to the network's USDC [P2]. */
  usdcTrustline: boolean;
}

export type SendResult =
  | { status: "success"; hash: string; ledger: number; returnValue?: xdr.ScVal }
  /** The network refused it or it failed in a ledger: nothing happened, and it can be built again. */
  | { status: "failed"; hash: string; reason: string }
  /** It may or may not be in a ledger: never send it again without looking it up. */
  | { status: "unknown"; hash: string; reason: string };

/** One invocation of a Stellar 8004 registry. */
export interface ContractCall {
  /** Which registry, for its error codes. */
  registry: "identity" | "validation";
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

/** The reads and writes of the owner commands. */
export interface OwnerChain {
  readonly network: StellarNetwork;
  readonly passphrase: string;
  /** Whether the account exists and holds a USDC trustline. Throws when the RPC can't tell. */
  account(address: string): Promise<AccountState>;
  /** Testnet only: funds a new account with test XLM from Friendbot, and waits until it exists. */
  fund(address: string): Promise<void>;
  /** A transaction from `address` that adds its USDC trustline [P2]. */
  trustline(address: string): Promise<Transaction>;
  /**
   * Testnet only: a transaction from `address` that adds its USDC trustline and buys `amount` USDC (base units)
   * with test XLM on the testnet DEX. It funds the throwaway payer of `provider-kit try`.
   */
  buyTestUsdc(address: string, amount: string): Promise<Transaction>;
  /** A contract call from `address`, simulated and assembled, ready to sign. Throws an ApprovalError explaining a contract error. */
  invoke(address: string, call: ContractCall): Promise<Transaction>;
  /** Sends a signed transaction and waits for a ledger to include it. */
  send(transaction: Transaction): Promise<SendResult>;
}

export function rpcOwnerChain(network: StellarNetwork, rpcUrl?: string): OwnerChain {
  const config = registryConfig(network);
  const target = rpcUrl ?? config.rpcUrl;
  const url = new URL(target);
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new TypeError("the Soroban RPC URL must be https:// (http:// only on localhost)");
  const server = new rpc.Server(target, { timeout: RPC_TIMEOUT_MS, allowHttp: loopback });
  const passphrase = config.networkPassphrase;
  const usdc = new Asset("USDC", USDC_ISSUER[network]);

  async function account(address: string): Promise<AccountState> {
    const keys = [accountKey(address), trustlineKey(address, usdc)];
    const { entries } = await server.getLedgerEntries(...keys);
    const found = new Set(entries.map((entry) => entry.key.toXDR("base64")));
    return { exists: found.has(keys[0]!.toXDR("base64")), usdcTrustline: found.has(keys[1]!.toXDR("base64")) };
  }

  async function source(address: string): Promise<Account> {
    const { entries } = await server.getLedgerEntries(accountKey(address));
    const entry = entries[0];
    if (entry === undefined) throw new ApprovalError("The account doesn't exist", `${address} isn't on ${networkName(network)} yet.`, "connect");
    return new Account(address, entry.val.account().seqNum().toString());
  }

  return {
    network,
    passphrase,
    account,
    async fund(address) {
      if (network !== "stellar:testnet") throw new ApprovalError("No test XLM on Mainnet", "Friendbot funds testnet accounts only.", "none");
      // Friendbot answers 400 for an account that already exists: the account read below decides.
      const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      for (let attempt = 0; attempt < 10; attempt++) {
        if ((await account(address)).exists) return;
        await sleep(1000);
      }
      throw new ApprovalError("Friendbot didn't fund the account", `Friendbot answered ${response.status}, and ${address} still doesn't exist. Try again in a minute.`, "connect");
    },
    async trustline(address) {
      return new TransactionBuilder(await source(address), { fee: CLASSIC_MAX_FEE, networkPassphrase: passphrase })
        .addOperation(Operation.changeTrust({ asset: usdc }))
        .setTimeout(OWNER_TX_TIMEOUT_SECONDS)
        .build();
    },
    async buyTestUsdc(address, amount) {
      if (network !== "stellar:testnet") throw new ApprovalError("No test USDC on Mainnet", "The testnet DEX sells test USDC only.", "none");
      return new TransactionBuilder(await source(address), { fee: CLASSIC_MAX_FEE, networkPassphrase: passphrase })
        .addOperation(Operation.changeTrust({ asset: usdc }))
        .addOperation(
          Operation.pathPaymentStrictReceive({
            sendAsset: Asset.native(),
            sendMax: TEST_XLM_SPEND,
            destination: address,
            destAsset: usdc,
            destAmount: decimal(BigInt(amount)),
            path: [],
          }),
        )
        .setTimeout(OWNER_TX_TIMEOUT_SECONDS)
        .build();
    },
    async invoke(address, call) {
      const draft = new TransactionBuilder(await source(address), { fee: BASE_FEE, networkPassphrase: passphrase })
        .addOperation(new Contract(call.contractId).call(call.method, ...call.args))
        .setTimeout(OWNER_TX_TIMEOUT_SECONDS)
        .build();
      try {
        // Simulates the call, then adds its footprint, resource fee and the caller's authorization.
        return await server.prepareTransaction(draft);
      } catch (error) {
        throw contractError(call.registry, error);
      }
    },
    async send(transaction) {
      const hash = transaction.hash().toString("hex");
      let sent: rpc.Api.SendTransactionResponse;
      try {
        sent = await server.sendTransaction(transaction);
      } catch (error) {
        return { status: "unknown", hash, reason: `the RPC didn't answer (${(error as Error).message})` };
      }
      if (sent.status === "ERROR") return { status: "failed", hash, reason: describeResult(sent.errorResult) };
      if (sent.status === "TRY_AGAIN_LATER") return { status: "failed", hash, reason: "The network didn't take it just now." };
      // PENDING, or DUPLICATE when it was sent before: either way, follow it into a ledger.
      let response: rpc.Api.GetTransactionResponse;
      try {
        response = await server.pollTransaction(hash, { attempts: POLL_ATTEMPTS, sleepStrategy: () => 1000 });
      } catch (error) {
        return { status: "unknown", hash, reason: `the RPC stopped answering (${(error as Error).message})` };
      }
      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { status: "success", hash, ledger: response.ledger, ...(response.returnValue === undefined ? {} : { returnValue: response.returnValue }) };
      }
      if (response.status === rpc.Api.GetTransactionStatus.FAILED) return { status: "failed", hash, reason: describeResult(response.resultXdr) };
      return { status: "unknown", hash, reason: `no ledger included it within ${POLL_ATTEMPTS} seconds` };
    },
  };
}

/**
 * The transaction a wallet signed, if it is exactly `built`, signed by `signer` for this network. A wallet
 * that changed anything, signed with another account or for another network is refused: nothing is sent.
 */
export function verifySigned(built: Transaction, signedXdr: string, signer: string, network: StellarNetwork, passphrase: string): Transaction {
  let signed: Transaction | FeeBumpTransaction;
  try {
    signed = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch {
    throw new ApprovalError("The wallet didn't return a transaction", "Nothing was sent. Approve it again.", "rebuild");
  }
  if (signed instanceof FeeBumpTransaction || !signed.hash().equals(built.hash())) {
    throw new ApprovalError("The wallet changed the transaction", "What it signed isn't the transaction you reviewed, so nothing was sent.", "rebuild");
  }
  const keypair = Keypair.fromPublicKey(signer);
  const hash = signed.hash();
  const signedBySigner = signed.signatures.some((signature) => signature.hint().equals(keypair.signatureHint()) && keypair.verify(hash, signature.signature()));
  if (!signedBySigner) {
    const name = networkName(network);
    throw new ApprovalError(
      "The signature doesn't match",
      `It isn't signed by ${signer} for ${name}, so nothing was sent. Check that your wallet is on ${name} and uses that account, then approve again.`,
      "rebuild",
    );
  }
  return signed;
}

/** register_with_uri(caller, agent_uri): a new agent, owned by the caller, whose wallet is the caller [I3]. */
export function registerCall(identity: string, caller: string, agentUri: string): ContractCall {
  return { registry: "identity", contractId: identity, method: "register_with_uri", args: [new Address(caller).toScVal(), nativeToScVal(agentUri, { type: "string" })] };
}

/** set_agent_uri(caller, agent_id, new_uri): a new registration file for an existing agent. */
export function setAgentUriCall(identity: string, caller: string, agentId: number, agentUri: string): ContractCall {
  return {
    registry: "identity",
    contractId: identity,
    method: "set_agent_uri",
    args: [new Address(caller).toScVal(), nativeToScVal(agentId, { type: "u32" }), nativeToScVal(agentUri, { type: "string" })],
  };
}

/** validation_request(caller, validator_address, agent_id, request_uri, request_hash), as prepareValidationRequest() built it. */
export function validationRequestCall(caller: string, prepared: PreparedValidationRequest): ContractCall {
  return {
    registry: "validation",
    contractId: prepared.contractId,
    method: "validation_request",
    args: [
      new Address(caller).toScVal(),
      new Address(prepared.request.validator).toScVal(),
      nativeToScVal(prepared.request.agentId, { type: "u32" }),
      nativeToScVal(prepared.requestUri, { type: "string" }),
      nativeToScVal(Buffer.from(prepared.requestHash, "hex")),
    ],
  };
}

/** "GDTC…2JMH": enough to tell accounts apart in a message, never enough to approve one. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function networkName(network: StellarNetwork): string {
  return network === "stellar:pubnet" ? "Stellar Mainnet" : "Stellar Testnet";
}

/** A transaction, account or contract on Stellar Expert. */
export function explorerUrl(network: StellarNetwork, kind: "tx" | "account" | "contract", id: string): string {
  return `https://stellar.expert/explorer/${network === "stellar:pubnet" ? "public" : "testnet"}/${kind}/${id}`;
}

/** Stroops as XLM, such as "0.0012345 XLM". */
export function formatXlm(stroops: string | number | bigint): string {
  return `${decimal(BigInt(stroops))} XLM`;
}

/** USDC base units as USDC, such as "0.01 USDC". */
export function formatUsdc(units: string | bigint): string {
  return `${decimal(BigInt(units), 2)} USDC`;
}

/** An amount with 7 decimals, as Stellar writes assets, with at least `minDecimals` of them. */
function decimal(units: bigint, minDecimals = 0): string {
  const whole = units / 10_000_000n;
  const fraction = (units % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "").padEnd(minDecimals, "0");
  return `${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

function accountKey(address: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }));
}

function trustlineKey(address: string, asset: Asset): xdr.LedgerKey {
  return xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: Keypair.fromPublicKey(address).xdrPublicKey(), asset: asset.toTrustLineXDRObject() }));
}

/** The registries' contract errors (stellar-8004 contracts/*-registry/src/errors.rs) a developer can run into. */
const CONTRACT_ERRORS: Record<ContractCall["registry"], Record<number, [string, string]>> = {
  identity: {
    1: ["This account can't change the agent", "Only the agent's owner, the address approved for it, or an operator of the owner's can."],
    3: ["The agent doesn't exist", "Check provider.agentId [I2]."],
    8: ["The registration is empty", "The registration file can't be empty [I1]."],
  },
  validation: {
    1: ["This account can't ask for the agent", "Only the agent's owner, the address approved for it, or an operator of the owner's can."],
    4: ["This request was already sent", "The Validation Registry has a request with this hash. Look it up before sending another."],
    7: ["The agent doesn't exist", "Check provider.agentId [I2]."],
  },
};

/** A failed simulation as something to act on: the contract's error when it names one. */
export function contractError(registry: ContractCall["registry"], error: unknown): ApprovalError {
  if (error instanceof ApprovalError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  const known = code === undefined ? undefined : CONTRACT_ERRORS[registry][Number(code)];
  if (known !== undefined) return new ApprovalError(known[0], known[1], "connect");
  if (code !== undefined) return new ApprovalError("The contract refused the call", `The ${registry} registry answered with error #${code}.`, "rebuild");
  return new ApprovalError("The transaction can't be built", `Simulating it failed: ${message.split("\n")[0]}`, "rebuild");
}

/** Why the network refused a transaction, from its result code. */
const RESULT_CODES: Record<string, string> = {
  txTooLate: "It expired before it reached the network.",
  txBadSeq: "The account sent another transaction first.",
  txBadAuth: "The signature doesn't authorize the account. Accounts that need several signatures aren't supported here.",
  txInsufficientBalance: "The account doesn't have enough XLM for the fee.",
  txNoAccount: "The account doesn't exist.",
  txInsufficientFee: "The fee was too low for the network's load right now.",
  txSorobanInvalid: "The contract call's resources didn't fit.",
  changeTrustLowReserve: "The account needs 0.5 XLM more to hold USDC: Stellar keeps it in reserve while the trustline exists.",
  pathPaymentStrictReceiveTooFewOffers: "The testnet DEX has no test USDC for sale right now.",
  pathPaymentStrictReceiveOverSendmax: "Test USDC costs more XLM on the testnet DEX right now than the account may spend.",
  invokeHostFunctionTrapped: "The contract refused the call.",
  invokeHostFunctionResourceLimitExceeded: "The contract call needed more resources than simulated.",
  invokeHostFunctionInsufficientRefundableFee: "The contract call needed a higher fee than simulated.",
  invokeHostFunctionEntryArchived: "A registry entry is archived and must be restored first.",
};

export function describeResult(result: xdr.TransactionResult | undefined): string {
  if (result === undefined) return "The network refused it without saying why.";
  const outcome = result.result();
  let code: string = outcome.switch().name;
  if (code === "txFailed") {
    // The operation that failed. The ones before it succeeded, and were undone with the transaction.
    const codes = outcome
      .results()
      .map((operation) => (operation.switch().name === "opInner" ? (operation.tr().value() as { switch(): { name: string } }).switch().name : operation.switch().name));
    code = codes.find((name) => !name.endsWith("Success")) ?? codes[0] ?? code;
  }
  return RESULT_CODES[code] ?? `Stellar answered ${code}.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
