// What the CLI commands share: the flags, the usage error, and the outside world (Io), which tests replace.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { parseArgs } from "node:util";
import type { ChainReader } from "../chain.js";
import type { Payer } from "../payments.js";
import type { Registry } from "../registry.js";

export const OPTIONS = {
  dev: { type: "boolean" },
  pay: { type: "boolean" },
  json: { type: "boolean" },
  "allow-pubnet": { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  service: { type: "string" },
  input: { type: "string" },
  rpc: { type: "string" },
  "max-price": { type: "string" },
  "max-spend": { type: "string" },
  validator: { type: "string" },
  out: { type: "string", short: "o" },
  "request-hash": { type: "string" },
  "response-uri": { type: "string" },
  source: { type: "string" },
  network: { type: "string" },
  "max-age": { type: "string" },
} as const;

export type CliFlags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/** A mistake in how the CLI was called: printed with the usage text, exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** Where the CLI reads and writes. Tests pass fakes for the network and the Stellar CLI. */
export interface Io {
  /** A line on standard output. */
  out(line: string): void;
  /** A line on standard error. */
  err(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  chain?: ChainReader;
  registry?: Registry;
  /** The test payer, instead of the key in VERIFIER_PAYER_SECRET. */
  payer?: Payer;
  /** Runs the Stellar CLI and returns its standard output. */
  stellar?: (args: string[]) => Promise<string>;
}

const run = promisify(execFile);

export function processIo(): Io {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
    stellar: async (args) => (await run("stellar", args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout,
  };
}

/** Quotes an argument for copying into a shell. */
export function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
