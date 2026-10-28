// The developer's own wallet, through Stellar Wallets Kit (https://stellarwalletskit.dev): Freighter, xBull,
// Albedo, Rabet, Hana, MetaMask and the kit's other wallets that need no extra setup, plus Ledger over USB.
// The page asks the wallet for two things only: the connected account, and a signature on the transaction the
// terminal built. The terminal checks that signature before it sends anything.
//
// The modules are imported one by one, without LOBSTR's: its connector, @lobstrco/signer-extension-api, is
// GPL-3.0, and this page ships in provider-kit's MIT package. The kit's defaultModules() would bundle it even when
// filtered out, so don't use it. vite.config.ts fails the build if copyleft code would be bundled.

import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { BitgetModule } from "@creit.tech/stellar-wallets-kit/modules/bitget";
import { CactusLinkModule } from "@creit.tech/stellar-wallets-kit/modules/cactuslink";
import { DcentModule } from "@creit.tech/stellar-wallets-kit/modules/dcent";
import { FordefiModule } from "@creit.tech/stellar-wallets-kit/modules/fordefi";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { GhostsigModule } from "@creit.tech/stellar-wallets-kit/modules/ghostsig";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { KleverModule } from "@creit.tech/stellar-wallets-kit/modules/klever";
import { LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import { MetaMaskModule } from "@creit.tech/stellar-wallets-kit/modules/metamask";
import { OneKeyModule } from "@creit.tech/stellar-wallets-kit/modules/onekey";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { ScopulyModule } from "@creit.tech/stellar-wallets-kit/modules/scopuly";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { parseError, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import type { ModuleInterface, Networks, SwkAppTheme } from "@creit.tech/stellar-wallets-kit/types";

/** The wallets the picker offers. It lists the installed ones first, in this order. */
function walletModules(): ModuleInterface[] {
  return [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new RabetModule(),
    new HanaModule(),
    new MetaMaskModule(),
    new KleverModule(),
    new OneKeyModule(),
    new BitgetModule(),
    new FordefiModule(),
    new CactusLinkModule(),
    new DcentModule(),
    new ScopulyModule(),
    new GhostsigModule(),
    new LedgerModule(),
  ];
}

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
    modules: walletModules(),
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
