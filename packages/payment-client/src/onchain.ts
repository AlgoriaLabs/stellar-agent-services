// On-chain settlement proof: a receipt is a claim until the transaction is confirmed [J16].
//
// PoC: the transaction exists on chain and succeeded.
// TODO: also decode its USDC `transfer` event and match payer, payTo and amount to the receipt.

import type { PaymentReceipt, StellarNetwork } from "@stellar-agent-services/protocol";
import { rpc } from "@stellar/stellar-sdk";

const RPC_URLS: Record<StellarNetwork, string | undefined> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  // There is no public default for mainnet; pass rpcUrl.
  "stellar:pubnet": undefined,
};

export type ConfirmPayment = (receipt: PaymentReceipt) => Promise<boolean>;

export function rpcConfirmPayment(rpcUrl?: string): ConfirmPayment {
  return async (receipt) => {
    const url = rpcUrl ?? RPC_URLS[receipt.network];
    if (url === undefined) throw new Error(`no RPC URL for ${receipt.network}; pass rpcUrl`);
    const server = new rpc.Server(url);
    // The provider may answer before the RPC node has ingested the ledger.
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await server.getTransaction(receipt.transaction);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return true;
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) return false;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return false;
  };
}

export function explorerUrl(network: StellarNetwork, transaction: string): string {
  return `https://stellar.expert/explorer/${network === "stellar:pubnet" ? "public" : "testnet"}/tx/${transaction}`;
}
