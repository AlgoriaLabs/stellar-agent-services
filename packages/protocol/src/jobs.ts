// Job model: create-job, check-status, get-result (docs/provider-standard.md §5).

import { canonicalSha256, type JsonObject } from "./canonical-json.js";
import type { JobFailureCode, Problem } from "./errors.js";
import { IDEMPOTENCY_KEY_PATTERN } from "./headers.js";
import type { PaymentReceipt } from "./receipts.js";
import { SERVICE_NAME_PATTERN } from "./standard.js";

/** When the user is charged (§3.2). The manifest default is "upfront". */
export type Charge = "on-success" | "upfront";

/** POST {baseUrl}/services/{name}/jobs (§5.1). */
export function createJobUrl(baseUrl: string, service: string): string {
  if (!SERVICE_NAME_PATTERN.test(service)) throw new TypeError(`invalid service name: ${service}`);
  return `${baseUrl}/services/${service}/jobs`;
}

/** GET {baseUrl}/jobs/{jobId} (§5.1). */
export function jobStatusUrl(baseUrl: string, jobId: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(jobId)) throw new TypeError(`invalid job id: ${jobId}`);
  return `${baseUrl}/jobs/${jobId}`;
}

/** GET {baseUrl}/jobs/{jobId}/result (§5.1). */
export function jobResultUrl(baseUrl: string, jobId: string): string {
  return `${jobStatusUrl(baseUrl, jobId)}/result`;
}

/** hex(sha256(JCS({ service, input }))): binds a job id to one request (§5.3). */
export function bindingHash(service: string, input: unknown): Promise<string> {
  return canonicalSha256({ service, input });
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "payment_uncertain";
export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "succeeded", "failed", "payment_uncertain"];

/** `succeeded` and `failed` never change again [J12]. */
export const FINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed"];

/** Whether the user paid: "unknown" exactly while the job is payment_uncertain (§5.6). */
export type Charged = boolean | "unknown";

/** The one response body of create-job, check-status and get-result (§5.5). */
export interface JobView {
  jobId: string;
  service: string;
  status: JobStatus;
  charge: Charge;
  charged: Charged;
  /** RFC 3339 timestamps. */
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** create-job and get-result, when succeeded. Withheld while payment_uncertain [J14]. */
  output?: JsonObject;
  /** When failed. */
  error?: Problem<JobFailureCode>;
  /** When charged is true. */
  payment?: PaymentReceipt;
  /** Only in the create-job response, and only when the provider created the token [J2]. */
  jobToken?: string;
}

/** The states a job may start in: (new) → queued | running | payment_uncertain | failed (§5.6). */
export const INITIAL_JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "payment_uncertain", "failed"];

/** Allowed transitions between states (§5.6). Final states have none [J12]. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running"],
  running: ["succeeded", "failed", "payment_uncertain"],
  payment_uncertain: ["queued", "succeeded", "failed"],
  succeeded: [],
  failed: [],
};

/**
 * Whether a job may move from `from` (undefined for a new job) to `to`. running → payment_uncertain
 * happens only with charge "on-success", where settlement follows the work (§5.6).
 */
export function canTransition(from: JobStatus | undefined, to: JobStatus, charge: Charge): boolean {
  if (from === undefined) return INITIAL_JOB_STATUSES.includes(to);
  if (from === "running" && to === "payment_uncertain" && charge !== "on-success") return false;
  return JOB_TRANSITIONS[from].includes(to);
}

/** The `charged` value the §5.6 table requires for a job's status, charge and failure code. */
export function chargedFor(status: JobStatus, charge: Charge, failureCode?: JobFailureCode): Charged {
  switch (status) {
    case "payment_uncertain":
      return "unknown";
    case "succeeded":
      return true;
    case "failed":
      return charge === "upfront" && failureCode !== "payment_failed";
    default:
      return charge === "upfront";
  }
}

/** 200 once the job has finished, otherwise 202 with Retry-After [J8]. */
export function jobViewHttpStatus(status: JobStatus): 200 | 202 {
  return FINAL_JOB_STATUSES.includes(status) ? 200 : 202;
}
