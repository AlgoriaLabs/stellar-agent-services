// Error responses (docs/provider-standard.md §6).
//
// Every error other than 402 is an RFC 9457 problem with a stable `code`, which is what clients act
// on [E1]. A failed job carries the same shape in its job view, with a job failure code. 402
// responses use x402's own format, not this one.
//
// Problems never contain request headers, payment payloads or job tokens [E2]: `detail` and
// `errors[].message` are written by the provider, never copied from the request.

import { SPEC_URL } from "./standard.js";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Codes for HTTP error responses, with their status and default title (§6). */
export const PROBLEMS = {
  invalid_request: { status: 400, title: "The request is malformed" },
  invalid_input: { status: 400, title: "Input does not match the service's inputSchema" },
  service_not_found: { status: 404, title: "No service with that name" },
  job_not_found: { status: 404, title: "Job not found" },
  request_in_progress: { status: 409, title: "The job is still being claimed or settled", retryAfter: true },
  payload_too_large: { status: 413, title: "The input is larger than maxInputBytes" },
  idempotency_key_reused: { status: 422, title: "The job id is bound to a different request" },
  rate_limited: { status: 429, title: "Too many requests", retryAfter: true },
  unavailable: { status: 503, title: "The service is unavailable", retryAfter: true },
} as const satisfies Record<string, { status: number; title: string; retryAfter?: true }>;

export type ProblemCode = keyof typeof PROBLEMS;

/** Codes for a failed job, in the job view's `error.code` (§6). */
export const JOB_FAILURES = {
  service_failed: { title: "The work failed" },
  output_invalid: { title: "The output did not match outputSchema" },
  timeout: { title: "The work did not finish in time" },
  payment_failed: { title: "Settlement did not happen" },
} as const satisfies Record<string, { title: string }>;

export type JobFailureCode = keyof typeof JOB_FAILURES;

/** An RFC 9457 problem. `status` is present on HTTP errors and absent on a failed job's `error`. */
export interface Problem<Code extends string = ProblemCode> {
  type: string;
  title: string;
  status?: number;
  detail?: string;
  code: Code;
  /** invalid_input only: where the input fails its schema. */
  errors?: InputError[];
}

export interface InputError {
  /** JSON Pointer (RFC 6901) into the input. */
  pointer: string;
  message: string;
}

/** The problem `type` URI for a problem or job failure code. */
export function problemType(code: ProblemCode | JobFailureCode): string {
  return `${SPEC_URL}#error-${code}`;
}

/** Builds the body of an HTTP error response. Send it as PROBLEM_CONTENT_TYPE with PROBLEMS[code].status. */
export function problem(code: ProblemCode, options: { detail?: string; errors?: InputError[] } = {}): Problem {
  const { status, title } = PROBLEMS[code];
  return { type: problemType(code), title, status, code, ...options };
}

/** Builds a failed job's `error`. */
export function jobError(code: JobFailureCode, detail?: string): Problem<JobFailureCode> {
  const error: Problem<JobFailureCode> = { type: problemType(code), title: JOB_FAILURES[code].title, code };
  if (detail !== undefined) error.detail = detail;
  return error;
}
