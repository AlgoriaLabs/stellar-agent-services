// What the verifier reads from the chain, through Soroban RPC. It never submits anything.
//
// - usdcTrustline(): a G... payTo can receive USDC [P2].
// - proveSettlement(): a job's receipt is a claim until the chain shows it [J16]. The transaction must
//   have succeeded, carry the payment the verifier itself signed (the payer's auth entry with its nonce),
//   and move exactly the approved asset and amount from the payer to payTo. Matching by nonce rather
//   than by amount means another job's payment can never pass as this one's.
// - findSettlements(): which of the verifier's payments landed, from the payer's transfer events. "Not
//   settled" needs proof of absence: the payment's expiration ledger has closed and every ledger from
//   its signing to its expiration was searched. After that the signature is void.

import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { SOROBAN_RPC_URL, USDC_ISSUER } from "@stellar-agent-services/protocol";
import { Address, Asset, Keypair, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { registryConfig } from "./registry.js";

/** The RPC calls the verifier makes: an rpc.Server, or a fake chain in tests. */
export type ChainReader = Pick<rpc.Server, "getLatestLedger" | "getTransaction" | "getEvents" | "getLedgerEntries">;

const RPC_TIMEOUT_MS = 15_000;

/** The public Soroban RPC for testnet; on pubnet, which SDF runs none for, the one the 8004 SDK uses. */
export function defaultRpcUrl(network: StellarNetwork): string {
  return SOROBAN_RPC_URL[network] ?? registryConfig(network).rpcUrl;
}

/** A Soroban RPC client. The URL is https://, or http://localhost with `dev`. */
export function rpcChain(network: StellarNetwork, url?: string, options: { dev?: boolean } = {}): ChainReader {
  const target = url ?? defaultRpcUrl(network);
  const base = new URL(target);
  const loopback = base.protocol === "http:" && isLoopback(base.hostname);
  if (base.protocol !== "https:" && !(options.dev && loopback)) {
    throw new TypeError("the Soroban RPC URL must be https:// (http://localhost only in development mode)");
  }
  return new rpc.Server(target, { timeout: RPC_TIMEOUT_MS, allowHttp: loopback });
}

export function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

export type TrustlineState = "authorized" | "unauthorized" | "missing" | "no_account";

/** Whether a G... account exists and holds an authorized USDC trustline [P2]. Throws when the chain can't be read. */
export async function usdcTrustline(chain: ChainReader, network: StellarNetwork, account: string): Promise<TrustlineState> {
  const accountId = Keypair.fromPublicKey(account).xdrAccountId();
  const { entries } = await chain.getLedgerEntries(
    xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId })),
    xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId, asset: new Asset("USDC", USDC_ISSUER[network]).toTrustLineXDRObject() })),
  );
  if (!entries.some((entry) => entry.val.switch().name === "account")) return "no_account";
  const trustline = entries.find((entry) => entry.val.switch().name === "trustline");
  if (trustline === undefined) return "missing";
  // AUTHORIZED_FLAG: an issuer without AUTH_REQUIRED sets it on every new trustline.
  return (trustline.val.trustLine().flags() & 1) === 1 ? "authorized" : "unauthorized";
}

/** One signed payment as an auth entry authorizes it: the token transfer and the signature's terms. */
export interface SignedTransfer {
  payer: string;
  /** The auth-entry nonce, a decimal string. Soroban accepts an (address, nonce) pair once. */
  nonce: string;
  /** The last ledger the signature is valid for. */
  expirationLedger: number;
  asset: string;
  from: string;
  payTo: string;
  amount: string;
}

/** The token transfers a transaction's address-credential auth entries authorize. */
export function signedTransfers(envelope: xdr.TransactionEnvelope): SignedTransfer[] {
  const transfers: SignedTransfer[] = [];
  for (const operation of operationsOf(envelope)) {
    if (operation.body().switch() !== xdr.OperationType.invokeHostFunction()) continue;
    for (const entry of operation.body().invokeHostFunctionOp().auth()) {
      const credentials = addressCredentials(entry.credentials());
      const authorized = entry.rootInvocation().function();
      if (credentials === undefined || authorized.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) continue;
      const call = authorized.contractFn();
      if (call.functionName().toString() !== "transfer" || call.args().length !== 3) continue;
      const [from, to, amount] = call.args().map((arg) => scValToNative(arg) as unknown);
      if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "bigint") continue;
      transfers.push({
        payer: Address.fromScAddress(credentials.address()).toString(),
        nonce: credentials.nonce().toString(),
        expirationLedger: credentials.signatureExpirationLedger(),
        asset: Address.fromScAddress(call.contractAddress()).toString(),
        from,
        payTo: to,
        amount: amount.toString(),
      });
    }
  }
  return transfers;
}

/** A payment the verifier signed: what proves it settled, or that it never did. */
export interface PaymentRecord {
  payer: string;
  nonce: string;
  asset: string;
  payTo: string;
  amount: string;
  /** The latest ledger before signing: the payment can't land before it. */
  signedAfterLedger: number;
  expirationLedger: number;
}

export type SettlementProof =
  | { outcome: "confirmed"; ledger: number }
  | { outcome: "refuted"; reason: string }
  | { outcome: "unknown"; reason: string };

/**
 * Whether `transaction` is the settlement of `payment` [J16]. The provider may answer before its RPC
 * node has ingested the ledger, so a transaction that isn't found yet is looked up again a few times.
 */
export async function proveSettlement(
  chain: ChainReader,
  payment: PaymentRecord,
  transaction: string,
  options: { sleep: (ms: number) => Promise<void>; attempts?: number; intervalMs?: number },
): Promise<SettlementProof> {
  if (!/^[0-9a-f]{64}$/.test(transaction)) return { outcome: "refuted", reason: "the receipt's transaction is not a 64-character lowercase hex hash" };
  const attempts = options.attempts ?? 10;
  let response: rpc.Api.GetTransactionResponse | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await chain.getTransaction(transaction);
    } catch (error) {
      return { outcome: "unknown", reason: `the RPC lookup of ${transaction} failed: ${(error as Error).message}` };
    }
    if (response.status !== rpc.Api.GetTransactionStatus.NOT_FOUND || attempt >= attempts) break;
    await options.sleep(options.intervalMs ?? 1500);
  }
  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { outcome: "refuted", reason: `transaction ${transaction} is not on chain` };
  if (response.status === rpc.Api.GetTransactionStatus.FAILED) return { outcome: "refuted", reason: `transaction ${transaction} failed on chain` };

  const carried = signedTransfers(response.envelopeXdr).some((transfer) => transfer.payer === payment.payer && transfer.nonce === payment.nonce);
  if (!carried) return { outcome: "refuted", reason: `transaction ${transaction} does not carry the payment the verifier signed for this job` };
  const transfers = transferEvents(response.events.contractEventsXdr.flat(), payment.asset, payment.payer);
  if (transfers.length !== 1) {
    return { outcome: "refuted", reason: `transaction ${transaction} has ${transfers.length} transfers of the asset from the payer, not one` };
  }
  const [transfer] = transfers;
  if (transfer!.to !== payment.payTo || transfer!.amount !== payment.amount) {
    return { outcome: "refuted", reason: `transaction ${transaction} moved ${String(transfer!.amount)} to ${String(transfer!.to)}, not ${payment.amount} to ${payment.payTo}` };
  }
  return { outcome: "confirmed", ledger: response.ledger };
}

export type SettlementSearch =
  | { outcome: "settled"; transaction: string }
  | { outcome: "not_settled" }
  | { outcome: "unknown"; reason: string };

const PAGE_SIZE = 100;
/** A payer with more transfers in the window than this is looked at by hand. */
const MAX_PAGES = 20;

/**
 * Which of the payments landed, by the transactions behind the payer's transfer events. Results are in
 * the order of `payments`, which all have the same payer and asset.
 */
export async function findSettlements(chain: ChainReader, payments: readonly PaymentRecord[]): Promise<SettlementSearch[]> {
  const [first] = payments;
  if (first === undefined) return [];
  const key = (payer: string, nonce: string) => `${payer} ${nonce}`;
  const found = new Map<string, string>();
  let latest: number;
  try {
    latest = (await chain.getLatestLedger()).sequence;
    const start = Math.max(1, Math.min(...payments.map((payment) => payment.signedAfterLedger)));
    const end = Math.min(latest, Math.max(...payments.map((payment) => payment.expirationLedger)));
    const filters = transferFilters(first.asset, first.payer);
    const looked = new Set<string>();
    let request: rpc.Api.GetEventsRequest = { filters, startLedger: start, endLedger: end + 1, limit: PAGE_SIZE };
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) throw new Error(`the payer has more than ${MAX_PAGES * PAGE_SIZE} transfers in the window`);
      const response = await chain.getEvents(request);
      for (const event of response.events) {
        if (event.ledger > end || looked.has(event.txHash)) continue;
        looked.add(event.txHash);
        const transaction = await chain.getTransaction(event.txHash);
        if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS) continue;
        for (const transfer of signedTransfers(transaction.envelopeXdr)) found.set(key(transfer.payer, transfer.nonce), event.txHash);
      }
      if (response.events.length < PAGE_SIZE || response.events.some((event) => event.ledger > end)) break;
      request = { filters, cursor: response.cursor, limit: PAGE_SIZE };
    }
  } catch (error) {
    return payments.map(() => ({ outcome: "unknown", reason: `the chain could not be searched: ${(error as Error).message}` }));
  }

  return payments.map((payment): SettlementSearch => {
    const transaction = found.get(key(payment.payer, payment.nonce));
    if (transaction !== undefined) return { outcome: "settled", transaction };
    if (latest <= payment.expirationLedger) {
      return { outcome: "unknown", reason: `the payment can still land until ledger ${payment.expirationLedger} closes (the latest is ${latest})` };
    }
    return { outcome: "not_settled" };
  });
}

/** Waits until `ledger` has closed. False if it hasn't by the deadline. */
export async function waitForLedger(
  chain: ChainReader,
  ledger: number,
  options: { sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs: number },
): Promise<boolean> {
  const deadline = options.now() + options.timeoutMs;
  for (;;) {
    const latest = await chain.getLatestLedger().then(
      (response) => response.sequence,
      () => undefined,
    );
    if (latest !== undefined && latest > ledger) return true;
    if (options.now() >= deadline) return false;
    await options.sleep(2500);
  }
}

/** The asset's transfer events from `payer`, with their recipient and amount. */
function transferEvents(events: readonly xdr.ContractEvent[], asset: string, payer: string): { to: unknown; amount: string | undefined }[] {
  return events.flatMap((event) => {
    const contractId = event.contractId();
    // Typed as Opaque[], but the SDK's own Buffer at runtime.
    if (contractId === null || StrKey.encodeContract(contractId as unknown as Buffer) !== asset) return [];
    const topics = event.body().v0().topics().map((topic) => scValToNative(topic) as unknown);
    if (topics[0] !== "transfer" || topics[1] !== payer) return [];
    return [{ to: topics[2], amount: transferAmount(event.body().v0().data())?.toString() }];
  });
}

// The data is an i128, or a map with `amount` when the payee is a muxed account (CAP-67).
function transferAmount(data: xdr.ScVal): bigint | undefined {
  const value = scValToNative(data) as unknown;
  if (typeof value === "bigint") return value;
  if (typeof value === "object" && value !== null && typeof (value as { amount?: unknown }).amount === "bigint") return (value as { amount: bigint }).amount;
  return undefined;
}

/** Transfer events from `payer`: a SAC's have a fourth topic, the asset's name; other SEP-41 tokens' have three. */
function transferFilters(asset: string, payer: string): rpc.Api.EventFilter[] {
  const transfer = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  const from = Address.fromString(payer).toScVal().toXDR("base64");
  return [{ type: "contract", contractIds: [asset], topics: [[transfer, from, "*", "*"], [transfer, from, "*"]] }];
}

function operationsOf(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
  switch (envelope.switch()) {
    // A facilitator may wrap its transaction in a fee bump.
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      return envelope.feeBump().tx().innerTx().v1().tx().operations();
    case xdr.EnvelopeType.envelopeTypeTx():
      return envelope.v1().tx().operations();
    default:
      return envelope.v0().tx().operations();
  }
}

/** Address credentials, in either encoding Soroban accepts. */
function addressCredentials(credentials: xdr.SorobanCredentials): xdr.SorobanAddressCredentials | undefined {
  switch (credentials.switch()) {
    case xdr.SorobanCredentialsType.sorobanCredentialsAddress():
      return credentials.address();
    case xdr.SorobanCredentialsType.sorobanCredentialsAddressV2():
      return credentials.addressV2();
    default:
      return undefined;
  }
}
