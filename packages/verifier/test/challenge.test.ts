import { defineService } from "@stellar-agent-services/provider-kit";
import { problem, PROBLEM_CONTENT_TYPE, type CheckResult } from "@stellar-agent-services/protocol";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../src/index.js";
import { payTo, report, setup, textStats, type Tamper } from "./support/harness.js";

// C3: the unpaid create-job answers, checked against the manifest [P2]–[P8].

const challenge = (result: VerificationReport) => result.results.find((each) => each.check === "C3") as CheckResult;

/** Rewrites the x402 challenge of every 402. */
function rewriteChallenge(change: (challenge: any) => void): Tamper {
  return (_request, response) => {
    const header = response.headers.get("PAYMENT-REQUIRED");
    if (response.status !== 402 || header === null) return response;
    const decoded = decodePaymentRequiredHeader(header) as any;
    change(decoded);
    const headers = new Headers(response.headers);
    headers.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(decoded));
    return new Response(JSON.stringify(decoded), { status: 402, headers });
  };
}

describe("C3 challenge", () => {
  it("passes, checking every service, and keeps the Bazaar extension", async () => {
    const result = challenge(await setup().verify());
    expect(result).toMatchObject({ status: "passed", evidence: { payTo: "authorized" } });
    expect(result.evidence?.["services"]).toEqual([
      { service: "text-stats", input: "example", amount: "100000", matches: true, bazaar: true },
      { service: "report", input: "sample", amount: "200000", matches: true, bazaar: true },
    ]);
  });

  it.each<[string, (challenge: any) => void, string]>([
    ["another amount", (c) => (c.accepts[0].amount = "1"), "P4"],
    ["another payee", (c) => (c.accepts[0].payTo = "GBZSBASBFMV5RGKPRIPCB5QQVAJ35IXKMTF2A2766MOA4ZHQ7MLSIPXU"), "P4"],
    ["two payment options", (c) => c.accepts.push(c.accepts[0]), "P4"],
    ["fees that are not sponsored", (c) => (c.accepts[0].extra = {}), "P4"],
    ["an internal resource URL", (c) => (c.resource.url = "http://10.0.0.5/services/text-stats/jobs"), "P5"],
    ["x402 version 1", (c) => (c.x402Version = 1), "P3"],
  ])("fails a challenge with %s", async (_name, change, rule) => {
    const result = challenge(await setup({ tamper: rewriteChallenge(change) }).verify());
    expect(result.status).toBe("failed");
    expect(result.failedRules).toContain(rule);
  });

  it("warns when the challenge has no Bazaar extension [P6]", async () => {
    const result = challenge(await setup({ tamper: rewriteChallenge((c) => delete c.extensions) }).verify());
    expect(result).toMatchObject({ status: "passed", warnings: ["P6"] });
  });

  it("fails a 402 without the PAYMENT-REQUIRED header [P3]", async () => {
    const tamper: Tamper = (_request, response) => {
      if (response.status !== 402) return response;
      const headers = new Headers(response.headers);
      headers.delete("PAYMENT-REQUIRED");
      return new Response(response.body, { status: 402, headers });
    };
    expect(challenge(await setup({ tamper }).verify())).toMatchObject({ status: "failed", failedRules: ["P3"] });
  });

  it("fails a provider that asks payment for invalid input [P8]", async () => {
    const tamper: Tamper = async (request, response) => {
      const body = request.method === "POST" ? await request.text() : "";
      if (body !== "{}" || response.status !== 400) return response;
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: request.url }, accepts: [] }) } });
    };
    const result = challenge(await setup({ tamper }).verify());
    expect(result.failedRules).toContain("P8");
  });

  it("fails a provider that rejects an input matching its own schema [P3]", async () => {
    const tamper: Tamper = (_request, response) =>
      response.status === 402 ? new Response(JSON.stringify(problem("invalid_input")), { status: 400, headers: { "Content-Type": PROBLEM_CONTENT_TYPE } }) : response;
    const result = challenge(await setup({ tamper }).verify());
    expect(result).toMatchObject({ status: "failed", failedRules: ["P3"] });
    expect(result.findings?.[0]?.message).toMatch(/rejected the example input, which matches inputSchema/);
  });

  it.each<["no_account" | "missing" | "unauthorized"]>([["no_account"], ["missing"], ["unauthorized"]])("fails a payTo that can't hold USDC: %s [P2]", async (trustline) => {
    const result = challenge(await setup({ trustline }).verify());
    expect(result).toMatchObject({ status: "failed", failedRules: ["P2"], evidence: { payTo: trustline } });
  });

  it("needs no trustline for a contract payTo", async () => {
    const contract = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    const { verify } = setup({ provider: { payTo: contract }, trustline: "no_account" });
    const result = challenge(await verify());
    expect(result).toMatchObject({ status: "passed", evidence: { payTo: "contract" } });
    expect(payTo).not.toBe(contract);
  });

  it("is inconclusive when the trustline can't be read, or the provider stays busy", async () => {
    expect(challenge(await setup({ trustline: "down" }).verify())).toMatchObject({ status: "skipped", reason: expect.stringMatching(/trustline could not be read/) });

    const busy: Tamper = (request, response) =>
      request.method === "POST"
        ? new Response(JSON.stringify(problem("unavailable")), { status: 503, headers: { "Content-Type": PROBLEM_CONTENT_TYPE, "Retry-After": "1" } })
        : response;
    const result = challenge(await setup({ tamper: busy }).verify({ now: fastClock() }));
    expect(result).toMatchObject({ status: "skipped", reason: expect.stringMatching(/stayed busy/) });
  });

  it("lists services it found no input for", async () => {
    const patterned = defineService({
      name: "code",
      description: "Needs a code.",
      price: "0.01",
      inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } } },
      outputSchema: { type: "object" },
      handler: () => ({}),
    });
    const result = challenge(await setup({ services: [textStats, report, patterned] }).verify());
    expect(result).toMatchObject({ status: "passed", evidence: { unprobed: ["code"] } });
  });
});

/** A clock that jumps 10 s at each reading, so busy waits run out at once. */
function fastClock(): () => number {
  let now = Date.now();
  return () => (now += 10_000);
}
