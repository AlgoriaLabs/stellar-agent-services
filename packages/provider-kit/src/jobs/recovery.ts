// Recovery sweeps: decide what a crash, a lost worker or the passage of time left behind. Run at
// startup and then periodically, by every process sharing a store (the steps are compare-and-set, so
// running them twice is harmless).
//
// - A settlement that never answered (the process died, or settle outlived every deadline) becomes
//   payment_uncertain, to be decided from on-chain data (jobs/reconcile.ts) [J13]. Nothing is charged
//   again.
// - An on-success job that never started settling before its payment expired can never be charged:
//   it fails with `timeout`, uncharged [S2], [Q4]. Expired means the ledger clock is past the payment's
//   expiration ledger, or, whether or not the clock answers, maxTimeoutSeconds have passed since the
//   claim.
// - An upfront job whose worker died is not handled here: workers lease it again (store.lease()).
// - Final jobs past jobs.retentionSeconds are deleted [J15].

import { jobError } from "@stellar-agent-services/protocol";
import type { LedgerClock } from "../payments/chain.js";
import type { JobStore, StoredJob } from "./store.js";

/** How far past its last deadline a job must be before a sweep decides that its process is gone. */
export const ORPHAN_MARGIN_SECONDS = 60;
const BATCH = 500;

export interface SweepOptions {
  maxTimeoutSeconds: number;
  /** How long a settle call may take (payments/facilitator.ts). */
  settleTimeoutSeconds: number;
  retentionSeconds: number;
  /** Tells that a payment expired from its ledger, before the wall-clock cutoff. */
  clock?: LedgerClock | undefined;
}

export async function sweep(store: JobStore, options: SweepOptions, now = Date.now()): Promise<void> {
  const settleCutoff = now - (options.settleTimeoutSeconds + ORPHAN_MARGIN_SECONDS) * 1000;
  for (const job of await all(store, ["pending", "running"], settleCutoff)) {
    // A running upfront job was settled before it queued; only on-success jobs settle while running.
    if (job.status === "running" && job.charge !== "on-success") continue;
    if (job.settlingSince === undefined || Date.parse(job.settlingSince) >= settleCutoff) continue;
    console.error(`[provider-kit] job ${job.jobId}: its settlement never answered; it is payment_uncertain until reconciled`);
    await store.update(job.jobId, job.status, {
      status: "payment_uncertain",
      settlement: { reason: "the settlement did not answer before the provider stopped" },
    });
  }

  // An on-success job settles before its payment expires or not at all. Past its expiration ledger the
  // signature is void, so even a live process can no longer charge for the job.
  const paymentCutoff = now - (options.maxTimeoutSeconds + ORPHAN_MARGIN_SECONDS) * 1000;
  const latestLedger = await options.clock?.latest().catch(() => undefined);
  for (const job of await all(store, ["queued", "running"], latestLedger === undefined ? paymentCutoff : now + 1000)) {
    if (job.charge !== "on-success" || job.settlingSince !== undefined) continue;
    const expired = Date.parse(job.createdAt) < paymentCutoff || (latestLedger !== undefined && latestLedger > job.claim.expirationLedger);
    if (!expired) continue;
    const detail = "the job did not finish before its payment expired; nothing was charged";
    if (job.status === "queued" && (await store.update(job.jobId, "queued", { status: "running" })) === undefined) continue;
    await store.update(job.jobId, "running", { status: "failed", error: jobError("timeout", detail) });
  }

  await store.deleteFinishedBefore(new Date(now - options.retentionSeconds * 1000).toISOString());
}

/**
 * Paid jobs, by service, of services not in `offered`: queued or running when the provider stopped
 * offering them. They wait, so restoring the service runs them, and check-status keeps answering.
 */
export async function strandedJobs(store: JobStore, offered: ReadonlyMap<string, unknown>): Promise<Map<string, number>> {
  const stranded = new Map<string, number>();
  for (const job of await all(store, ["queued", "running"], Date.now() + 1000)) {
    if (!offered.has(job.service)) stranded.set(job.service, (stranded.get(job.service) ?? 0) + 1);
  }
  return stranded;
}

/** Up to BATCH jobs per status group and sweep: the next sweep takes the rest. */
function all(store: JobStore, statuses: StoredJob["status"][], before: number): Promise<StoredJob[]> {
  return store.list({ statuses, createdBefore: new Date(before).toISOString(), limit: BATCH });
}
