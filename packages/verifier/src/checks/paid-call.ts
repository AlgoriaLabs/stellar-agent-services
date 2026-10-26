// C4 Paid call (docs/provider-standard.md §4, §5): the test payer pays for one job, the way a careful
// client does, and the chain confirms the payment.
//
//   1. Unpaid create-job with a fresh job id and token [J1]: a 402 whose challenge matches the manifest.
//      Otherwise nothing is signed [P7].
//   2. The wallet signs within the verifier's limits, and the identical request goes out with
//      PAYMENT-SIGNATURE. A busy provider is waited out with the same payment while it is valid [Q8];
//      a 409 means it is still settling [J7]; a lost response is recovered with get-result, never paid
//      again.
//   3. Every job view is checked (§5.5–§5.7), and get-result is polled at the provider's pace until the
//      job finishes [Q9]. It must succeed, charged, with output that matches outputSchema [S1].
//   4. The receipt's transaction must carry the payment the verifier signed and move exactly the price
//      from the payer to payTo [J16]. The response that settled SHOULD carry PAYMENT-RESPONSE [P10].
//
// It runs with a test payer and a Soroban RPC, and only when C1 passed: the verifier pays only where a
// conforming client would.

import { checkChallenge as compareChallenge, type CheckResult, type JsonObject, type PaymentReceipt, type ServiceDescriptor } from "@stellar-agent-services/protocol";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { proveSettlement } from "../chain.js";
import { Recorder, skipped, type RunContext } from "../context.js";
import { answered, jsonBody, type Exchange } from "../http.js";
import { checkJobView, createJob, followJob, isBusy, isFinal, newIds, readJob, retryAfterMs, shown, type FollowedJob, type JobIds } from "../jobs.js";
import { isObject } from "../json.js";
import { PaymentRefused, type SignedPayment } from "../payments.js";
import { BUSY_WAIT_MS, readChallenge } from "./challenge.js";

/** Room left before a signed payment expires, for the provider to settle it [Q8]. */
const EXPIRY_MARGIN_MS = 10_000;

export async function checkPaidCall(ctx: RunContext): Promise<CheckResult> {
  const reason = paidCheckBlocker(ctx);
  if (reason !== undefined) return skipped("C4", reason);
  const service = ctx.target!;
  const input = ctx.inputs.get(service.name)!;
  const wallet = ctx.wallet!;
  const refusal = wallet.refusal({ amount: service.price.amount, network: ctx.manifest!.payment.accepts[0].network });
  if (refusal !== undefined) return skipped("C4", `nothing was paid: ${refusal}`);

  const recorder = new Recorder("C4");
  const ids = newIds();
  const name = `create-job for "${service.name}"`;
  recorder.evidence["service"] = service.name;
  recorder.evidence["input"] = input.source;
  recorder.evidence["jobId"] = ids.jobId;

  // 1. The challenge, for this job.
  const quote = await createJob(ctx, "C4", service.name, input.input, { ids, busyWaitMs: BUSY_WAIT_MS });
  const challenge = readChallenge(quote, name, input.source, recorder);
  if (challenge === undefined) return recorder.result();
  const violations = compareChallenge(ctx.manifest!, service.name, challenge);
  if (violations.length > 0) {
    for (const violation of violations) recorder.fail(violation.rule, `${name}: the challenge's ${violation.pointer || "/"}: ${violation.message}; nothing was signed [P7]`);
    return recorder.result();
  }
  const requirements = challenge.accepts[0]!;

  // 2. Sign once, send the identical request with the payment.
  let payment: SignedPayment;
  try {
    payment = await wallet.sign(requirements, challenge.resource, `C4 ${service.name}`);
  } catch (error) {
    if (error instanceof PaymentRefused) return skipped("C4", `nothing was paid: ${error.message}`);
    recorder.inconclusive(`the payment could not be signed: ${(error as Error).message}`);
    return recorder.result();
  }
  const signedAt = ctx.now();
  recorder.evidence["amount"] = payment.amount;
  const validFor = requirements.maxTimeoutSeconds * 1000 - EXPIRY_MARGIN_MS;
  const paid = await createJob(ctx, "C4", service.name, input.input, { ids, payment, busyWaitMs: Math.max(0, Math.min(BUSY_WAIT_MS, signedAt + validFor - ctx.now())) });
  recorder.evidence["paidStatus"] = paid.status ?? null;

  const expected = { jobId: ids.jobId, service, baseUrl: ctx.manifest!.baseUrl, payment, token: ids.token };
  let first: FollowedJob | undefined;
  if (paid.status === 200 || paid.status === 202) {
    const view = checkJobView(paid, { ...expected, endpoint: "create-job" }, recorder);
    if (view !== undefined) first = { view, exchange: paid };
  } else if (paid.status === 402) {
    const error = isObject(jsonBody(paid)) ? (jsonBody(paid) as JsonObject)["error"] : undefined;
    recorder.fail("§4.3", `the paid ${name} answered 402${error === undefined ? "" : ` with error ${shown(error)}`}: the provider refused the payment its own challenge asked for`);
  } else if (isBusy(paid)) {
    recorder.inconclusive(`the provider stayed busy (${paid.status}) while the payment was valid; it answered before taking the payment, so nothing was charged`);
  } else if (paid.status === 409 || paid.error !== undefined) {
    // Still settling [J7], or the response was lost: the job is collected with get-result, never paid again.
    first = await collect(ctx, recorder, ids, service, paid);
  } else {
    recorder.fail("§5.5", `the paid ${name} ${answered(paid)}; it must answer with the job`);
  }
  if (first === undefined) return recorder.result();

  // 3. Follow the job until it finishes.
  const deadline = ctx.now() + followMs(service);
  const final = await followJob(ctx, "C4", recorder, expected, first, deadline);
  if (final === undefined) return recorder.result();
  const { view } = final;
  recorder.evidence["status"] = String(view["status"]);
  if (view["status"] === "payment_uncertain") {
    recorder.inconclusive("the job is payment_uncertain: the provider has yet to decide its payment from the chain [J13]");
    return recorder.result();
  }
  if (!isFinal(view["status"])) {
    recorder.fail("§5.6", `job ${ids.jobId} was still ${String(view["status"])} after ${Math.round(followMs(service) / 1000)} s`);
    return recorder.result();
  }
  if (view["status"] === "failed") {
    const code = isObject(view["error"]) ? view["error"]["code"] : undefined;
    recorder.fail("§5.6", `the paid job failed with ${shown(code)} for the ${input.source} input`);
    return recorder.result();
  }
  ctx.paidJob = { service, input: input.input, jobId: ids.jobId, token: ids.token, payment, view };

  // 4. The receipt, against the chain [J16].
  const receipt = view["payment"];
  if (view["charged"] !== true || !isObject(receipt) || typeof receipt["transaction"] !== "string") return recorder.result();
  const transaction = receipt["transaction"];
  const proof = await proveSettlement(ctx.chain!, payment, transaction, { sleep: ctx.sleep });
  if (proof.outcome === "refuted") recorder.fail("J16", proof.reason);
  if (proof.outcome === "unknown") recorder.inconclusive(proof.reason);
  if (proof.outcome === "confirmed") {
    recorder.evidence["transaction"] = transaction;
    recorder.evidence["ledger"] = proof.ledger;
    const other = ctx.transactions.get(transaction);
    if (other !== undefined) recorder.fail("J16", `transaction ${transaction} is also the receipt of job ${other}: one transaction proves one job`);
    ctx.transactions.set(transaction, ids.jobId);
    if (!recorder.failed) ctx.payment = receiptOf(receipt);
  }

  // [P10]: the response that settled carries PAYMENT-RESPONSE, naming the same transaction.
  const settledInResponse = (paid.status === 200 || paid.status === 202) && first.view["charged"] === true;
  if (settledInResponse) {
    const header = paid.headers.get("PAYMENT-RESPONSE");
    let named: unknown;
    try {
      named = header === null ? undefined : decodePaymentResponseHeader(header).transaction;
    } catch {
      named = undefined;
    }
    if (named !== transaction) recorder.warn("P10", `the response that settled the payment should carry a PAYMENT-RESPONSE header naming transaction ${transaction}`);
  }
  return recorder.result();
}

/** Why the paid checks can't run, or undefined when they can. */
export function paidCheckBlocker(ctx: RunContext): string | undefined {
  if (ctx.payer === undefined) return "no test payer: run verifier verify --pay";
  if (!ctx.conformant) return "C1 failed, and the verifier pays only a provider whose manifest a client would accept";
  if (ctx.chain === undefined || ctx.wallet === undefined) return "no Soroban RPC to confirm payments with: pass --rpc";
  const service = ctx.target;
  if (service === undefined || !ctx.inputs.has(service.name)) return "no service has an input to pay for: add an example, or pass --service and --input";
  if (!ctx.challenges.has(service.name)) return `the challenge for "${service.name}" did not match the manifest in C3, so nothing is signed [P7]`;
  return undefined;
}

/**
 * The job after a 409 or a lost create-job response: get-result with the job's token, at the provider's
 * pace, until it answers with a job view [J7]. Undefined when it never does.
 */
async function collect(ctx: RunContext, recorder: Recorder, ids: JobIds, service: ServiceDescriptor, paid: Exchange): Promise<FollowedJob | undefined> {
  const deadline = ctx.now() + followMs(service);
  let wait = paid.status === 409 ? retryAfterMs(paid) : 1000;
  while (ctx.now() < deadline) {
    await ctx.sleep(Math.min(Math.max(wait, 1000), 60_000));
    const exchange = await readJob(ctx, "C4", ids.jobId, ids.token, true);
    wait = retryAfterMs(exchange);
    if (exchange.status === 409 || isBusy(exchange) || exchange.error !== undefined) continue;
    if (exchange.status === 200 || exchange.status === 202) {
      const view = checkJobView(exchange, { jobId: ids.jobId, service, baseUrl: ctx.manifest!.baseUrl, endpoint: "get-result" }, recorder);
      return view === undefined ? undefined : { view, exchange };
    }
    if (exchange.status === 404 && paid.error !== undefined) {
      recorder.inconclusive(`the paid create-job ${answered(paid)}, and get-result knows no such job, so the payment was probably not taken`);
      return undefined;
    }
    recorder.fail("§5.5", `get-result for job ${ids.jobId} ${answered(exchange)}`);
    return undefined;
  }
  recorder.fail("J7", `job ${ids.jobId} was still being settled after ${Math.round(followMs(service) / 1000)} s`);
  return undefined;
}

/** How long a paid job is followed: its expected duration, three times over, plus its queue wait. */
export function followMs(service: ServiceDescriptor): number {
  const seconds = 3 * (service.expectedDurationSeconds ?? 10) + (service.capacity?.maxQueueWaitSeconds ?? 0);
  return Math.min(600, Math.max(60, seconds)) * 1000;
}

function receiptOf(receipt: Record<string, unknown>): PaymentReceipt {
  return {
    network: receipt["network"] as PaymentReceipt["network"],
    asset: String(receipt["asset"]),
    amount: String(receipt["amount"]),
    payTo: String(receipt["payTo"]),
    payer: String(receipt["payer"]),
    transaction: String(receipt["transaction"]),
    settledAt: String(receipt["settledAt"]),
  };
}
