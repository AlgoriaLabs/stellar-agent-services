// The test wallet's account on Stellar testnet: balances from Horizon, and funding through Friendbot and
// the testnet exchange, as `stellar-pay wallet fund` does.

import { Asset, Horizon, Keypair, Networks, NotFoundError, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { parseAmount } from "./format.js";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

/** In base units. `usdc` is undefined until the account trusts USDC. */
export interface Balances {
  xlm: bigint;
  usdc: bigint | undefined;
}

export type FundingStep = "xlm" | "usdc";

/** Undefined while the account does not exist on chain. */
export async function readBalances(address: string): Promise<Balances | undefined> {
  const account = await loadAccount(new Horizon.Server(HORIZON_URL), address);
  if (account === undefined) return undefined;
  let xlm = 0n;
  let usdc: bigint | undefined;
  for (const balance of account.balances) {
    if (balance.asset_type === "native") xlm = parseAmount(balance.balance) ?? 0n;
    else if ("asset_code" in balance && balance.asset_code === USDC.code && balance.asset_issuer === USDC.issuer) {
      usdc = parseAmount(balance.balance) ?? 0n;
    }
  }
  return { xlm, usdc };
}

/** Test XLM from Friendbot if the account is new, then a USDC trustline and `usdc` bought with XLM. */
export async function fundTestWallet(secret: string, usdc: string, onStep: (step: FundingStep) => void): Promise<void> {
  const keypair = Keypair.fromSecret(secret);
  const horizon = new Horizon.Server(HORIZON_URL);
  let account = await loadAccount(horizon, keypair.publicKey());
  if (account === undefined) {
    onStep("xlm");
    const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(keypair.publicKey())}`);
    if (!response.ok) throw new Error(`Friendbot could not fund the account (it answered ${response.status}). Try again in a minute.`);
    account = await horizon.loadAccount(keypair.publicKey());
  }

  onStep("usdc");
  const trusted = account.balances.some((b) => "asset_code" in b && b.asset_code === USDC.code && b.asset_issuer === USDC.issuer);
  const builder = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET }).setTimeout(60);
  if (!trusted) builder.addOperation(Operation.changeTrust({ asset: USDC }));
  builder.addOperation(
    Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: "1000", destination: keypair.publicKey(), destAsset: USDC, destAmount: usdc, path: [] }),
  );
  const transaction = builder.build();
  transaction.sign(keypair);
  try {
    await horizon.submitTransaction(transaction);
  } catch (error) {
    throw new Error(explainSubmitError(error));
  }
}

export function accountExplorerUrl(address: string): string {
  return `https://stellar.expert/explorer/testnet/account/${address}`;
}

async function loadAccount(horizon: Horizon.Server, address: string) {
  try {
    return await horizon.loadAccount(address);
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

function explainSubmitError(error: unknown): string {
  const codes = (error as { response?: { data?: { extras?: { result_codes?: { operations?: string[] } } } } }).response?.data?.extras?.result_codes?.operations ?? [];
  if (codes.includes("op_too_few_offers") || codes.includes("op_over_source_max")) {
    return "The testnet exchange has no USDC for sale right now. Try again later, or get test USDC from faucet.circle.com.";
  }
  return `Stellar did not accept the funding transaction${codes.length > 0 ? ` (${codes.join(", ")})` : ""}.`;
}
