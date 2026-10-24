// A fake Soroban RPC: ledgers, transactions and the transfer events they emitted, served the way
// reconciliation and the ledger clock read them, without the network.

import { Address, nativeToScVal, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import type { ChainReader } from "../../src/index.js";

/** Seconds per ledger on the fake chain. */
export const LEDGER_SECONDS = 5;

export interface FakeTransaction {
  hash: string;
  ledger: number;
  status?: "SUCCESS" | "FAILED";
  envelope: xdr.TransactionEnvelope;
  events: xdr.ContractEvent[];
}

/** A SAC `transfer` event, as a token emits it. */
export function transferEvent(options: { asset: string; from: string; to: string; amount?: bigint }): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(options.asset) as unknown as xdr.Hash,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [
          nativeToScVal("transfer", { type: "symbol" }),
          nativeToScVal(options.from, { type: "address" }),
          nativeToScVal(options.to, { type: "address" }),
          nativeToScVal("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
        ],
        data: nativeToScVal(options.amount ?? 100000n, { type: "i128" }),
      }),
    ),
  });
}

/**
 * A chain at `latestLedger`, keeping ledgers from `oldestLedger`. The latest ledger closed just now,
 * and each one before it LEDGER_SECONDS earlier. `calls` counts each RPC method's calls.
 */
export function fakeChain(options: { latestLedger: number; oldestLedger?: number; transactions?: FakeTransaction[] }) {
  const state = {
    latestLedger: options.latestLedger,
    oldestLedger: options.oldestLedger ?? 1,
    transactions: [...(options.transactions ?? [])],
    /** Makes every call fail, like an RPC that is down. */
    down: false,
  };
  const calls: Record<string, number> = {};
  const latestCloseTime = Math.floor(Date.now() / 1000);
  const closeTime = (ledger: number) => latestCloseTime - (state.latestLedger - ledger) * LEDGER_SECONDS;
  const call = (method: string) => {
    calls[method] = (calls[method] ?? 0) + 1;
    if (state.down) throw new Error("the RPC is down");
  };
  const retention = () => ({
    latestLedger: state.latestLedger,
    oldestLedger: state.oldestLedger,
    latestLedgerCloseTime: closeTime(state.latestLedger),
    oldestLedgerCloseTime: closeTime(state.oldestLedger),
  });

  /** Every transfer event of a successful transaction, in ledger order, with a cursor-like id. */
  const transferEvents = () =>
    state.transactions
      .filter((transaction) => (transaction.status ?? "SUCCESS") === "SUCCESS" && transaction.ledger <= state.latestLedger)
      .sort((a, b) => a.ledger - b.ledger)
      .flatMap((transaction) =>
        transaction.events.map((event, index) => ({
          id: `${String(transaction.ledger).padStart(12, "0")}-${transaction.hash}-${index}`,
          ledger: transaction.ledger,
          txHash: transaction.hash,
          asset: StrKey.encodeContract(event.contractId() as unknown as Buffer),
          from: scValToNative(event.body().v0().topics()[1]!) as string,
        })),
      );

  const chain: ChainReader = {
    async getHealth() {
      call("getHealth");
      return { status: "healthy", latestLedger: state.latestLedger, oldestLedger: state.oldestLedger, ledgerRetentionWindow: state.latestLedger - state.oldestLedger };
    },
    async getLatestLedger() {
      call("getLatestLedger");
      return { id: "", sequence: state.latestLedger, protocolVersion: "23", closeTime: String(closeTime(state.latestLedger)) } as rpc.Api.GetLatestLedgerResponse;
    },
    async getLedgers(request) {
      call("getLedgers");
      const sequence = request.startLedger!;
      return { ...retention(), cursor: "", ledgers: [{ hash: "", sequence, ledgerCloseTime: String(closeTime(sequence)) }] } as unknown as rpc.Api.GetLedgersResponse;
    },
    async getTransaction(hash) {
      call("getTransaction");
      const transaction = state.transactions.find((candidate) => candidate.hash === hash && candidate.ledger <= state.latestLedger);
      if (transaction === undefined) return { status: rpc.Api.GetTransactionStatus.NOT_FOUND, txHash: hash, ...retention() } as rpc.Api.GetTransactionResponse;
      return {
        status: transaction.status === "FAILED" ? rpc.Api.GetTransactionStatus.FAILED : rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: hash,
        ledger: transaction.ledger,
        createdAt: closeTime(transaction.ledger),
        envelopeXdr: transaction.envelope,
        events: { transactionEventsXdr: [], contractEventsXdr: [transaction.events] },
        ...retention(),
      } as unknown as rpc.Api.GetTransactionResponse;
    },
    async getEvents(request) {
      call("getEvents");
      const [filter] = request.filters;
      const [pattern] = filter!.topics!;
      const from = Address.fromScVal(xdr.ScVal.fromXDR(pattern![1]!, "base64")).toString();
      if (request.startLedger !== undefined && request.startLedger < state.oldestLedger) throw new Error(`startLedger must be at least ${state.oldestLedger}`);
      const limit = request.limit ?? 100;
      const events = transferEvents().filter(
        (event) =>
          filter!.contractIds!.includes(event.asset) &&
          event.from === from &&
          (request.cursor === undefined ? event.ledger >= request.startLedger! : event.id > request.cursor) &&
          (request.endLedger === undefined || event.ledger < request.endLedger),
      );
      const page = events.slice(0, limit);
      return {
        ...retention(),
        cursor: page.at(-1)?.id ?? "",
        // Like current RPCs, without the deprecated inSuccessfulContractCall.
        events: page.map((event) => ({ id: event.id, type: "contract", ledger: event.ledger, txHash: event.txHash })),
      } as unknown as rpc.Api.GetEventsResponse;
    },
  };
  return { chain, state, calls };
}
