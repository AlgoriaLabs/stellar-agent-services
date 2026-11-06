// Spending limits and verification minimums block payments before signing [V1].

import { USDC_ASSET } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkPolicy, defaultPolicy, PAY_ACTION, type PaymentRequest } from "../src/index.js";

const agent = Keypair.random().publicKey();
const payee = Keypair.random().publicKey();
const now = new Date("2026-10-21T12:00:00Z");
const policy = defaultPolicy(agent, "stellar:testnet", now);
const request: PaymentRequest = {
  action: PAY_ACTION,
  network: "stellar:testnet",
  asset: USDC_ASSET["stellar:testnet"],
  amount: "100000",
  payTo: payee,
  spentLast24h: 0n,
  now,
};
const fields = (r: PaymentRequest, p = policy) => checkPolicy(p, r).violations.map((v) => v.field);

describe("checkPolicy", () => {
  it("allows a payment inside every limit, and asks for approval by default", () => {
    expect(checkPolicy(policy, request)).toEqual({ allowed: true, violations: [], needsApproval: true });
  });

  it("refuses payments outside the limits", () => {
    expect(fields({ ...request, amount: "1000001" })).toEqual(["maxValuePerTx"]);
    expect(fields({ ...request, spentLast24h: 9_950_000n })).toEqual(["maxValuePerDay"]);
    expect(fields({ ...request, amount: "0" })).toEqual(["amount"]);
  });

  it("refuses other networks, assets and actions", () => {
    expect(fields({ ...request, network: "stellar:pubnet" })).toEqual(["stellar.network"]);
    expect(fields({ ...request, asset: USDC_ASSET["stellar:pubnet"] })).toEqual(["allowedContracts"]);
    expect(fields({ ...request, action: "swap" })).toEqual(["allowedActions"]);
  });

  it("applies payee lists and the validity window", () => {
    const blocked = { ...policy, stellar: { ...policy.stellar, payees: { block: [payee] } } };
    expect(fields(request, blocked)).toEqual(["stellar.payees.block"]);
    const allowOther = { ...policy, stellar: { ...policy.stellar, payees: { allow: [agent], block: [] } } };
    expect(fields(request, allowOther)).toEqual(["stellar.payees.allow"]);
    expect(fields({ ...request, now: new Date("2027-01-01T00:00:00Z") })).toEqual(["validUntil"]);
  });

  it("needs no approval at or below autoApproveUpTo", () => {
    const auto = { ...policy, stellar: { ...policy.stellar, autoApproveUpTo: "100000" } };
    expect(checkPolicy(auto, request).needsApproval).toBe(false);
    expect(checkPolicy(auto, { ...request, amount: "100001" }).needsApproval).toBe(true);
  });

  it("requires evidence for each configured verification minimum, even zero", () => {
    const restricted = { ...policy, minVerificationScore: 0, stellar: { ...policy.stellar, minProviderLevel: 0 } };
    expect(fields(request, restricted)).toEqual(["minVerificationScore", "stellar.minProviderLevel"]);
    expect(fields({ ...request, verification: { riskScore: 0, level: 0 } }, restricted)).toEqual([]);
  });

  it("compares the trusted score and provider level independently", () => {
    const restricted = { ...policy, minVerificationScore: 70, stellar: { ...policy.stellar, minProviderLevel: 2 } };
    expect(fields({ ...request, verification: { riskScore: 70, level: 2 } }, restricted)).toEqual([]);
    expect(fields({ ...request, verification: { riskScore: 71, level: 2 } }, restricted)).toEqual(["minVerificationScore"]);
    expect(fields({ ...request, verification: { riskScore: 10, level: 1 } }, restricted)).toEqual(["stellar.minProviderLevel"]);
    expect(fields({ ...request, verification: { riskScore: 10 } }, restricted)).toEqual(["stellar.minProviderLevel"]);
    expect(fields({ ...request, verification: { level: 3 } }, restricted)).toEqual(["minVerificationScore"]);
  });

  it.each([-1, 0.5, NaN, Infinity, 101])("rejects an invalid score minimum or observation: %s", (score) => {
    expect(fields({ ...request, verification: { riskScore: 100 } }, { ...policy, minVerificationScore: score }))
      .toEqual(["minVerificationScore"]);
    expect(fields({ ...request, verification: { riskScore: score } }, { ...policy, minVerificationScore: 0 }))
      .toEqual(["minVerificationScore"]);
  });

  it.each([-1, 0.5, NaN, Infinity, 4])("rejects an invalid level minimum or observation: %s", (level) => {
    const restricted = { ...policy, stellar: { ...policy.stellar, minProviderLevel: level } };
    expect(fields({ ...request, verification: { level: 3 } }, restricted)).toEqual(["stellar.minProviderLevel"]);
    expect(fields({ ...request, verification: { level } }, {
      ...policy, stellar: { ...policy.stellar, minProviderLevel: 0 },
    })).toEqual(["stellar.minProviderLevel"]);
  });
});
