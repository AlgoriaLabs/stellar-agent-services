// On-chain settlement proof: a receipt is a claim until the transaction is confirmed [J16].
//
// The transaction must have succeeded, and its token `transfer` event must move exactly what the user
// approved: the approved asset contract, from the payer, to payTo, for the amount. The expected values
// come from the journal, never from the provider's receipt.

import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { rpc, scValToNative, StrKey, type xdr } from "@stellar/stellar-sdk";

const RPC_URLS: Record<StellarNetwork, string | undefined> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  // There is no public default for mainnet; pass rpcUrl.
  "stellar:pubnet": undefined,
};

/** What the user approved, as journaled in `sending`. */
export interface ExpectedPayment {
  network: StellarNetwork;
  /** The asset's contract address (C...), as in the challenge. */
  asset: string;
  /** Base units. */
  amount: string;
  payTo: string;
  payer: string;
}

export interface Confirmation {
  confirmed: boolean;
  /** Why the payment is not confirmed. */
  reason?: string;
}

export type ConfirmPayment = (transaction: string, expected: ExpectedPayment) => Promise<Confirmation>;

export function rpcConfirmPayment(rpcUrl?: string): ConfirmPayment {
  return async (transaction, expected) => {
    const url = rpcUrl ?? RPC_URLS[expected.network];
    if (url === undefined) throw new Error(`no RPC URL for ${expected.network}; pass rpcUrl`);
    const server = new rpc.Server(url);
    // The provider may answer before the RPC node has ingested the ledger.
    for (let attempt = 0; attempt < 10; attempt++) {
      let result: rpc.Api.GetTransactionResponse;
      try {
        result = await server.getTransaction(transaction);
      } catch (error) {
        return { confirmed: false, reason: `the RPC lookup failed: ${(error as Error).message}` };
      }
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return checkTransfer(result.events.contractEventsXdr.flat(), expected);
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) return { confirmed: false, reason: "the transaction failed on chain" };
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return { confirmed: false, reason: "the transaction is not on chain yet" };
  };
}

/**
 * Matches a transaction's contract events to the approved payment. The payer must send exactly one
 * transfer of the approved asset, and it must go to payTo for the approved amount.
 */
export function checkTransfer(events: readonly xdr.ContractEvent[], expected: ExpectedPayment): Confirmation {
  const transfers = events.flatMap((event) => {
    const contractId = event.contractId();
    // Typed as Opaque[], but a Buffer at runtime.
    if (contractId === null || StrKey.encodeContract(Buffer.from(contractId as unknown as Uint8Array)) !== expected.asset) return [];
    const topics = event.body().v0().topics().map((topic) => scValToNative(topic) as unknown);
    if (topics[0] !== "transfer" || topics[1] !== expected.payer) return [];
    return [{ to: topics[2], amount: transferAmount(event.body().v0().data()) }];
  });
  if (transfers.length === 0) return { confirmed: false, reason: "the transaction has no transfer of the approved asset from the payer" };
  if (transfers.length > 1) return { confirmed: false, reason: `the transaction has ${transfers.length} transfers from the payer, expected one` };
  const [transfer] = transfers;
  if (transfer!.to !== expected.payTo) return { confirmed: false, reason: `the transfer went to ${String(transfer!.to)}, not ${expected.payTo}` };
  if (transfer!.amount !== BigInt(expected.amount)) {
    return { confirmed: false, reason: `the transfer moved ${String(transfer!.amount)}, not ${expected.amount} base units` };
  }
  return { confirmed: true };
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

export function explorerUrl(network: StellarNetwork, transaction: string): string {
  return `https://stellar.expert/explorer/${network === "stellar:pubnet" ? "public" : "testnet"}/tx/${transaction}`;
}
