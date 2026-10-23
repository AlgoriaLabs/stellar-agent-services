// Recovery sweeps: decide what a crash, a lost worker or the passage of time left behind. Run at
// startup and then periodically, by every process sharing a store (the steps are compare-and-set, so
// running them twice is harmless).
//
// - A settlement that never answered (the process died, or settle outlived every deadline) becomes
//   payment_uncertain, to be decided from on-chain data [J13]. Nothing is charged again.
// - An on-success job that never started settling before its payment expired can never be charged:
//   it fails with `timeout`, uncharged [S2], [Q4].
// - An upfront job whose worker died is not handled here: workers lease it again (store.lease()).
// - Final jobs past jobs.retentionSeconds are deleted [J15].

import { jobError } from "@stellar-agent-services/protocol";
import type { JobStore, StoredJob } from "./store.js";

/** How far past its last deadline a job must be before a sweep decides that its process is gone. */
export const ORPHAN_MARGIN_SECONDS = 60;
const BATCH = 500;

export interface SweepOptions {
  maxTimeoutSeconds: number;
  /** How long a settle call may take (payments/facilitator.ts). */
  settleTimeoutSeconds: number;
  retentionSeconds: number;
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

  // An on-success job settles before its payment expires or not at all.
  const paymentCutoff = now - (options.maxTimeoutSeconds + ORPHAN_MARGIN_SECONDS) * 1000;
  for (const job of await all(store, ["queued", "running"], paymentCutoff)) {
    if (job.charge !== "on-success" || job.settlingSince !== undefined) continue;
    const detail = "the job did not finish before its payment expired; nothing was charged";
    if (job.status === "queued" && (await store.update(job.jobId, "queued", { status: "running" })) === undefined) continue;
    await store.update(job.jobId, "running", { status: "failed", error: jobError("timeout", detail) });
  }

  await store.deleteFinishedBefore(new Date(now - options.retentionSeconds * 1000).toISOString());
}

/** Up to BATCH jobs per status group and sweep: the next sweep takes the rest. */
function all(store: JobStore, statuses: StoredJob["status"][], before: number): Promise<StoredJob[]> {
  return store.list({ statuses, createdBefore: new Date(before).toISOString(), limit: BATCH });
}
