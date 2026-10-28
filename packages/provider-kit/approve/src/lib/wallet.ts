// The developer's own wallet, through Stellar Wallets Kit (https://stellarwalletskit.dev): every wallet the kit
// supports without extra setup (Freighter, LOBSTR, xBull, Albedo, Rabet, Hana and more), plus Ledger over USB.
// The page asks the wallet for two things only: the connected account, and a signature on the transaction the
// terminal built. The terminal checks that signature before it sends anything.

import { LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { parseError, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import type { Networks, SwkAppTheme } from "@creit.tech/stellar-wallets-kit/types";

/**
 * The kit's wallet picker in the page's own colors. The kit sets these as CSS variables, so the page's tokens
 * resolve through them and the picker follows light and dark mode with the page.
 */
const THEME: SwkAppTheme = {
  background: "var(--surface)",
  "background-secondary": "var(--surface-sunken)",
  "foreground-strong": "var(--text)",
  foreground: "var(--text)",
  "foreground-secondary": "var(--text-secondary)",
  primary: "var(--accent-solid)",
  "primary-foreground": "var(--on-accent)",
  transparent: "rgba(0, 0, 0, 0)",
  lighter: "var(--surface)",
  light: "var(--surface-sunken)",
  "light-gray": "var(--border-strong)",
  gray: "var(--text-tertiary)",
  danger: "var(--danger)",
  border: "var(--border)",
  shadow: "var(--shadow-lg)",
  "border-radius": "var(--radius-lg)",
  "font-family": "var(--font-sans)",
};

let started = false;

export function startWallets(networkPassphrase: string): void {
  if (started) return;
  started = true;
  StellarWalletsKit.init({
    modules: [...defaultModules(), new LedgerModule()],
    network: networkPassphrase as Networks,
    theme: THEME,
    authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
  });
}

/** Opens the wallet picker. Undefined when the developer closes it. */
export async function connectWallet(): Promise<{ address: string; wallet: string } | undefined> {
  try {
    const { address } = await StellarWalletsKit.authModal();
    return { address, wallet: StellarWalletsKit.selectedModule.productName };
  } catch (error) {
    if (parseError(error).message === "The user closed the modal.") return undefined;
    throw error;
  }
}

/** The network the wallet is on, for the wallets that say. */
export async function walletNetwork(): Promise<string | undefined> {
  try {
    return (await StellarWalletsKit.getNetwork()).networkPassphrase;
  } catch {
    return undefined;
  }
}

/** Asks the wallet to sign the transaction as it is. */
export async function signInWallet(xdr: string, address: string, networkPassphrase: string): Promise<string> {
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, { address, networkPassphrase });
  return signedTxXdr;
}

/** A wallet's error, in words the page can show. */
export function walletProblem(error: unknown): { title: string; message: string } {
  const { message } = parseError(error);
  if (/declin|reject|denied|cancel/i.test(message)) return { title: "You declined in your wallet", message: "Nothing was signed. Approve again when you're ready." };
  return { title: "Your wallet couldn't do that", message };
}
