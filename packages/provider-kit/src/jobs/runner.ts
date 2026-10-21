// Runs a claimed job under its charge policy (docs/provider-standard.md §3.2, §5.6).
//
// - "on-success": the job is claimed as running -> run handler -> validate output -> settle. A handler
//   failure or an invalid output settles nothing [S1].
// - "upfront": the job is claimed as pending -> settle -> queued -> running -> succeeded | failed.
// Every state change is stored before the next step, so a lost response is always recoverable.
//
// TODO:
// - Durable background work: an upfront job whose process dies while queued or running stays there.
// - Retention and expiry.

import { jobError, type JobFailureCode, type JsonObject } from "@stellar-agent-services/protocol";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { Service } from "../define-service.js";
import { settle, type Facilitator } from "../payments/settlement.js";
import type { JobStore, StoredJob } from "./store.js";

export interface RunContext {
  store: JobStore;
  facilitator: Facilitator;
  service: Service;
  input: JsonObject;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
}

/** Resolves when the job is final or payment_uncertain. Returns the settle response if settled. */
export async function runJob(job: StoredJob, context: RunContext): Promise<SettleResponse | undefined> {
  return job.charge === "on-success" ? runOnSuccess(job, context) : runUpfront(job, context);
}

async function runOnSuccess(job: StoredJob, context: RunContext): Promise<SettleResponse | undefined> {
  const { store, facilitator, payload, requirements } = context;
  // The signed payment expires maxTimeoutSeconds after signing [S2]; leave room to settle.
  const budgetMs = Math.max(1, requirements.maxTimeoutSeconds - 10) * 1000;
  const work = await doWork(context, budgetMs);
  if ("failure" in work) {
    await fail(store, job.jobId, "running", work.failure, work.detail);
    return undefined;
  }

  const settlement = await settle(facilitator, payload, requirements);
  if (settlement.outcome === "settled") {
    await store.update(job.jobId, "running", finished({ status: "succeeded", output: work.output, payment: settlement.receipt }));
    return settlement.response;
  }
  if (settlement.outcome === "failed") {
    await fail(store, job.jobId, "running", "payment_failed", settlement.reason);
  } else {
    // The output is kept but withheld until the payment is decided from on-chain data [J14].
    await store.update(job.jobId, "running", { status: "payment_uncertain", output: work.output });
  }
  return undefined;
}

async function runUpfront(job: StoredJob, context: RunContext): Promise<SettleResponse | undefined> {
  const { store, facilitator, payload, requirements } = context;
  const settlement = await settle(facilitator, payload, requirements);
  if (settlement.outcome === "failed") {
    await fail(store, job.jobId, "pending", "payment_failed", settlement.reason);
    return undefined;
  }
  if (settlement.outcome === "uncertain") {
    await store.update(job.jobId, "pending", { status: "payment_uncertain" });
    return undefined;
  }

  await store.update(job.jobId, "pending", { status: "queued", payment: settlement.receipt });
  await store.update(job.jobId, "queued", { status: "running" });
  const work = await doWork(context, (context.service.expectedDurationSeconds ?? 300) * 2 * 1000);
  if ("failure" in work) await fail(store, job.jobId, "running", work.failure, work.detail);
  else await store.update(job.jobId, "running", finished({ status: "succeeded", output: work.output }));
  return settlement.response;
}

type WorkResult = { output: JsonObject } | { failure: JobFailureCode; detail: string };

async function doWork({ service, input }: RunContext, budgetMs: number): Promise<WorkResult> {
  const signal = AbortSignal.timeout(budgetMs);
  let output: JsonObject;
  try {
    output = await Promise.race([
      service.handler(structuredClone(input), { signal }),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ]);
  } catch (error) {
    if (signal.aborted) return { failure: "timeout", detail: `the work took longer than ${budgetMs / 1000} s` };
    // The handler's message may contain anything, so it is not passed on [E2].
    console.error(`[provider-kit] ${service.name} failed:`, error);
    return { failure: "service_failed", detail: "the service handler failed" };
  }
  if (!service.validateOutput(output)) return { failure: "output_invalid", detail: "the output did not match outputSchema" };
  return { output };
}

function fail(store: JobStore, jobId: string, from: StoredJob["status"], code: JobFailureCode, detail: string) {
  return store.update(jobId, from, finished({ status: "failed", error: jobError(code, detail) }));
}

function finished<Patch extends object>(patch: Patch): Patch & { finishedAt: string } {
  return { ...patch, finishedAt: new Date().toISOString() };
}
