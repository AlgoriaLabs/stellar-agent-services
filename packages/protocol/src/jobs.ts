// Job model: create-job, check-status, get-result (docs/provider-standard.md §5).

import { canonicalSha256 } from "./canonical-json.js";
import { IDEMPOTENCY_KEY_PATTERN } from "./headers.js";
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

// TODO:
// - JobStatus: "queued" | "running" | "succeeded" | "failed" | "payment_uncertain".
// - Charged: true | false | "unknown" ("unknown" exactly when status is payment_uncertain).
// - JobView: the one response shape for all three operations: jobId, service, status, charge,
//   charged, createdAt, updatedAt, expiresAt, output? (create-job and get-result, when succeeded),
//   error? (problem object, when failed), payment? (PaymentReceipt, when charged), jobToken? (only
//   when the provider generated the token for a client that sent none).
// - JOB_TRANSITIONS: (new) -> queued | running | payment_uncertain | failed; queued -> running;
//   running -> succeeded | failed | payment_uncertain; payment_uncertain -> queued | succeeded | failed.
//   succeeded and failed are final.
// - JobFailureCode: "service_failed" | "output_invalid" | "timeout" | "payment_failed".
