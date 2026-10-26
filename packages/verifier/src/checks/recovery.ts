// C5 Recovery (docs/provider-standard.md §5.3–§5.5, docs/job-recovery.md): a client that lost the
// create-job response gets its job back, and is never asked to pay again.
//
//   repeat          create-job again with the same id, token and input, and no payment: the same job,
//                   with no new 402 [J5]
//   repeat, paid    the same with the same PAYMENT-SIGNATURE: the same job, the payment not settled
//                   again [J5]; the receipt still names the one transaction that carried it [J16]
//   another input   the same id with another input: 422 idempotency_key_reused [J6]
//   another token   the same id and input with another token: 422 [J6]
//   status, result  check-status and get-result with the token return the job [J8], get-result with its
//                   output [J15]
//   no access       without the token, with a wrong one, or for an unknown job: 404 job_not_found, and
//                   the same answer each time, so it never reveals whether a job exists [J10]
//
// It recovers the job C4 paid for, so it runs only once that job succeeded.

import { canonicalJson, type CheckResult, type JsonObject, type ServiceDescriptor } from "@stellar-agent-services/protocol";
import { Recorder, skipped, type RunContext } from "../context.js";
import { answered, problemCode, type Exchange } from "../http.js";
import { checkJobView, createJob, newIds, readJob, shown } from "../jobs.js";
import { isObject, sameJson } from "../json.js";
import { matchesSchema } from "../schemas.js";

export async function checkRecovery(ctx: RunContext): Promise<CheckResult> {
  const job = ctx.paidJob;
  if (job === undefined) return skipped("C5", ctx.payer === undefined ? "no test payer: run verifier verify --pay" : "C4 did not leave a finished paid job to recover");
  const recorder = new Recorder("C5");
  const { service, input, jobId, token, payment, view } = job;
  const ids = { jobId, token };
  const expected = { jobId, service, baseUrl: ctx.manifest!.baseUrl, payment };
  const transaction = isObject(view["payment"]) ? view["payment"]["transaction"] : undefined;
  const probes: JsonObject = {};
  recorder.evidence["jobId"] = jobId;
  recorder.evidence["probes"] = probes;

  /** The answer must be the finished job, unchanged. */
  const sameJob = (exchange: Exchange, label: string, endpoint: "create-job" | "check-status" | "get-result", rule: string) => {
    probes[label] = exchange.status ?? exchange.error ?? null;
    if (exchange.status === 402) {
      recorder.fail(rule, `${label} asked for payment again`);
      return;
    }
    if (exchange.status !== 200) {
      recorder.fail(rule, `${label} ${answered(exchange)}; the job has finished, so it must answer 200 with the job`);
      return;
    }
    const again = checkJobView(exchange, { ...expected, endpoint }, recorder);
    if (again === undefined) return;
    if (again["status"] !== view["status"]) recorder.fail(rule, `${label} returned the job as ${shown(again["status"])}, not ${shown(view["status"])}`);
    const named = isObject(again["payment"]) ? again["payment"]["transaction"] : undefined;
    if (named !== transaction) recorder.fail("J16", `${label} names transaction ${shown(named)}, not ${shown(transaction)}: one payment, one transaction`);
    if (endpoint !== "check-status" && !sameJson(again["output"], view["output"])) recorder.fail(rule, `${label} returned other output than the job's`);
  };

  sameJob(await createJob(ctx, "C5", service.name, input, { ids }), "create-job repeated", "create-job", "J5");
  sameJob(await createJob(ctx, "C5", service.name, input, { ids, payment }), "create-job repeated with the payment", "create-job", "J5");

  const reused = async (label: string, body: JsonObject, jobToken: string) => {
    const exchange = await createJob(ctx, "C5", service.name, body, { ids: { jobId, token: jobToken } });
    probes[label] = exchange.status ?? exchange.error ?? null;
    if (exchange.status !== 422 || problemCode(exchange) !== "idempotency_key_reused") {
      recorder.fail("J6", `${label} ${answered(exchange)}; it must answer 422 idempotency_key_reused`);
    }
  };
  await reused("create-job with the same id and another input", otherInput(service, input), token);
  await reused("create-job with the same id and another token", input, newIds().token);

  sameJob(await readJob(ctx, "C5", jobId, token, false), "check-status", "check-status", "J8");
  sameJob(await readJob(ctx, "C5", jobId, token, true), "get-result", "get-result", "J15");

  // [J10]: no token, a wrong token and an unknown job look the same.
  const unknownJob = newIds().jobId;
  for (const result of [false, true]) {
    const endpoint = result ? "get-result" : "check-status";
    const answers: [string, Exchange][] = [
      ["without a token", await readJob(ctx, "C5", jobId, undefined, result)],
      ["with a wrong token", await readJob(ctx, "C5", jobId, newIds().token, result)],
      ["for an unknown job", await readJob(ctx, "C5", unknownJob, token, result)],
    ];
    for (const [label, exchange] of answers) {
      probes[`${endpoint} ${label}`] = exchange.status ?? exchange.error ?? null;
      if (exchange.status !== 404 || problemCode(exchange) !== "job_not_found") {
        recorder.fail("J10", `${endpoint} ${label} ${answered(exchange)}; it must answer 404 job_not_found`);
      }
    }
    const bodies = answers.map(([, exchange]) => normalized(exchange, [jobId, unknownJob]));
    if (answers.every(([, exchange]) => exchange.status === 404) && new Set(bodies).size > 1) {
      recorder.fail("J10", `${endpoint}'s 404 answers differ between a wrong token and an unknown job, which reveals whether a job exists`);
    }
  }
  return recorder.result();
}

/**
 * An input with another binding hash: another example, or the input with one value changed, valid
 * against inputSchema when possible. The provider must refuse it before validating it either way (§5.4).
 */
function otherInput(service: ServiceDescriptor, input: JsonObject): JsonObject {
  for (const example of service.examples ?? []) {
    if (!sameJson(example.input, input) && matchesSchema(service.inputSchema, example.input) === true) return example.input;
  }
  for (const [key, value] of Object.entries(input)) {
    const candidates =
      typeof value === "string" ? [`${value}.`, value.slice(0, -1), "verifier"] : typeof value === "number" ? [value + 1, value - 1] : typeof value === "boolean" ? [!value] : [];
    for (const candidate of candidates) {
      const changed = { ...input, [key]: candidate };
      if (!sameJson(changed, input) && matchesSchema(service.inputSchema, changed) === true) return changed;
    }
  }
  return { ...input, "x-verifier-probe": true };
}

/** A 404 body with job ids replaced, so answers for different jobs compare equal when they say the same. */
function normalized(exchange: Exchange, jobIds: string[]): string {
  let text = exchange.text;
  for (const id of jobIds) text = text.replaceAll(id, "{jobId}");
  try {
    return canonicalJson(JSON.parse(text));
  } catch {
    return text;
  }
}
