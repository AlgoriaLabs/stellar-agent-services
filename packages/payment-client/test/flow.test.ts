import { describe, expect, it } from "vitest";
import { PaymentRefusedError, PaymentUncertainError, verifyChain } from "../src/index.js";
import { manifestUrl, payTo, setup } from "./support/harness.js";

describe("payment flow", () => {
  it("quotes, pays once after approval, and confirms", async () => {
    const { client, facilitator, journal } = await setup();

    const quote = await client.quote(manifestUrl, "text-stats", { text: "hello agent world" });
    expect(quote.requirements).toMatchObject({ amount: "100000", payTo, network: "stellar:testnet" });
    expect(quote.challengeViolations).toEqual([]);
    expect(quote.policyViolations).toEqual([]);
    expect(quote.needsApproval).toBe(true);
    expect(facilitator.verify).not.toHaveBeenCalled();

    const { job, confirmed } = await client.pay(quote, { approved: true });
    expect(job).toMatchObject({ status: "succeeded", charged: true, output: { words: 3 } });
    expect(job.payment?.amount).toBe("100000");
    expect(confirmed).toBe(true);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);

    expect(journal.forJob(quote.jobId).map((entry) => entry.event)).toEqual(["intent", "approved", "sending", "settled", "result"]);
    expect(await verifyChain(journal.entries())).toBeUndefined();
    expect(journal.spentSince(new Date(0))).toBe(100000n);
  });

  it("pays nothing when the user declines", async () => {
    const { client, facilitator, journal } = await setup();
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });

    await expect(client.pay(quote, { approved: false })).rejects.toThrow(PaymentRefusedError);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(journal.forJob(quote.jobId).map((entry) => entry.event)).toEqual(["intent", "refused"]);
  });

  it("pays without a prompt inside the auto-approve budget", async () => {
    const { client } = await setup({ policy: { stellar: { network: "stellar:testnet", payees: { block: [] }, autoApproveUpTo: "100000" } } });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });
    expect(quote.needsApproval).toBe(false);
    expect((await client.pay(quote, { approved: false })).job.status).toBe("succeeded");
  });

  it("blocks a payment above the per-payment limit (fail closed)", async () => {
    const { client, facilitator } = await setup({ policy: { maxValuePerTx: "50000" } });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });

    expect(quote.policyViolations.map((v) => v.field)).toEqual(["maxValuePerTx"]);
    await expect(client.pay(quote, { approved: true })).rejects.toThrow(PaymentRefusedError);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("blocks a payment that would exceed the 24-hour limit", async () => {
    const { client } = await setup({ policy: { maxValuePerDay: "150000" } });
    await client.pay(await client.quote(manifestUrl, "text-stats", { text: "one" }), { approved: true });

    const second = await client.quote(manifestUrl, "text-stats", { text: "two" });
    expect(second.policyViolations.map((v) => v.field)).toEqual(["maxValuePerDay"]);
  });

  it("refuses to sign a challenge that differs from the manifest", async () => {
    const { client } = await setup({
      tamper: async (_request, response) => {
        if (response.status !== 402) return response;
        const body = await response.json();
        body.accepts[0].amount = "9000000";
        const headers = new Headers(response.headers);
        headers.set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(body)).toString("base64"));
        return new Response(JSON.stringify(body), { status: 402, headers });
      },
    });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });

    expect(quote.challengeViolations).toEqual([expect.stringContaining("/accepts/0/amount")]);
    await expect(client.pay(quote, { approved: true })).rejects.toThrow(PaymentRefusedError);
  });

  it("follows an upfront job that answers 202", async () => {
    const { client } = await setup({ provider: { holdSeconds: 0 } });
    const quote = await client.quote(manifestUrl, "slow-report", { topic: "stellar" });

    const { job } = await client.pay(quote, { approved: true });
    expect(job).toMatchObject({ status: "succeeded", charge: "upfront", output: { report: "report on stellar" } });
  });
});

describe("job recovery", () => {
  it("recovers a lost response without paying again", async () => {
    const { client, facilitator, journal } = await setup({ provider: { loseCreateJobResponse: true } });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "lost and found" });

    await expect(client.pay(quote, { approved: true })).rejects.toThrow(PaymentUncertainError);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);

    // Paying the same quote again is refused: the job was already sent.
    await expect(client.pay(quote, { approved: true })).rejects.toThrow(/already paid/);

    const { job, confirmed } = await client.recover(quote.jobId);
    expect(job).toMatchObject({ status: "succeeded", charged: true, output: { words: 3 } });
    expect(confirmed).toBe(true);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(journal.forJob(quote.jobId).map((entry) => entry.event)).toEqual([
      "intent",
      "approved",
      "sending",
      "uncertain",
      "recovered",
      "settled",
      "result",
    ]);
  });

  it("does not recover a job that was never paid", async () => {
    const { client } = await setup();
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });
    await expect(client.recover(quote.jobId)).rejects.toThrow(/never paid/);
  });
});
