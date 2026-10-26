// verifier CLI:
//
//   check <manifest-url>     the checks that need no payment and no key (C1, C2, C3, C6, C7)
//   verify <manifest-url>    the same, plus the paid checks with --pay (C4, C5, C7), and a receipt
//   badge <receipt.json>     the SVG badges a receipt earns
//   publish <receipt.json>   validation_response in the Stellar 8004 Validation Registry
//
// The test payer's key comes from VERIFIER_PAYER_SECRET: a dedicated testnet account, never a wallet
// that holds anything else. The validator key never enters this process: publish signs through the
// Stellar CLI keychain.

import { parseArgs } from "node:util";
import { badge } from "./badge.js";
import { publish } from "./publish.js";
import { runChecks } from "./run.js";
import { OPTIONS, UsageError, type Io } from "./shared.js";

export const USAGE = `verifier: check a provider against Provider Standard v1 (stellar-agent-services/provider@1)

Usage:
  verifier check <manifest-url> [--dev] [--service <name> [--input <json>]] [--rpc <url>] [--json]
  verifier verify <manifest-url> [--pay] [--dev] [--service <name> [--input <json>]] [--rpc <url>]
                  [--max-price <usdc>] [--max-spend <usdc>] [--allow-pubnet]
                  [--validator <G...> --out <dir>] [--json]
  verifier badge <receipt.json> [--out <dir>] [--request-hash <hex>] [--rpc <url>]
  verifier publish <receipt.json> --request-hash <hex> --response-uri <https url>
                   --source <stellar-cli key> [--network <stellar-cli network>] [--rpc <url>]
                   [--max-age <hours>] [--dry-run]

check    Runs the checks that need no payment and no key: C1 manifest, C2 identity, C3 challenge,
         C6 hygiene and C7 load. --dev also accepts a provider on http://localhost.
verify   The same, plus, with --pay, the paid checks: C4 paid call, C5 recovery and C7's paid part.
         The test payer is the key in VERIFIER_PAYER_SECRET, a dedicated testnet account holding USDC.
         It pays at most --max-price for a job (default 0.10 USDC) and --max-spend in a run (default
         1.00). With --validator and --out, writes the verification receipt to <out>/<sha256>.json.
badge    Writes the SVG badges a receipt earns next to it, or to --out. With --request-hash, also
         "8004 validated", once the Validation Registry record matches the receipt.
publish  Answers a validation request with the receipt: validation_response in the Stellar 8004
         Validation Registry, signed with a key from the Stellar CLI keychain (--source). The receipt
         must already be served at --response-uri. --dry-run prints the command instead.

--json prints the report, or the receipt, as JSON on standard output.
Exit codes: 0 every check that ran passed, 1 a check or the command failed, 2 a usage error.
Docs: docs/verification.md`;

/** Runs one command and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const [command, target, ...extra] = positionals;
    if (values.help || command === undefined || command === "help") {
      io.out(USAGE);
      return values.help || command === "help" ? 0 : 2;
    }
    if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
    switch (command) {
      case "check":
      case "verify":
        if (target === undefined) throw new UsageError(`${command} needs <manifest-url>`);
        return await runChecks(command, target, values, io);
      case "badge":
        if (target === undefined) throw new UsageError("badge needs <receipt.json>");
        return await badge(target, values, io);
      case "publish":
        if (target === undefined) throw new UsageError("publish needs <receipt.json>");
        return await publish(target, values, io);
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"))) {
      io.err(`verifier: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`verifier: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
