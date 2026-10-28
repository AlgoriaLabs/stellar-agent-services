// The payment flow (docs/payment-client.md, "One payment, step by step"):
//
//   quote():   manifest -> job id, token, binding hash -> unpaid create-job -> 402 -> checkChallenge
//              -> pick a payment method -> policy and wallet budget. Nothing is signed.
//   pay():     approval -> sign once -> journal `sending` -> paid create-job -> follow the job ->
//              confirm on chain.
//   recover(): check-status / get-result from the journal. Never signs or pays again.
//
// A busy provider answers create-job with 429 or 503 before it claims or settles anything. The client
// waits out Retry-After and sends the same request again, the paid one with the same signed payment,
// which still buys at most one job (docs/provider-standard.md §5.8) [Q8]. It gives up after
// busyWaitSeconds, or once the signed payment is about to expire.
//
// 409 request_in_progress means the opposite: the provider has claimed the payment and is still
// settling it [J7]. The client never pays again; it follows the job with get-result until it has a job
// view, for followSeconds, and otherwise hands it back for recover().
//
// The signer and the payment methods are strategies (strategies.ts). Every safety step stays here, so
// it holds whichever ones are plugged in.

import {
  bindingHash,
  checkChallenge,
  createJobUrl,
  IDEMPOTENCY_KEY,
  JOB_TOKEN,
  jobResultUrl,
  parseRetryAfter,
  type JobView,
  type JsonObject,
  type Problem,
  type ProviderManifest,
  type ServiceDescriptor,
  type StellarNetwork,
} from "@stellar-agent-services/protocol";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { Journal, SecretStore } from "./journal.js";
import { loadManifest } from "./manifest.js";
import { checkPolicy, PAY_ACTION, policyHash, type PolicyDecision, type PolicyViolation, type SpendingPolicy } from "./policy.js";
import type { Confirmation, PaymentMethod, SignedPayload, Signer } from "./strategies.js";
import { X402_EXACT_STELLAR, x402ExactStellar } from "./x402-exact-stellar.js";

export interface PaymentClientOptions {
  /** Who pays: localKeySigner(), or a wallet adapter. */
  signer: Signer;
  /** How to pay. The first method that matches the challenge is used. Default: x402ExactStellar(). */
  methods?: PaymentMethod[];
  policy: SpendingPolicy;
  journal: Journal;
  secrets: SecretStore;
  fetch?: typeof fetch;
  /** Soroban RPC for the default payment method. Defaults to the public testnet RPC. */
  rpcUrl?: string;
  /** Accept http://localhost providers, for local development. */
  allowLocalhost?: boolean;
  /** How long pay() and recover() follow a running job before returning it. Default 120 s. */
  followSeconds?: number;
  /** Time between polls while following a job. Default: the provider's Retry-After, or 2000 ms. */
  pollMs?: number;
  /** How long quote() and pay() wait out a busy provider (429 or 503) before giving up. Default 30 s. */
  busyWaitSeconds?: number;
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
  /** The 402 does not match the manifest [P7], or no installed method can pay it. Any entry blocks the payment. */
  challengeViolations: string[];
  /** The installed payment method that pays this challenge. */
  methodId: string | undefined;
  /** What a policy wallet can still pay on chain, when the signer reports a budget. */
  walletBudget: string | undefined;
  /** The spending policy's violations, and the wallet budget's (`wallet.budget`). */
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
    /** What happened, without the advice the message adds. */
    readonly reason: string,
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

/** The provider is busy (429 or 503) and answered before taking the payment: nothing was charged. */
export class ProviderBusyError extends ProviderError {
  override name = "ProviderBusyError";
  constructor(
    status: number,
    problem: Partial<Problem<string>> | undefined,
    /** When the provider suggested trying again. */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(status, problem);
    const again = retryAfterSeconds === undefined ? "later" : `in ${retryAfterSeconds} s`;
    this.message = `the provider is busy${problem?.code ? ` (${problem.code})` : ""}; try again ${again}`;
  }
}

/** Seconds to wait when a busy answer has no usable Retry-After. */
const BUSY_RETRY_SECONDS = 2;
/** Room left, before the signed payment expires, for the provider to settle it. */
const PAYMENT_EXPIRY_MARGIN_SECONDS = 10;

export class PaymentClient {
  private readonly fetch: typeof fetch;
  private readonly methods: readonly PaymentMethod[];
  /** Jobs inside pay() right now. A slow signer, such as a wallet popup, must not let a job be signed twice. */
  private readonly paying = new Set<string>();

  constructor(private readonly options: PaymentClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.methods = options.methods ?? [x402ExactStellar(options.rpcUrl === undefined ? {} : { rpcUrl: options.rpcUrl })];
    if (this.methods.length === 0) throw new TypeError("PaymentClient needs at least one payment method");
    const ids = this.methods.map((method) => method.id);
    // Recovery finds the method that paid by its id.
    if (new Set(ids).size !== ids.length) throw new TypeError(`payment method ids must be unique: ${ids.join(", ")}`);
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
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
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

    const response = await this.createJob(
      createJobUrl(manifest.baseUrl, service.name),
      { method: "POST", headers: this.jobHeaders(jobId, token), body: JSON.stringify(input), redirect: "manual" },
      Date.now() + this.busyWaitMs,
    );
    if (isBusy(response)) throw await busyError(response);
    if (response.status !== 402) throw new ProviderError(response.status, await readProblem(response));
    const header = response.headers.get("PAYMENT-REQUIRED");
    const challenge = header !== null ? decodePaymentRequiredHeader(header) : ((await response.json()) as PaymentRequired);

    const challengeViolations = checkChallenge(manifest, service.name, challenge).map((v) => `[${v.rule}] ${v.pointer}: ${v.message}`);
    const requirements = challenge.accepts?.[0] ?? ({} as PaymentRequirements);
    const method = this.methodFor(requirements);
    if (method === undefined) challengeViolations.push(noMethod(requirements));
    const limits = await this.checkLimits(requirements);

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
      methodId: method?.id,
      walletBudget: limits.walletBudget,
      policyViolations: limits.violations,
      needsApproval: limits.needsApproval,
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
    if (!this.payable(quote)) throw new PaymentRefusedError(this.reasons(quote).join("; "));
    if (this.options.journal.forJob(quote.jobId).some((entry) => entry.event === "sending")) {
      throw new PaymentRefusedError(`job ${quote.jobId} was already paid for; use recover()`);
    }
    // Checked and marked before the first await, so a second pay() for this job can't sign it again.
    if (this.paying.has(quote.jobId)) throw new PaymentRefusedError(`job ${quote.jobId} is already being paid`);
    this.paying.add(quote.jobId);
    try {
      return await this.payOnce(quote, approved);
    } finally {
      this.paying.delete(quote.jobId);
    }
  }

  /**
   * The human said no on the approval screen. Journaled, and nothing is signed. Too late once the job is
   * being paid or was sent; recover() it instead.
   */
  async decline(quote: Quote): Promise<void> {
    const { journal, policy } = this.options;
    if (this.paying.has(quote.jobId)) return;
    if (journal.forJob(quote.jobId).some((entry) => entry.event === "refused" || entry.event === "sending")) return;
    await journal.append("refused", quote.jobId, await policyHash(policy), { reasons: ["the user declined"] });
  }

  private async payOnce(quote: Quote, approved: boolean): Promise<PaymentResult> {
    const { journal, policy, signer } = this.options;
    const hash = await policyHash(policy);
    const method = this.methodFor(quote.requirements);
    if (method === undefined) throw new PaymentRefusedError(noMethod(quote.requirements));
    // Limits are checked again: another payment may have run since the quote.
    const decision = await this.checkLimits(quote.requirements);
    if (!decision.allowed) {
      await journal.append("refused", quote.jobId, hash, { reasons: decision.violations.map((v) => `${v.field}: ${v.message}`) });
      throw new PaymentRefusedError(decision.violations.map((v) => v.message).join("; "));
    }
    if (decision.needsApproval && !approved) {
      await journal.append("refused", quote.jobId, hash, { reasons: ["the user declined"] });
      throw new PaymentRefusedError("the user declined the payment");
    }
    await journal.append("approved", quote.jobId, hash, { by: decision.needsApproval ? "user" : "policy" });

    let signed: SignedPayload;
    // Taken before signing, which may wait on a wallet popup: the payment's validity starts when it is built.
    const signedAt = Date.now();
    try {
      signed = await method.createPayload(quote.requirements, signer);
    } catch (error) {
      // Nothing was sent, so nothing was charged, and the user may try again.
      const reason = `the payment was not signed: ${(error as Error).message}`;
      await journal.append("refused", quote.jobId, hash, { reasons: [reason] });
      throw new PaymentRefusedError(reason);
    }
    const payload: PaymentPayload = { ...signed, x402Version: 2, resource: quote.challenge.resource, accepted: quote.requirements };
    // Written and flushed before the request goes out: from here on, this job is never signed again.
    await journal.append("sending", quote.jobId, hash, { ...pick(quote.requirements), payer: signer.address, method: method.id });

    const token = (await this.options.secrets.get(quote.jobId))!;
    // A busy provider is waited out with the same signed payment [Q8], but only while it can still settle it.
    const expiresAt = signedAt + (quote.requirements.maxTimeoutSeconds - PAYMENT_EXPIRY_MARGIN_SECONDS) * 1000;
    let response: Response;
    try {
      response = await this.createJob(
        createJobUrl(quote.manifest.baseUrl, quote.service.name),
        {
          method: "POST",
          headers: { ...this.jobHeaders(quote.jobId, token), "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
          body: JSON.stringify(quote.input),
          redirect: "manual",
        },
        Math.min(Date.now() + this.busyWaitMs, expiresAt),
      );
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
    if (isBusy(response)) {
      // Answered at step 5 of §5.4, before the payment was verified or claimed: nothing was charged.
      const error = await busyError(response);
      await journal.append("failed", quote.jobId, hash, { charged: false, reason: error.problem?.code ?? `provider_busy_${response.status}` });
      throw error;
    }
    if (isInProgress(response)) {
      // The provider holds the payment and is still settling it: follow the job, never pay again.
      const settled = await this.whileSettling(quote.manifest.baseUrl, quote.jobId, token, response);
      if (settled === undefined) {
        await journal.append("uncertain", quote.jobId, hash, { reason: "the provider was still settling the payment" });
        throw new PaymentUncertainError(quote.jobId, "the provider is still settling the payment");
      }
      return this.finish(quote.manifest.baseUrl, quote.jobId, token, settled.job, hash, settled.retryAfter);
    }
    if (response.status !== 200 && response.status !== 202) {
      await journal.append("uncertain", quote.jobId, hash, { reason: `the provider answered ${response.status}` });
      throw new PaymentUncertainError(quote.jobId, `the provider answered ${response.status}`);
    }
    const job = (await response.json()) as JobView;
    return this.finish(quote.manifest.baseUrl, quote.jobId, token, job, hash, retryAfterMs(response));
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
    const response = await this.getResult(baseUrl, jobId, token);
    if (isBusy(response)) throw await busyError(response);
    if (isInProgress(response)) {
      const settled = await this.whileSettling(baseUrl, jobId, token, response);
      if (settled === undefined) throw new PaymentUncertainError(jobId, "the provider is still settling the payment");
      return this.finish(baseUrl, jobId, token, settled.job, hash, settled.retryAfter);
    }
    const job = await readJob(response);
    return this.finish(baseUrl, jobId, token, job, hash, retryAfterMs(response));
  }

  /**
   * Polls get-result while the provider answers 409 request_in_progress, at its Retry-After pace, for at
   * most followSeconds. Resolves with the first job view, or undefined if settlement outlasted the wait.
   */
  private async whileSettling(baseUrl: string, jobId: string, token: string, response: Response): Promise<{ job: JobView; retryAfter: number | undefined } | undefined> {
    const deadline = Date.now() + (this.options.followSeconds ?? 120) * 1000;
    for (;;) {
      const wait = this.options.pollMs ?? retryAfterMs(response) ?? 2000;
      await response.body?.cancel();
      if (Date.now() + wait > deadline) return undefined;
      await sleep(wait);
      response = await this.getResult(baseUrl, jobId, token);
      // Busy is "ask again later" too [Q9].
      if (!isInProgress(response) && !isBusy(response)) return { job: await readJob(response), retryAfter: retryAfterMs(response) };
    }
  }

  private async finish(baseUrl: string, jobId: string, token: string, first: JobView, hash: string, retryAfter: number | undefined): Promise<PaymentResult> {
    const { journal } = this.options;
    const job = await this.follow(baseUrl, jobId, token, first, retryAfter);

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
    // Journals from before `method` was recorded were paid with the only method there was.
    const methodId = typeof sending["method"] === "string" ? sending["method"] : X402_EXACT_STELLAR;
    const method = this.methods.find((candidate) => candidate.id === methodId);
    if (method === undefined) return { confirmed: false, reason: `payment method "${methodId}" is not installed, so the payment can't be checked` };
    try {
      return await method.confirm(transaction, {
        network: String(sending["network"]) as StellarNetwork,
        asset: String(sending["asset"]),
        amount: String(sending["amount"]),
        payTo: String(sending["payTo"]),
        // Journals from before `payer` was recorded were signed by this client's key.
        payer: typeof sending["payer"] === "string" ? sending["payer"] : this.address,
      });
    } catch (error) {
      return { confirmed: false, reason: `the payment could not be checked: ${(error as Error).message}` };
    }
  }

  /** The first installed method that pays the entry. A method that throws does not match (fail closed). */
  private methodFor(requirements: PaymentRequirements): PaymentMethod | undefined {
    return this.methods.find((method) => {
      try {
        return method.matches(requirements);
      } catch {
        return false;
      }
    });
  }

  /** The spending policy, plus a policy wallet's own on-chain budget. Both must pass (fail closed). */
  private async checkLimits(requirements: PaymentRequirements): Promise<PolicyDecision & { walletBudget: string | undefined }> {
    const { policy, journal, signer } = this.options;
    const terms = pick(requirements);
    const decision = checkPolicy(policy, {
      action: PAY_ACTION,
      ...terms,
      amount: terms.amount ?? "0",
      spentLast24h: journal.spentSince(new Date(Date.now() - 86400_000)),
    });
    if (signer.budget === undefined || terms.amount === undefined) return { ...decision, walletBudget: undefined };

    let walletBudget: string | undefined;
    let problem: string | undefined;
    try {
      const reported = await signer.budget(terms.network, terms.asset);
      if (reported !== undefined && !/^\d+$/.test(reported)) problem = `the wallet reported an invalid budget "${reported}"`;
      else walletBudget = reported;
    } catch (error) {
      problem = `the wallet's budget could not be read: ${(error as Error).message}`;
    }
    if (walletBudget !== undefined && BigInt(terms.amount) > BigInt(walletBudget)) problem = "the amount is above what the wallet's on-chain budget has left";
    if (problem === undefined) return { ...decision, walletBudget };
    return { allowed: false, violations: [...decision.violations, { field: "wallet.budget", message: problem }], needsApproval: false, walletBudget };
  }

  /**
   * Polls get-result until the job finishes or followSeconds pass, at the provider's Retry-After pace.
   * A busy or in-progress answer while polling only means "ask again later" [Q9], [J7].
   */
  private async follow(baseUrl: string, jobId: string, token: string, job: JobView, retryAfter: number | undefined): Promise<JobView> {
    const deadline = Date.now() + (this.options.followSeconds ?? 120) * 1000;
    while ((job.status !== "succeeded" && job.status !== "failed") || (job.status === "succeeded" && job.output === undefined)) {
      // Only the provider's reconciliation can resolve it [J13]; polling won't, so hand it back now.
      if (job.status === "payment_uncertain" || Date.now() >= deadline) return job;
      const wait = this.options.pollMs ?? retryAfter ?? 2000;
      await sleep(Math.min(wait, deadline - Date.now()));
      const response = await this.getResult(baseUrl, jobId, token);
      retryAfter = retryAfterMs(response);
      if (isBusy(response) || isInProgress(response)) await response.body?.cancel();
      else job = await readJob(response);
    }
    return job;
  }

  /** get-result. Answers other than a job view, a busy provider or a job still settling throw. */
  private async getResult(baseUrl: string, jobId: string, token: string): Promise<Response> {
    const response = await this.fetch(jobResultUrl(baseUrl, jobId), { headers: { [JOB_TOKEN]: token }, redirect: "manual" });
    if (response.status !== 200 && response.status !== 202 && !isBusy(response) && !isInProgress(response)) {
      throw new ProviderError(response.status, await readProblem(response));
    }
    return response;
  }

  /** Sends create-job, and sends it again while the provider is busy and `until` allows [Q8]. */
  private async createJob(url: string, init: RequestInit, until: number): Promise<Response> {
    for (;;) {
      const response = await this.fetch(url, init);
      if (!isBusy(response)) return response;
      // A little jitter, so clients turned away together don't all come back together.
      const wait = (retryAfterMs(response) ?? BUSY_RETRY_SECONDS * 1000) * (1 + Math.random() * 0.2);
      if (Date.now() + wait > until) return response;
      await response.body?.cancel();
      await sleep(wait);
    }
  }

  private get busyWaitMs(): number {
    return (this.options.busyWaitSeconds ?? 30) * 1000;
  }

  private jobHeaders(jobId: string, token: string): Record<string, string> {
    return { "Content-Type": "application/json", [IDEMPOTENCY_KEY]: jobId, [JOB_TOKEN]: token };
  }

  private reasons(quote: Quote): string[] {
    return [...quote.challengeViolations, ...quote.policyViolations.map((v) => `${v.field}: ${v.message}`)];
  }
}

function noMethod(requirements: PaymentRequirements): string {
  return `no installed payment method pays scheme "${String(requirements.scheme)}" on ${String(requirements.network)}`;
}

/** Without Node's Buffer, so the core runs in the browser too. */
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pick(requirements: PaymentRequirements) {
  return {
    network: requirements.network as StellarNetwork,
    asset: requirements.asset,
    amount: requirements.amount,
    payTo: requirements.payTo,
  };
}

function isBusy(response: Response): boolean {
  return response.status === 429 || response.status === 503;
}

/** 409 request_in_progress: the job exists and its payment is still being claimed or settled [J7]. */
function isInProgress(response: Response): boolean {
  return response.status === 409;
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = parseRetryAfter(response.headers.get("Retry-After"));
  return seconds === undefined ? undefined : seconds * 1000;
}

async function busyError(response: Response): Promise<ProviderBusyError> {
  return new ProviderBusyError(response.status, await readProblem(response), parseRetryAfter(response.headers.get("Retry-After")));
}

async function readJob(response: Response): Promise<JobView> {
  return (await response.json()) as JobView;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
