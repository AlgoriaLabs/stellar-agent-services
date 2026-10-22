// SAC `transfer` events and a fake chain that serves them, for confirmation tests without the network.

import { nativeToScVal, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import type { TransactionReader } from "../../src/index.js";

export function transferEvent(options: { asset: string; from: string; to: string; data?: xdr.ScVal }): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(options.asset),
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
        data: options.data ?? nativeToScVal(100000n, { type: "i128" }),
      }),
    ),
  });
}

/** Serves each transaction as succeeded with the given events; any other hash is not found. */
export function fakeChain(transactions: Record<string, xdr.ContractEvent[]>): TransactionReader {
  return {
    async getTransaction(hash: string) {
      const events = transactions[hash];
      if (events === undefined) return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as rpc.Api.GetTransactionResponse;
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, events: { contractEventsXdr: [events] } } as unknown as rpc.Api.GetTransactionResponse;
    },
  };
}
