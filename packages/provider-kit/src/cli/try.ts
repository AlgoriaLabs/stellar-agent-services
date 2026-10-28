// provider-kit try: one paid call to a service on testnet, made the way any client makes it, from a throwaway payer
// (docs/provider-setup-guide.md §6). It shows the whole flow working before anyone else pays.
//
//   1. The provider: --manifest, or the baseUrl of --config. Without either, ./provider.config.json when it exists,
//      else a provider on this computer's default port (http://localhost:8787).
//   2. The quote: an unpaid create-job and its 402 challenge, checked against the manifest [P7]. Nothing is signed.
//   3. Approval: the exact price, payee, asset and network, shown before anything is paid. --yes skips the question,
//      as in scripts.
//   4. The payer: a new key, held in memory only, funded with test XLM by Friendbot and with the job's price in test
//      USDC, bought on the testnet DEX. It is never written anywhere and is gone when the command ends.
//   5. The payment client pays once, follows the job and confirms the transfer on chain [J16]. Its spending policy
//      allows this one payment only: the manifest's price, to the manifest's payTo.
//
// Testnet only: a provider on Mainnet is refused before anything is signed.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  defaultPolicy,
  Journal,
  loadManifest,
  localKeySigner,
  ManifestError,
  memoryJournalStorage,
  memorySecretStore,
  PaymentClient,
  PaymentRefusedError,
  PaymentUncertainError,
  ProviderBusyError,
  ProviderError,
  type PaymentClientOptions,
  type PaymentResult,
  type Quote,
} from "@stellar-agent-services/payment-client";
import { DEFAULT_MANIFEST_PATH, type JsonObject, type ProviderManifest, type ServiceDescriptor, type StellarNetwork } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { DEFAULT_PORT, gatewayManifestUrl } from "../gateway/config.js";
import { ApprovalError, explorerUrl, formatUsdc, networkName, rpcOwnerChain, shortAddress, type OwnerChain } from "./owner-chain.js";
import { quote as shellQuote, UsageError, type CliFlags } from "./shared.js";

/** The config file read when neither --config nor --manifest is given: the one `provider-kit init` writes. */
const DEFAULT_CONFIG = "provider.config.json";
/** The most of a job's output printed, in characters. */
const OUTPUT_LIMIT = 10_000;

/** Where `try` reaches the outside world. Tests replace it. */
export interface TryIo {
  /** Prints a line. */
  log(line: string): void;
  /** Shows the step under way until the next line replaces it. Terminals only. "" clears it. */
  status(text: string): void;
  /** Whether someone is there to answer a question. */
  interactive: boolean;
  /** Asks yes or no. Enter means yes. */
  confirm(question: string): Promise<boolean>;
  chain(network: StellarNetwork, rpcUrl?: string): OwnerChain;
  /** The throwaway payer's key: a new one each time. */
  payer(): Keypair;
  /** How the payment client reaches providers and pays: fetch and x402 `exact` unless a test says otherwise. */
  client: Pick<PaymentClientOptions, "fetch" | "methods" | "pollMs">;
}

export function tryIo(): TryIo {
  const live = process.stdout.isTTY === true;
  let showing = false;
  const clear = () => {
    if (showing) process.stdout.write("\r\x1b[K");
    showing = false;
  };
  return {
    log(line) {
      clear();
      console.log(line);
    },
    status(text) {
      if (!live) return;
      clear();
      if (text === "") return;
      process.stdout.write(text);
      showing = true;
    },
    interactive: process.stdin.isTTY === true,
    async confirm(question) {
      clear();
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        // Ctrl+C and Ctrl+D answer no.
        const answer = await new Promise<string | undefined>((resolve) => {
          readline.once("SIGINT", () => resolve(undefined));
          readline.question(question).then(resolve, () => resolve(undefined));
        });
        if (answer === undefined) process.stdout.write("\n");
        return answer !== undefined && /^(y|yes)?$/i.test(answer.trim());
      } finally {
        readline.close();
      }
    },
    chain: rpcOwnerChain,
    payer: () => Keypair.random(),
    client: {},
  };
}

/** provider-kit try [<service>] ['<input JSON>' | @<file>] */
export async function tryCall(flags: CliFlags, args: string[], io: TryIo = tryIo()): Promise<number> {
  if (args.length > 2) throw new UsageError("try takes a service and its input: provider-kit try <service> ['<input JSON>' | @<file>]");
  if (!flags.yes && !io.interactive) throw new UsageError("try asks before it pays, and nobody can answer here: add --yes to pay without asking");
  try {
    return await payOnce(flags, args, io);
  } finally {
    io.status("");
  }
}

async function payOnce(flags: CliFlags, args: string[], io: TryIo): Promise<number> {
  const manifestUrl = await providerManifestUrl(flags);
  const manifest = await readManifest(manifestUrl, io.client.fetch ?? fetch);
  const network = manifest.payment.accepts[0].network;
  if (network !== "stellar:testnet") {
    throw new Error(`${plain(manifest.provider.name)} is on ${networkName(network)}. try pays from a throwaway testnet account, so it runs on testnet only. Nothing was signed.`);
  }
  const service = pickService(manifest, args[0], flags, io);
  if (service === undefined) return 2;
  const { input, example } = await readInput(service, args[1]);

  const payer = io.payer();
  const price = service.price.amount;
  const journal = await Journal.open(memoryJournalStorage());
  const client = new PaymentClient({
    signer: localKeySigner(payer.secret(), network),
    // This one payment and no other: the manifest's price, to the manifest's payTo.
    policy: {
      ...defaultPolicy(payer.publicKey(), network),
      maxValuePerTx: price,
      maxValuePerDay: price,
      stellar: { network, payees: { allow: [manifest.payment.accepts[0].payTo], block: [] }, autoApproveUpTo: "0" },
    },
    journal,
    secrets: memorySecretStore(),
    // A development tool on testnet: an http://localhost provider is fine [M6].
    allowLocalhost: true,
    followSeconds: Math.max(120, (service.expectedDurationSeconds ?? 0) * 2 + 30),
    ...(flags.rpc === undefined ? {} : { rpcUrl: flags.rpc }),
    ...io.client,
  });

  io.status(`  … Asking ${service.name} for its price`);
  let offer: Quote;
  try {
    offer = await client.quote(manifestUrl, service.name, input);
  } catch (error) {
    throw new Error(`${service.name} didn't quote a price: ${problem(error)}. Nothing was signed.`);
  }
  showTerms(io, offer, network, payer.publicKey(), example);
  if (!client.payable(offer)) {
    io.log("Nothing was signed or paid.");
    return 1;
  }
  if (!flags.yes) {
    if (!(await io.confirm(`Pay ${formatUsdc(offer.requirements.amount)} in test money? [Y/n] `))) {
      await client.decline(offer);
      io.log("Not paid. Nothing was signed.");
      return 1;
    }
    io.log("");
  }

  try {
    await fundPayer(io, io.chain(network, flags.rpc), payer, offer.requirements.amount);
  } catch (error) {
    throw new Error(`${problem(error)}. Nothing was paid to ${service.name}.`);
  }

  io.status(`  … Paying ${service.name} and waiting for its result`);
  const started = Date.now();
  let result: PaymentResult;
  try {
    result = await client.pay(offer, { approved: true });
  } catch (error) {
    return notPaid(io, error, offer, journal);
  }
  return report(io, offer, result, (Date.now() - started) / 1000);
}

/** The manifest URL of the provider to try: --manifest, the baseUrl of --config or ./provider.config.json, or this computer's default port. */
async function providerManifestUrl(flags: CliFlags): Promise<string> {
  if (flags.config !== undefined && flags.manifest !== undefined) throw new UsageError("pass --config <file> or --manifest <url>, not both");
  if (flags.manifest !== undefined) return flags.manifest;
  const config = flags.config ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
  if (config === undefined) return new URL(DEFAULT_MANIFEST_PATH, `http://localhost:${DEFAULT_PORT}`).toString();
  try {
    return await gatewayManifestUrl(config);
  } catch (error) {
    throw new Error(`${config}: ${(error as Error).message}. Set it as the provider has it, or pass --manifest <url>.`);
  }
}

/** The manifest, read as a client reads it: from the running provider, and checked against the standard. */
async function readManifest(url: string, fetcher: typeof fetch): Promise<ProviderManifest> {
  try {
    return await loadManifest(url, { fetch: fetcher, allowLocalhost: true });
  } catch (error) {
    if (error instanceof ManifestError) throw new Error(`the manifest at ${url} isn't valid: ${error.message}. provider-kit check lists every problem.`);
    if (unreachable(error)) throw new Error(`nothing answers at ${url}. Start the provider first, such as with provider-kit serve --config provider.config.json.`);
    throw error;
  }
}

/** The service named on the command line, or the only one there is. Lists them when there are several to pick from. */
function pickService(manifest: ProviderManifest, name: string | undefined, flags: CliFlags, io: TryIo): ServiceDescriptor | undefined {
  const names = manifest.services.map((service) => service.name);
  if (name !== undefined) {
    const service = manifest.services.find((candidate) => candidate.name === name);
    if (service === undefined) throw new Error(`${plain(manifest.provider.name)} has no service "${name}". It has ${names.join(", ")}.`);
    return service;
  }
  if (manifest.services.length === 1) return manifest.services[0];
  const target = flags.manifest !== undefined ? ` --manifest ${shellQuote(flags.manifest)}` : flags.config !== undefined ? ` --config ${shellQuote(flags.config)}` : "";
  const width = Math.max(...names.map((candidate) => candidate.length));
  io.log(`${plain(manifest.provider.name)} has ${names.length} services. Name the one to try:`);
  for (const service of manifest.services) {
    io.log(`  provider-kit try ${service.name.padEnd(width)}${target}   ${formatUsdc(service.price.amount)}`);
  }
  return undefined;
}

/** The job's input: the argument as JSON, the JSON file it names with @, or the service's first example. */
async function readInput(service: ServiceDescriptor, arg: string | undefined): Promise<{ input: JsonObject; example: boolean }> {
  if (arg === undefined) {
    const example = service.examples?.[0]?.input;
    if (example === undefined) throw new UsageError(`${service.name} has no example input, so pass one: provider-kit try ${service.name} '<input JSON>'`);
    return { input: example, example: true };
  }
  const file = arg.startsWith("@") ? arg.slice(1) : undefined;
  let text = arg;
  if (file !== undefined) {
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new UsageError(`the input file can't be read: ${(error as Error).message}`);
    }
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    input = undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new UsageError(`the input must be a JSON object, such as '{"text":"Hello"}'${file === undefined ? "" : `, and ${file} doesn't hold one`}`);
  }
  return { input: input as JsonObject, example: false };
}

/** The terms of the payment, as the challenge states them: what the developer approves. */
function showTerms(io: TryIo, offer: Quote, network: StellarNetwork, payer: string, example: boolean): void {
  const { manifest, service, requirements } = offer;
  const charge = service.charge === "on-success" ? "charged only if the work succeeds" : "charged up front, before the work starts";
  io.log(`Pay for one job at ${plain(manifest.provider.name)} (${new URL(manifest.baseUrl).host})`);
  io.log("");
  const rows: [string, string][] = [
    ["Service", `${service.name}: ${plain(service.description, 70)}`],
    ["Input", `${plain(JSON.stringify(offer.input), 70)}${example ? "  (its example)" : ""}`],
    ["Price", `${formatUsdc(requirements.amount)}, ${charge}`],
    ["Pay to", requirements.payTo],
    ["From", `${payer}, a throwaway test account`],
    ["Network", `${networkName(network)}: test money only`],
  ];
  for (const [label, value] of rows) io.log(`  ${label.padEnd(8)} ${value}`);
  for (const violation of offer.challengeViolations) io.log(`  ✗ ${violation}`);
  for (const violation of offer.policyViolations) io.log(`  ✗ ${violation.field}: ${violation.message}`);
  io.log("");
}

/** Funds the throwaway payer: test XLM from Friendbot, then the job's price in test USDC from the testnet DEX. */
async function fundPayer(io: TryIo, chain: OwnerChain, payer: Keypair, amount: string): Promise<void> {
  const address = payer.publicKey();
  await step(io, "Test XLM from Friendbot", () => chain.fund(address));
  await step(io, `Test USDC from the testnet DEX: ${formatUsdc(amount)}`, async () => {
    const purchase = await chain.buyTestUsdc(address, amount);
    purchase.sign(payer);
    const sent = await chain.send(purchase);
    if (sent.status === "failed") {
      throw new Error(
        `Buying test USDC failed: ${sent.reason} Try again in a minute, or pay with stellar-pay from a test wallet of your own, funded at https://faucet.circle.com (docs/provider-setup-guide.md §6).`,
      );
    }
    if (sent.status === "unknown") throw new Error(`Buying test USDC may not have gone through: ${sent.reason}.`);
  });
}

/** Runs one step: "  … label" while it runs, on a terminal, then "  ✓ label" or "  ✗ label". */
async function step<T>(io: TryIo, label: string, run: () => Promise<T>): Promise<T> {
  io.status(`  … ${label}`);
  try {
    const value = await run();
    io.log(`  ✓ ${label}`);
    return value;
  } catch (error) {
    io.log(`  ✗ ${label}`);
    throw error;
  }
}

/**
 * pay() threw. Before the paid request went out, a refusal or a busy answer to it charged nothing. Anything else
 * after it went out may have been paid.
 */
function notPaid(io: TryIo, error: unknown, offer: Quote, journal: Journal): number {
  const sent = journal.forJob(offer.jobId).some((entry) => entry.event === "sending");
  if (!sent || error instanceof PaymentRefusedError || error instanceof ProviderBusyError) {
    io.log(`  ✗ Not paid: ${problem(error)}. Nothing was charged.`);
    return 1;
  }
  const reason = error instanceof PaymentUncertainError ? error.reason : problem(error);
  io.log(`  ! The payment may have gone through, but the answer was lost: ${reason}.`);
  io.log(`    Don't pay again. The provider decides job ${offer.jobId} from the chain [J13]; provider-kit reconcile --dry-run shows where it stands.`);
  return 1;
}

/** What became of the job and its payment. 0 only when the job succeeded and its payment is confirmed on chain [J16]. */
function report(io: TryIo, offer: Quote, { job, confirmed, unconfirmedReason }: PaymentResult, seconds: number): number {
  const name = offer.service.name;
  const took = `${seconds.toFixed(1)} s`;
  if (job.status === "succeeded") io.log(`  ✓ ${name} succeeded: ${took} from payment to result`);
  else if (job.status === "failed") io.log(`  ✗ ${name} failed: ${job.error === undefined ? "no reason given" : plain(`${job.error.code}${job.error.detail === undefined ? "" : `: ${job.error.detail}`}`, 200)}`);
  else if (job.status === "payment_uncertain") io.log(`  ! ${name} can't tell yet whether it was paid. The provider decides job ${job.jobId} from the chain [J13]; don't pay again.`);
  else io.log(`  ! ${name} is still ${job.status} after ${took}. Its job is ${job.jobId}.`);

  if (job.payment !== undefined) {
    const link = explorerUrl(job.payment.network, "tx", job.payment.transaction);
    if (confirmed) io.log(`  ✓ Paid ${formatUsdc(job.payment.amount)}, confirmed on chain: ${link}`);
    else io.log(`  ! The provider says it was paid, but that isn't confirmed on chain: ${unconfirmedReason ?? "no reason given"}. ${link}`);
  } else if (job.charged === false) {
    io.log("  ✓ Not charged");
  }
  if (job.output !== undefined) io.log(`\n${printable(job.output)}`);

  const ok = job.status === "succeeded" && confirmed;
  if (ok) io.log(`\n${shortAddress(offer.requirements.payTo)} (payTo) received ${formatUsdc(offer.requirements.amount)}.`);
  return ok ? 0 : 1;
}

/**
 * An error in words, to go before ". ": an approval error's title and message, or the error's own message, which
 * may carry the provider's text.
 */
function problem(error: unknown): string {
  let text: string;
  if (error instanceof ApprovalError) text = `${error.title}: ${error.message}`;
  else if (unreachable(error)) text = "nothing answers at the provider's address";
  else text = error instanceof Error ? error.message : String(error);
  // Which part of the input the service refused, and why.
  const errors = error instanceof ProviderError ? (error.problem?.errors ?? []) : [];
  if (errors.length > 0) text += `: ${errors.map((entry) => `${entry.pointer || "/"} ${entry.message}`).join("; ")}`;
  return plain(text, 400).replace(/\.$/, "");
}

/** fetch() found nothing listening, or no such host. */
function unreachable(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}

/**
 * Provider text on one terminal line: no control characters or direction overrides, which could rewrite what the
 * terminal shows, and at most `max` characters.
 */
function plain(text: string, max = 80): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A job's output for the terminal: indented JSON, clipped when it is long. */
function printable(output: JsonObject): string {
  // JSON escapes the C0 controls in strings, but not C1 (U+0080–U+009F), which some terminals take as commands.
  const text = JSON.stringify(output, null, 2).replace(/[\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… and ${text.length - OUTPUT_LIMIT} more characters` : text;
}
