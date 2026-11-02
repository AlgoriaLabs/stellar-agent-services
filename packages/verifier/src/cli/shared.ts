// What the CLI commands share: the flags, the usage error, and the outside world (Io), which tests replace.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { parseArgs } from "node:util";
import type { ChainReader } from "../chain.js";
import type { Payer } from "../payments.js";
import type { Registry, ValidatorIndex } from "../registry.js";
import type { Handler, Served } from "./serve.js";

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
  "public-url": { type: "string" },
  port: { type: "string" },
  data: { type: "string" },
  interval: { type: "string" },
  "retry-for": { type: "string" },
} as const;

/** The flags only `verifier watch` takes. */
export const WATCH_FLAGS = ["public-url", "port", "data", "interval", "retry-for"] as const;

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
  registry?: Registry & ValidatorIndex;
  /** The test payer, instead of the key in VERIFIER_PAYER_SECRET. */
  payer?: Payer;
  /** Runs the Stellar CLI and returns its standard output. */
  stellar?: (args: string[]) => Promise<string>;
  /** Serves `watch`'s HTTP side. Default: Node's HTTP server on every interface. */
  serve?: (handler: Handler, port: number) => Promise<Served>;
  /** Stops `watch`. Default: SIGINT or SIGTERM. */
  signal?: AbortSignal;
  /** Waits between `watch`'s rounds, until `signal` stops it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
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
