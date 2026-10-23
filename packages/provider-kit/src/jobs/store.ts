// JobStore: the persistence contract behind Job Recovery and the queue.
//
// - claim(): an atomic insert keyed by jobId that also reserves the payment fingerprint, so one
//   signed payment can buy at most one job [P9].
// - update(): compare-and-set on the status (and, for a leased job, on the worker). It never moves a
//   job out of a final state [J12].
// - Only sha256(job token) is stored, never the token itself [J3]. The input is kept only until the
//   job is final.
// - The queue lives here too, so it is as durable as the store (docs/provider-standard.md §5.8):
//   a service's jobs start in the order they were queued, at most `concurrency` at a time, counted
//   across every process that shares the store. Workers lease upfront jobs; a job whose worker died
//   is taken over when its lease runs out, so a paid job survives a restart [Q4].
//
// memoryStore() and sqliteStore() implement it; test/job-store.test.ts is the contract every store
// must pass.

import type { Charge, JobFailureCode, JobStatus, JsonObject, PaymentReceipt, Problem } from "@stellar-agent-services/protocol";

/**
 * "pending" is internal: an upfront job whose id and payment are claimed and whose settlement has not
 * answered yet. Requests for a pending job get 409 request_in_progress [J7].
 */
export type StoredStatus = JobStatus | "pending";

/** The payment a job was claimed with. Reconciliation finds it on chain from these fields. */
export interface PaymentClaim {
  /** sha256(JCS({ network, payer, nonce })): unique across the store [P9]. */
  fingerprint: string;
  payer: string;
  nonce: string;
  /** The last ledger the payer's signature is valid for: after it, the payment can never land. */
  expirationLedger: number;
}

export interface StoredJob {
  jobId: string;
  service: string;
  charge: Charge;
  bindingHash: string;
  tokenHash: string;
  status: StoredStatus;
  claim: PaymentClaim;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Kept until the job is final: a queued upfront job runs from it, in any process, after a restart. */
  input?: JsonObject;
  output?: JsonObject;
  error?: Problem<JobFailureCode>;
  /** The settled payment. */
  payment?: PaymentReceipt;
  /** When settlement was asked for. A job still settling long after it is decided as payment_uncertain. */
  settlingSince?: string;
  /** Why the settlement is uncertain, and the transaction the facilitator named, if any. */
  settlement?: { reason: string; transaction?: string };
  /** Queue order, set by the store when the job becomes queued. */
  queueSeq?: number;
  /** The worker running an upfront job, and until when (epoch ms) its lease holds. */
  lease?: { owner: string; expiresAt: number };
  /** How many times a worker started the job. */
  attempts?: number;
}

/** What update() may change. The store sets updatedAt, and clears what a final job no longer needs. */
export type JobPatch = Partial<Omit<StoredJob, "jobId" | "service" | "charge" | "bindingHash" | "tokenHash" | "claim" | "createdAt" | "queueSeq">> & {
  status: StoredStatus;
};

export type ClaimResult =
  | { outcome: "created"; job: StoredJob }
  /** Same binding and token: the existing job [J5]. */
  | { outcome: "existing"; job: StoredJob }
  /** Same job id, different binding or token [J6]. */
  | { outcome: "conflict" }
  /** The payment already bought another job [P9]. */
  | { outcome: "payment_used" };

export interface ServiceLoad {
  pending: number;
  queued: number;
  running: number;
}

export interface JobStore {
  get(jobId: string): Promise<StoredJob | undefined>;
  /** Inserts the job and reserves job.claim.fingerprint, atomically. */
  claim(job: StoredJob): Promise<ClaimResult>;
  /**
   * Applies the patch only while the job is still in `from` and, with `owner`, still leased by that
   * worker. Returns the updated job, or undefined. On a final status the store drops the input, the
   * lease and a failed job's output, and sets finishedAt if the patch did not; settlingSince is kept
   * only while pending or running.
   */
  update(jobId: string, from: StoredStatus, patch: JobPatch, owner?: string): Promise<StoredJob | undefined>;
  /** How many of a service's jobs are being settled, are queued and are running: admission counts (§5.8). */
  load(service: string): Promise<ServiceLoad>;
  /** 1 for a service's next queued job; undefined when the job is not queued. */
  position(jobId: string): Promise<number | undefined>;
  /**
   * Moves a queued job to running if its turn has come: fewer than `concurrency` jobs of its service
   * are running and queued ahead of it. Returns the running job, or undefined.
   */
  start(jobId: string, concurrency: number): Promise<StoredJob | undefined>;
  /**
   * Gives a worker the next upfront job of a service, leased until now + leaseSeconds: first a running
   * job whose lease ran out (its worker died), else the oldest queued job if fewer than `concurrency`
   * are running. Counts the attempt. A lease held by `owner` itself is never taken over: an owner is
   * one process, which still runs its jobs even when a stalled event loop let a lease run out.
   */
  lease(service: string, concurrency: number, owner: string, leaseSeconds: number): Promise<StoredJob | undefined>;
  /** Extends a running job's lease. False when the worker no longer holds it. */
  renew(jobId: string, owner: string, leaseSeconds: number): Promise<boolean>;
  /** Jobs in the given statuses created before `createdBefore`, oldest first: for recovery sweeps. */
  list(filter: { statuses: StoredStatus[]; createdBefore: string; limit: number }): Promise<StoredJob[]>;
  /** Deletes final jobs that finished before `before`, with their payment fingerprints. Returns how many. */
  deleteFinishedBefore(before: string): Promise<number>;
  close?(): Promise<void> | void;
}

export const FINAL_STATUSES: readonly StoredStatus[] = ["succeeded", "failed"];

/** The patch rules every store applies (see update()). Mutates and returns `job`. */
export function applyPatch(job: StoredJob, patch: JobPatch, now: Date): StoredJob {
  Object.assign(job, structuredClone(patch), { updatedAt: now.toISOString() });
  if (FINAL_STATUSES.includes(job.status)) {
    delete job.input;
    delete job.lease;
    delete job.settlingSince;
    if (job.status === "failed") delete job.output;
    job.finishedAt ??= now.toISOString();
  }
  if (job.status === "payment_uncertain") delete job.lease;
  // settlingSince marks a settlement still in flight: pending (upfront) or running (on-success). Any
  // other status means the settlement was decided, so a long upfront job is never mistaken for one.
  if (job.status !== "pending" && job.status !== "running") delete job.settlingSince;
  return job;
}
