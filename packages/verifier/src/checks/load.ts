// C7 Load (docs/provider-standard.md §5.8): load is answered, before payment, and never charged for.
// Independent of the conformance levels; it earns the "Load-safe" badge, so it holds the provider to the
// SHOULD rules of §5.8.
//
//   burst   create-job requests at once (20 by default), unpaid, for the probe service. Each one is
//           answered within 30 s with 402, or with 429 or 503 carrying Retry-After [Q1]. A 500, a
//           dropped connection or a timeout fails the check.
//   paid    with a test payer, once C4 passed: capacity.concurrency + 1 jobs paid at once (5 when the
//           manifest gives no capacity), so at least one has to wait or be turned away. Each is accepted
//           (200 or 202, with `queue` while queued [Q5]) and then finishes [Q4] (an on-success job that
//           times out should not have been admitted [Q2]), or is refused with 429 or 503 before
//           settlement [Q3]. Accepted jobs prove their payment like C4's, each with its own transaction
//           [J16]. A payment that was not to be charged, refused [Q3] or for work that failed [S1], must
//           never land: once its signature has expired, the chain must show no transfer for it.

import { type CheckResult, type JsonObject, type ServiceDescriptor } from "@stellar-agent-services/protocol";
import { findSettlements, proveSettlement, waitForLedger } from "../chain.js";
import { Recorder, skipped, type RunContext } from "../context.js";
import { answered, type Exchange } from "../http.js";
import { checkJobView, createJob, followJob, isBusy, isFinal, newIds, shown, type JobIds } from "../jobs.js";
import { isObject } from "../json.js";
import { PaymentRefused, type SignedPayment } from "../payments.js";
import { paidCheckBlocker, followMs } from "./paid-call.js";

/** How long each request of the burst may take. */
const BURST_TIMEOUT_MS = 30_000;
/** Paid jobs when the manifest gives no capacity: the kit's default concurrency of 4, plus one. */
const DEFAULT_PAID_JOBS = 5;
/** More paid jobs than this are not sent: the paid part is skipped. */
const MAX_PAID_JOBS = 10;

export async function checkLoad(ctx: RunContext): Promise<CheckResult> {
  const manifest = ctx.manifest;
  if (manifest === undefined || !ctx.usable) return skipped("C7", "the manifest could not be used (C1)");
  const service = ctx.target;
  const probe = service === undefined ? undefined : ctx.inputs.get(service.name);
  if (service === undefined || probe === undefined) return skipped("C7", "no service has an input to send: add an example, or pass --service and --input");

  const recorder = new Recorder("C7");
  recorder.evidence["service"] = service.name;
  if (service.capacity === undefined) recorder.evidence["capacity"] = null;
  await burst(ctx, recorder, service, probe.input);
  await paidLoad(ctx, recorder, service, probe.input);
  return recorder.result();
}

/** [Q1]: every request of an unpaid burst gets 402, or 429 or 503 with Retry-After, in time. */
async function burst(ctx: RunContext, recorder: Recorder, service: ServiceDescriptor, input: JsonObject): Promise<void> {
  const answers = await Promise.all(
    Array.from({ length: ctx.burstSize }, () => createJob(ctx, "C7", service.name, input, { ids: newIds(), timeoutMs: BURST_TIMEOUT_MS })),
  );
  const statuses: Record<string, number> = {};
  const wrong: Record<string, number> = {};
  let longestRetryAfter = 0;
  for (const exchange of answers) {
    const outcome = exchange.error === undefined ? String(exchange.status) : exchange.error;
    statuses[outcome] = (statuses[outcome] ?? 0) + 1;
    const retryAfter = retryAfterSeconds(exchange);
    if (retryAfter !== undefined) longestRetryAfter = Math.max(longestRetryAfter, retryAfter);
    const ok = exchange.error === undefined && (exchange.status === 402 || (isBusy(exchange) && retryAfter !== undefined));
    if (!ok) {
      const what = isBusy(exchange) && exchange.error === undefined ? `answered ${exchange.status} without Retry-After` : answered(exchange);
      wrong[what] = (wrong[what] ?? 0) + 1;
    }
  }
  for (const [what, count] of Object.entries(wrong)) {
    recorder.fail("Q1", `${count} of ${ctx.burstSize} create-job requests sent at once ${what}; load must be answered with 402, or 429 or 503 with Retry-After`);
  }
  recorder.evidence["burst"] = { requests: ctx.burstSize, statuses, longestRetryAfter };
}

/** The paid part: concurrency + 1 paid jobs at once, each accepted and finished or refused uncharged. */
async function paidLoad(ctx: RunContext, recorder: Recorder, service: ServiceDescriptor, input: JsonObject): Promise<void> {
  const note = (reason: string) => (recorder.evidence["paid"] = { skipped: reason });
  const blocker = paidCheckBlocker(ctx);
  if (blocker !== undefined) return void note(blocker);
  if (ctx.paidJob === undefined || ctx.payment === undefined) return void note("C4 did not pass, so paying more jobs would prove nothing");
  const count = service.capacity?.concurrency === undefined ? DEFAULT_PAID_JOBS : service.capacity.concurrency + 1;
  if (count > MAX_PAID_JOBS) return void note(`a concurrency of ${count - 1} would take ${count} paid jobs; the verifier pays at most ${MAX_PAID_JOBS}`);
  const wallet = ctx.wallet!;
  const refusal = wallet.refusal({ amount: service.price.amount, network: ctx.manifest!.payment.accepts[0].network }, count);
  if (refusal !== undefined) return void note(refusal);
  const challenge = ctx.challenges.get(service.name)!;
  const requirements = challenge.accepts[0]!;

  // Signed first, then sent together, so they all arrive at once.
  const jobs: { ids: JobIds; payment: SignedPayment }[] = [];
  try {
    for (let i = 1; i <= count; i++) jobs.push({ ids: newIds(), payment: await wallet.sign(requirements, challenge.resource, `C7 ${service.name} ${i}/${count}`) });
  } catch (error) {
    if (error instanceof PaymentRefused) return void note(error.message);
    recorder.inconclusive(`a load payment could not be signed: ${(error as Error).message}`);
    return;
  }
  const answers = await Promise.all(jobs.map((job) => createJob(ctx, "C7", service.name, input, { ids: job.ids, payment: job.payment })));

  // Payments that must never land: refused before settlement [Q3], or for work that failed uncharged [S1].
  const uncharged: { payment: SignedPayment; why: string; rule: string }[] = [];
  let refused = 0;
  const accepted: { ids: JobIds; payment: SignedPayment; exchange: Exchange; view: JsonObject }[] = [];
  answers.forEach((exchange, i) => {
    const { ids, payment } = jobs[i]!;
    if (isBusy(exchange) && exchange.error === undefined) {
      refused++;
      uncharged.push({ payment, why: `a payment refused with ${exchange.status}`, rule: "Q3" });
      if (retryAfterSeconds(exchange) === undefined) recorder.fail("Q3", `a paid create-job was refused with ${exchange.status} without Retry-After`);
    } else if (exchange.status === 200 || exchange.status === 202) {
      const view = checkJobView(exchange, { jobId: ids.jobId, service, baseUrl: ctx.manifest!.baseUrl, endpoint: "create-job", payment, queueRequired: true }, recorder);
      if (view !== undefined) accepted.push({ ids, payment, exchange, view });
    } else {
      recorder.fail("Q3", `a paid create-job sent with ${count - 1} others ${answered(exchange)}; it must be accepted, or refused with 429 or 503 and Retry-After before the payment is taken`);
    }
  });
  const queued = accepted.filter((job) => job.view["status"] === "queued").length;

  // [Q4]: an accepted job finishes, and proves its own payment [J16].
  const deadline = ctx.now() + followMs(service);
  let finished = 0;
  for (const job of accepted) {
    const final = await followJob(ctx, "C7", recorder, { jobId: job.ids.jobId, service, baseUrl: ctx.manifest!.baseUrl, payment: job.payment, token: job.ids.token }, { view: job.view, exchange: job.exchange }, deadline);
    if (final === undefined) continue;
    const status = final.view["status"];
    if (status === "payment_uncertain") {
      recorder.inconclusive(`load job ${job.ids.jobId} is payment_uncertain`);
      continue;
    }
    if (!isFinal(status)) {
      recorder.fail("Q4", `accepted job ${job.ids.jobId} was still ${String(status)} after ${Math.round(followMs(service) / 1000)} s`);
      continue;
    }
    if (status === "failed") {
      const code = isObject(final.view["error"]) ? final.view["error"]["code"] : undefined;
      // An on-success job may time out when its payment expires [Q4]; then it should not have been admitted [Q2].
      if (code === "timeout" && service.charge === "on-success") recorder.fail("Q2", `accepted job ${job.ids.jobId} timed out before its payment expired; it should have been turned away`);
      else recorder.fail("Q4", `accepted job ${job.ids.jobId} failed with ${shown(code)}; load must not fail an accepted job`);
      if (final.view["charged"] === false) uncharged.push({ payment: job.payment, why: `the payment of job ${job.ids.jobId}, which failed uncharged,`, rule: "S1" });
      continue;
    }
    finished++;
    const receipt = final.view["payment"];
    const transaction = isObject(receipt) && typeof receipt["transaction"] === "string" ? receipt["transaction"] : undefined;
    if (transaction === undefined) continue;
    const proof = await proveSettlement(ctx.chain!, job.payment, transaction, { sleep: ctx.sleep });
    if (proof.outcome === "refuted") recorder.fail("J16", proof.reason);
    if (proof.outcome === "unknown") recorder.inconclusive(proof.reason);
    const other = ctx.transactions.get(transaction);
    if (other !== undefined) recorder.fail("J16", `transaction ${transaction} is the receipt of jobs ${other} and ${job.ids.jobId}: one transaction proves one job`);
    ctx.transactions.set(transaction, job.ids.jobId);
  }

  // A payment that was not to be charged never lands. Proven once each signature has expired.
  let landed = 0;
  if (uncharged.length > 0) {
    const lastLedger = Math.max(...uncharged.map(({ payment }) => payment.expirationLedger));
    const timeoutMs = (requirements.maxTimeoutSeconds + 60) * 1000;
    if (!(await waitForLedger(ctx.chain!, lastLedger, { sleep: ctx.sleep, now: ctx.now, timeoutMs }))) {
      recorder.inconclusive(`ledger ${lastLedger}, when the uncharged payments expire, did not close in time to prove they never landed`);
    } else {
      const searches = await findSettlements(ctx.chain!, uncharged.map(({ payment }) => payment));
      searches.forEach((search, i) => {
        if (search.outcome === "settled") {
          landed++;
          recorder.fail(uncharged[i]!.rule, `${uncharged[i]!.why} was settled anyway, in transaction ${search.transaction}`);
        }
        if (search.outcome === "unknown") recorder.inconclusive(search.reason);
      });
    }
  }
  recorder.evidence["paid"] = { jobs: count, accepted: accepted.length, queued, finished, refused, unchargedButSettled: landed };
}

/** Retry-After as whole seconds (§5.8), or undefined when missing or malformed. */
function retryAfterSeconds(exchange: Exchange): number | undefined {
  const value = exchange.headers.get("Retry-After")?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}
