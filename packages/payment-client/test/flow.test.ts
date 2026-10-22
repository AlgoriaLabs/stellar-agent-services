import { describe, expect, it, vi } from "vitest";
import { PaymentClient, PaymentRefusedError, PaymentUncertainError, verifyChain, type Signer } from "../src/index.js";
import { fakeFacilitator, manifestUrl, payer, payTo, setup, signer, testMethod } from "./support/harness.js";

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

  it("confirms against the approved payment, not the provider's receipt", async () => {
    const { client, method } = await setup();
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });
    const { job } = await client.pay(quote, { approved: true });

    expect(method.confirm).toHaveBeenCalledWith(job.payment?.transaction, {
      network: "stellar:testnet",
      asset: quote.requirements.asset,
      amount: "100000",
      payTo,
      payer,
    });
  });

  it("does not confirm a job whose receipt reuses another job's transaction", async () => {
    const facilitator = fakeFacilitator();
    facilitator.settle.mockImplementation(async (_payload, requirements) => ({ success: true, transaction: "a".repeat(64), network: requirements.network, payer }));
    const { client, journal } = await setup({ provider: { facilitator } });

    expect((await client.pay(await client.quote(manifestUrl, "text-stats", { text: "one" }), { approved: true })).confirmed).toBe(true);
    const second = await client.quote(manifestUrl, "text-stats", { text: "two" });
    const result = await client.pay(second, { approved: true });

    expect(result.confirmed).toBe(false);
    expect(result.unconfirmedReason).toMatch(/already confirmed job/);
    expect(journal.forJob(second.jobId).find((entry) => entry.event === "settled")?.details).toMatchObject({ confirmed: false });
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

describe("strategies", () => {
  it("pays with the first installed method that matches, and journals which one", async () => {
    const other = testMethod({ id: "other-scheme", matches: () => false });
    const method = testMethod();
    const { client, journal } = await setup({ client: { methods: [other, method] } });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });
    expect(quote.methodId).toBe("test-exact");

    await client.pay(quote, { approved: true });
    expect(other.createPayload).not.toHaveBeenCalled();
    expect(method.createPayload).toHaveBeenCalledWith(quote.requirements, signer);
    expect(journal.forJob(quote.jobId).find((entry) => entry.event === "sending")?.details).toMatchObject({ method: "test-exact", payer });
  });

  it("refuses before signing when no installed method pays the challenge", async () => {
    const notMine = testMethod({ id: "not-mine", matches: () => false });
    const broken = testMethod({
      id: "broken",
      matches: () => {
        throw new Error("bug");
      },
    });
    const { client, facilitator } = await setup({ client: { methods: [notMine, broken] } });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });

    expect(quote.methodId).toBeUndefined();
    expect(quote.challengeViolations).toEqual([expect.stringMatching(/no installed payment method pays scheme "exact"/)]);
    await expect(client.pay(quote, { approved: true })).rejects.toThrow(PaymentRefusedError);
    expect(notMine.createPayload).not.toHaveBeenCalled();
    expect(broken.createPayload).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("signs once when pay() runs twice at the same time", async () => {
    const { client, method, facilitator } = await setup();
    const quote = await client.quote(manifestUrl, "text-stats", { text: "double click" });

    const [first, second] = await Promise.allSettled([client.pay(quote, { approved: true }), client.pay(quote, { approved: true })]);
    expect(first.status).toBe("fulfilled");
    expect(second.status === "rejected" && second.reason).toBeInstanceOf(PaymentRefusedError);
    expect(method.createPayload).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the wallet does not sign, and lets the user try again", async () => {
    const { client, method, facilitator, journal } = await setup();
    method.createPayload.mockRejectedValueOnce(new Error("the user closed the wallet"));
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });

    await expect(client.pay(quote, { approved: true })).rejects.toThrow("the payment was not signed: the user closed the wallet");
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(journal.forJob(quote.jobId).map((entry) => entry.event)).toEqual(["intent", "approved", "refused"]);

    expect((await client.pay(quote, { approved: true })).confirmed).toBe(true);
    expect(journal.spentSince(new Date(0))).toBe(100000n);
  });

  it("re-checks a policy wallet's on-chain budget when paying", async () => {
    const budget = vi.fn(async () => "150000");
    const { client, facilitator, journal } = await setup({ client: { signer: { ...signer, budget } } });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });
    expect(budget).toHaveBeenCalledWith("stellar:testnet", quote.requirements.asset);
    expect(quote.walletBudget).toBe("150000");
    expect(quote.policyViolations).toEqual([]);

    budget.mockResolvedValue("50000"); // another agent spent from the wallet meanwhile
    await expect(client.pay(quote, { approved: true })).rejects.toThrow(/on-chain budget/);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(journal.forJob(quote.jobId).map((entry) => entry.event)).toEqual(["intent", "refused"]);
  });

  it.each<[string, NonNullable<Signer["budget"]>, RegExp]>([
    ["is too low", async () => "50000", /on-chain budget/],
    ["can't be read", async () => Promise.reject(new Error("RPC down")), /could not be read: RPC down/],
    ["is not in base units", async () => "lots", /invalid budget "lots"/],
  ])("blocks the payment when the wallet's budget %s (fail closed)", async (_case, budget, message) => {
    const { client } = await setup({ client: { signer: { ...signer, budget } } });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });

    expect(quote.policyViolations).toEqual([{ field: "wallet.budget", message: expect.stringMatching(message) }]);
    expect(client.payable(quote)).toBe(false);
  });

  it("does not confirm a recovered payment whose method is no longer installed", async () => {
    const { client, journal, secrets, policy, fetch } = await setup({ provider: { loseCreateJobResponse: true } });
    const quote = await client.quote(manifestUrl, "text-stats", { text: "hi" });
    await expect(client.pay(quote, { approved: true })).rejects.toThrow(PaymentUncertainError);

    const options = { signer, policy, journal, secrets, fetch, allowLocalhost: true, pollMs: 20, followSeconds: 5 };
    const result = await new PaymentClient({ ...options, methods: [testMethod({ id: "something-else" })] }).recover(quote.jobId);
    expect(result.job.status).toBe("succeeded");
    expect(result.confirmed).toBe(false);
    expect(result.unconfirmedReason).toBe('payment method "test-exact" is not installed, so the payment can\'t be checked');
  });

  it("does not confirm a payment whose method throws while checking it", async () => {
    const { client, method } = await setup();
    method.confirm.mockRejectedValueOnce(new Error("RPC down"));
    const result = await client.pay(await client.quote(manifestUrl, "text-stats", { text: "hi" }), { approved: true });

    expect(result.confirmed).toBe(false);
    expect(result.unconfirmedReason).toBe("the payment could not be checked: RPC down");
  });

  it("needs at least one payment method, each with its own id", async () => {
    const { policy, journal, secrets } = await setup();
    const options = { signer, policy, journal, secrets };
    expect(() => new PaymentClient({ ...options, methods: [] })).toThrow(/at least one/);
    expect(() => new PaymentClient({ ...options, methods: [testMethod(), testMethod()] })).toThrow(/unique/);
  });
});
