import { problem, PROBLEM_CONTENT_TYPE, type CheckResult } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../src/index.js";
import { rewriteJson, setup, textStats, type Tamper } from "./support/harness.js";

// C6: how the provider answers, over every exchange of the run.

const hygiene = (report: VerificationReport) => report.results.find((result) => result.check === "C6") as CheckResult;
const isProblem = (response: Response) => response.status >= 400 && response.status !== 402;

describe("C6 hygiene", () => {
  it("passes a provider that answers cleanly, and records its probes", async () => {
    const result = hygiene(await setup().verify());
    expect(result).toMatchObject({ status: "passed", evidence: { bodyLimit: { bytes: 1024 * 1024 + 1, status: 413 }, preflight: 204 } });
    expect(result.evidence?.["exchanges"]).toBeGreaterThan(20);
  });

  it("fails an answer that echoes a job token [E2]", async () => {
    const tamper: Tamper = (request, response) => {
      const token = request.headers.get("Job-Token");
      return token !== null && isProblem(response) ? rewriteJson(response, (body) => ({ ...body, detail: `token ${token} is not valid here` })) : response;
    };
    const result = hygiene(await setup({ tamper }).verify());
    expect(result).toMatchObject({ status: "failed", failedRules: ["E2"] });
  });

  it("fails an answer that echoes a signed payment [E2]", async () => {
    const tamper: Tamper = (request, response) => {
      const payment = request.headers.get("PAYMENT-SIGNATURE");
      if (payment === null || response.status !== 200) return response;
      const headers = new Headers(response.headers);
      headers.set("X-Debug-Payment", payment);
      return new Response(response.body, { status: response.status, headers });
    };
    const { verify, payer } = setup({ tamper, services: [textStats] });
    expect(hygiene(await verify({ payer })).failedRules).toContain("E2");
  });

  it("fails an answer that contains a Stellar secret key (§10)", async () => {
    const secret = Keypair.random().secret();
    const tamper: Tamper = (_request, response) => (response.status === 404 ? rewriteJson(response, (body) => ({ ...body, detail: `signer ${secret}` })) : response);
    const { verify, payer } = setup({ tamper, services: [textStats] });
    expect(hygiene(await verify({ payer })).failedRules).toContain("§10");
  });

  it.each<[string, Tamper]>([
    ["an error that is not application/problem+json", (_req, res) => (isProblem(res) ? new Response(JSON.stringify({ code: "invalid_input" }), { status: res.status }) : res)],
    ["an error without a code", (_req, res) => (isProblem(res) ? rewriteJson(res, ({ code: _code, ...body }) => body) : res)],
    ["an error code the standard doesn't define", (_req, res) => (isProblem(res) ? rewriteJson(res, (body) => ({ ...body, code: "bad_thing" })) : res)],
    ["a code that goes with another status", (_req, res) => (res.status === 413 ? rewriteJson(res, (body) => ({ ...body, code: "invalid_input" })) : res)],
    ["a status member that disagrees with the HTTP status", (_req, res) => (isProblem(res) ? rewriteJson(res, (body) => ({ ...body, status: 500 })) : res)],
  ])("fails %s [E1]", async (_name, tamper) => {
    const result = hygiene(await setup({ tamper }).verify());
    expect(result.failedRules).toContain("E1");
  });

  it("fails a 409 without Retry-After [J7]", async () => {
    let first = true;
    const tamper: Tamper = (request, response) => {
      if (request.headers.get("PAYMENT-SIGNATURE") === null || !first) return response;
      first = false;
      return new Response(JSON.stringify(problem("request_in_progress")), { status: 409, headers: { "Content-Type": PROBLEM_CONTENT_TYPE } });
    };
    const { verify, payer } = setup({ tamper, services: [textStats] });
    expect(hygiene(await verify({ payer })).failedRules).toContain("J7");
  });

  it("fails a job endpoint that redirects (§5.5)", async () => {
    const tamper: Tamper = (request, response) =>
      request.method === "POST" && response.status === 400 ? new Response(null, { status: 307, headers: { Location: "https://elsewhere.test/jobs" } }) : response;
    expect(hygiene(await setup({ tamper }).verify()).failedRules).toContain("§5.5");
  });

  it.each<[string, number]>([
    ["takes an oversized body to payment", 402],
    ["answers an oversized body with 400", 400],
  ])("fails a provider that %s (§5.4)", async (_name, status) => {
    const tamper: Tamper = (_request, response) => (response.status === 413 ? new Response("{}", { status, headers: { "Content-Type": "application/json" } }) : response);
    const result = hygiene(await setup({ tamper }).verify());
    expect(result.failedRules).toContain("§5.4");
    expect(result.evidence?.["bodyLimit"]).toEqual({ bytes: 1024 * 1024 + 1, status });
  });

  it("warns when browsers can't call the provider [J17]", async () => {
    const tamper: Tamper = (_request, response) => {
      const headers = new Headers(response.headers);
      for (const name of [...headers.keys()]) if (name.startsWith("access-control-")) headers.delete(name);
      return new Response(response.body, { status: response.status, headers });
    };
    const result = hygiene(await setup({ tamper }).verify());
    expect(result).toMatchObject({ status: "passed", warnings: ["J17"] });
    expect(result.findings?.length).toBeGreaterThanOrEqual(3);
  });
});
