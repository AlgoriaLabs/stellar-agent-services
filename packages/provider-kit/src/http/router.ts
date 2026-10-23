// HTTP routes (Fetch API). Job paths are fixed relative to baseUrl (docs/provider-standard.md §5).
//
//   GET  <manifest path>                 -> manifest
//   POST {baseUrl}/services/{name}/jobs  -> create-job   (x402; Idempotency-Key + Job-Token, or neither)
//   GET  {baseUrl}/jobs/{jobId}          -> check-status (Job-Token)
//   GET  {baseUrl}/jobs/{jobId}/result   -> get-result   (Job-Token)
//
// create-job follows the processing order in §5.4. Errors are RFC 9457 problems that never echo
// headers, payment payloads or tokens [E2]. CORS is open so browser wallets can call providers.
//
// Capacity (§5.8) is step 5: the caller's rate limit (429), then a place in the service's lane (503),
// both before the 402, so nobody signs or pays for a job the provider can't take [Q1]. A paid request
// is checked again. The place is held while the payment is verified and claimed, then becomes the
// queued job.
//
// TODO: a 409 for a pending job on check-status, which the spec does not yet describe.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  bindingHash,
  chargedFor,
  CREATE_JOB_HOLD_MAX_SECONDS,
  DEFAULT_RETENTION_SECONDS,
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_KEY_PATTERN,
  JOB_TOKEN,
  JOB_TOKEN_PATTERN,
  jobStatusUrl,
  jobViewHttpStatus,
  problem,
  PROBLEM_CONTENT_TYPE,
  PROBLEMS,
  type InputError,
  type JobView,
  type JsonObject,
  type ProblemCode,
  type ProviderManifest,
} from "@stellar-agent-services/protocol";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import type { ErrorObject } from "ajv/dist/2020.js";
import type { Service } from "../define-service.js";
import { runJob } from "../jobs/runner.js";
import type { Reservation, Scheduler } from "../jobs/scheduler.js";
import type { JobStore, StoredJob } from "../jobs/store.js";
import type { Facilitator } from "../payments/settlement.js";
import { paymentFingerprint, paymentRequired, paymentRequirements, readPayment } from "../payments/x402-server.js";
import type { RateLimiter } from "./rate-limit.js";

export interface RouterContext {
  manifest: ProviderManifest;
  manifestPath: string;
  services: ReadonlyMap<string, Service>;
  store: JobStore;
  facilitator: Facilitator;
  scheduler: Scheduler;
  rateLimit: RateLimiter | undefined;
  holdSeconds: number;
  /** Test-only response-loss drill (docs/job-recovery.md): fail create-job after the job is stored. */
  loseCreateJobResponse: boolean;
}

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const RETRY_AFTER_SECONDS = 2;
/** Longest Retry-After on a 202 for a queued job [Q6]. */
const QUEUED_RETRY_AFTER_MAX_SECONDS = 60;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Location, Retry-After",
};

export async function route(request: Request, context: RouterContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": `Content-Type, ${IDEMPOTENCY_KEY}, ${JOB_TOKEN}, PAYMENT-SIGNATURE`,
        "Access-Control-Max-Age": "600",
      },
    });
  }
  if (url.pathname === context.manifestPath && request.method === "GET") {
    return json(context.manifest, 200, { "Cache-Control": "max-age=300" });
  }

  const basePath = new URL(context.manifest.baseUrl).pathname.replace(/\/$/, "");
  if (!url.pathname.startsWith(`${basePath}/`)) return error("service_not_found");
  const path = url.pathname.slice(basePath.length);

  const createJob = /^\/services\/([^/]+)\/jobs$/.exec(path);
  if (createJob !== null && request.method === "POST") return handleCreateJob(request, decodeURIComponent(createJob[1]!), context);

  const getJob = /^\/jobs\/([^/]+?)(\/result)?$/.exec(path);
  if (getJob !== null && request.method === "GET") return handleGetJob(request, getJob[1]!, getJob[2] !== undefined, context);

  return error("service_not_found");
}

async function handleCreateJob(request: Request, serviceName: string, context: RouterContext): Promise<Response> {
  const { store } = context;

  // 1. Headers and body.
  const jobIdHeader = request.headers.get(IDEMPOTENCY_KEY);
  const tokenHeader = request.headers.get(JOB_TOKEN);
  if ((jobIdHeader === null) !== (tokenHeader === null)) {
    return error("invalid_request", `send both ${IDEMPOTENCY_KEY} and ${JOB_TOKEN}, or neither`);
  }
  if (jobIdHeader !== null && !IDEMPOTENCY_KEY_PATTERN.test(jobIdHeader)) return error("invalid_request", `${IDEMPOTENCY_KEY} must be a lowercase UUID`);
  if (tokenHeader !== null && !JOB_TOKEN_PATTERN.test(tokenHeader)) return error("invalid_request", `${JOB_TOKEN} must be 43 base64url characters`);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return error("invalid_request", "the body must be application/json");

  // 2. Service.
  const service = context.services.get(serviceName);
  if (service === undefined) return error("service_not_found");

  const body = await request.arrayBuffer();
  if (body.byteLength > (service.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES)) return error("payload_too_large");
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return error("invalid_request", "the body is not valid JSON");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return error("invalid_input", "the input must be a JSON object");

  const binding = await bindingHash(service.name, input);
  const tokenHash = tokenHeader === null ? undefined : sha256(tokenHeader);

  // 3. An existing job [J5]–[J7].
  if (jobIdHeader !== null) {
    const existing = await store.get(jobIdHeader);
    if (existing !== undefined) return existingJob(existing, binding, tokenHash!, context);
  }

  // 4. Input [P8].
  if (!service.validateInput(input)) return error("invalid_input", undefined, inputErrors(service.validateInput.errors));

  // 5. Capacity [P8], [Q1], [Q2].
  const limited = context.rateLimit?.(request);
  if (limited !== undefined) {
    return error("rate_limited", "too many requests from this caller; nothing was charged", undefined, { "Retry-After": String(limited) });
  }
  const admission = context.scheduler.admit(service.name);
  if (!admission.accepted) {
    const detail = `"${service.name}" is at capacity; nothing was charged`;
    return error("unavailable", detail, undefined, { "Retry-After": String(admission.retryAfterSeconds) });
  }
  try {
    const ids = { jobIdHeader, tokenHeader, tokenHash, binding };
    return await payAndRun(request, service, input as JsonObject, ids, admission.reservation, context);
  } finally {
    // A no-op once the job's work is queued. Otherwise the request ended without a job (or an upfront
    // job's settlement outlasted holdSeconds or failed), and the place is free again.
    admission.reservation.release();
  }
}

async function payAndRun(
  request: Request,
  service: Service,
  input: JsonObject,
  ids: { jobIdHeader: string | null; tokenHeader: string | null; tokenHash: string | undefined; binding: string },
  reservation: Reservation,
  context: RouterContext,
): Promise<Response> {
  const { manifest, store, facilitator } = context;
  const { jobIdHeader, tokenHeader, tokenHash, binding } = ids;

  // 6. No payment: the challenge.
  const requirements = paymentRequirements(manifest, service);
  const paymentHeader = request.headers.get("PAYMENT-SIGNATURE");
  if (paymentHeader === null) return challenge(manifest, service);

  // 7. Verify the payment.
  const payload = readPayment(paymentHeader, requirements);
  if (payload === undefined) return challenge(manifest, service, "invalid_payment");
  try {
    const verified = await facilitator.verify(payload, requirements);
    if (!verified.isValid) return challenge(manifest, service, verified.invalidReason ?? "invalid_payment");
  } catch {
    return error("unavailable", "the payment could not be verified; nothing was charged");
  }

  // 8. Claim the job id and the payment together [J4], [P9].
  const generated = jobIdHeader === null;
  const jobId = jobIdHeader ?? randomUUID();
  const jobToken = tokenHeader ?? randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const claim = await store.claim(
    {
      jobId,
      service: service.name,
      charge: service.charge,
      bindingHash: binding,
      tokenHash: sha256(jobToken),
      status: service.charge === "on-success" ? "queued" : "pending",
      createdAt: now,
      updatedAt: now,
    },
    await paymentFingerprint(payload),
  );
  if (claim.outcome === "payment_used") return challenge(manifest, service, "payment_already_used");
  if (claim.outcome === "conflict") return error("idempotency_key_reused");
  // Raced with an identical request: that request owns the payment, this one must not settle it [J5].
  if (claim.outcome === "existing") return existingJob(claim.job, binding, tokenHash!, context);

  // 9. Settle and run, holding the response for at most holdSeconds [J9].
  let settled: SettleResponse | undefined;
  const queue = <T>(work: () => Promise<T>) => reservation.run(jobId, work);
  const run = runJob(claim.job, { store, facilitator, service, input, payload, requirements, queue })
    .then((response) => (settled = response))
    .catch((cause) => console.error(`[provider-kit] job ${jobId} crashed:`, cause));
  await Promise.race([run, sleep(context.holdSeconds * 1000)]);

  if (context.loseCreateJobResponse) throw new Error(`response-loss drill: dropping the create-job response for ${jobId}`);

  // 10. Respond.
  const job = (await store.get(jobId))!;
  const headers: Record<string, string> = {};
  if (settled !== undefined) headers["PAYMENT-RESPONSE"] = encodePaymentResponseHeader(settled);
  return jobResponse(job, context, { withOutput: true, create: true, ...(generated ? { jobToken } : {}), headers });
}

async function handleGetJob(request: Request, jobId: string, withOutput: boolean, context: RouterContext): Promise<Response> {
  const token = request.headers.get(JOB_TOKEN);
  const job = IDEMPOTENCY_KEY_PATTERN.test(jobId) ? await context.store.get(jobId) : undefined;
  // Unknown job, missing token and wrong token all look the same [J10].
  if (job === undefined || token === null || !sameHash(job.tokenHash, sha256(token))) return error("job_not_found");
  if (job.status === "pending") return error("request_in_progress", undefined, undefined, { "Retry-After": String(RETRY_AFTER_SECONDS) });
  return jobResponse(job, context, { withOutput });
}

function existingJob(job: StoredJob, binding: string, tokenHash: string, context: RouterContext): Response {
  if (job.bindingHash !== binding || !sameHash(job.tokenHash, tokenHash)) return error("idempotency_key_reused");
  if (job.status === "pending") return error("request_in_progress", undefined, undefined, { "Retry-After": String(RETRY_AFTER_SECONDS) });
  return jobResponse(job, context, { withOutput: true, create: true });
}

function jobResponse(
  job: StoredJob,
  context: RouterContext,
  options: { withOutput: boolean; create?: boolean; jobToken?: string; headers?: Record<string, string> },
): Response {
  if (job.status === "pending") throw new Error("a pending job has no view");
  const retention = context.manifest.jobs?.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
  const charged = chargedFor(job.status, job.charge, job.error?.code);
  const view: JobView = {
    jobId: job.jobId,
    service: job.service,
    status: job.status,
    charge: job.charge,
    charged,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: new Date(Date.parse(job.finishedAt ?? job.createdAt) + retention * 1000).toISOString(),
  };
  if (options.withOutput && job.status === "succeeded" && job.output !== undefined) view.output = job.output;
  if (job.status === "failed" && job.error !== undefined) view.error = job.error;
  if (charged === true && job.payment !== undefined) view.payment = job.payment;
  if (options.jobToken !== undefined) view.jobToken = options.jobToken;
  let retryAfter = RETRY_AFTER_SECONDS;
  const queue = job.status === "queued" ? context.scheduler.position(job.jobId) : undefined;
  if (queue !== undefined) {
    view.queue = queue;
    const seconds = Math.ceil((Date.parse(queue.estimatedStartAt) - Date.now()) / 1000);
    retryAfter = Math.min(QUEUED_RETRY_AFTER_MAX_SECONDS, Math.max(1, seconds));
  }

  const status = jobViewHttpStatus(job.status);
  const headers = { ...options.headers };
  if (status === 202) {
    headers["Retry-After"] = String(retryAfter);
    if (options.create) headers["Location"] = jobStatusUrl(context.manifest.baseUrl, job.jobId);
  }
  return json(view, status, headers);
}

function challenge(manifest: ProviderManifest, service: Service, reason?: string): Response {
  const body = paymentRequired(manifest, service, reason);
  return json(body, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) });
}

function error(code: ProblemCode, detail?: string, errors?: InputError[], headers: Record<string, string> = {}): Response {
  const options: { detail?: string; errors?: InputError[] } = {};
  if (detail !== undefined) options.detail = detail;
  if (errors !== undefined) options.errors = errors;
  const retry = "retryAfter" in PROBLEMS[code] ? { "Retry-After": String(RETRY_AFTER_SECONDS) } : {};
  return json(problem(code, options), PROBLEMS[code].status, { ...retry, ...headers }, PROBLEM_CONTENT_TYPE);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": contentType, ...headers } });
}

function inputErrors(errors: ErrorObject[] | null | undefined): InputError[] {
  return (errors ?? []).map((e) => ({ pointer: e.instancePath, message: e.message ?? "is invalid" }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export const MAX_HOLD_SECONDS = CREATE_JOB_HOLD_MAX_SECONDS;
