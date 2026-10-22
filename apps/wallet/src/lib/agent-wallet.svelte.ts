// The page's state and actions, on top of the payment-client core. Every safety step happens in the core:
// this class only keeps what the page shows in step with it (the wallet, the spending policy, the journal,
// and the payment in flight) and never decides whether something is paid.

import {
  defaultPolicy,
  Journal,
  loadManifest,
  localKeySigner,
  PaymentClient,
  PaymentRefusedError,
  PaymentUncertainError,
  totalSpentSince,
  type JournalEntry,
  type JournalStorage,
  type PaymentResult,
  type Quote,
  type SpendingPolicy,
} from "@stellar-agent-services/payment-client";
import { indexedDbJournalStorage, indexedDbSecretStore } from "@stellar-agent-services/payment-client/browser";
import type { Charge, JsonObject, ProviderManifest, StellarNetwork } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { summarizeJobs } from "./jobs.js";
import { fundTestWallet, readBalances, type Balances, type FundingStep } from "./stellar.js";
import { humanize } from "./format.js";
import { readPolicy, readTitles, readWallet, writePolicy, writeTitles, writeWallet, type StoredWallet } from "./storage.js";

export const NETWORK: StellarNetwork = "stellar:testnet";
const DAY_MS = 86_400_000;
const POLICY_DAYS = 30;

/** Where the payment in flight is. The core moves it on; the page follows the journal and the requests. */
export type Phase = "signing" | "working" | "confirming" | "finished";

export interface Payment {
  jobId: string;
  service: string;
  charge: Charge | undefined;
  expectedSeconds: number | undefined;
  /** In base units. */
  amount: string | undefined;
  /** Collecting a job that was already paid for, with check-status and get-result only. */
  recovering: boolean;
  /** `sending` is journaled: from here on the job is never signed again. */
  sent: boolean;
  phase: Phase;
  result: PaymentResult | undefined;
  problem: Problem | undefined;
}

export interface Problem {
  /** refused: nothing was paid. uncertain: it may have been paid, so recover it and never pay again. */
  kind: "refused" | "uncertain" | "error";
  message: string;
}

export class AgentWallet {
  /** Set when the journal can't be opened. Nothing can be paid then (fail closed). */
  startError = $state<string>();
  ready = $state(false);
  wallet = $state<StoredWallet>();
  policy = $state<SpendingPolicy>();
  /** null until the first read; undefined while the account does not exist on chain. */
  balances = $state<Balances | undefined | null>(null);
  entries = $state.raw<readonly JournalEntry[]>([]);
  payment = $state<Payment>();

  jobs = $derived(summarizeJobs(this.entries));
  /** The same total the policy checks before each payment. */
  spentLast24h = $derived(totalSpentSince(this.entries, new Date(Date.now() - DAY_MS)));

  /** Local providers are accepted only while the page itself runs locally, as with `stellar-pay --dev`. */
  readonly allowLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  #journal: Journal | undefined;
  #client: PaymentClient | undefined;
  /** Service titles from loaded manifests, by "baseUrl#name"; the journal keeps only names. */
  titles = $state<Record<string, string>>({});

  async start(): Promise<void> {
    try {
      this.#journal = await Journal.open(observed(indexedDbJournalStorage(), (entry) => this.#onEntry(entry)));
      this.entries = [...this.#journal.entries()];
      this.titles = readTitles();
      const wallet = readWallet();
      if (wallet !== undefined) {
        this.wallet = wallet;
        this.#setPolicy(readPolicy() ?? defaultPolicy(wallet.address, NETWORK));
      }
    } catch (error) {
      this.startError = messageOf(error);
      return;
    }
    this.ready = true;
    await this.refreshBalances();
  }

  createWallet(): void {
    const keypair = Keypair.random();
    const wallet: StoredWallet = { version: 1, network: NETWORK, address: keypair.publicKey(), secret: keypair.secret() };
    writeWallet(wallet);
    this.wallet = wallet;
    this.balances = undefined;
    this.#setPolicy(defaultPolicy(wallet.address, NETWORK));
  }

  async fund(onStep: (step: FundingStep) => void): Promise<void> {
    await fundTestWallet(this.#requireWallet().secret, "5", onStep);
    await this.refreshBalances();
  }

  async refreshBalances(): Promise<void> {
    if (this.wallet === undefined) return;
    try {
      this.balances = await readBalances(this.wallet.address);
    } catch {
      // Horizon is unreachable: keep showing the last balances.
    }
  }

  setLimits(maxValuePerTx: bigint, maxValuePerDay: bigint): void {
    this.#setPolicy({ ...this.#currentPolicy(), maxValuePerTx: maxValuePerTx.toString(), maxValuePerDay: maxValuePerDay.toString() });
  }

  /** A fresh 30-day window, for a policy that expired. */
  renewPolicy(): void {
    const now = Math.floor(Date.now() / 1000);
    this.#setPolicy({ ...this.#currentPolicy(), validAfter: now, validUntil: now + POLICY_DAYS * 86400 });
  }

  async fetchManifest(manifestUrl: string): Promise<ProviderManifest> {
    const manifest = await loadManifest(manifestUrl, { allowLocalhost: this.allowLocalhost });
    const titles = { ...this.titles };
    for (const service of manifest.services) {
      if (service.title !== undefined) titles[`${manifest.baseUrl}#${service.name}`] = service.title;
    }
    this.titles = titles;
    try {
      writeTitles(titles);
    } catch {
      // Only labels: the history falls back to the service's name.
    }
    return manifest;
  }

  serviceTitle(baseUrl: string | undefined, name: string): string {
    return this.titles[`${baseUrl}#${name}`] ?? humanize(name);
  }

  /** Everything the approval screen shows. Nothing is signed. */
  quote(manifestUrl: string, service: string, input: JsonObject): Promise<Quote> {
    return this.#requireClient().quote(manifestUrl, service, input);
  }

  payable(quote: Quote): boolean {
    return this.#requireClient().payable(quote);
  }

  decline(quote: Quote): Promise<void> {
    return this.#requireClient().decline(quote);
  }

  /** The human approved this exact payment. */
  async pay(quote: Quote): Promise<void> {
    const client = this.#requireClient();
    this.payment = {
      jobId: quote.jobId,
      service: quote.service.title ?? quote.service.name,
      charge: quote.service.charge,
      expectedSeconds: quote.service.expectedDurationSeconds,
      amount: quote.requirements.amount,
      recovering: false,
      sent: false,
      phase: "signing",
      result: undefined,
      problem: undefined,
    };
    await this.#follow(() => client.pay(quote, { approved: true }));
  }

  /** Collects a job after a lost response. Never signs or pays again. */
  async recover(jobId: string): Promise<void> {
    const client = this.#requireClient();
    const job = this.jobs.find((candidate) => candidate.jobId === jobId);
    this.payment = {
      jobId,
      service: job === undefined ? "Job" : this.serviceTitle(job.baseUrl, job.service),
      charge: undefined,
      expectedSeconds: undefined,
      amount: job?.amount,
      recovering: true,
      sent: true,
      phase: "working",
      result: undefined,
      problem: undefined,
    };
    await this.#follow(() => client.recover(jobId));
  }

  closePayment(): void {
    this.payment = undefined;
  }

  async #follow(task: () => Promise<PaymentResult>): Promise<void> {
    const payment = this.payment!;
    try {
      payment.result = await task();
    } catch (error) {
      payment.problem = this.#problem(payment.jobId, error);
    }
    payment.phase = "finished";
    await this.refreshBalances();
  }

  #problem(jobId: string, error: unknown): Problem {
    if (error instanceof PaymentRefusedError) return { kind: "refused", message: error.message };
    // Once `sending` is journaled, any failure may hide a payment that went through.
    const sent = this.entries.some((entry) => entry.jobId === jobId && entry.event === "sending");
    if (error instanceof PaymentUncertainError || sent) return { kind: "uncertain", message: messageOf(error) };
    return { kind: "error", message: messageOf(error) };
  }

  #onEntry(entry: JournalEntry): void {
    this.entries = [...this.entries, entry];
    if (entry.event === "sending" && this.payment?.jobId === entry.jobId) {
      this.payment.sent = true;
      this.payment.phase = "working";
    }
  }

  /** The core's requests. A finished job view while the provider works means the chain check is next. */
  #fetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (this.payment?.phase === "working" && response.status === 200) this.payment.phase = "confirming";
    return response;
  };

  #setPolicy(policy: SpendingPolicy): void {
    writePolicy(policy);
    this.policy = policy;
    const wallet = this.#requireWallet();
    this.#client = new PaymentClient({
      signer: localKeySigner(wallet.secret, wallet.network),
      policy,
      journal: this.#journal!,
      secrets: indexedDbSecretStore(),
      allowLocalhost: this.allowLocalhost,
      fetch: this.#fetch,
    });
  }

  #currentPolicy(): SpendingPolicy {
    return $state.snapshot(this.policy) ?? defaultPolicy(this.#requireWallet().address, NETWORK);
  }

  #requireWallet(): StoredWallet {
    if (this.wallet === undefined) throw new Error("Create a test wallet first.");
    return this.wallet;
  }

  #requireClient(): PaymentClient {
    if (this.#client === undefined) throw new Error("Create a test wallet first.");
    return this.#client;
  }
}

/** Tells the page about each journal entry once it is stored. */
function observed(storage: JournalStorage, onAppend: (entry: JournalEntry) => void): JournalStorage {
  return {
    readLines: () => storage.readLines(),
    async appendLine(line) {
      await storage.appendLine(line);
      onAppend(JSON.parse(line) as JournalEntry);
    },
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
