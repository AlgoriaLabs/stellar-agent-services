import { defineService } from "@stellar-agent-services/provider-kit";
import { problem, PROBLEM_CONTENT_TYPE, type CheckResult } from "@stellar-agent-services/protocol";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../src/index.js";
import { rewriteJson, setup, type Tamper } from "./support/harness.js";

// C7: a burst is answered before payment, and paid jobs under load are accepted and finished, or
// refused without a charge.

const load = (report: VerificationReport) => report.results.find((result) => result.check === "C7") as CheckResult;
const isCreateJob = (request: Request) => request.method === "POST" && request.url.endsWith("/jobs");
const busy = (retryAfter: string | null) =>
  new Response(JSON.stringify(problem("unavailable")), {
    status: 503,
    headers: { "Content-Type": PROBLEM_CONTENT_TYPE, ...(retryAfter === null ? {} : { "Retry-After": retryAfter }) },
  });

/** A slow service with room for `concurrency` jobs at a time (one by default), and `queueSeconds` of queue. */
function limited(options: { queueSeconds: number; charge?: "on-success" | "upfront"; concurrency?: number; handler?: () => Promise<{ words: number }> }) {
  return defineService({
    name: "slow-stats",
    description: "Counts words, slowly.",
    price: "0.01",
    charge: options.charge ?? "on-success",
    expectedDurationSeconds: 1,
    capacity: { concurrency: options.concurrency ?? 1, maxQueueWaitSeconds: options.queueSeconds },
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    outputSchema: { type: "object", required: ["words"], properties: { words: { type: "integer" } } },
    examples: [{ input: { text: "Hello" }, output: { words: 1 } }],
    handler: options.handler ?? (() => sleep(50).then(() => ({ words: 1 }))),
  });
}

describe("C7 load: the unpaid burst [Q1]", () => {
  it("passes 402s, and 503s that say when to come back", async () => {
    let count = 0;
    const tamper: Tamper = (request, response) => (isCreateJob(request) && response.status === 402 && ++count % 3 === 0 ? busy("5") : response);
    const result = load(await setup({ tamper }).verify());
    expect(result.status).toBe("passed");
    expect(result.evidence?.["burst"]).toMatchObject({ requests: 20, longestRetryAfter: 5 });
  });

  it.each<[string, (request: Request, response: Response) => Response | Promise<Response>, RegExp]>([
    ["500s", (_req, res) => (res.status === 402 ? new Response("{}", { status: 500 }) : res), /answered 500/],
    ["503s without Retry-After", (_req, res) => (res.status === 402 ? busy(null) : res), /answered 503 without Retry-After/],
    ["dropped connections", () => Promise.reject(new TypeError("fetch failed", { cause: new Error("socket hang up") })), /could not be reached/],
    ["timeouts", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")), /no answer within 30 s/],
  ])("fails a burst answered with %s", async (_name, answer, message) => {
    let burst = false;
    const tamper: Tamper = (request, response) => {
      // The burst is the run's last run of create-job requests: after the C6 probes.
      if (request.method === "OPTIONS") burst = true;
      return burst && isCreateJob(request) ? answer(request, response) : response;
    };
    const result = load(await setup({ tamper }).verify());
    expect(result).toMatchObject({ status: "failed", failedRules: ["Q1"] });
    expect(result.findings?.[0]?.message).toMatch(message);
  });
});

describe("C7 load: paid jobs at capacity", () => {
  it("proves that a job turned away at capacity was not charged [Q3]", async () => {
    const { verify, payer } = setup({ services: [limited({ queueSeconds: 0 })] });
    const report = await verify({ payer });
    const result = load(report);
    expect(result.status).toBe("passed");
    expect(result.evidence?.["paid"]).toEqual({ jobs: 2, accepted: 1, queued: 0, finished: 1, refused: 1, unchargedButSettled: 0 });
  });

  it("fails a provider that turns a paid job away and settles its payment anyway [Q3]", async () => {
    // The second job paid for is C7's first (C5 only repeats C4's): settled, but answered 503.
    const paidJobs: (string | null)[] = [];
    const tamper: Tamper = (request, response) => {
      if (request.headers.get("PAYMENT-SIGNATURE") === null) return response;
      const job = request.headers.get("Idempotency-Key");
      if (!paidJobs.includes(job)) paidJobs.push(job);
      return paidJobs.indexOf(job) === 1 ? busy("5") : response;
    };
    const { verify, payer } = setup({ tamper });
    const result = load(await verify({ payer }));
    expect(result).toMatchObject({ status: "failed", failedRules: ["Q3"] });
    expect(result.findings?.[0]?.message).toMatch(/was settled anyway/);
    expect(result.evidence?.["paid"]).toMatchObject({ refused: 1, unchargedButSettled: 1 });
  });

  it("fails a queued job that doesn't say where it stands [Q5]", async () => {
    // An upfront job answered at once (holdSeconds 0) shows its place in the queue.
    const upfront = limited({ queueSeconds: 60, charge: "upfront" });
    const tamper: Tamper = (_request, response) =>
      response.status === 202 ? rewriteJson(response, (view) => (view.status === "queued" ? (({ queue: _queue, ...rest }) => rest)(view) : view)) : response;
    const { verify, payer } = setup({ tamper, services: [upfront], provider: { holdSeconds: 0 } });
    const result = load(await verify({ payer }));
    expect(result.failedRules).toContain("Q5");
    expect(result.evidence?.["paid"]).toMatchObject({ jobs: 2, accepted: 2, queued: 1, finished: 2 });
  });

  it("passes a queued job that says where it stands [Q5]", async () => {
    const upfront = limited({ queueSeconds: 60, charge: "upfront" });
    const { verify, payer } = setup({ services: [upfront], provider: { holdSeconds: 0 } });
    const result = load(await verify({ payer }));
    expect(result.status).toBe("passed");
    expect(result.evidence?.["paid"]).toMatchObject({ jobs: 2, accepted: 2, queued: 1, finished: 2 });
  });

  it("fails accepted jobs that load makes fail [Q4]", async () => {
    let calls = 0;
    const service = limited({
      queueSeconds: 60,
      handler: async () => {
        if (++calls > 1) throw new Error("overloaded");
        return { words: 1 };
      },
    });
    const { verify, payer } = setup({ services: [service] });
    const report = await verify({ payer });
    expect(report.results.find((result) => result.check === "C4")?.status).toBe("passed");
    expect(load(report)).toMatchObject({ status: "failed", failedRules: ["Q4"] });
  });

  it("proves that work said to have failed uncharged was not charged [Q2] [S1]", async () => {
    // The provider settles a load job, then calls it a timeout that cost nothing. The second job paid for
    // is C7's first: C4's is the first, and C5 repeats C4's.
    const paidJobs: (string | null)[] = [];
    const tamper: Tamper = (request, response) => {
      if (request.headers.get("PAYMENT-SIGNATURE") === null) return response;
      const job = request.headers.get("Idempotency-Key");
      if (!paidJobs.includes(job)) paidJobs.push(job);
      return paidJobs.indexOf(job) === 1
        ? rewriteJson(response, ({ output: _output, payment: _payment, ...view }) => ({ ...view, status: "failed", charged: false, error: { type: "x", title: "x", code: "timeout" } }))
        : response;
    };
    const { verify, payer } = setup({ tamper });
    const result = load(await verify({ payer }));
    expect(result.failedRules).toEqual(["Q2", "S1"]);
    expect(result.findings?.find((finding) => finding.rule === "S1")?.message).toMatch(/failed uncharged, was settled anyway/);
    expect(result.evidence?.["paid"]).toMatchObject({ unchargedButSettled: 1 });
  });

  it("skips the paid part for a concurrency the verifier won't pay for", async () => {
    const wide = limited({ queueSeconds: 0, concurrency: 50 });
    const { verify, payer } = setup({ services: [wide] });
    const result = load(await verify({ payer }));
    expect(result.status).toBe("passed");
    expect(result.evidence?.["paid"]).toEqual({ skipped: expect.stringMatching(/at most 10/) });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

