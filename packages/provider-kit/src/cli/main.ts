// provider-kit CLI (operator side):
//
//   dev                    run a provider on this computer, on testnet, with no wallet (a throwaway payTo)
//   try                    one paid testnet call, from a throwaway payer that only lives in memory
//   launch                 take it live: one wallet approval registers it, then deploy and wait for it
//   status                 where it stands, from this computer to verified, and what to run next
//   serve --config <file>  gateway mode: put an existing HTTP API behind payment and job recovery
//   init                   write a starter gateway config, or one from an OpenAPI document
//   check                  self-check against Provider Standard v1 (no payment, no keys)
//   trustline              let the payout account receive USDC (signed in the owner's wallet)
//   register               register or update the 8004 identity (signed in the owner's wallet)
//   request-validation     ask a verifier for validation in the 8004 Validation Registry (signed the same way)
//   reconcile              decide payment_uncertain jobs from on-chain data (signs nothing)
//   wallet                 show a local wallet, withdraw its income, or export it to a wallet app
//
// By default this CLI never holds the owner's key. The owner's transactions are signed in their own wallet, on a
// page the CLI serves on this computer (approval.ts), or with --source by the Stellar CLI keychain. The keys it
// makes by itself are throwaway testnet ones, kept in memory and never written anywhere: try's payer, and dev's
// payout account (dev-account.ts), whose key is dropped once its USDC trustline is signed.
// The one exception is asked for: with --local-wallet, it makes an owner account and keeps its key in the OS
// keychain, outside the project (wallet-store.ts), and signs the owner's steps with it (local-wallet.ts). The
// provider still gets only the public address.
// `serve` is also shipped as a Docker image (packages/provider-kit/Dockerfile).

import { parseArgs } from "node:util";
import { check } from "./check.js";
import { dev } from "./dev.js";
import { init } from "./init.js";
import { launch } from "./launch.js";
import { reconcile } from "./reconcile.js";
import { register } from "./register.js";
import { requestValidation } from "./request-validation.js";
import { serve } from "./serve.js";
import { OPTIONS, UsageError } from "./shared.js";
import { status } from "./status.js";
import { trustline } from "./trustline.js";
import { tryCall } from "./try.js";
import { wallet } from "./wallet.js";

const USAGE = `provider-kit: run a paid AI service on Stellar (Provider Standard v1)

From nothing to live:
  provider-kit dev [--config <file>] [--with '<command>'] [--tunnel] [-- <command> ...]
  provider-kit try [<service>] ['<input JSON>' | @<file>] [--config <file> | --manifest <url>]
                   [--start '<command>'] [--yes] [--json]
  provider-kit launch [--config <file> | --start '<command>' | --manifest <url>] [--url <https origin>]
                      [--validator <G...> | --no-validation] [--deploy | --no-deploy] [--no-wait]
                      [--local-wallet]
  provider-kit status [--config <file>] [--url <https origin>] [--json]

More:
  provider-kit serve --config <file> [--port <n>] [--dev] [--no-workers]
  provider-kit init [--out <file>] [--upstream <url>] [--openapi <file | url>] [--json]
  provider-kit check (--config <file> | --manifest <url>) [--dev] [--fix] [--json]
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
  provider-kit wallet [show] [--network <testnet|mainnet>] [--json]
  provider-kit wallet withdraw --to <G...> --network <testnet|mainnet> [--amount <n>]
                               [--asset usdc|xlm] [--memo <text>] [--wallet <G...>] [--yes]
  provider-kit wallet export [--wallet <G...>]

dev         Runs the provider on this computer: a gateway config (default ./provider.config.json),
            or your own command after --. Reads .env. On testnet, with PAY_TO empty, it makes a
            throwaway testnet account to be paid to, so no wallet is needed yet: its key is dropped
            once it can hold USDC. On mainnet, PAY_TO must be your own account: launch sets it up.
            --with runs the API the gateway calls next to it. --tunnel also serves it at a temporary
            public HTTPS address (cloudflared).
try         Pays for one job on testnet, the way any client does, and shows the result and the
            payment on chain. The payer is a throwaway test account, funded with test XLM and test
            USDC, kept in memory only. Without an input, it uses the service's example. When nothing
            answers, it starts the provider for the call: the gateway config, or --start's command.
            It shows the exact payment and asks first; --yes pays without asking.
launch      Takes the provider live at its public HTTPS address (--url, fly.toml's app, or an https://
            PUBLIC_ORIGIN). One page in your wallet adds the USDC trustline, registers it in Stellar
            8004 (or updates the registration) and asks a verifier to check it. Saves PAY_TO and
            AGENT_ID, then deploys with flyctl when fly.toml is there and you agree, and waits until
            the public manifest is live. --start builds the manifest from your provider's own command.
status      Shows where the provider stands: running here, paid once, registered, live, verified,
            and the one command to run next. --json for scripts and coding agents.
serve       Puts the HTTP API named in the config behind the manifest, x402 payment, job recovery
            and capacity limits. Jobs are kept in SQLite, so paid jobs survive a restart.
init        Writes a starter gateway config to edit. With --openapi, writes a service for each POST
            endpoint of an OpenAPI 3 document (JSON or YAML, a file or a URL such as FastAPI's
            /openapi.json), says why it skipped the others, and checks the config as serve would.
            --upstream is then the API's address, when the document doesn't name a full one.
check       Checks a provider without paying: config, manifest, facilitator, payTo trustline and the
            Stellar 8004 registration, then how agents see it. --fix writes the words search would
            miss into the config's provider.description. Exits 1 if anything fails.
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
wallet      Manages a local wallet (see below). show lists them with their balances. withdraw pays
            its USDC (all, or --amount) or XLM (--amount) to an account of yours, after showing the
            payment and asking; --yes pays without asking. export shows the secret key, to import
            the account into a wallet app: only to a person at a terminal, never to a script.

Approving in your wallet: launch, trustline, register and request-validation open a page on this
computer where you connect the wallet you already use (Freighter, xBull, Albedo, Hana, Ledger and
more), review each transaction and approve it there. provider-kit never sees a key. --port <n> picks
the page's port (default 8790); --no-open prints its link without opening a browser, as over SSH.
--source <key> signs with the Stellar CLI keychain instead, for scripts and CI (trustline, register,
request-validation); with it, --dry-run prints the Stellar CLI command.

No wallet app: --local-wallet (launch, trustline, register, request-validation) signs the same steps
with a local wallet instead. provider-kit makes the account, keeps its key in your OS keychain (never
in the project, never printed) and reuses it for this project. On testnet it needs nothing from you.
On mainnet it names the account and the XLM to send it (about 2.5), and waits. The account is paid your income:
provider-kit wallet shows, withdraws and exports it.

The provider never needs a Stellar secret key. Docs: docs/provider-setup-guide.md`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [command, ...args] = positionals;
  if (values.help || command === undefined || command === "help") {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  switch (command) {
    case "dev":
      return dev(values, args);
    case "launch":
      if (args.length > 0) throw new UsageError("launch takes no arguments: --start '<command>' runs your provider's command");
      return launch(values);
    case "status":
      if (args.length > 0) throw new UsageError("status takes no arguments");
      return status(values);
    case "serve":
      return serve(values);
    case "init":
      return init(values);
    case "check":
      return check(values);
    case "try":
      return tryCall(values, args);
    case "trustline":
      return trustline(values);
    case "register":
      return register(values);
    case "request-validation":
      return requestValidation(values);
    case "reconcile":
      return reconcile(values);
    case "wallet":
      return wallet(values, args);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    // serve and dev's gateway keep running; everything else exits with its result.
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
