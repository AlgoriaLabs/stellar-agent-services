import { defineService } from "@stellar-agent-services/provider-kit";
import { signTestPayment } from "@stellar-agent-services/provider-kit/testing";
import { problem, PROBLEM_CONTENT_TYPE, USDC_ASSET, type CheckResult } from "@stellar-agent-services/protocol";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../src/index.js";
import { payerKeys, payTo, rewriteJson, setup, textStats, type Tamper } from "./support/harness.js";

// C4 (paid call) and C5 (recovery). The test payer signs real payments offline, the facilitator settles
// them onto the fake chain, and the verifier proves them there.

const result = (report: VerificationReport, id: string) => report.results.find((each) => each.check === id) as CheckResult;
const isPaidCreateJob = (request: Request) => request.method === "POST" && request.headers.get("PAYMENT-SIGNATURE") !== null;
const isJobView = (response: Response) => response.status === 200 || response.status === 202;

/** Rewrites the job views of paid create-job and get-result answers. */
function rewriteViews(change: (view: any) => void, filter: (request: Request) => boolean = () => true): Tamper {
  return (request, response) => {
    const jobAnswer = isPaidCreateJob(request) || (request.method === "GET" && request.url.includes("/jobs/"));
    if (!jobAnswer || !isJobView(response) || !filter(request)) return response;
    return rewriteJson(response, (view) => {
      change(view);
      return view;
    });
  };
}

describe("C4 paid call: the verifier's own limits", () => {
  it("pays nothing above its price limit", async () => {
    const { verify, payer, facilitator } = setup();
    const report = await verify({ payer, maxPrice: 50_000n });
    expect(result(report, "C4")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/above the verifier's limit/) });
    expect(report.spent).toBe("0");
    expect(facilitator.settled).toEqual([]);
  });

  it("stops paying at the run's spending limit", async () => {
    const { verify, payer } = setup();
    const report = await verify({ payer, maxSpend: 300_000n });
    expect(result(report, "C4").status).toBe("passed");
    expect(result(report, "C7").evidence?.["paid"]).toEqual({ skipped: expect.stringMatching(/above its limit/) });
    expect(report.spent).toBe("100000");
  });

  it("pays a pubnet provider only when allowed", async () => {
    const { verify, payer } = setup({ provider: { network: "stellar:pubnet" } });
    const report = await verify({ payer });
    expect(result(report, "C4")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/pubnet/) });
    expect(report.spent).toBe("0");
  });

  it("never pays a provider whose manifest failed C1", async () => {
    const tamper: Tamper = (request, response) =>
      request.url.endsWith("/stellar-agent-services.json") ? rewriteJson(response, (m) => ((m.services[0].examples[0].output = { words: "x" }), m)) : response;
    const { verify, payer, facilitator } = setup({ tamper });
    const report = await verify({ payer });
    expect(result(report, "C4")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/C1 failed/) });
    expect(facilitator.settled).toEqual([]);
  });

  it("never signs when the challenge doesn't match the manifest [P7]", async () => {
    const { verify, payer, facilitator } = setup({ tamper: rewriteJsonChallenge() });
    const report = await verify({ payer });
    expect(result(report, "C4")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/P7/) });
    expect(report.spent).toBe("0");
    expect(facilitator.settled).toEqual([]);
  });
});

describe("C4 paid call: what the provider gets wrong", () => {
  it("fails a receipt whose transaction is not on chain [J16]", async () => {
    const fake = "f".repeat(64);
    const { verify, payer } = setup({ tamper: rewriteViews((view) => view.payment && (view.payment.transaction = fake)) });
    const paid = result(await verify({ payer }), "C4");
    expect(paid).toMatchObject({ status: "failed", failedRules: ["J16"] });
    expect(paid.findings?.[0]?.message).toMatch(/not on chain/);
  });

  it("fails a receipt that names another payment's transaction [J16]", async () => {
    const world = setup();
    // A real settled payment from the same payer, for another job.
    const requirements = { scheme: "exact", network: "stellar:testnet", asset: USDC_ASSET["stellar:testnet"], amount: "100000", payTo, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } } as PaymentRequirements;
    const other = await signTestPayment(requirements, payerKeys, { expirationLedger: 5000 });
    const otherTransaction = world.chain.settle((other.payload as { transaction: string }).transaction);
    const { verify, payer } = setup({ tamper: rewriteViews((view) => view.payment && (view.payment.transaction = otherTransaction)) });
    // The second world's chain must hold that transaction too.
    const second = await verify({ payer, rpc: world.chain.chain });
    expect(result(second, "C4")).toMatchObject({ status: "failed", failedRules: ["J16"] });
    expect(result(second, "C4").findings?.[0]?.message).toMatch(/does not carry the payment the verifier signed/);
  });

  it.each<[string, (view: any) => void, string]>([
    ["output that fails outputSchema", (view) => view.output && (view.output = { words: "two" }), "S1"],
    ["charged: false on a succeeded job", (view) => view.status === "succeeded" && (view.charged = false), "§5.6"],
    ["another job id", (view) => (view.jobId = "00000000-0000-4000-8000-000000000000"), "§5.2"],
    ["a receipt for another amount", (view) => view.payment && (view.payment.amount = "1"), "§5.7"],
    ["a job state that doesn't exist", (view) => (view.status = "done"), "§5.6"],
  ])("fails a job view with %s", async (_name, change, rule) => {
    const { verify, payer } = setup({ tamper: rewriteViews(change) });
    const paid = result(await verify({ payer }), "C4");
    expect(paid.status).toBe("failed");
    expect(paid.failedRules).toContain(rule);
  });

  it("fails a provider that refuses the payment its own challenge asked for", async () => {
    const tamper: Tamper = (request, response) => (isPaidCreateJob(request) ? new Response("{}", { status: 402 }) : response);
    expect(result(await setup({ tamper }).verify({ payer: setup().payer }), "C4")).toMatchObject({ status: "failed", failedRules: ["§4.3"] });
  });

  it("fails a paid job that fails", async () => {
    const broken = defineService({ ...textStatsConfig(), handler: () => Promise.reject(new Error("model unavailable")) });
    const { verify, payer } = setup({ services: [broken] });
    const paid = result(await verify({ payer }), "C4");
    expect(paid).toMatchObject({ status: "failed", failedRules: ["§5.6"], evidence: { status: "failed" } });
    expect(paid.findings?.[0]?.message).toMatch(/failed with "service_failed"/);
  });

  it("warns when the settling response has no PAYMENT-RESPONSE [P10]", async () => {
    const tamper: Tamper = (request, response) => (isPaidCreateJob(request) ? rewriteJson(response, (view) => view, { "PAYMENT-RESPONSE": null }) : response);
    const { verify, payer } = setup({ tamper });
    expect(result(await verify({ payer }), "C4")).toMatchObject({ status: "passed", warnings: ["P10"] });
  });

  it("collects a job whose response was lost, without paying again", async () => {
    const { verify, payer, facilitator } = setup({ provider: { loseCreateJobResponse: true } });
    const report = await verify({ payer });
    expect(result(report, "C4")).toMatchObject({ status: "passed", evidence: { paidStatus: null, status: "succeeded" } });
    expect(result(report, "C5").status).toBe("passed");
    expect(facilitator.settled.filter((transaction) => transaction === report.payment?.transaction)).toHaveLength(1);
  });

  it("follows a job that is still being settled [J7]", async () => {
    let first = true;
    const tamper: Tamper = (request, response) => {
      if (!isPaidCreateJob(request) || !first) return response;
      first = false;
      return new Response(JSON.stringify(problem("request_in_progress")), { status: 409, headers: { "Content-Type": PROBLEM_CONTENT_TYPE, "Retry-After": "1" } });
    };
    const { verify, payer } = setup({ tamper, services: [textStats] });
    expect(result(await verify({ payer }), "C4")).toMatchObject({ status: "passed", evidence: { paidStatus: 409, status: "succeeded" } });
  });

  it("follows an upfront job through 202 and get-result", async () => {
    const { verify, payer } = setup();
    const report = await verify({ payer, service: "report" });
    expect(result(report, "C4")).toMatchObject({ status: "passed", evidence: { service: "report", status: "succeeded" } });
  });
});

describe("C5 recovery", () => {
  it("records every probe of a recovered job", async () => {
    const { verify, payer } = setup();
    const recovery = result(await verify({ payer }), "C5");
    expect(recovery.status).toBe("passed");
    expect(recovery.evidence?.["probes"]).toEqual({
      "create-job repeated": 200,
      "create-job repeated with the payment": 200,
      "create-job with the same id and another input": 422,
      "create-job with the same id and another token": 422,
      "check-status": 200,
      "get-result": 200,
      "check-status without a token": 404,
      "check-status with a wrong token": 404,
      "check-status for an unknown job": 404,
      "get-result without a token": 404,
      "get-result with a wrong token": 404,
      "get-result for an unknown job": 404,
    });
  });

  it("fails a provider that asks to be paid again for a job it has [J5]", async () => {
    let paidJob: string | null = null;
    const tamper: Tamper = (request, response) => {
      if (isPaidCreateJob(request)) paidJob ??= request.headers.get("Idempotency-Key");
      const repeat = request.method === "POST" && !isPaidCreateJob(request) && request.headers.get("Idempotency-Key") === paidJob;
      return repeat && response.status === 200 ? new Response("{}", { status: 402 }) : response;
    };
    const { verify, payer } = setup({ tamper, services: [textStats] });
    const recovery = result(await verify({ payer }), "C5");
    expect(recovery).toMatchObject({ status: "failed", failedRules: ["J5"] });
  });

  it("fails a provider that accepts a job id for another request [J6]", async () => {
    const tamper: Tamper = (_request, response) =>
      response.status === 422 ? new Response(JSON.stringify(problem("invalid_input")), { status: 400, headers: { "Content-Type": PROBLEM_CONTENT_TYPE } }) : response;
    const recovery = result(await setup({ tamper }).verify({ payer: setup().payer }), "C5");
    expect(recovery).toMatchObject({ status: "failed", failedRules: ["J6"] });
  });

  it("fails a provider whose 404 reveals that a job exists [J10]", async () => {
    const tamper: Tamper = async (request, response) => {
      if (request.method !== "GET" || response.status !== 404 || request.headers.get("Job-Token") === null) return response;
      return rewriteJson(response, (body) => ({ ...body, detail: request.url.includes("00000000") ? "no such job" : "the token is wrong" }));
    };
    const { verify, payer } = setup({ tamper, services: [textStats] });
    const recovery = result(await verify({ payer }), "C5");
    expect(recovery).toMatchObject({ status: "failed", failedRules: ["J10"] });
    expect(recovery.findings?.map((finding) => finding.message).join(" ")).toMatch(/reveals whether a job exists/);
  });

  it("fails job endpoints that let anyone in [J10]", async () => {
    const { verify, payer } = setup({
      services: [textStats],
      tamper: (request, response) => (request.method === "GET" && request.headers.get("Job-Token") === null && response.status === 404 ? new Response("{}", { status: 200 }) : response),
    });
    expect(result(await verify({ payer }), "C5")).toMatchObject({ status: "failed", failedRules: ["J10"] });
  });

  it("is skipped without a paid job", async () => {
    expect(result(await setup().verify(), "C5")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no test payer/) });
    const { verify, payer } = setup();
    expect(result(await verify({ payer, maxPrice: 1n }), "C5")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/C4 did not leave/) });
  });
});

function textStatsConfig() {
  return {
    name: "text-stats",
    description: "Counts the words in a text.",
    price: "0.01",
    charge: "on-success" as const,
    expectedDurationSeconds: 1,
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    outputSchema: { type: "object", required: ["words"], properties: { words: { type: "integer" } } },
    examples: [{ input: { text: "Hello world." }, output: { words: 2 } }],
  };
}

/** Rewrites every challenge's amount: C3 fails P4, and C4 must not sign. */
function rewriteJsonChallenge(): Tamper {
  return (_request, response) => {
    const header = response.headers.get("PAYMENT-REQUIRED");
    if (response.status !== 402 || header === null) return response;
    const challenge = decodePaymentRequiredHeader(header);
    challenge.accepts[0]!.amount = "1";
    const headers = new Headers(response.headers);
    headers.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(challenge));
    return new Response(JSON.stringify(challenge), { status: 402, headers });
  };
}
