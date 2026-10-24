// Runs claimed jobs under their charge policy (docs/provider-standard.md §3.2, §5.6).
//
// - "on-success": claimed as queued -> its turn (scheduler) -> running -> handler -> output checked ->
//   output stored, settlement started -> settle -> succeeded | failed | payment_uncertain. A handler
//   failure or an invalid output settles nothing [S1]. A job that can't start, or finish, before its
//   payment expires fails with `timeout`, also uncharged [S2].
// - "upfront": claimed as pending -> settle -> queued (or failed | payment_uncertain). A worker in any
//   process sharing the store then leases it: running -> handler -> succeeded | failed. Paid before it
//   waits, so its place survives a restart [Q4]: a job whose worker died is leased again, up to
//   MAX_ATTEMPTS starts, so the handler may run more than once for one job.
// Every state change is stored before the next step, so a lost response is always recoverable, and a
// process that dies mid-settlement leaves a trail recovery.ts can decide from.
//
// Settlement has a deadline (settleTimeoutMs). Past it the job is payment_uncertain, but the answer
// still counts if it comes: a late or raced result is recorded from payment_uncertain, which the spec
// allows to become queued, succeeded or failed (§5.6). A charged payment is never dropped.
//
// An on-success job's deadline is when its payment expires, less room to settle: the close of its
// expiration ledger by the ledger clock (payments/chain.ts), so a payment the client resent long after
// signing [Q8] is not worked on past its life. The claim time plus maxTimeoutSeconds bounds it too,
// and is the deadline when the clock can't answer.

import { jobError, type JobFailureCode, type JsonObject } from "@stellar-agent-services/protocol";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { Service } from "../define-service.js";
import type { LedgerClock } from "../payments/chain.js";
import type { Facilitator } from "../payments/facilitator.js";
import type { CheckedPayment } from "../payments/payload-checks.js";
import { settle, type Settlement } from "../payments/settlement.js";
import { SETTLE_MARGIN_SECONDS, type Scheduler } from "./scheduler.js";
import type { JobStore, StoredJob } from "./store.js";

/** Starts of one upfront job before it fails: a handler that keeps killing its worker is not retried forever. */
export const MAX_ATTEMPTS = 3;

export interface PaidRun {
  store: JobStore;
  facilitator: Facilitator;
  scheduler: Scheduler;
  service: Service;
  input: JsonObject;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  payment: CheckedPayment;
  /** How long settlement may take before the job is payment_uncertain. */
  settleTimeoutMs: number;
  /** Times an on-success job by its payment's expiration ledger. */
  clock?: LedgerClock | undefined;
}

/** on-success: resolves when the job is final or payment_uncertain, with the settle response if settled. */
export async function runOnSuccess(job: StoredJob, run: PaidRun): Promise<SettleResponse | undefined> {
  const { store, scheduler, service } = run;
  const deadline = await paymentDeadline(job, run);
  try {
    const started = await scheduler.waitForTurn(job, deadline);
    if (started === undefined) {
      // Its turn never came, or came just as it gave up: either way it is failed from running.
      await store.update(job.jobId, "queued", { status: "running" });
      await fail(store, job.jobId, "timeout", "the job could not start before its payment expired; nothing was charged");
      return undefined;
    }
    const budgetMs = Math.min(deadline - Date.now(), service.timeoutSeconds * 1000);
    if (budgetMs <= 0) {
      await fail(store, job.jobId, "timeout", "the job could not start before its payment expired; nothing was charged");
      return undefined;
    }

    const startedAt = Date.now();
    const work = await doWork(service, job.jobId, run.input, budgetMs);
    scheduler.record(service.name, Date.now() - startedAt);
    if ("failure" in work) {
      await fail(store, job.jobId, work.failure, work.detail);
      return undefined;
    }
    // Stored before settling: if this process dies mid-settlement, recovery finds the output and
    // marks the job payment_uncertain rather than losing a payment that may have landed [J14].
    const settling = await store.update(job.jobId, "running", { status: "running", output: work.output, settlingSince: new Date().toISOString() });
    if (settling === undefined) return undefined;
    return await settleAndRecord(job, run, "running", (receipt) => ({ status: "succeeded", payment: receipt }));
  } finally {
    scheduler.wake(service.name);
  }
}

/**
 * When an on-success job's work must be done, leaving room to settle before its payment expires [S2]:
 * the close of its expiration ledger, but no later than maxTimeoutSeconds after the claim.
 */
async function paymentDeadline(job: StoredJob, run: PaidRun): Promise<number> {
  const byClaim = Date.parse(job.createdAt) + Math.max(1, run.requirements.maxTimeoutSeconds - SETTLE_MARGIN_SECONDS) * 1000;
  const expires = await run.clock?.closesAt(job.claim.expirationLedger).catch(() => undefined);
  return expires === undefined ? byClaim : Math.min(byClaim, expires - SETTLE_MARGIN_SECONDS * 1000);
}

/** upfront: settles, then queues the job for a worker. Resolves once it is queued, failed or payment_uncertain. */
export function settleUpfront(job: StoredJob, run: PaidRun): Promise<SettleResponse | undefined> {
  return settleAndRecord(job, run, "pending", (receipt) => ({ status: "queued", payment: receipt }));
}

async function settleAndRecord(
  job: StoredJob,
  run: PaidRun,
  from: "pending" | "running",
  settled: (receipt: NonNullable<StoredJob["payment"]>) => { status: "queued" | "succeeded"; payment: NonNullable<StoredJob["payment"]> },
): Promise<SettleResponse | undefined> {
  const { store, facilitator, payload, requirements, payment, settleTimeoutMs } = run;
  const attempt = settle(facilitator, payload, requirements, payment.payer);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(resolve, settleTimeoutMs, undefined)));
  const settlement = await Promise.race([attempt, late]);
  clearTimeout(timer);

  if (settlement === undefined) {
    const seconds = Math.round(settleTimeoutMs / 1000);
    await record(job, run, from, { outcome: "uncertain", reason: `the settlement did not answer in ${seconds} s` }, settled);
    void attempt.then((answer) => (answer.outcome === "uncertain" ? undefined : record(job, run, "payment_uncertain", answer, settled)));
    return undefined;
  }
  return record(job, run, from, settlement, settled);
}

/**
 * Stores a settlement's outcome. If the job is no longer in `from` because recovery already marked it
 * payment_uncertain, the outcome is recorded from there instead [J13].
 */
async function record(
  job: StoredJob,
  run: PaidRun,
  from: "pending" | "running" | "payment_uncertain",
  settlement: Settlement,
  settled: (receipt: NonNullable<StoredJob["payment"]>) => { status: "queued" | "succeeded"; payment: NonNullable<StoredJob["payment"]> },
): Promise<SettleResponse | undefined> {
  const { store } = run;
  const update = async (patch: Parameters<JobStore["update"]>[2]) =>
    (await store.update(job.jobId, from, patch)) ?? (from === "payment_uncertain" ? undefined : await store.update(job.jobId, "payment_uncertain", patch));
  switch (settlement.outcome) {
    case "settled": {
      const stored = await update(settled(settlement.receipt));
      if (stored?.status === "queued") run.scheduler.wake(run.service.name);
      return settlement.response;
    }
    case "failed":
      await update(finished({ status: "failed", error: jobError("payment_failed", `the payment was not settled (${settlement.reason}); nothing was charged`) }));
      return undefined;
    case "uncertain": {
      // Decided later from on-chain data, never by charging again [J13]. The output stays withheld [J14].
      const detail = settlement.transaction === undefined ? { reason: settlement.reason } : { reason: settlement.reason, transaction: settlement.transaction };
      console.error(`[provider-kit] job ${job.jobId}: settlement uncertain (${settlement.reason}); run reconcile`);
      await update({ status: "payment_uncertain", settlement: detail });
      return undefined;
    }
  }
}

export interface WorkerContext {
  store: JobStore;
  services: ReadonlyMap<string, Service>;
  scheduler: Scheduler;
  owner: string;
  leaseSeconds: number;
}

/** Runs a leased upfront job to its end, renewing the lease while the handler works. */
export async function runLeased(job: StoredJob, context: WorkerContext): Promise<void> {
  const { store, owner, leaseSeconds } = context;
  const finish = (patch: Parameters<JobStore["update"]>[2]) => store.update(job.jobId, "running", patch, owner);
  const service = context.services.get(job.service);
  if (service === undefined) {
    // Workers lease only the services they run, so this is a bug: leave the paid job for its lease to expire.
    console.error(`[provider-kit] job ${job.jobId}: leased for "${job.service}", which this process does not run`);
    return;
  }
  if (job.input === undefined) {
    await finish(finished({ status: "failed", error: jobError("service_failed", "the job's input was lost") }));
    return;
  }
  if ((job.attempts ?? 1) > MAX_ATTEMPTS) {
    await finish(finished({ status: "failed", error: jobError("service_failed", `the job was interrupted ${MAX_ATTEMPTS} times`) }));
    return;
  }

  const budgetMs = service.timeoutSeconds * 1000;
  const lost = new AbortController();
  const renew = setInterval(() => {
    store.renew(job.jobId, owner, leaseSeconds).then(
      (held) => held || lost.abort(new Error("the lease was lost")),
      (error) => console.error(`[provider-kit] job ${job.jobId}: the lease could not be renewed:`, error),
    );
  }, (leaseSeconds * 1000) / 3);
  renew.unref();
  try {
    const startedAt = Date.now();
    const work = await doWork(service, job.jobId, job.input, budgetMs, lost.signal);
    context.scheduler.record(service.name, Date.now() - startedAt);
    // Another worker took the job over: its result counts, this one is dropped.
    if (lost.signal.aborted) return;
    if ("failure" in work) await finish(finished({ status: "failed", error: jobError(work.failure, work.detail) }));
    else await finish(finished({ status: "succeeded", output: work.output }));
  } finally {
    clearInterval(renew);
  }
}

type WorkResult = { output: JsonObject } | { failure: JobFailureCode; detail: string };

/** Runs the handler for at most budgetMs, or until `stop` aborts. The handler's signal aborts with it. */
async function doWork(service: Service, jobId: string, input: JsonObject, budgetMs: number, stop?: AbortSignal): Promise<WorkResult> {
  const timeout = new AbortController();
  // A plain timer rather than AbortSignal.timeout(), so tests can drive it with fake timers.
  const timer = setTimeout(() => timeout.abort(new DOMException("the work took too long", "TimeoutError")), budgetMs);
  const signal = stop === undefined ? timeout.signal : AbortSignal.any([timeout.signal, stop]);
  let output: JsonObject;
  try {
    output = await Promise.race([
      service.handler(structuredClone(input), { signal, jobId }),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } catch (error) {
    if (signal.aborted) return { failure: "timeout", detail: `the work took longer than ${Math.round(budgetMs / 1000)} s` };
    // The handler's message may contain anything, so it is not passed on [E2].
    console.error(`[provider-kit] ${service.name} failed:`, error);
    return { failure: "service_failed", detail: "the service handler failed" };
  } finally {
    clearTimeout(timer);
  }
  if (!service.validateOutput(output)) return { failure: "output_invalid", detail: "the output did not match outputSchema" };
  return { output };
}

/** running -> failed. */
function fail(store: JobStore, jobId: string, code: JobFailureCode, detail: string) {
  return store.update(jobId, "running", finished({ status: "failed", error: jobError(code, detail) }));
}

function finished<Patch extends object>(patch: Patch): Patch & { finishedAt: string } {
  return { ...patch, finishedAt: new Date().toISOString() };
}
