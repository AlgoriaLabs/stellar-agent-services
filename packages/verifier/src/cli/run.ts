// verifier check and verifier verify: run the checks, print each result as it finishes, and, for verify
// with --validator and --out, write the verification receipt.

import { CONFORMANCE_LEVELS, stellarAddressKind, type CheckId, type CheckResult, type JsonObject } from "@stellar-agent-services/protocol";
import { localKeyPayer, formatUsdc, parseUsdc, type Payer } from "../payments.js";
import { issueReceipt, writeReceipt } from "../receipt.js";
import { InvalidOptionsError, verifyProvider, type VerificationReport } from "../verify.js";
import { UsageError, type CliFlags, type Io } from "./shared.js";

const NAMES: Readonly<Record<CheckId, string>> = {
  C1: "Manifest",
  C2: "Identity",
  C3: "Challenge",
  C4: "Paid call",
  C5: "Recovery",
  C6: "Hygiene",
  C7: "Load",
};
const MARK = { passed: "✓", failed: "✗", skipped: "-" } as const;

export async function runChecks(command: "check" | "verify", manifestUrl: string, flags: CliFlags, io: Io): Promise<number> {
  const verify = command === "verify";
  for (const flag of ["pay", "max-price", "max-spend", "allow-pubnet", "validator", "out"] as const) {
    if (!verify && flags[flag] !== undefined) throw new UsageError(`--${flag} belongs to verify; check never pays and issues no receipt`);
  }
  for (const flag of ["request-hash", "response-uri", "source", "network", "max-age", "dry-run"] as const) {
    if (flags[flag] !== undefined) throw new UsageError(`--${flag} belongs to ${flag === "request-hash" ? "badge or publish" : "publish"}`);
  }
  if (flags.input !== undefined && flags.service === undefined) throw new UsageError("--input needs --service");
  const input = flags.input === undefined ? undefined : parseInput(flags.input);
  if ((flags.validator === undefined) !== (flags.out === undefined)) throw new UsageError("--validator and --out go together: the receipt names its validator");
  if (flags.validator !== undefined && stellarAddressKind(flags.validator) !== "account") throw new UsageError("--validator must be the verifier's G... account address");
  if (flags.validator !== undefined && flags.dev) throw new UsageError("receipts are never issued in development mode");
  const maxPrice = usdc(flags["max-price"], "--max-price");
  const maxSpend = usdc(flags["max-spend"], "--max-spend");
  const payer = flags.pay ? testPayer(io, flags.rpc) : undefined;

  // With --json, standard output is the JSON alone, and the progress goes to standard error.
  const print = flags.json ? io.err : io.out;
  print(`Provider Standard v1 ${command}${payer === undefined ? "" : ` with test payer ${payer.address}`}: ${manifestUrl}`);
  let report: VerificationReport;
  try {
    report = await verifyProvider({
      manifestUrl,
      dev: flags.dev ?? false,
      ...(flags.service === undefined ? {} : { service: flags.service }),
      ...(input === undefined ? {} : { input }),
      ...(payer === undefined ? {} : { payer }),
      ...(maxPrice === undefined ? {} : { maxPrice }),
      ...(maxSpend === undefined ? {} : { maxSpend }),
      allowPubnet: flags["allow-pubnet"] ?? false,
      ...(io.chain !== undefined ? { rpc: io.chain } : flags.rpc !== undefined ? { rpc: flags.rpc } : {}),
      ...(io.registry === undefined ? {} : { registry: io.registry }),
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      onResult: (result) => printResult(result, print),
    });
  } catch (error) {
    if (error instanceof InvalidOptionsError) throw new UsageError(error.message);
    throw error;
  }
  printSummary(report, print);

  if (flags.validator !== undefined && flags.out !== undefined) {
    const receipt = issueReceipt(report, { validator: flags.validator });
    const { path, sha256 } = await writeReceipt(receipt, flags.out);
    print(`Receipt: ${path}`);
    print(`  response_hash ${sha256}`);
    print(`  Publish the file exactly as written, then: verifier publish ${path} --request-hash <hex> --response-uri <its https URL> --source <key>`);
    if (flags.json) io.out(JSON.stringify(receipt, null, 2));
  } else if (flags.json) {
    io.out(JSON.stringify(report, null, 2));
  }
  return report.results.some((result) => result.status === "failed") ? 1 : 0;
}

function printResult(result: CheckResult, print: (line: string) => void): void {
  const head = `  ${MARK[result.status]} ${result.check} ${NAMES[result.check]}`;
  print(result.status === "skipped" ? `${head}: skipped, ${result.reason}` : head);
  for (const finding of result.findings ?? []) print(`      ${finding.severity === "fail" ? "✗" : "!"} [${finding.rule}] ${finding.message}`);
}

function printSummary(report: VerificationReport, print: (line: string) => void): void {
  const status = (check: CheckId) => report.results.find((result) => result.check === check)?.status;
  const name = CONFORMANCE_LEVELS.find((level) => level.level === report.level)?.name ?? "not Described";
  print("");
  print(`Level ${report.level} (${name}): score ${report.score} of 100.`);
  if (status("C2") === "passed") print("Identity (C2) passed: with a Validation Registry record, the provider is Registered.");
  if (status("C7") === "passed") print("Load (C7) passed: Load-safe.");
  if (report.payer !== undefined) print(`The test payer signed for ${formatUsdc(BigInt(report.spent))}.`);
  const failed = report.results.filter((result) => result.status === "failed").length;
  print(failed === 0 ? "Every check that ran passed." : `${failed} check(s) failed.`);
}

function parseInput(text: string): JsonObject {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new UsageError(`--input must be a JSON object, such as '{"text":"Hello"}'`);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new UsageError("--input must be a JSON object");
  return input as JsonObject;
}

function usdc(value: string | undefined, flag: string): bigint | undefined {
  if (value === undefined) return undefined;
  const units = parseUsdc(value);
  if (units === undefined || units === 0n) throw new UsageError(`${flag} must be a USDC amount above zero, such as 0.10`);
  return units;
}

/** The test payer: the io's, or the key in VERIFIER_PAYER_SECRET. */
function testPayer(io: Io, rpcUrl: string | undefined): Payer {
  if (io.payer !== undefined) return io.payer;
  const secret = io.env["VERIFIER_PAYER_SECRET"];
  if (secret === undefined || secret === "") {
    throw new UsageError("--pay needs the test payer's secret key in VERIFIER_PAYER_SECRET: a dedicated testnet account holding USDC");
  }
  try {
    return localKeyPayer(secret.trim(), rpcUrl === undefined ? {} : { rpcUrl });
  } catch {
    throw new UsageError("VERIFIER_PAYER_SECRET is not a Stellar secret key (S...)");
  }
}
