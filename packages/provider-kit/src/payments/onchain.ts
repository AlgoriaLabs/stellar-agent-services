// Finding a job's payment on chain, for reconciliation [J13].
//
// A payment is one signed Soroban authorization: the payer's auth entry, with a nonce, for exactly one
// SAC transfer(payer, payTo, amount) (payments/payload-checks.ts). Soroban accepts an (address, nonce)
// pair once, so the successful transaction that carries the payer's auth entry with the job's nonce IS
// the job's payment. Any other transfer between the same accounts, for the same amount, belongs to
// another job. The lookup goes by that binding, never by recipient and amount alone:
//
// 1. the transaction the facilitator named, if any;
// 2. otherwise, or if that one failed, the asset's `transfer` events from the payer in every ledger the
//    payment could have landed in, and the transactions behind them.
//
// "not_settled" needs proof of absence: the RPC searched every ledger up to the payment's expiration
// ledger, that ledger has closed, and none of them carried the payment. After it the signature is void,
// so the payment can never land. Anything less is "undecided" and the job stays payment_uncertain: a
// ledger still to come, a window older than the RPC's history, an RPC error, or a transaction that used
// the payment but shows no matching transfer. Nothing is decided from a guess.

import type { PaymentReceipt, StellarNetwork } from "@stellar-agent-services/protocol";
import { Address, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import type { PaymentClaim } from "../jobs/store.js";
import type { ChainReader } from "./chain.js";
import { addressCredentials } from "./payload-checks.js";

export type PaymentLookup =
  | { outcome: "settled"; receipt: PaymentReceipt }
  | { outcome: "not_settled"; reason: string }
  | { outcome: "undecided"; reason: string };

export interface PaymentSearch {
  chain: ChainReader;
  network: StellarNetwork;
  /** The asset contract the payment is in: the manifest's USDC SAC. */
  asset: string;
}

/**
 * How far before its expiration ledger a payment can land. The provider (http/router.ts) and the
 * facilitator both refuse a signature that expires more than maxTimeoutSeconds (at most 300, §4.1) of
 * ledgers after the payment is verified, counting a ledger as at least one second (they take about
 * five), and a payment lands after its verification. So this window holds every ledger it could have
 * landed in, with room to spare.
 */
export const SEARCH_WINDOW_LEDGERS = 320;
/** Ledgers beyond the latest that a signature may expire in, on top of maxTimeoutSeconds. */
export const EXPIRATION_TOLERANCE_LEDGERS = 10;
const PAGE_SIZE = 100;
/** A payer with more transfers than this in one window is checked by hand. */
const MAX_PAGES = 10;

/**
 * Looks for the payment `claim` describes. `known` is a transaction the facilitator named. `health` is
 * a recent getHealth() answer, to share one across many lookups; it is read when not given.
 */
export async function findPayment(
  claim: PaymentClaim,
  known: string | undefined,
  search: PaymentSearch,
  health?: rpc.Api.GetHealthResponse,
): Promise<PaymentLookup> {
  const { chain } = search;
  const checked = new Set<string>();
  const check = async (hash: string): Promise<PaymentLookup | undefined> => {
    if (checked.has(hash)) return undefined;
    checked.add(hash);
    return paymentIn(await chain.getTransaction(hash), hash, claim, search);
  };

  try {
    if (known !== undefined) {
      const found = await check(known);
      if (found !== undefined) return found;
    }

    const range = health ?? (await chain.getHealth());
    const end = claim.expirationLedger;
    const from = Math.max(1, end - SEARCH_WINDOW_LEDGERS);
    const start = Math.max(from, range.oldestLedger);
    // The lowest latest ledger any answer reported: with several RPC nodes behind one URL, the search
    // has covered no more than the least advanced of them had seen.
    let latest = range.latestLedger;
    if (start <= Math.min(end, latest)) {
      const filters = transferFilters(search.asset, claim.payer);
      let request: rpc.Api.GetEventsRequest = { filters, startLedger: start, endLedger: Math.min(end, latest) + 1, limit: PAGE_SIZE };
      for (let page = 0; ; page++) {
        if (page === MAX_PAGES) return undecided(`${claim.payer} made more transfers than reconciliation searches; check its transfers with nonce ${claim.nonce} by hand`);
        const response = await chain.getEvents(request);
        latest = Math.min(latest, response.latestLedger);
        let past = false;
        for (const event of response.events) {
          if (event.ledger > end) {
            past = true;
            break;
          }
          // The transaction's own status decides, not the event's: current RPCs leave the deprecated
          // inSuccessfulContractCall unset.
          const found = await check(event.txHash);
          if (found !== undefined) return found;
        }
        if (past || response.events.length < PAGE_SIZE) break;
        request = { filters, cursor: response.cursor, limit: PAGE_SIZE };
      }
    }

    if (latest <= end) return undecided(`the payment can still land until ledger ${end} closes (the latest is ${latest})`);
    if (start > from) {
      return undecided(`ledgers ${from}–${start - 1} are older than the RPC's history; look for a transfer from ${claim.payer} with nonce ${claim.nonce} in an archive`);
    }
    return { outcome: "not_settled", reason: `no transaction used the payment before it expired at ledger ${end}` };
  } catch (error) {
    return undecided(`the chain could not be read: ${(error as Error).message}`);
  }
}

/** Whether a transaction is the claim's payment: settled, undecided, or undefined when it isn't the payment. */
function paymentIn(transaction: rpc.Api.GetTransactionResponse, hash: string, claim: PaymentClaim, search: PaymentSearch): PaymentLookup | undefined {
  if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS) return undefined;
  const signed = signedTransfer(transaction.envelopeXdr, claim, search.asset);
  if (signed === undefined) return undefined;
  // It used the payer's auth entry, so the signed transfer ran. Its event must say so too [J16].
  const moved = transfersFrom(transaction.events.contractEventsXdr.flat(), search.asset, claim.payer);
  if (!moved.some((transfer) => transfer.to === signed.to && transfer.amount === signed.amount)) {
    return undecided(`transaction ${hash} used the payment, but its events show no transfer of ${signed.amount} to ${signed.to}`);
  }
  return {
    outcome: "settled",
    receipt: {
      network: search.network,
      asset: search.asset,
      amount: signed.amount,
      payTo: signed.to,
      payer: claim.payer,
      transaction: hash,
      settledAt: new Date(transaction.createdAt * 1000).toISOString(),
    },
  };
}

/**
 * The transfer the payer's auth entry with the claim's nonce authorizes, if the transaction carries it.
 * An entry with that nonce for anything else means the nonce was spent elsewhere: not this payment.
 */
function signedTransfer(envelope: xdr.TransactionEnvelope, claim: PaymentClaim, asset: string): { to: string; amount: string } | undefined {
  for (const operation of operationsOf(envelope)) {
    if (operation.body().switch() !== xdr.OperationType.invokeHostFunction()) continue;
    for (const entry of operation.body().invokeHostFunctionOp().auth()) {
      const credentials = addressCredentials(entry.credentials());
      if (credentials === undefined) continue;
      if (Address.fromScAddress(credentials.address()).toString() !== claim.payer || credentials.nonce().toString() !== claim.nonce) continue;
      const authorized = entry.rootInvocation().function();
      if (authorized.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) return undefined;
      const call = authorized.contractFn();
      if (Address.fromScAddress(call.contractAddress()).toString() !== asset || call.functionName().toString() !== "transfer") return undefined;
      const [from, to, amount] = call.args().map((arg) => scValToNative(arg) as unknown);
      if (from !== claim.payer || typeof to !== "string" || typeof amount !== "bigint") return undefined;
      return { to, amount: amount.toString() };
    }
  }
  return undefined;
}

function operationsOf(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
  switch (envelope.switch()) {
    // The facilitator may wrap its transaction in a fee bump.
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      return envelope.feeBump().tx().innerTx().v1().tx().operations();
    case xdr.EnvelopeType.envelopeTypeTx():
      return envelope.v1().tx().operations();
    default:
      return envelope.v0().tx().operations();
  }
}

/** The asset's transfer events from `payer`. */
function transfersFrom(events: readonly xdr.ContractEvent[], asset: string, payer: string): { to: unknown; amount: string | undefined }[] {
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
  if (typeof value === "object" && value !== null && typeof (value as { amount?: unknown }).amount === "bigint") {
    return (value as { amount: bigint }).amount;
  }
  return undefined;
}

/** Transfer events from `payer`: a SAC's have a fourth topic, the asset's name; other SEP-41 tokens' have three. */
function transferFilters(asset: string, payer: string): rpc.Api.EventFilter[] {
  const transfer = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  const from = Address.fromString(payer).toScVal().toXDR("base64");
  return [{ type: "contract", contractIds: [asset], topics: [[transfer, from, "*", "*"], [transfer, from, "*"]] }];
}

function undecided(reason: string): PaymentLookup {
  return { outcome: "undecided", reason };
}
