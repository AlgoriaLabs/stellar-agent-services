// What the page keeps in this browser next to the journal (which payment-client/browser stores): the
// test wallet's key and the spending policy.
//
// Testnet only. A key in site storage is fine for test money, never for real money: real wallets come in
// through Stellar Wallets Kit or a passkey account (docs/payment-client.md, "Strategies").

import type { SpendingPolicy } from "@stellar-agent-services/payment-client";
import type { StellarNetwork } from "@stellar-agent-services/protocol";

export interface StoredWallet {
  version: 1;
  network: StellarNetwork;
  address: string;
  secret: string;
}

const WALLET = "agent-wallet.wallet";
const POLICY = "agent-wallet.policy";
const TITLES = "agent-wallet.titles";

export function readWallet(): StoredWallet | undefined {
  return read<StoredWallet>(WALLET);
}

export function writeWallet(wallet: StoredWallet): void {
  localStorage.setItem(WALLET, JSON.stringify(wallet));
}

export function readPolicy(): SpendingPolicy | undefined {
  return read<SpendingPolicy>(POLICY);
}

export function writePolicy(policy: SpendingPolicy): void {
  localStorage.setItem(POLICY, JSON.stringify(policy));
}

/** Service titles by "baseUrl#name", for the history: the journal keeps only names. */
export function readTitles(): Record<string, string> {
  return read<Record<string, string>>(TITLES) ?? {};
}

export function writeTitles(titles: Record<string, string>): void {
  localStorage.setItem(TITLES, JSON.stringify(titles));
}

function read<T>(key: string): T | undefined {
  const text = localStorage.getItem(key);
  return text === null ? undefined : (JSON.parse(text) as T);
}
