// The payment flow (docs/payment-client.md, "One payment, step by step"):
//
//   quote():   manifest -> job id, token, binding hash -> unpaid create-job -> 402 -> checkChallenge
//              -> policy. Nothing is signed.
//   pay():     approval -> journal `sending` -> sign once -> paid create-job -> follow the job ->
//              confirm on chain.
//   recover(): check-status / get-result from the journal. Never signs or pays again.

import {
  bindingHash,
  checkChallenge,
  createJobUrl,
  IDEMPOTENCY_KEY,
  JOB_TOKEN,
  jobResultUrl,
  type JobView,
  type JsonObject,
  type Problem,
  type ProviderManifest,
  type ServiceDescriptor,
  type StellarNetwork,
} from "@stellar-agent-services/protocol";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import type { Journal, SecretStore } from "./journal.js";
import { loadManifest } from "./manifest.js";
import { rpcConfirmPayment, type Confirmation, type ConfirmPayment } from "./onchain.js";
import { checkPolicy, PAY_ACTION, policyHash, type PolicyViolation, type SpendingPolicy } from "./policy.js";

export interface PaymentClientOptions {
  signer: ClientStellarSigner;
  policy: SpendingPolicy;
  journal: Journal;
  secrets: SecretStore;
  fetch?: typeof fetch;
  /** Soroban RPC for signing and confirmation. Defaults to the public testnet RPC. */
  rpcUrl?: string;
  confirmPayment?: ConfirmPayment;
  /** Builds the signed x402 payload. Defaults to @x402/stellar's ExactStellarScheme with `signer`. */
  createPayload?: (requirements: PaymentRequirements) => Promise<Pick<PaymentPayload, "x402Version" | "payload">>;
  /** Accept http://localhost providers, for local development. */
  allowLocalhost?: boolean;
  /** How long pay() and recover() follow a running job before returning it. Default 120 s. */
  followSeconds?: number;
  /** Time between polls while following a job. Default 2000 ms. */
  pollMs?: number;
}

export interface Quote {
  manifestUrl: string;
  manifest: ProviderManifest;
  service: ServiceDescriptor;
  input: JsonObject;
  jobId: string;
  bindingHash: string;
  challenge: PaymentRequired;
  requirements: PaymentRequirements;
  /** The 402 does not match the manifest [P7]. Any entry blocks the payment. */
  challengeViolations: string[];
  policyViolations: PolicyViolation[];
  /** No violations, but above the auto-approve amount: a human must approve. */
  needsApproval: boolean;
}

export interface PaymentResult {
  job: JobView;
  /** The approved transfer was confirmed on chain. Only then may a UI show "paid" [J16]. */
  confirmed: boolean;
  /** Why a charged job is not confirmed. */
  unconfirmedReason?: string;
}

/** The payment may or may not have gone through. Run recover(jobId); never pay again. */
export class PaymentUncertainError extends Error {
  override name = "PaymentUncertainError";
  constructor(
    readonly jobId: string,
    reason: string,
  ) {
    super(`${reason}. The payment may have gone through: recover job ${jobId}, do not pay again.`);
  }
}

export class PaymentRefusedError extends Error {
  override name = "PaymentRefusedError";
}

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem<string>> | undefined,
  ) {
    super(`the provider answered ${status}${problem?.code ? ` ${problem.code}` : ""}${problem?.detail ? `: ${problem.detail}` : ""}`);
  }
}

export class PaymentClient {
  private readonly fetch: typeof fetch;
  private readonly confirmPayment: ConfirmPayment;
  private readonly createPayload: NonNullable<PaymentClientOptions["createPayload"]>;

  constructor(private readonly options: PaymentClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.confirmPayment = options.confirmPayment ?? rpcConfirmPayment(options.rpcUrl);
    const scheme = new ExactStellarScheme(options.signer, options.rpcUrl === undefined ? undefined : { url: options.rpcUrl });
    this.createPayload = options.createPayload ?? ((requirements) => scheme.createPaymentPayload(2, requirements));
  }

  get address(): string {
    return this.options.signer.address;
  }

  /** Everything needed to show the approval screen. Nothing is signed or paid. */
  async quote(manifestUrl: string, serviceName: string, input: JsonObject): Promise<Quote> {
    const { journal, secrets, policy } = this.options;
    const loadOptions: { fetch: typeof fetch; allowLocalhost?: boolean } = { fetch: this.fetch };
    if (this.options.allowLocalhost !== undefined) loadOptions.allowLocalhost = this.options.allowLocalhost;
    const manifest = await loadManifest(manifestUrl, loadOptions);
    const service = manifest.services.find((candidate) => candidate.name === serviceName);
    if (service === undefined) throw new PaymentRefusedError(`the provider has no service "${serviceName}"`);

    // The job identity is fixed, and saved, before the first request [J1].
    const jobId = crypto.randomUUID();
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const binding = await bindingHash(service.name, input);
    await secrets.set(jobId, token);
    const hash = await policyHash(policy);
    await journal.append("intent", jobId, hash, {
      manifestUrl,
      baseUrl: manifest.baseUrl,
      service: service.name,
      bindingHash: binding,
      input,
    });

    const response = await this.fetch(createJobUrl(manifest.baseUrl, service.name), {
      method: "POST",
      headers: this.jobHeaders(jobId, token),
      body: JSON.stringify(input),
      redirect: "manual",
    });
    if (response.status !== 402) throw new ProviderError(response.status, await readProblem(response));
    const header = response.headers.get("PAYMENT-REQUIRED");
    const challenge = header !== null ? decodePaymentRequiredHeader(header) : ((await response.json()) as PaymentRequired);

    const challengeViolations = checkChallenge(manifest, service.name, challenge).map((v) => `[${v.rule}] ${v.pointer}: ${v.message}`);
    const requirements = challenge.accepts?.[0] ?? ({} as PaymentRequirements);
    const decision = checkPolicy(policy, {
      action: PAY_ACTION,
      network: requirements.network,
      asset: requirements.asset,
      amount: requirements.amount ?? "0",
      payTo: requirements.payTo,
      spentLast24h: journal.spentSince(new Date(Date.now() - 86400_000)),
    });

    const quote: Quote = {
      manifestUrl,
      manifest,
      service,
      input,
      jobId,
      bindingHash: binding,
      challenge,
      requirements,
      challengeViolations,
      policyViolations: decision.violations,
      needsApproval: decision.needsApproval,
    };
    if (!this.payable(quote)) await journal.append("refused", jobId, hash, { reasons: this.reasons(quote) });
    return quote;
  }

  /** Whether quote() found nothing that blocks the payment (approval aside). */
  payable(quote: Quote): boolean {
    return quote.challengeViolations.length === 0 && quote.policyViolations.length === 0;
  }

  /**
   * Signs once and pays. `approved` is the human's answer to the approval screen; it is ignored for
   * payments the policy auto-approves. A refusal is journaled and thrown.
   */
  async pay(quote: Quote, { approved }: { approved: boolean }): Promise<PaymentResult> {
    const { journal, policy } = this.options;
    const hash = await policyHash(policy);
    if (!this.payable(quote)) throw new PaymentRefusedError(this.reasons(quote).join("; "));
    if (journal.forJob(quote.jobId).some((entry) => entry.event === "sending")) {
      throw new PaymentRefusedError(`job ${quote.jobId} was already paid for; use recover()`);
    }
    // Limits are checked again: another payment may have run since the quote.
    const decision = checkPolicy(policy, {
      action: PAY_ACTION,
      ...pick(quote.requirements),
      spentLast24h: journal.spentSince(new Date(Date.now() - 86400_000)),
    });
    if (!decision.allowed) {
      await journal.append("refused", quote.jobId, hash, { reasons: decision.violations.map((v) => `${v.field}: ${v.message}`) });
      throw new PaymentRefusedError(decision.violations.map((v) => v.message).join("; "));
    }
    if (decision.needsApproval && !approved) {
      await journal.append("refused", quote.jobId, hash, { reasons: ["the user declined"] });
      throw new PaymentRefusedError("the user declined the payment");
    }
    await journal.append("approved", quote.jobId, hash, { by: decision.needsApproval ? "user" : "policy" });

    const signed = await this.createPayload(quote.requirements);
    const payload: PaymentPayload = { ...signed, x402Version: 2, resource: quote.challenge.resource, accepted: quote.requirements };
    // Written and flushed before the request goes out: from here on, this job is never signed again.
    await journal.append("sending", quote.jobId, hash, { ...pick(quote.requirements), payer: this.address });

    const token = (await this.options.secrets.get(quote.jobId))!;
    let response: Response;
    try {
      response = await this.fetch(createJobUrl(quote.manifest.baseUrl, quote.service.name), {
        method: "POST",
        headers: { ...this.jobHeaders(quote.jobId, token), "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
        body: JSON.stringify(quote.input),
        redirect: "manual",
      });
    } catch (error) {
      await journal.append("uncertain", quote.jobId, hash, { reason: "the paid request failed in transit" });
      throw new PaymentUncertainError(quote.jobId, `the paid request failed (${(error as Error).message})`);
    }

    if (response.status === 402) {
      const reason = (await readChallengeError(response)) ?? "payment_rejected";
      // The provider refused before settling: nothing was charged.
      await journal.append("failed", quote.jobId, hash, { charged: false, reason });
      throw new PaymentRefusedError(`the provider rejected the payment: ${reason}`);
    }
    if (response.status !== 200 && response.status !== 202) {
      await journal.append("uncertain", quote.jobId, hash, { reason: `the provider answered ${response.status}` });
      throw new PaymentUncertainError(quote.jobId, `the provider answered ${response.status}`);
    }
    const job = (await response.json()) as JobView;
    return this.finish(quote.manifest.baseUrl, quote.jobId, token, job, hash);
  }

  /** Resumes a job from the journal with check-status and get-result. Never pays. */
  async recover(jobId: string): Promise<PaymentResult> {
    const { journal, secrets, policy } = this.options;
    const entries = journal.forJob(jobId);
    const intent = entries.find((entry) => entry.event === "intent");
    const token = await secrets.get(jobId);
    if (intent === undefined || token === undefined) throw new Error(`job ${jobId} is not in this journal`);
    if (!entries.some((entry) => entry.event === "sending")) {
      throw new Error(`job ${jobId} was never paid for, so there is nothing to recover`);
    }
    const hash = await policyHash(policy);
    const baseUrl = String(intent.details["baseUrl"]);
    await journal.append("recovered", jobId, hash, {});
    const job = await this.getResult(baseUrl, jobId, token);
    return this.finish(baseUrl, jobId, token, job, hash);
  }

  private async finish(baseUrl: string, jobId: string, token: string, first: JobView, hash: string): Promise<PaymentResult> {
    const { journal } = this.options;
    const job = await this.follow(baseUrl, jobId, token, first);

    let confirmation: Confirmation = { confirmed: false };
    if (job.charged === true) {
      confirmation = job.payment === undefined ? { confirmed: false, reason: "the provider sent no payment receipt" } : await this.confirm(jobId, job.payment.transaction);
      const settled = journal.forJob(jobId).filter((entry) => entry.event === "settled");
      // Journaled once, and again only when a later check confirms what an earlier one could not.
      if (settled.length === 0 || (confirmation.confirmed && !settled.some((entry) => entry.details["confirmed"] === true))) {
        await journal.append("settled", jobId, hash, {
          transaction: job.payment?.transaction ?? "",
          network: job.payment?.network ?? "",
          amount: job.payment?.amount ?? "",
          confirmed: confirmation.confirmed,
          ...(confirmation.reason === undefined ? {} : { reason: confirmation.reason }),
        });
      }
    }
    if (job.status === "failed") await journal.append("failed", jobId, hash, { charged: job.charged, code: job.error?.code ?? "" });
    else if (job.status === "succeeded") await journal.append("result", jobId, hash, { status: job.status });
    const result: PaymentResult = { job, confirmed: confirmation.confirmed };
    if (job.charged === true && confirmation.reason !== undefined) result.unconfirmedReason = confirmation.reason;
    return result;
  }

  /** Checks the transaction against what this job journaled in `sending`, never against the receipt. */
  private async confirm(jobId: string, transaction: string): Promise<Confirmation> {
    const { journal } = this.options;
    const sending = journal.forJob(jobId).find((entry) => entry.event === "sending")!.details;
    // One transaction proves one job: a provider must not reuse an earlier payment as a receipt.
    const other = journal
      .entries()
      .find((entry) => entry.event === "settled" && entry.jobId !== jobId && entry.details["confirmed"] === true && entry.details["transaction"] === transaction);
    if (other !== undefined) return { confirmed: false, reason: `transaction ${transaction} already confirmed job ${other.jobId}` };
    return this.confirmPayment(transaction, {
      network: String(sending["network"]) as StellarNetwork,
      asset: String(sending["asset"]),
      amount: String(sending["amount"]),
      payTo: String(sending["payTo"]),
      // Journals from before `payer` was recorded were signed by this client's key.
      payer: typeof sending["payer"] === "string" ? sending["payer"] : this.address,
    });
  }

  /** Polls get-result until the job finishes or followSeconds pass. */
  private async follow(baseUrl: string, jobId: string, token: string, job: JobView): Promise<JobView> {
    const deadline = Date.now() + (this.options.followSeconds ?? 120) * 1000;
    while ((job.status !== "succeeded" && job.status !== "failed") || (job.status === "succeeded" && job.output === undefined)) {
      if (Date.now() >= deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2000));
      job = await this.getResult(baseUrl, jobId, token);
    }
    return job;
  }

  private async getResult(baseUrl: string, jobId: string, token: string): Promise<JobView> {
    const response = await this.fetch(jobResultUrl(baseUrl, jobId), { headers: { [JOB_TOKEN]: token }, redirect: "manual" });
    if (response.status !== 200 && response.status !== 202) throw new ProviderError(response.status, await readProblem(response));
    return (await response.json()) as JobView;
  }

  private jobHeaders(jobId: string, token: string): Record<string, string> {
    return { "Content-Type": "application/json", [IDEMPOTENCY_KEY]: jobId, [JOB_TOKEN]: token };
  }

  private reasons(quote: Quote): string[] {
    return [...quote.challengeViolations, ...quote.policyViolations.map((v) => `${v.field}: ${v.message}`)];
  }
}

function pick(requirements: PaymentRequirements) {
  return {
    network: requirements.network as StellarNetwork,
    asset: requirements.asset,
    amount: requirements.amount,
    payTo: requirements.payTo,
  };
}

async function readProblem(response: Response): Promise<Partial<Problem<string>> | undefined> {
  try {
    return (await response.json()) as Partial<Problem<string>>;
  } catch {
    return undefined;
  }
}

async function readChallengeError(response: Response): Promise<string | undefined> {
  const header = response.headers.get("PAYMENT-REQUIRED");
  try {
    return header !== null ? decodePaymentRequiredHeader(header).error : ((await response.json()) as PaymentRequired).error;
  } catch {
    return undefined;
  }
}
