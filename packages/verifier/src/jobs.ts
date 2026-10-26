// The job endpoints (docs/provider-standard.md §5), called the way a careful client calls them, and the
// checks every job view must pass (§5.5–§5.7).
//
// Messages quote a provider's value only when it is a short, plain token (an id, a status, a number),
// so a receipt never carries text a provider chose.

import { randomBytes, randomUUID } from "node:crypto";
import {
  chargedFor,
  createJobUrl,
  FINAL_JOB_STATUSES,
  IDEMPOTENCY_KEY,
  JOB_FAILURES,
  JOB_STATUSES,
  JOB_TOKEN,
  jobResultUrl,
  jobStatusUrl,
  parseRetryAfter,
  type CheckId,
  type JobFailureCode,
  type JobStatus,
  type JsonObject,
  type JsonValue,
  type ServiceDescriptor,
} from "@stellar-agent-services/protocol";
import type { Recorder, RunContext } from "./context.js";
import { answered, jsonBody, type Exchange } from "./http.js";
import { isObject } from "./json.js";
import type { SignedPayment } from "./payments.js";
import { firstSchemaError, matchesSchema } from "./schemas.js";

export interface JobIds {
  jobId: string;
  token: string;
}

/** A new job identity, as a client fixes it before its first request [J1]: a UUID and 32 random bytes. */
export function newIds(): JobIds {
  return { jobId: randomUUID(), token: randomBytes(32).toString("base64url") };
}

/** A provider holds create-job for at most 30 s [J9]; a client waits longer. */
export const CREATE_JOB_TIMEOUT_MS = 45_000;
const READ_TIMEOUT_MS = 15_000;
/** Job views carry the output; above this, a provider should link to it instead (§3.3). */
const JOB_VIEW_MAX_BYTES = 8 * 1024 * 1024;

export interface CreateJobOptions {
  ids?: JobIds;
  payment?: SignedPayment;
  /** A raw body to send instead of the input. */
  body?: string;
  timeoutMs?: number;
  /** How long to wait out a busy provider (429 or 503) by sending the same request again [Q8]. Default 0. */
  busyWaitMs?: number;
}

/** POST create-job. While the provider is busy, the identical request is sent again after Retry-After. */
export async function createJob(ctx: RunContext, check: CheckId, service: string, input: JsonValue, options: CreateJobOptions = {}): Promise<Exchange> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const secrets: string[] = [];
  if (options.ids !== undefined) {
    headers[IDEMPOTENCY_KEY] = options.ids.jobId;
    headers[JOB_TOKEN] = options.ids.token;
    secrets.push(options.ids.token);
  }
  if (options.payment !== undefined) {
    headers["PAYMENT-SIGNATURE"] = options.payment.header;
    secrets.push(options.payment.header, options.payment.transaction);
  }
  const request = {
    method: "POST" as const,
    url: createJobUrl(ctx.manifest!.baseUrl, service),
    headers,
    body: options.body ?? JSON.stringify(input),
    timeoutMs: options.timeoutMs ?? CREATE_JOB_TIMEOUT_MS,
    maxBytes: JOB_VIEW_MAX_BYTES,
    secrets,
  };
  const deadline = ctx.now() + (options.busyWaitMs ?? 0);
  for (;;) {
    const exchange = await ctx.http.request(check, request);
    if (!isBusy(exchange)) return exchange;
    const wait = retryAfterMs(exchange) * (1 + Math.random() * 0.2);
    if (ctx.now() + wait > deadline) return exchange;
    await ctx.sleep(wait);
  }
}

/** GET check-status, or get-result with `result`. */
export function readJob(ctx: RunContext, check: CheckId, jobId: string, token: string | undefined, result: boolean): Promise<Exchange> {
  const url = (result ? jobResultUrl : jobStatusUrl)(ctx.manifest!.baseUrl, jobId);
  return ctx.http.request(check, {
    method: "GET",
    url,
    headers: { Accept: "application/json", ...(token === undefined ? {} : { [JOB_TOKEN]: token }) },
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: JOB_VIEW_MAX_BYTES,
    secrets: token === undefined ? [] : [token],
  });
}

export function isBusy(exchange: Exchange): boolean {
  return exchange.status === 429 || exchange.status === 503;
}

/** Retry-After in ms; `fallbackSeconds` when the answer has none. */
export function retryAfterMs(exchange: Exchange, fallbackSeconds = 2): number {
  return (parseRetryAfter(exchange.headers.get("Retry-After")) ?? fallbackSeconds) * 1000;
}

export function isFinal(status: unknown): boolean {
  return FINAL_JOB_STATUSES.includes(status as JobStatus);
}

/** A provider's value for a message: shown when it is a short plain token, described otherwise. */
export function shown(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (typeof value === "string") return /^[A-Za-z0-9_.:+-]{1,80}$/.test(value) ? `"${value}"` : "a string the verifier does not repeat";
  return value === undefined ? "nothing" : Array.isArray(value) ? "an array" : "an object";
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

export interface ExpectedJob {
  jobId: string;
  service: ServiceDescriptor;
  /** The manifest's baseUrl. */
  baseUrl: string;
  endpoint: "create-job" | "check-status" | "get-result";
  /** The payment the verifier sent for this job, which the receipt must match [J16]. */
  payment?: SignedPayment;
  /** While queued, a job view SHOULD say where the job stands [Q5]; with this, its absence fails. */
  queueRequired?: boolean;
}

/**
 * Checks a 200 or 202 answer as a job view (§5.5–§5.7) and records what is wrong. Returns the view, or
 * undefined when the answer is not a job view at all.
 */
export function checkJobView(exchange: Exchange, expected: ExpectedJob, recorder: Recorder): JsonObject | undefined {
  const where = `${expected.endpoint} for job ${expected.jobId}`;
  const view = jsonBody(exchange);
  if (!isObject(view)) {
    recorder.fail("§5.5", `${where} ${answered(exchange)} without a job view`);
    return undefined;
  }
  const job = view as JsonObject;
  if (job["jobId"] !== expected.jobId) recorder.fail("§5.2", `${where} returned job ${shown(job["jobId"])}: the Idempotency-Key is the job id`);
  if (job["service"] !== expected.service.name) recorder.fail("§5.5", `${where} names service ${shown(job["service"])}`);

  const status = job["status"];
  if (!JOB_STATUSES.includes(status as JobStatus)) {
    recorder.fail("§5.6", `${where} has status ${shown(status)}, which is not a job state`);
    return job;
  }
  const charge = expected.service.charge ?? "upfront";
  if (job["charge"] !== charge) recorder.fail("§3.2", `${where} has charge ${shown(job["charge"])}; the manifest says "${charge}"`);

  const error = job["error"];
  let failure: JobFailureCode | undefined;
  if (status === "failed") {
    const code = isObject(error) ? error["code"] : undefined;
    if (typeof code === "string" && Object.hasOwn(JOB_FAILURES, code)) failure = code as JobFailureCode;
    else recorder.fail("§6", `${where} failed without an error whose code is a job failure code`);
  }
  const charged = chargedFor(status as JobStatus, charge, failure);
  if (job["charged"] !== charged) recorder.fail("§5.6", `${where} is ${status} with charged ${shown(job["charged"])}; it must be ${String(charged)}`);
  for (const field of ["createdAt", "updatedAt", "expiresAt"]) {
    if (!isTimestamp(job[field])) recorder.fail("§5.5", `${where} has no RFC 3339 ${field}`);
  }

  // [J8]: 200 once finished, otherwise 202 with Retry-After, and Location on create-job.
  const final = isFinal(status);
  if (final && exchange.status !== 200) recorder.fail("J8", `${where} is ${status} but answered ${exchange.status}, not 200`);
  if (!final) {
    if (exchange.status !== 202) recorder.fail("J8", `${where} is ${status} but answered ${exchange.status}, not 202`);
    const retryAfter = parseRetryAfter(exchange.headers.get("Retry-After"));
    if (retryAfter === undefined) recorder.fail("J8", `${where} answered 202 without Retry-After`);
    else if (retryAfter < 1 || retryAfter > 60) recorder.warn("Q6", `${where} answered 202 with Retry-After ${retryAfter}; it should be 1 to 60 seconds`);
    if (expected.endpoint === "create-job" && resolve(exchange.headers.get("Location"), exchange.url) !== jobStatusUrl(expected.baseUrl, expected.jobId)) {
      recorder.fail("J8", `${where} answered 202 without Location set to the job's check-status URL`);
    }
  }

  const output = job["output"];
  if (status === "succeeded" && expected.endpoint !== "check-status") {
    if (!isObject(output)) recorder.fail("§5.5", `${where} succeeded without output`);
    else if (matchesSchema(expected.service.outputSchema, output) === false) {
      recorder.fail(charge === "on-success" ? "S1" : "§3.3", `${where}: the output does not match outputSchema (${firstSchemaError(expected.service.outputSchema, output)})`);
    }
  }
  if (status === "payment_uncertain" && output !== undefined) recorder.fail("J14", `${where} shows output while payment_uncertain`);
  if (status !== "succeeded" && status !== "payment_uncertain" && output !== undefined) recorder.fail("§5.5", `${where} is ${status} but has output`);

  const payment = job["payment"];
  if (charged === true) {
    if (!isObject(payment)) recorder.fail("§5.5", `${where} is charged but has no payment receipt`);
    else checkReceipt(payment, expected, where, recorder);
  } else if (payment !== undefined) {
    recorder.fail("§5.5", `${where} has a payment receipt although charged is ${String(charged)}`);
  }

  if (status === "queued") {
    const queue = job["queue"];
    const valid = isObject(queue) && Number.isInteger(queue["position"]) && (queue["position"] as number) >= 1 && isTimestamp(queue["estimatedStartAt"]);
    if (!valid) {
      const message = `${where} is queued without queue: { position, estimatedStartAt }`;
      if (expected.queueRequired) recorder.fail("Q5", message);
      else recorder.warn("Q5", message);
    }
  }
  if (job["jobToken"] !== undefined) recorder.fail("J2", `${where} returned a jobToken although the client sent its own Job-Token`);
  return job;
}

/** The receipt in a job view against the payment the verifier made (§5.7). The chain decides later [J16]. */
function checkReceipt(receipt: Record<string, unknown>, expected: ExpectedJob, where: string, recorder: Recorder): void {
  if (typeof receipt["transaction"] !== "string" || !/^[0-9a-f]{64}$/.test(receipt["transaction"])) {
    recorder.fail("§5.7", `${where}: the receipt's transaction is not a 64-character lowercase hex hash`);
  }
  if (!isTimestamp(receipt["settledAt"])) recorder.fail("§5.7", `${where}: the receipt has no RFC 3339 settledAt`);
  const paid = expected.payment;
  if (paid === undefined) return;
  const terms: Record<string, string> = { network: paid.network, asset: paid.asset, amount: paid.amount, payTo: paid.payTo, payer: paid.payer };
  for (const [field, value] of Object.entries(terms)) {
    if (receipt[field] !== value) recorder.fail("§5.7", `${where}: the receipt's ${field} is ${shown(receipt[field])}, not ${value}`);
  }
}

/** A Location header as an absolute URL: RFC 9110 allows a relative reference. */
function resolve(location: string | null, base: string): string | undefined {
  if (location === null) return undefined;
  try {
    return new URL(location, base).href;
  } catch {
    return undefined;
  }
}

export interface FollowedJob {
  view: JsonObject;
  exchange: Exchange;
}

/**
 * Polls get-result at the provider's pace [Q9] until the job is final or payment_uncertain, or the
 * deadline passes; then returns the last view. A 409, 429 or 503 while polling means "ask again
 * later" [J7], [Q9]. Undefined when the provider stops answering with job views; what went wrong is recorded.
 */
export async function followJob(
  ctx: RunContext,
  check: CheckId,
  recorder: Recorder,
  expected: Omit<ExpectedJob, "endpoint"> & { token: string },
  first: FollowedJob,
  deadline: number,
): Promise<FollowedJob | undefined> {
  let current = first;
  let wait = retryAfterMs(first.exchange);
  // A state that is not one of the standard's was already reported; polling won't make it one.
  const pending = (status: unknown) => status === "queued" || status === "running";
  while (pending(current.view["status"]) && ctx.now() < deadline) {
    await ctx.sleep(Math.min(Math.max(wait, 1000), 60_000));
    const exchange = await readJob(ctx, check, expected.jobId, expected.token, true);
    wait = retryAfterMs(exchange);
    if (exchange.status === 409 || isBusy(exchange)) {
      // A provider at capacity SHOULD still answer the job endpoints [Q7].
      if (isBusy(exchange)) recorder.warn("Q7", `get-result for job ${expected.jobId} answered ${exchange.status}; it should stay outside capacity limits`);
      continue;
    }
    if (exchange.status !== 200 && exchange.status !== 202) {
      if (exchange.status === 404) recorder.fail("J15", `get-result for job ${expected.jobId} answered 404 while the job should be retrievable`);
      else recorder.fail("§5.5", `get-result for job ${expected.jobId} ${answered(exchange)}`);
      return undefined;
    }
    const view = checkJobView(exchange, { ...expected, endpoint: "get-result" }, recorder);
    if (view === undefined) return undefined;
    current = { view, exchange };
  }
  return current;
}
