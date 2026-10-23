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

import { jobError, type JobFailureCode, type JsonObject } from "@stellar-agent-services/protocol";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { Service } from "../define-service.js";
import type { Facilitator } from "../payments/facilitator.js";
import type { CheckedPayment } from "../payments/payload-checks.js";
import { settle } from "../payments/settlement.js";
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
}

/** on-success: resolves when the job is final or payment_uncertain, with the settle response if settled. */
export async function runOnSuccess(job: StoredJob, run: PaidRun): Promise<SettleResponse | undefined> {
  const { store, scheduler, service, requirements } = run;
  // The signed payment expires about maxTimeoutSeconds after signing [S2]; leave room to settle.
  const deadline = Date.parse(job.createdAt) + Math.max(1, requirements.maxTimeoutSeconds - SETTLE_MARGIN_SECONDS) * 1000;
  try {
    const started = await scheduler.waitForTurn(job, deadline);
    if (started === undefined) {
      if (await store.update(job.jobId, "queued", { status: "running" })) {
        await fail(store, job.jobId, "timeout", "the job could not start before its payment expired; nothing was charged");
      }
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

/** upfront: settles, then queues the job for a worker. Resolves once it is queued, failed or payment_uncertain. */
export async function settleUpfront(job: StoredJob, run: PaidRun): Promise<SettleResponse | undefined> {
  const response = await settleAndRecord(job, run, "pending", (receipt) => ({ status: "queued", payment: receipt }));
  if (response !== undefined) run.scheduler.wake(run.service.name);
  return response;
}

async function settleAndRecord(
  job: StoredJob,
  run: PaidRun,
  from: "pending" | "running",
  settled: (receipt: NonNullable<StoredJob["payment"]>) => { status: "queued" | "succeeded"; payment: NonNullable<StoredJob["payment"]> },
): Promise<SettleResponse | undefined> {
  const { store, facilitator, payload, requirements, payment } = run;
  const settlement = await settle(facilitator, payload, requirements, payment.payer);
  switch (settlement.outcome) {
    case "settled":
      await store.update(job.jobId, from, settled(settlement.receipt));
      return settlement.response;
    case "failed":
      await store.update(job.jobId, from, finished({ status: "failed", error: jobError("payment_failed", `the payment was not settled (${settlement.reason}); nothing was charged`) }));
      return undefined;
    case "uncertain": {
      // Decided later from on-chain data, never by charging again [J13]. The output stays withheld [J14].
      const record = settlement.transaction === undefined ? { reason: settlement.reason } : { reason: settlement.reason, transaction: settlement.transaction };
      console.error(`[provider-kit] job ${job.jobId}: settlement uncertain (${settlement.reason}); run reconcile`);
      await store.update(job.jobId, from, { status: "payment_uncertain", settlement: record });
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
  if (service === undefined || job.input === undefined) {
    await finish(finished({ status: "failed", error: jobError("service_failed", "the service is no longer offered") }));
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
