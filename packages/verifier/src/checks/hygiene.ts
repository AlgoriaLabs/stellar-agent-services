// C6 Hygiene: how the provider answers, across every exchange of the run, plus two probes of its own.
//
//   redirects   the job endpoints answer; they never redirect (§5.5). The manifest's are C1's [M3].
//   problems    every error but 402 is an RFC 9457 problem: application/problem+json, a known `code`
//               that goes with the HTTP status, and a `status` member, if any, equal to it [E1]
//   retrying    409 carries Retry-After [J7], and so do 429 and 503 (§6)
//   secrets     no response contains a job token or a signed payment the verifier sent [E2], or a
//               Stellar secret key (§10)
//   body limit  a body over the service's maxInputBytes is refused with 413 payload_too_large, before
//               anything else is looked at (§5.4)
//   CORS        the manifest and the job endpoints SHOULD allow browser clients, preflight included [J17]
//
// The probes run before the load test, and the rest at the very end, over every exchange.

import { createJobUrl, PROBLEM_CONTENT_TYPE, PROBLEMS, type CheckResult, type ProblemCode } from "@stellar-agent-services/protocol";
import { StrKey } from "@stellar/stellar-sdk";
import { Recorder, type RunContext } from "../context.js";
import { answered, jsonBody, problemCode, type Exchange } from "../http.js";
import { createJob, isBusy, shown } from "../jobs.js";
import { isObject } from "../json.js";

const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const PREFLIGHT_ORIGIN = "https://verifier.invalid";
const EXPOSED_HEADERS = ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "Location", "Retry-After"];
const PREFLIGHT_HEADERS = ["Content-Type", "Idempotency-Key", "Job-Token", "PAYMENT-SIGNATURE"];

/** The probes: the body limit and the CORS preflight. Run them before the load test. */
export async function probeHygiene(ctx: RunContext): Promise<Recorder> {
  const recorder = new Recorder("C6");
  const manifest = ctx.manifest;
  if (manifest === undefined || !ctx.usable) return recorder;
  const service = ctx.target ?? manifest.services[0]!;

  // A body one byte over the limit, as valid JSON [§5.4 step 1].
  const limit = service.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const body = `{"x":"${"a".repeat(limit + 1 - 8)}"}`;
  const oversized = await createJob(ctx, "C6", service.name, null, { body });
  recorder.evidence["bodyLimit"] = { bytes: limit + 1, status: oversized.status ?? null };
  if (isBusy(oversized)) recorder.inconclusive(`a body over maxInputBytes was answered ${oversized.status}, so the limit could not be checked`);
  else if (oversized.status !== 413 || problemCode(oversized) !== "payload_too_large") {
    recorder.fail("§5.4", `create-job for "${service.name}" ${answered(oversized)} to a body of ${limit + 1} bytes; it must refuse a body over maxInputBytes (${limit}) with 413 payload_too_large`);
  }

  // The CORS preflight a browser sends before create-job [J17].
  const preflight = await ctx.http.request("C6", {
    method: "OPTIONS",
    url: createJobUrl(manifest.baseUrl, service.name),
    headers: {
      Origin: PREFLIGHT_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": PREFLIGHT_HEADERS.map((header) => header.toLowerCase()).join(", "),
    },
  });
  const origin = preflight.headers.get("Access-Control-Allow-Origin");
  const methods = list(preflight.headers.get("Access-Control-Allow-Methods"));
  const headers = list(preflight.headers.get("Access-Control-Allow-Headers"));
  const allowed =
    preflight.status !== undefined &&
    preflight.status >= 200 &&
    preflight.status < 300 &&
    (origin === "*" || origin === PREFLIGHT_ORIGIN) &&
    (methods.includes("*") || ["get", "post"].every((method) => methods.includes(method))) &&
    (headers.includes("*") || PREFLIGHT_HEADERS.every((header) => headers.includes(header.toLowerCase())));
  recorder.evidence["preflight"] = preflight.status ?? null;
  if (!allowed) recorder.warn("J17", `the CORS preflight for create-job ${answered(preflight)} without allowing GET, POST and the headers ${PREFLIGHT_HEADERS.join(", ")}`);
  return recorder;
}

/** Everything else, over every exchange of the run. */
export function checkHygiene(ctx: RunContext, recorder: Recorder): CheckResult {
  if (ctx.manifest === undefined || !ctx.usable) recorder.inconclusive("the provider could not be probed (C1)");
  const exchanges = ctx.http.exchanges.filter((exchange) => exchange.provider);
  const secrets = [...ctx.http.secrets];
  let problemAnswers = 0;

  for (const exchange of exchanges) {
    const endpoint = endpointOf(exchange, ctx);
    const contents = [exchange.text, ...[...exchange.headers.values()]].join("\n");
    if (secrets.some((secret) => contents.includes(secret))) recorder.fail("E2", `a ${endpoint} answer contains a job token or a signed payment the verifier sent`);
    if (findSecretKey(contents)) recorder.fail("§10", `a ${endpoint} answer contains a Stellar secret key`);

    const status = exchange.status;
    if (status === undefined || endpoint === "manifest" || endpoint === "preflight") continue;
    if (status >= 300 && status < 400) recorder.fail("§5.5", `a ${endpoint} request was answered with a ${status} redirect; job endpoints answer, they don't redirect`);
    if (status < 400 || status === 402) continue;
    problemAnswers++;
    checkProblem(exchange, endpoint, recorder);
    if ([409, 429, 503].includes(status) && exchange.headers.get("Retry-After") === null) {
      recorder.fail(status === 409 ? "J7" : "§6", `a ${endpoint} answer ${status} has no Retry-After`);
    }
  }
  recorder.evidence["exchanges"] = exchanges.length;
  recorder.evidence["problemAnswers"] = problemAnswers;

  // [J17]: browser clients read the manifest and the job endpoints directly.
  const answeredBy = (name: string) => exchanges.filter((exchange) => endpointOf(exchange, ctx) === name && exchange.status !== undefined);
  for (const name of ["manifest", "create-job", "check-status", "get-result"]) {
    if (answeredBy(name).some((exchange) => exchange.headers.get("Access-Control-Allow-Origin") !== "*")) {
      recorder.warn("J17", `${name === "manifest" ? "the manifest" : `${name} answers`} should carry Access-Control-Allow-Origin: *`);
    }
  }
  const exposed = answeredBy("create-job").map((exchange) => list(exchange.headers.get("Access-Control-Expose-Headers")));
  if (exposed.some((headers) => !headers.includes("*") && !EXPOSED_HEADERS.every((header) => headers.includes(header.toLowerCase())))) {
    recorder.warn("J17", `create-job answers should carry Access-Control-Expose-Headers: ${EXPOSED_HEADERS.join(", ")}`);
  }
  return recorder.result();
}

/** [E1]: an RFC 9457 problem whose code goes with its HTTP status. */
function checkProblem(exchange: Exchange, endpoint: string, recorder: Recorder): void {
  const where = `a ${endpoint} answer ${exchange.status}`;
  const type = exchange.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== PROBLEM_CONTENT_TYPE) recorder.fail("E1", `${where} is not ${PROBLEM_CONTENT_TYPE}`);
  const body = jsonBody(exchange);
  const code = isObject(body) ? body["code"] : undefined;
  if (typeof code !== "string") {
    recorder.fail("E1", `${where} is not a problem with a code`);
    return;
  }
  if (!Object.hasOwn(PROBLEMS, code)) recorder.fail("E1", `${where} has the code ${shown(code)}, which is not in the standard (§6)`);
  else if (PROBLEMS[code as ProblemCode].status !== exchange.status) {
    recorder.fail("E1", `${where} has the code "${code}", which goes with ${PROBLEMS[code as ProblemCode].status}`);
  }
  if (isObject(body) && body["status"] !== undefined && body["status"] !== exchange.status) recorder.fail("E1", `${where} has a status member of ${shown(body["status"])}`);
}

/** Which endpoint an exchange went to, for messages and grouping. */
function endpointOf(exchange: Exchange, ctx: RunContext): string {
  if (exchange.url === ctx.manifestUrl) return "manifest";
  if (exchange.method === "OPTIONS") return "preflight";
  const base = ctx.manifest?.baseUrl;
  const path = base !== undefined && exchange.url.startsWith(`${base}/`) ? exchange.url.slice(base.length) : new URL(exchange.url).pathname;
  if (/^\/services\/[^/]+\/jobs$/.test(path)) return "create-job";
  if (/^\/jobs\/[^/]+\/result$/.test(path)) return "get-result";
  if (/^\/jobs\/[^/]+$/.test(path)) return "check-status";
  return "provider";
}

/** Whether the text contains a Stellar secret key (an S... ed25519 seed with a valid checksum). */
function findSecretKey(text: string): boolean {
  for (const match of text.matchAll(/S[A-Z2-7]{55}/g)) if (StrKey.isValidEd25519SecretSeed(match[0])) return true;
  return false;
}

function list(header: string | null): string[] {
  return (header ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item !== "");
}
