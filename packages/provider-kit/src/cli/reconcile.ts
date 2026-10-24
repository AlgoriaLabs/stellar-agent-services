// provider-kit reconcile: decides payment_uncertain jobs from on-chain data [J13].
//
// A provider with a Soroban RPC does this by itself after every recovery sweep (jobs/reconcile.ts).
// This command is for the operator: to see where uncertain jobs stand (--dry-run), to decide them
// while the provider is stopped or has no RPC, or with another RPC (--rpc), such as one that keeps
// more history. It reads the chain and writes only the job store, compare-and-set, so it is safe next
// to a running provider. It signs nothing.

import { existsSync } from "node:fs";
import { USDC_ASSET, type StellarNetwork } from "@stellar-agent-services/protocol";
import { loadGatewayConfig } from "../gateway/config.js";
import { reconcile as reconcileStore, type Reconciled } from "../jobs/reconcile.js";
import { sqliteStore } from "../jobs/sqlite-store.js";
import type { JobStore } from "../jobs/store.js";
import { rpcChain } from "../payments/chain.js";
import { UsageError, type CliFlags } from "./shared.js";

const NETWORKS: Readonly<Record<string, StellarNetwork>> = {
  testnet: "stellar:testnet",
  "stellar:testnet": "stellar:testnet",
  mainnet: "stellar:pubnet",
  pubnet: "stellar:pubnet",
  "stellar:pubnet": "stellar:pubnet",
};

/** Jobs looked at in one run, oldest first: run it again for more. */
const LIMIT = 1000;

export async function reconcile(flags: CliFlags): Promise<number> {
  const { store, network, rpcUrl, source } = await openJobs(flags);
  try {
    const chain = rpcChain(network, flags.rpc ?? rpcUrl, { dev: flags.dev ?? false });
    if (chain === undefined) throw new UsageError(`there is no public Soroban RPC for ${network}: pass --rpc <url>`);
    const dryRun = flags["dry-run"] ?? false;
    console.log(`Reconciling the payment_uncertain jobs of ${source} on ${network}${dryRun ? " (dry run: nothing changes)" : ""}`);

    const results = await reconcileStore(store, { chain, network, asset: USDC_ASSET[network], dryRun, limit: LIMIT });
    if (results.length === 0) {
      console.log("No payment_uncertain jobs.");
      return 0;
    }
    for (const result of results) console.log(`  ${describe(result, dryRun)}`);
    const undecided = results.filter((result) => result.outcome === "undecided").length;
    console.log(`${results.length} job(s): ${results.length - undecided} decided, ${undecided} undecided.`);
    if (results.length === LIMIT) console.log(`Looked at the oldest ${LIMIT}; run it again for the rest.`);
    return undecided === 0 ? 0 : 1;
  } finally {
    await store.close?.();
  }
}

async function openJobs(flags: CliFlags): Promise<{ store: JobStore; network: StellarNetwork; rpcUrl: string | undefined; source: string }> {
  if ((flags.config === undefined) === (flags.store === undefined)) throw new UsageError("pass --config <file>, or --store <file> with --network");
  if (flags.config !== undefined) {
    const { config } = await loadGatewayConfig(flags.config, { overrides: flags.dev ? { dev: true } : {} });
    return { store: config.store!, network: config.network, rpcUrl: typeof config.rpc === "string" ? config.rpc : undefined, source: flags.config };
  }
  const network = NETWORKS[flags.network ?? ""];
  if (network === undefined) throw new UsageError("--store needs --network testnet or pubnet");
  // sqliteStore() would create a missing file: a typo must not look like a store with nothing to do.
  if (!existsSync(flags.store!)) throw new Error(`there is no job store at ${flags.store}`);
  return { store: sqliteStore(flags.store!), network, rpcUrl: undefined, source: flags.store! };
}

function describe(result: Reconciled, dryRun: boolean): string {
  const job = `${result.jobId} (${result.service})`;
  const now = `${dryRun ? "would be" : "now"} ${result.status}`;
  switch (result.outcome) {
    case "settled":
      return `✓ ${job}: settled in ${result.transaction}; ${now}`;
    case "not_settled":
      return `✓ ${job}: not settled, nothing was charged (${result.reason}); ${now}`;
    case "undecided":
      return `! ${job}: undecided, still payment_uncertain: ${result.reason}`;
  }
}
