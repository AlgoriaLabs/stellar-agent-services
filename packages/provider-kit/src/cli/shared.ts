// What every CLI command shares: the flags, the usage error, and the two ways the owner's transactions are
// signed: in the owner's own wallet on a local approval page (cli/approval.ts), or with --source by the
// Stellar CLI, with a key from its keychain.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { parseArgs } from "node:util";
import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { rpcRegistry, type RegistryReader } from "../registration.js";
import { approveInBrowser, type ApprovalOutcome, type ApprovalPlan } from "./approval.js";
import { rpcOwnerChain, type OwnerChain } from "./owner-chain.js";

export const OPTIONS = {
  config: { type: "string", short: "c" },
  manifest: { type: "string" },
  port: { type: "string", short: "p" },
  dev: { type: "boolean" },
  "no-workers": { type: "boolean" },
  "no-open": { type: "boolean" },
  out: { type: "string", short: "o" },
  upstream: { type: "string" },
  source: { type: "string" },
  "agent-uri": { type: "string" },
  validator: { type: "string" },
  network: { type: "string" },
  store: { type: "string" },
  rpc: { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export type CliFlags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/** A mistake in how the CLI was called: printed with the usage text, exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** Runs the Stellar CLI (https://developers.stellar.org/docs/tools/cli) and returns its standard output. */
export type StellarCli = (args: string[]) => Promise<string>;

const run = promisify(execFile);

/** The installed Stellar CLI, or undefined when it is not installed. */
export async function findStellarCli(): Promise<StellarCli | undefined> {
  try {
    await run("stellar", ["--version"], { timeout: 10_000 });
  } catch {
    return undefined;
  }
  return async (args) => (await run("stellar", args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout;
}

/** Quotes an argument for copying into a shell. A $(...) placeholder stays a command substitution. */
export function quote(arg: string): string {
  if (arg.startsWith("$(")) return `"${arg}"`;
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Where the owner commands (trustline, register, request-validation) reach the outside world. Tests replace it. */
export interface OwnerIo {
  /** The Stellar CLI, or undefined when it is not installed: for --source. */
  stellar(): Promise<StellarCli | undefined>;
  registry(network: StellarNetwork, rpcUrl?: string): RegistryReader;
  chain(network: StellarNetwork, rpcUrl?: string): OwnerChain;
  /** Has the developer approve `plan` in their wallet: the local approval page. */
  approve(plan: ApprovalPlan, chain: OwnerChain): Promise<ApprovalOutcome>;
  now(): Date;
}

export function ownerIo(flags: CliFlags): OwnerIo {
  const port = flags.port === undefined ? undefined : Number(flags.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new UsageError("--port must be a port number");
  return {
    stellar: findStellarCli,
    registry: rpcRegistry,
    chain: rpcOwnerChain,
    approve: (plan, chain) => approveInBrowser(plan, chain, { open: !flags["no-open"], ...(port === undefined ? {} : { port }) }),
    now: () => new Date(),
  };
}

/** --network as a network id: testnet or mainnet, also written pubnet, stellar:testnet or stellar:pubnet. */
export function parseNetwork(value: string): StellarNetwork {
  if (["testnet", "stellar:testnet"].includes(value)) return "stellar:testnet";
  if (["mainnet", "pubnet", "public", "stellar:pubnet"].includes(value)) return "stellar:pubnet";
  throw new UsageError(`--network must be testnet or mainnet, not "${value}"`);
}
