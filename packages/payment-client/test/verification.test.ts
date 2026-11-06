// Trusted verification is bound to the approved provider and rechecked before signing [V1]. All calls are offline.

import { canonicalSha256 } from "@stellar-agent-services/protocol";
import { describe, expect, it, vi } from "vitest";
import { type ProviderVerification, type VerificationSource, type VerificationSubject } from "../src/index.js";
import { manifestUrl, setup } from "./support/harness.js";

function evidence(subject: VerificationSubject): ProviderVerification {
  return {
    ...subject,
    riskScore: 10,
    level: 3,
    checkedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const input = { text: "hello" };

describe("verification policy [V1]", () => {
  it("does not read verification when the policy requires none", async () => {
    const read = vi.fn<VerificationSource["read"]>(async () => { throw new Error("offline"); });
    const { client } = await setup({ client: { verificationSource: { read } } });
    const quote = await client.quote(manifestUrl, "text-stats", input);
    await client.pay(quote, { approved: true });
    expect(read).not.toHaveBeenCalled();
  });

  it("checks the approved manifest hash and rereads evidence before paying", async () => {
    const read = vi.fn<VerificationSource["read"]>(async (subject) => evidence(subject));
    const { client, method, facilitator } = await setup({
      policy: { minVerificationScore: 20 }, client: { verificationSource: { read } },
    });
    const quote = await client.quote(manifestUrl, "text-stats", input);
    expect(client.payable(quote)).toBe(true);
    expect(read).toHaveBeenCalledWith({
      network: "stellar:testnet", payTo: quote.requirements.payTo, manifestUrl,
      manifestSha256: await canonicalSha256(quote.manifest),
    });
    await client.pay(quote, { approved: true });
    expect(read).toHaveBeenCalledTimes(2);
    expect(method.createPayload).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it.each(["absent", "unknown", "unavailable"])("blocks configured minimums when evidence is %s", async (kind) => {
    const read: VerificationSource["read"] = async () => {
      if (kind === "unavailable") throw new Error("RPC unavailable");
      return undefined;
    };
    const { client, method, facilitator } = await setup({
      policy: { minVerificationScore: 0 },
      client: kind === "absent" ? {} : { verificationSource: { read } },
    });
    const quote = await client.quote(manifestUrl, "text-stats", input);
    expect(quote.policyViolations).toEqual([expect.objectContaining({ field: "minVerificationScore" })]);
    await expect(client.pay(quote, { approved: true })).rejects.toThrow("[V1]");
    expect(method.createPayload).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  const mismatches: Partial<ProviderVerification>[] = [
    { network: "stellar:pubnet" }, { payTo: "another payee" }, { manifestUrl: "https://other.example/manifest" },
    { manifestSha256: "0".repeat(64) }, { agentId: 42 },
    { checkedAt: "2099-01-01T00:00:00Z" }, { expiresAt: "2000-01-01T00:00:00Z" },
    { checkedAt: "not a date" }, { expiresAt: "2099-01-01T00:00:00" },
    { riskScore: NaN }, { riskScore: 101 }, { level: 4 as 3 },
  ];
  it.each(mismatches)("refuses mismatched, stale or malformed evidence: %j", async (mismatch) => {
    const { client, method } = await setup({
      policy: { minVerificationScore: 20 },
      client: { verificationSource: { read: async (subject) => ({ ...evidence(subject), ...mismatch }) } },
    });
    const quote = await client.quote(manifestUrl, "text-stats", input);
    expect(client.payable(quote)).toBe(false);
    await expect(client.pay(quote, { approved: true })).rejects.toThrow("[V1]");
    expect(method.createPayload).not.toHaveBeenCalled();
  });

  it.each(["score", "level", "expired", "outage"])("blocks a previously allowed quote after %s changes", async (kind) => {
    let changed = false;
    const read: VerificationSource["read"] = async (subject) => {
      if (changed && kind === "outage") throw new Error("RPC unavailable");
      const result = evidence(subject);
      if (changed && kind === "score") result.riskScore = 90;
      if (changed && kind === "level") result.level = 1;
      if (changed && kind === "expired") result.expiresAt = new Date(Date.now() - 1).toISOString();
      return result;
    };
    const { client, policy, method, facilitator, journal } = await setup({ client: { verificationSource: { read } } });
    policy.minVerificationScore = 20;
    policy.stellar.minProviderLevel = 2;
    const quote = await client.quote(manifestUrl, "text-stats", input);
    expect(client.payable(quote)).toBe(true);
    changed = true;
    await expect(client.pay(quote, { approved: true })).rejects.toThrow("[V1]");
    expect(method.createPayload).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(journal.forJob(quote.jobId).map((entry) => entry.event)).toEqual(["intent", "refused"]);
  });

  it("recovers a lost response even if verification later becomes unavailable", async () => {
    let unavailable = false;
    let loseResponse = true;
    const read = vi.fn<VerificationSource["read"]>(async (subject) => {
      if (unavailable) throw new Error("RPC unavailable");
      return evidence(subject);
    });
    const { client, method, facilitator } = await setup({
      policy: { minVerificationScore: 20 }, client: { verificationSource: { read } },
      tamper: async (request, response) => {
        if (request.headers.has("PAYMENT-SIGNATURE") && loseResponse) {
          loseResponse = false;
          throw new Error("response lost");
        }
        return response;
      },
    });
    const quote = await client.quote(manifestUrl, "text-stats", input);
    await expect(client.pay(quote, { approved: true })).rejects.toThrow("recover job");
    unavailable = true;
    const recovered = await client.recover(quote.jobId);
    expect(recovered.confirmed).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(method.createPayload).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });
});
