#!/usr/bin/env node
// stellar-pay: the PoC surface on top of the payment-client core (docs/payment-client.md).
//
// The key is a local file (the "local key" signer), which is fine for testnet and development.
// The web app, browser wallets and passkeys come later; they reuse the same core.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { JsonObject, StellarNetwork } from "@stellar-agent-services/protocol";
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  PaymentClient,
  PaymentRefusedError,
  PaymentUncertainError,
  ProviderBusyError,
  type PaymentResult,
  type Quote,
} from "./client.js";
import { fileJournalStorage, fileSecretStore } from "./file-storage.js";
import { Journal, verifyChain } from "./journal.js";
import { localKeySigner } from "./local-key-signer.js";
import { loadManifest } from "./manifest.js";
import { explorerUrl } from "./onchain.js";
import { defaultPolicy, type SpendingPolicy } from "./policy.js";

const HOME = process.env["STELLAR_PAY_HOME"] ?? join(homedir(), ".stellar-pay");
const NETWORK: StellarNetwork = "stellar:testnet";
const HORIZON = "https://horizon-testnet.stellar.org";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const files = {
  wallet: join(HOME, "wallet.json"),
  policy: join(HOME, "policy.json"),
  journal: join(HOME, "journal.jsonl"),
  tokens: join(HOME, "job-tokens.json"),
};

interface WalletFile {
  version: 1;
  network: StellarNetwork;
  address: string;
  secret: string;
}

const HELP = `stellar-pay: pay Provider Standard services on Stellar testnet (proof of concept)

  wallet create                 create a local testnet key in ${HOME}
  wallet fund [--usdc 5]        friendbot XLM, a USDC trustline, and buy USDC on the testnet DEX
  wallet                        show the address and balances
  policy                        show the spending policy
  policy set [--max-tx 0.10] [--max-day 1.00] [--auto-approve 0] [--allow-payee G...] [--block-payee G...]
  services <manifest-url>       list a provider's services and prices
  pay <manifest-url> <service> <json-input> [--yes]
                                quote, approve, pay once, and show the result
  recover <job-id>              collect a job after a lost response, without paying again
  jobs                          list jobs from the journal
  journal verify                check the journal's hash chain

  --dev   accept http://localhost providers`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      dev: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      usdc: { type: "string", default: "5" },
      "max-tx": { type: "string" },
      "max-day": { type: "string" },
      "auto-approve": { type: "string" },
      "allow-payee": { type: "string", multiple: true },
      "block-payee": { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  const key = `${command ?? ""} ${rest[0] ?? ""}`.trim();

  if (values.help || command === undefined) return console.log(HELP);
  if (key === "wallet create") return walletCreate();
  if (key === "wallet fund") return walletFund(values.usdc);
  if (command === "wallet") return walletShow();
  if (key === "policy set") return policySet(values);
  if (command === "policy") return console.log(JSON.stringify(await readPolicy(), null, 2));
  if (command === "services") return listServices(arg(rest, 0, "manifest-url"), values.dev);
  if (command === "pay") return pay(arg(rest, 0, "manifest-url"), arg(rest, 1, "service"), arg(rest, 2, "json-input"), values);
  if (command === "recover") return recover(arg(rest, 0, "job-id"), values.dev);
  if (command === "jobs") return listJobs();
  if (key === "journal verify") return journalVerify();
  throw new Error(`unknown command "${positionals.join(" ")}"\n\n${HELP}`);
}

// ── wallet ──────────────────────────────────────────────────────────────────

async function walletCreate(): Promise<void> {
  if (await exists(files.wallet)) throw new Error(`a wallet already exists in ${files.wallet}`);
  const keypair = Keypair.random();
  const wallet: WalletFile = { version: 1, network: NETWORK, address: keypair.publicKey(), secret: keypair.secret() };
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await writeFile(files.wallet, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  await writeFile(files.policy, JSON.stringify(defaultPolicy(wallet.address, NETWORK), null, 2), { mode: 0o600 });
  console.log(`Created a testnet wallet: ${wallet.address}`);
  console.log(`Next: stellar-pay wallet fund`);
}

async function walletFund(usdc: string): Promise<void> {
  const wallet = await readWallet();
  const horizon = new Horizon.Server(HORIZON);
  let account = await horizon.loadAccount(wallet.address).catch(() => undefined);
  if (account === undefined) {
    console.log("Asking friendbot for testnet XLM…");
    const response = await fetch(`https://friendbot.stellar.org/?addr=${wallet.address}`);
    if (!response.ok) throw new Error(`friendbot answered ${response.status}`);
    account = await horizon.loadAccount(wallet.address);
  }

  const hasTrustline = account.balances.some((b) => "asset_code" in b && b.asset_code === USDC.code && b.asset_issuer === USDC.issuer);
  const builder = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET }).setTimeout(60);
  if (!hasTrustline) builder.addOperation(Operation.changeTrust({ asset: USDC }));
  if (Number(usdc) > 0) {
    builder.addOperation(
      Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: "1000", destination: wallet.address, destAsset: USDC, destAmount: usdc, path: [] }),
    );
  }
  if (hasTrustline && Number(usdc) <= 0) return walletShow();

  const transaction = builder.build();
  transaction.sign(Keypair.fromSecret(wallet.secret));
  console.log(`${hasTrustline ? "" : "Adding a USDC trustline. "}${Number(usdc) > 0 ? `Buying ${usdc} USDC on the testnet DEX.` : ""}`);
  const result = await horizon.submitTransaction(transaction);
  console.log(`Done: ${explorerUrl(NETWORK, result.hash)}`);
  await walletShow();
}

async function walletShow(): Promise<void> {
  const wallet = await readWallet();
  console.log(`Address  ${wallet.address}  (${wallet.network})`);
  const account = await new Horizon.Server(HORIZON).loadAccount(wallet.address).catch(() => undefined);
  if (account === undefined) return console.log("Not funded yet. Run: stellar-pay wallet fund");
  for (const balance of account.balances) {
    const name = balance.asset_type === "native" ? "XLM" : "asset_code" in balance ? balance.asset_code : balance.asset_type;
    console.log(`${name.padEnd(8)} ${balance.balance}`);
  }
}

// ── policy ──────────────────────────────────────────────────────────────────

async function policySet(values: Record<string, unknown>): Promise<void> {
  const policy = await readPolicy();
  if (typeof values["max-tx"] === "string") policy.maxValuePerTx = toBaseUnits(values["max-tx"]);
  if (typeof values["max-day"] === "string") policy.maxValuePerDay = toBaseUnits(values["max-day"]);
  if (typeof values["auto-approve"] === "string") policy.stellar.autoApproveUpTo = toBaseUnits(values["auto-approve"], true);
  const allow = values["allow-payee"] as string[] | undefined;
  const block = values["block-payee"] as string[] | undefined;
  if (allow !== undefined) policy.stellar.payees.allow = [...(policy.stellar.payees.allow ?? []), ...allow];
  if (block !== undefined) policy.stellar.payees.block = [...policy.stellar.payees.block, ...block];
  await writeFile(files.policy, JSON.stringify(policy, null, 2), { mode: 0o600 });
  console.log(`Per payment ${usdc(policy.maxValuePerTx)} · per 24 h ${usdc(policy.maxValuePerDay)} · ` +
    `no prompt up to ${usdc(policy.stellar.autoApproveUpTo)}`);
}

// ── paying ──────────────────────────────────────────────────────────────────

async function listServices(manifestUrl: string, dev: boolean): Promise<void> {
  const manifest = await loadManifest(manifestUrl, { allowLocalhost: dev });
  const option = manifest.payment.accepts[0];
  console.log(`${manifest.provider.name}  ·  ${option.network}  ·  pays ${short(option.payTo)}\n`);
  for (const service of manifest.services) {
    console.log(`${service.name.padEnd(20)} ${usdc(service.price.amount).padEnd(12)} ${service.charge ?? "upfront"}`);
    console.log(`${"".padEnd(20)} ${service.description}`);
  }
}

async function pay(manifestUrl: string, serviceName: string, inputText: string, values: { dev: boolean; yes: boolean }): Promise<void> {
  let input: JsonObject;
  try {
    input = JSON.parse(inputText) as JsonObject;
  } catch {
    throw new Error(`the input must be a JSON object, such as '{"text":"hello"}'`);
  }
  const client = await openClient(values.dev);
  const quote = await client.quote(manifestUrl, serviceName, input);
  showQuote(quote, client);

  if (!client.payable(quote)) {
    console.log("\n✗ Blocked. Nothing was signed or paid.");
    process.exitCode = 1;
    return;
  }
  let approved = !quote.needsApproval || values.yes;
  if (quote.needsApproval && !values.yes) approved = await confirm("\nApprove this exact payment? [y/N] ");
  if (!quote.needsApproval) console.log("\nInside your auto-approve budget: paying without a prompt.");

  try {
    showResult(await client.pay(quote, { approved }));
  } catch (error) {
    if (error instanceof PaymentRefusedError || error instanceof ProviderBusyError) {
      console.log(`\n✗ Not paid: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof PaymentUncertainError) {
      console.log(`\n⚠ ${error.message}`);
      console.log(`  Run: stellar-pay recover ${error.jobId}${values.dev ? " --dev" : ""}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

async function recover(jobId: string, dev: boolean): Promise<void> {
  const client = await openClient(dev);
  console.log(`Recovering ${jobId} with check-status / get-result. No payment is sent.`);
  showResult(await client.recover(jobId));
}

function showQuote(quote: Quote, client: PaymentClient): void {
  const { manifest, service, requirements } = quote;
  const rows: [string, string][] = [
    ["Provider", `${manifest.provider.name}  (${new URL(manifest.baseUrl).host})`],
    ["Service", `${service.title ?? service.name}: ${service.description}`],
    ["Price", usdc(requirements.amount ?? "0")],
    ["Pay to", requirements.payTo ?? "?"],
    ["Network", `${requirements.network}${requirements.network === "stellar:testnet" ? "  (test money)" : ""}`],
    ["Charged", service.charge === "on-success" ? "only if the work succeeds" : "up front, before the work starts"],
    ["From", client.address],
    ["Method", quote.methodId ?? "none installed for this challenge"],
  ];
  if (quote.walletBudget !== undefined) rows.push(["Budget", `${usdc(quote.walletBudget)} left in the wallet`]);
  console.log(`\n┌─ Payment approval ${"─".repeat(50)}`);
  for (const [label, value] of rows) console.log(`│ ${label.padEnd(9)} ${value}`);
  for (const violation of quote.challengeViolations) console.log(`│ ✗ challenge ${violation}`);
  for (const violation of quote.policyViolations) console.log(`│ ✗ policy ${violation.field}: ${violation.message}`);
  if (client.payable(quote)) console.log("│ ✓ The challenge matches the manifest and your spending policy.");
  console.log(`└${"─".repeat(69)}`);
}

function showResult({ job, confirmed, unconfirmedReason }: PaymentResult): void {
  console.log(`\nJob ${job.jobId}: ${job.status}`);
  if (job.payment !== undefined) {
    console.log(`${confirmed ? "✓ Paid" : "⚠ Receipt not confirmed on chain:"} ${usdc(job.payment.amount)} · ${explorerUrl(job.payment.network, job.payment.transaction)}`);
  }
  if (unconfirmedReason !== undefined) console.log(`  ${unconfirmedReason}`);
  if (job.payment === undefined && job.charged === false) {
    console.log("Not charged.");
  }
  if (job.error !== undefined) console.log(`Error: ${job.error.code}${job.error.detail ? `: ${job.error.detail}` : ""}`);
  if (job.output !== undefined) console.log(`\n${JSON.stringify(job.output, null, 2)}`);
  if (job.status !== "succeeded" && job.status !== "failed") console.log(`Still ${job.status}. Run: stellar-pay recover ${job.jobId}`);
}

// ── journal ─────────────────────────────────────────────────────────────────

async function listJobs(): Promise<void> {
  const journal = await Journal.open(fileJournalStorage(files.journal));
  const jobs = new Map<string, { service: string; at: string; last: string; amount?: string }>();
  for (const entry of journal.entries()) {
    const job = jobs.get(entry.jobId) ?? { service: String(entry.details["service"] ?? "?"), at: entry.at, last: entry.event };
    job.last = entry.event;
    if (entry.event === "sending") job.amount = String(entry.details["amount"]);
    jobs.set(entry.jobId, job);
  }
  if (jobs.size === 0) return console.log("No jobs yet.");
  for (const [jobId, job] of jobs) {
    console.log(`${job.at.slice(0, 19)}  ${jobId}  ${job.service.padEnd(16)} ${(job.amount ? usdc(job.amount) : "-").padEnd(12)} ${job.last}`);
  }
  console.log(`\nSpent in the last 24 h: ${usdc(journal.spentSince(new Date(Date.now() - 86400_000)).toString())}`);
}

async function journalVerify(): Promise<void> {
  const lines = (await fileJournalStorage(files.journal).readLines()).filter((line) => line.trim() !== "");
  const broken = await verifyChain(lines.map((line) => JSON.parse(line)));
  if (broken !== undefined) throw new Error(`the journal is broken at entry ${broken}`);
  console.log(`✓ ${lines.length} entries, hash chain intact.`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function openClient(dev: boolean): Promise<PaymentClient> {
  const wallet = await readWallet();
  return new PaymentClient({
    signer: localKeySigner(wallet.secret, wallet.network),
    policy: await readPolicy(),
    journal: await Journal.open(fileJournalStorage(files.journal)),
    secrets: fileSecretStore(files.tokens),
    allowLocalhost: dev,
  });
}

async function readWallet(): Promise<WalletFile> {
  if (!(await exists(files.wallet))) throw new Error("no wallet yet. Run: stellar-pay wallet create");
  return JSON.parse(await readFile(files.wallet, "utf8")) as WalletFile;
}

async function readPolicy(): Promise<SpendingPolicy> {
  if (await exists(files.policy)) return JSON.parse(await readFile(files.policy, "utf8")) as SpendingPolicy;
  return defaultPolicy((await readWallet()).address, NETWORK);
}

async function confirm(question: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await readline.question(question)).trim());
  } finally {
    readline.close();
  }
}

function usdc(baseUnits: string): string {
  const units = BigInt(baseUnits);
  const whole = units / 10_000_000n;
  const fraction = (units % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction.padEnd(2, "0")}` : ".00"} USDC`;
}

function toBaseUnits(decimal: string, allowZero = false): string {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal);
  if (match === null) throw new Error(`"${decimal}" is not a USDC amount`);
  const units = BigInt(match[1]! + (match[2] ?? "").padEnd(7, "0"));
  if (units === 0n && !allowZero) throw new Error("the limit must be above zero");
  return units.toString();
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function arg(values: string[], index: number, name: string): string {
  const value = values[index];
  if (value === undefined) throw new Error(`missing <${name}>\n\n${HELP}`);
  return value;
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
