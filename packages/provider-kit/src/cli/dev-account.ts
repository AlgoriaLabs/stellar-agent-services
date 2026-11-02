// The payout account during development. `provider-kit dev` (and `try`, when it starts the provider itself) make a
// throwaway one when PAY_TO is empty, so the first paid call needs no wallet (docs/provider-setup-guide.md §2).
//
// A new key, in memory only, gets test XLM from Friendbot and signs one transaction: the USDC trustline [P2]. Then the
// key is dropped. It is never written to a file or the environment, and the provider never sees it: the provider
// knows only the public address, as for any payTo (AGENTS.md §4, rule 1). What the account receives is test money
// that nobody can spend. Testnet only. `provider-kit launch` replaces it with an account in the developer's own wallet,
// which is how DEV_PAY_TO, the throwaway's public address kept next to PAY_TO in .env, tells the two apart.

import { stellarAddressKind, type StellarNetwork } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { updateEnvFile } from "./env-file.js";
import { networkName, type OwnerChain } from "./owner-chain.js";

/** The .env variable that holds the throwaway account's address, so `launch` knows PAY_TO isn't the developer's own. */
export const DEV_PAY_TO = "DEV_PAY_TO";

/** What PAY_TO is: unset, a throwaway account made by `provider-kit dev`, or an account the developer holds. */
export type PayToKind = "unset" | "throwaway" | "yours";

export function payToKind(env: NodeJS.ProcessEnv): PayToKind {
  const payTo = env["PAY_TO"];
  if (payTo === undefined || payTo === "") return "unset";
  return payTo === env[DEV_PAY_TO] ? "throwaway" : "yours";
}

/** Makes a throwaway testnet account that can receive USDC, and returns its address. The key is gone when this returns. */
export async function throwawayPayTo(chain: OwnerChain, keypair: Keypair = Keypair.random()): Promise<string> {
  if (chain.network !== "stellar:testnet") throw new Error(`a throwaway payout account is for testnet only, not ${networkName(chain.network)}`);
  const address = keypair.publicKey();
  await chain.fund(address);
  const transaction = await chain.trustline(address);
  transaction.sign(keypair);
  const sent = await chain.send(transaction);
  if (sent.status === "failed") throw new Error(`the throwaway account's USDC trustline failed: ${sent.reason}`);
  if (sent.status === "unknown") throw new Error(`the throwaway account's USDC trustline may not have gone through: ${sent.reason}`);
  return address;
}

export interface DevPayTo {
  payTo: string;
  kind: Exclude<PayToKind, "unset">;
  /** Whether it was made just now. */
  made: boolean;
}

/**
 * PAY_TO for a provider in development: the one set, else a throwaway testnet account made now. A new one goes in
 * `env` and in the env file at `envFile`, when that exists, so the next run uses it again.
 */
export async function devPayTo(options: {
  env: NodeJS.ProcessEnv;
  network: StellarNetwork;
  chain: () => OwnerChain;
  envFile?: string;
  log?: (line: string) => void;
}): Promise<DevPayTo> {
  const { env, network } = options;
  const log = options.log ?? (() => {});
  const kind = payToKind(env);
  if (kind !== "unset") {
    const payTo = env["PAY_TO"]!;
    if (stellarAddressKind(payTo) === undefined) throw new Error(`PAY_TO is not a Stellar address: ${payTo}`);
    return { payTo, kind, made: false };
  }
  if (network !== "stellar:testnet") {
    throw new Error(`PAY_TO is empty. On ${networkName(network)} it must be an account in your own wallet: provider-kit launch sets it up`);
  }
  log("  … PAY_TO is empty: making a throwaway testnet account to receive test payments");
  const payTo = await throwawayPayTo(options.chain());
  env["PAY_TO"] = payTo;
  env[DEV_PAY_TO] = payTo;
  const saved =
    options.envFile !== undefined &&
    (await updateEnvFile(
      options.envFile,
      { PAY_TO: payTo, [DEV_PAY_TO]: payTo },
      { comments: { [DEV_PAY_TO]: "A throwaway testnet account provider-kit dev made, so test payments work before you connect a wallet.\nNobody holds its key, so nobody can spend what it receives. provider-kit launch replaces it with your own." } },
    ));
  log(`  ✓ PAY_TO=${payTo}, a throwaway testnet account${saved ? ` (saved in ${options.envFile})` : ""}`);
  return { payTo, kind: "throwaway", made: true };
}
