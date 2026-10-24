// Reconciliation: deciding payment_uncertain jobs from on-chain data [J13].
//
// A job is payment_uncertain when its settlement was attempted and no usable answer came
// (payments/settlement.ts, jobs/recovery.ts). It is never charged again. The chain says what happened
// (payments/onchain.ts), and the job moves on as §5.6 allows:
//
//   settled      upfront: queued, with the receipt, and a worker runs it.
//                on-success: succeeded, with the receipt. The output was stored before settling [J14].
//   not settled  failed with payment_failed, charged: false.
//   undecided    stays payment_uncertain, and the next run looks again.
//
// The provider runs this after every recovery sweep when it has a Soroban RPC, and operators run it
// with `provider-kit reconcile`. Each update is compare-and-set from payment_uncertain, so a late
// settlement answer, another process or a second run deciding the same job is harmless: they all read
// the same chain, and the first decision stands.

import { jobError } from "@stellar-agent-services/protocol";
import type { rpc } from "@stellar/stellar-sdk";
import { findPayment, type PaymentLookup, type PaymentSearch } from "../payments/onchain.js";
import type { JobPatch, JobStore, StoredJob, StoredStatus } from "./store.js";

export interface ReconcileOptions extends PaymentSearch {
  /** Report what would change, and change nothing. */
  dryRun?: boolean;
  /** At most this many jobs per run, oldest first. Default 500. */
  limit?: number;
}

export interface Reconciled {
  jobId: string;
  service: string;
  outcome: PaymentLookup["outcome"];
  /** The job's status afterwards: what it would be, in a dry run. */
  status: StoredStatus;
  /** The settling transaction. */
  transaction?: string;
  /** Why it was not settled, or is undecided. */
  reason?: string;
}

const DEFAULT_LIMIT = 500;

/** Decides the store's payment_uncertain jobs that the chain can decide. */
export async function reconcile(store: JobStore, options: ReconcileOptions): Promise<Reconciled[]> {
  const jobs = await store.list({
    statuses: ["payment_uncertain"],
    createdBefore: new Date(Date.now() + 1000).toISOString(),
    limit: options.limit ?? DEFAULT_LIMIT,
  });
  if (jobs.length === 0) return [];
  // One read of the RPC's ledger range serves every job of the run.
  let health: rpc.Api.GetHealthResponse;
  try {
    health = await options.chain.getHealth();
  } catch (error) {
    const reason = `the chain could not be read: ${(error as Error).message}`;
    return jobs.map((job) => ({ jobId: job.jobId, service: job.service, outcome: "undecided", status: job.status, reason }));
  }
  const results: Reconciled[] = [];
  for (const job of jobs) results.push(await reconcileJob(store, job, options, health));
  return results;
}

async function reconcileJob(store: JobStore, job: StoredJob, options: ReconcileOptions, health: rpc.Api.GetHealthResponse): Promise<Reconciled> {
  // Every ledger the payment could be in is gone from this RPC's history: nothing to ask it, so a
  // backlog of such jobs costs no calls. One with more history (provider-kit reconcile --rpc) may tell.
  const lookup: PaymentLookup =
    job.claim.expirationLedger < health.oldestLedger
      ? { outcome: "undecided", reason: `the payment's ledgers are older than the RPC's history (it starts at ledger ${health.oldestLedger}); use an RPC with more history` }
      : await findPayment(job.claim, job.settlement?.transaction, options, health);
  const result = (status: StoredStatus, extra: Pick<Reconciled, "transaction" | "reason"> = {}): Reconciled => ({
    jobId: job.jobId,
    service: job.service,
    outcome: lookup.outcome,
    status,
    ...extra,
  });

  let patch: JobPatch;
  let extra: Pick<Reconciled, "transaction" | "reason">;
  switch (lookup.outcome) {
    case "undecided":
      return result(job.status, { reason: lookup.reason });
    case "settled":
      extra = { transaction: lookup.receipt.transaction };
      if (job.charge === "upfront") patch = { status: "queued", payment: lookup.receipt };
      // The runner stores the output before it settles, so this means a broken store: never report a paid job as unpaid.
      else if (job.output === undefined) return { ...result(job.status, extra), outcome: "undecided", reason: "the payment settled, but the job's output is missing" };
      else patch = { status: "succeeded", payment: lookup.receipt };
      break;
    case "not_settled":
      extra = { reason: lookup.reason };
      patch = { status: "failed", error: jobError("payment_failed", `the payment was not settled (${lookup.reason}); nothing was charged`) };
      break;
  }

  if (options.dryRun) return result(patch.status, extra);
  const updated = await store.update(job.jobId, "payment_uncertain", patch);
  // Decided meanwhile, by a late settlement answer or another process: that decision stands.
  const status = updated?.status ?? (await store.get(job.jobId))?.status ?? job.status;
  return result(status, extra);
}
