// provider-kit CLI (operator side):
//
//   serve --config <file>  gateway mode: put an existing HTTP API behind payment and job recovery
//   init                   write a starter gateway config
//   check                  self-check against Provider Standard v1 (no payment, no keys)
//   trustline              let the payout account receive USDC (signed in the owner's wallet)
//   register               register or update the 8004 identity (signed in the owner's wallet)
//   request-validation     ask a verifier for validation in the 8004 Validation Registry (signed the same way)
//   reconcile              decide payment_uncertain jobs from on-chain data (signs nothing)
//
// This CLI never holds a key. The owner's transactions are signed in their own wallet, on a page the CLI
// serves on this computer (approval.ts), or with --source by the Stellar CLI keychain.
// `serve` is also shipped as a Docker image (packages/provider-kit/Dockerfile).

import { parseArgs } from "node:util";
import { check } from "./check.js";
import { init } from "./init.js";
import { reconcile } from "./reconcile.js";
import { register } from "./register.js";
import { requestValidation } from "./request-validation.js";
import { serve } from "./serve.js";
import { OPTIONS, UsageError } from "./shared.js";
import { trustline } from "./trustline.js";

const USAGE = `provider-kit: run a paid AI service on Stellar (Provider Standard v1)

Usage:
  provider-kit serve --config <file> [--port <n>] [--dev] [--no-workers]
  provider-kit init [--out <file>] [--upstream <url>]
  provider-kit check (--config <file> | --manifest <url>) [--dev]
  provider-kit trustline [--config <file> | --manifest <url> | --network <testnet|mainnet>]
                         [--source <stellar-cli key>] [--rpc <url>] [--dry-run]
  provider-kit register (--config <file> | --manifest <url>) [--source <stellar-cli key>]
                        [--agent-uri <https url>] [--network <stellar-cli network>] [--rpc <url>]
                        [--out <file>] [--dry-run]
  provider-kit request-validation (--config <file> | --manifest <url>) --validator <G...>
                        [--source <stellar-cli key>] [--network <stellar-cli network>] [--rpc <url>]
                        [--out <file>] [--dry-run]
  provider-kit reconcile (--config <file> | --store <file> --network <testnet|pubnet>)
                         [--rpc <url>] [--dry-run] [--dev]

serve       Puts the HTTP API named in the config behind the manifest, x402 payment, job recovery
            and capacity limits. Jobs are kept in SQLite, so paid jobs survive a restart.
init        Writes a starter gateway config to edit.
check       Checks a provider without paying: config, manifest, facilitator, payTo trustline and the
            Stellar 8004 registration. Exits 1 if anything fails.
trustline   Lets the payout account (payTo) receive USDC: a USDC trustline, approved in your wallet.
            A new testnet account gets test XLM first. Without --config or --manifest, it sets up the
            account your wallet connects and prints it as PAY_TO.
register    Registers the provider in the Stellar 8004 identity registry, or updates its registration,
            approved in your wallet from the payTo account. Adds the USDC trustline first if it is
            missing, and saves the new agentId to --config.
request-validation
            Asks a verifier (--validator) to check the provider: validation_request in the Stellar 8004
            Validation Registry, approved in the agent owner's wallet. Prints the request hash for the
            verifier. --out writes the request document once sent.
reconcile   Decides payment_uncertain jobs from on-chain data: paid jobs run (or show their output),
            unpaid ones fail uncharged. A provider with a Soroban RPC does this by itself; --dry-run
            only reports. Exits 1 if any job is still undecided.

Approving in your wallet: trustline, register and request-validation open a page on this computer
where you connect the wallet you already use (Freighter, xBull, Albedo, Hana, Ledger and more),
review each transaction and approve it there. provider-kit never sees a key. --port <n> picks the
page's port (default 8790); --no-open prints its link without opening a browser, as over SSH.
--source <key> signs with the Stellar CLI keychain instead, for scripts and CI; with it, --dry-run
prints the Stellar CLI command.

The provider never needs a Stellar secret key. Docs: docs/provider-setup-guide.md`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [command] = positionals;
  if (values.help || command === undefined || command === "help") {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  switch (command) {
    case "serve":
      return serve(values);
    case "init":
      return init(values);
    case "check":
      return check(values);
    case "trustline":
      return trustline(values);
    case "register":
      return register(values);
    case "request-validation":
      return requestValidation(values);
    case "reconcile":
      return reconcile(values);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    // serve keeps running; everything else exits with its result.
    if (code !== -1) process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"))) {
      console.error(`provider-kit: ${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    console.error(`provider-kit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
