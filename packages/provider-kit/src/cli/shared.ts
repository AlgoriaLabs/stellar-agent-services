// What every CLI command shares: the flags and the usage error.

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
