// What every CLI command shares: the flags, the usage error, and the Stellar CLI, which signs the owner's
// transactions with a key from its keychain.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { parseArgs } from "node:util";

export const OPTIONS = {
  config: { type: "string", short: "c" },
  manifest: { type: "string" },
  port: { type: "string", short: "p" },
  dev: { type: "boolean" },
  "no-workers": { type: "boolean" },
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
