import { CHECK_IDS } from "@stellar-agent-services/protocol";
import { describe, expect, it } from "vitest";
import { InvalidOptionsError, type VerificationReport } from "../src/index.js";
import { AGENT_ID, payer, payTo, setup } from "./support/harness.js";

// A provider built with the Provider Kit follows the standard, so it must pass every check that runs.
// These tests guard against false failures; the other test files make providers break one rule each.

const statuses = (report: VerificationReport) => Object.fromEntries(report.results.map((result) => [result.check, result.status]));

describe("a conforming provider", () => {
  it("passes every check that needs no payment, and reaches level 1", async () => {
    const { verify } = setup();
    const report = await verify();
    expect(statuses(report)).toEqual({ C1: "passed", C2: "passed", C3: "passed", C4: "skipped", C5: "skipped", C6: "passed", C7: "passed" });
    expect(report.results.flatMap((result) => result.failedRules)).toEqual([]);
    expect(report.results.flatMap((result) => result.warnings ?? [])).toEqual([]);
    expect(report).toMatchObject({ level: 1, score: 33, network: "stellar:testnet", agentId: AGENT_ID, dev: false, spent: "0" });
    expect(report.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.results.find((result) => result.check === "C4")?.reason).toMatch(/no test payer/);
  });

  it("passes every check with a test payer, reaches level 3, and proves the payment on chain", async () => {
    const { verify, payer: testPayer, chain } = setup();
    const report = await verify({ payer: testPayer });
    expect(statuses(report)).toEqual({ C1: "passed", C2: "passed", C3: "passed", C4: "passed", C5: "passed", C6: "passed", C7: "passed" });
    expect(report.results.flatMap((result) => result.warnings ?? [])).toEqual([]);
    expect(report).toMatchObject({ level: 3, score: 100, payer });
    expect(report.payment).toMatchObject({ network: "stellar:testnet", amount: "100000", payTo, payer });
    expect(chain.state.transactions.map((transaction) => transaction.hash)).toContain(report.payment!.transaction);
    // C4's job, and C7's concurrency (4) + 1 paid jobs.
    expect(report.spent).toBe("600000");
    const load = report.results.find((result) => result.check === "C7")!;
    expect(load.evidence?.["paid"]).toMatchObject({ jobs: 5, accepted: 5, finished: 5, refused: 0 });
  });

  it("reports every check in order, with evidence and no secrets", async () => {
    const { verify, payer: testPayer, requests } = setup();
    const report = await verify({ payer: testPayer });
    expect(report.results.map((result) => result.check)).toEqual(CHECK_IDS);
    const text = JSON.stringify(report);
    const tokens = requests.map((request) => request.headers.get("Job-Token")).filter((token): token is string => token !== null);
    const payments = requests.map((request) => request.headers.get("PAYMENT-SIGNATURE")).filter((header): header is string => header !== null);
    expect(tokens.length).toBeGreaterThan(0);
    expect(payments.length).toBeGreaterThan(0);
    for (const secret of [...tokens, ...payments]) expect(text).not.toContain(secret);
  });

  it("checks a development provider on http://localhost only in development mode", async () => {
    const { verify } = setup({ provider: { baseUrl: "http://localhost:8787", dev: true } });
    const refused = await verify();
    expect(refused.results[0]).toMatchObject({ check: "C1", status: "failed", failedRules: ["M1"] });
    expect(refused.level).toBe(0);

    const report = await verify({ dev: true });
    expect(statuses(report)).toMatchObject({ C1: "passed", C2: "skipped", C3: "passed", C6: "passed", C7: "passed" });
    expect(report.results.find((result) => result.check === "C2")?.reason).toMatch(/development mode/);
    expect(report.dev).toBe(true);
  });

  it("pays for the service and input it is told to", async () => {
    const { verify, payer: testPayer } = setup();
    const report = await verify({ payer: testPayer, service: "report", input: { topic: "agents" } });
    const paid = report.results.find((result) => result.check === "C4")!;
    expect(paid).toMatchObject({ status: "passed", evidence: { service: "report", input: "option", status: "succeeded" } });
    expect(report.payment?.amount).toBe("200000");
  });

  it("refuses options that don't fit the provider before paying anything", async () => {
    const { verify, payer: testPayer, facilitator } = setup();
    await expect(verify({ payer: testPayer, service: "missing" })).rejects.toThrow(InvalidOptionsError);
    await expect(verify({ payer: testPayer, service: "report", input: { topic: 42 } })).rejects.toThrow(/does not match the inputSchema/);
    await expect(verify({ input: { topic: "x" } })).rejects.toThrow(/needs the service/);
    await expect(verify({ rpc: "http://rpc.example.com" })).rejects.toThrow(/https/);
    expect(facilitator.settled).toEqual([]);
  });
});
