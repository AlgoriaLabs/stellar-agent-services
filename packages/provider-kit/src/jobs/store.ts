// JobStore: the persistence contract behind Job Recovery.
//
// - claim(): an atomic insert keyed by jobId that also reserves the payment fingerprint, so one
//   signed payment can buy at most one job [P9].
// - update(): compare-and-set on the status. It never moves out of a final state [J12].
// - Only sha256(job token) is stored, never the token itself [J3].
//
// TODO: expiry cleanup driven by manifest.jobs.retentionSeconds.

import type { Charge, JobFailureCode, JobStatus, JsonObject, PaymentReceipt, Problem } from "@stellar-agent-services/protocol";

/**
 * "pending" is internal: the job id and payment are claimed but settlement (upfront) has not answered
 * yet. Requests for a pending job get 409 request_in_progress [J7].
 */
export type StoredStatus = JobStatus | "pending";

export interface StoredJob {
  jobId: string;
  service: string;
  charge: Charge;
  bindingHash: string;
  tokenHash: string;
  status: StoredStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  output?: JsonObject;
  error?: Problem<JobFailureCode>;
  payment?: PaymentReceipt;
}

export type ClaimResult =
  | { outcome: "created"; job: StoredJob }
  /** Same binding and token: the existing job [J5]. */
  | { outcome: "existing"; job: StoredJob }
  /** Same job id, different binding or token [J6]. */
  | { outcome: "conflict" }
  /** The payment already bought another job [P9]. */
  | { outcome: "payment_used" };

export interface JobStore {
  get(jobId: string): Promise<StoredJob | undefined>;
  claim(job: StoredJob, paymentFingerprint: string): Promise<ClaimResult>;
  /** Applies the patch only while the job is still in `from`. Returns the updated job, or undefined. */
  update(jobId: string, from: StoredStatus, patch: Partial<StoredJob> & { status: StoredStatus }): Promise<StoredJob | undefined>;
}
