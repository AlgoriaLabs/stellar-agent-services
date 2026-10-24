import { checkChallenge, type JobView } from "@stellar-agent-services/protocol";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineService, type Facilitator, type ProviderConfig } from "../src/index.js";
import { fakeFacilitator, ids, jobId, payer, payTo, testProvider, token } from "./support/harness.js";

// Payment-safety tests that must exist before the pilot (IMPLEMENTATION_PLAN.md §7).

afterEach(() => {
  vi.useRealTimers();
});

function setup(options: { settle?: Facilitator["settle"]; handler?: () => unknown; timeoutSeconds?: number; provider?: Partial<ProviderConfig> } = {}) {
  const facilitator = fakeFacilitator();
  if (options.settle !== undefined) facilitator.settle.mockImplementation(options.settle);
  const echo = defineService({
    name: "echo",
    description: "Echoes the text.",
    price: "0.01",
    charge: "on-success",
    expectedDurationSeconds: 1,
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    handler: (options.handler ?? ((input: { text: string }) => ({ text: input.text }))) as (input: { text: string }) => { text: string },
  });
  const harness = testProvider([echo], { facilitator, ...options.provider });
  return {
    ...harness,
    createJob: (input: unknown, headers: Record<string, string> = {}) => harness.createJob("echo", input, headers),
    payment: (options?: Parameters<typeof harness.payment>[1]) => harness.payment("echo", options),
  };
}

describe("payment safety", () => {
  it("repeated create-job with the same key and input returns the same job without a second charge", async () => {
    const { createJob, facilitator, payment } = setup();
    const first = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment() });
    expect(first.status).toBe(200);

    // Without a payment: no new 402. With another payment: it is not settled [J5].
    const repeat = await createJob({ text: "hi" }, ids);
    const repaid = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment() });
    for (const response of [repeat, repaid]) {
      expect(response.status).toBe(200);
      expect(((await response.json()) as JobView).jobId).toBe(jobId);
    }
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("the same key with a different input or token returns 422", async () => {
    const { createJob, payment } = setup();
    await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment() });

    expect((await createJob({ text: "other" }, ids)).status).toBe(422);
    expect((await createJob({ text: "hi" }, { ...ids, "Job-Token": token.replace("q", "r") })).status).toBe(422);
  });

  it("a request for a job still being settled returns 409 with Retry-After, and nothing settles twice", async () => {
    let release!: () => void;
    const facilitator = fakeFacilitator();
    const settle = facilitator.settle.getMockImplementation()!;
    facilitator.settle.mockImplementation(async (payload, requirements) => {
      await new Promise<void>((resolve) => (release = resolve));
      return settle(payload, requirements);
    });
    const report = defineService({
      name: "report",
      description: "Upfront.",
      price: "0.02",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: () => ({ done: true }),
    });
    const { createJob, getJob, payment } = testProvider([report], { facilitator, holdSeconds: 0 });

    const paid = await createJob("report", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("report") });
    expect(paid.status).toBe(409);
    expect(paid.headers.get("Retry-After")).toBe("2");
    expect(await paid.json()).toMatchObject({ code: "request_in_progress" });

    const again = await createJob("report", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("report") });
    expect(again.status).toBe(409);
    expect((await getJob(jobId, token)).status).toBe(409);

    release();
    await vi.waitFor(async () => expect((await getJob(jobId, token)).status).toBe(200));
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("invalid input returns 400 before any 402", async () => {
    const { createJob, facilitator } = setup();
    const response = await createJob({ text: 42 }, ids);
    expect(response.status).toBe(400);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "invalid_input", errors: [{ pointer: "/text" }] });
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("a wrong or missing job token returns 404", async () => {
    const { createJob, getJob, payment } = setup();
    await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment() });

    expect((await getJob(jobId, token)).status).toBe(200);
    expect((await getJob(jobId, token.replace("q", "r"))).status).toBe(404);
    expect((await getJob(jobId)).status).toBe(404);
    expect((await getJob("0192d3a4-7c1e-7b2a-9f00-000000000000", token)).status).toBe(404);
  });

  it("one signed payment cannot pay for two jobs (fingerprint)", async () => {
    const { createJob, facilitator, payment } = setup();
    const signature = await payment();
    await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": signature });

    const second = await createJob({ text: "hi" }, { "PAYMENT-SIGNATURE": signature });
    expect(second.status).toBe(402);
    expect(decodePaymentRequiredHeader(second.headers.get("PAYMENT-REQUIRED")!).error).toBe("payment_already_used");
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("the same signed auth entry in a new transaction is still the same payment", async () => {
    const { createJob, facilitator, payment } = setup();
    await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment({ nonce: 7n }) });

    // Another signature over the same (payer, nonce): Soroban would accept only one of them.
    const second = await createJob({ text: "hi" }, { "PAYMENT-SIGNATURE": await payment({ nonce: 7n, expirationLedger: 2_000_000 }) });
    expect(decodePaymentRequiredHeader(second.headers.get("PAYMENT-REQUIRED")!).error).toBe("payment_already_used");
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("a payment to another address or for another amount is refused before the facilitator sees it", async () => {
    const { createJob, facilitator, payment } = setup();
    for (const [override, reason] of [
      [{ payTo: payer.publicKey() }, "invalid_exact_stellar_payload_wrong_recipient"],
      [{ amount: "99999" }, "invalid_exact_stellar_payload_wrong_amount"],
    ] as const) {
      const response = await createJob({ text: "hi" }, { "PAYMENT-SIGNATURE": await payment({ override }) });
      expect(response.status).toBe(402);
      expect(decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!).error).toBe(reason);
    }
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("a facilitator timeout or 5xx becomes payment_uncertain, never failed", async () => {
    const { createJob, payment } = setup({
      settle: async () => {
        throw new Error("timeout");
      },
    });
    const response = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment() });

    expect(response.status).toBe(202);
    const job = (await response.json()) as JobView;
    expect(job).toMatchObject({ status: "payment_uncertain", charged: "unknown" });
    expect(job.output).toBeUndefined();
  });

  it("a settlement refused before submission is failed and not charged; an unknown refusal is uncertain", async () => {
    for (const [errorReason, status] of [
      ["invalid_exact_stellar_payload_simulation_failed", "failed"],
      ["settle_exact_stellar_transaction_submission_failed", "failed"],
      ["unexpected_settle_error", "payment_uncertain"],
      ["some_other_facilitators_wording", "payment_uncertain"],
    ] as const) {
      const { createJob, payment } = setup({ settle: async (_payload, requirements) => ({ success: false, transaction: "", network: requirements.network, errorReason }) });
      const job = (await (await createJob({ text: "hi" }, { "PAYMENT-SIGNATURE": await payment() })).json()) as JobView;
      expect(job.status).toBe(status);
      expect(job.charged).toBe(status === "failed" ? false : "unknown");
      if (status === "failed") expect(job.error?.code).toBe("payment_failed");
    }
  });

  it("an on-success handler failure or invalid output settles nothing", async () => {
    for (const handler of [
      () => {
        throw new Error("boom: secret detail");
      },
      () => ({ wrong: true }),
    ]) {
      const { createJob, facilitator, payment } = setup({ handler });
      const response = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment() });
      const job = (await response.json()) as JobView;

      expect(job).toMatchObject({ status: "failed", charged: false });
      expect(["service_failed", "output_invalid"]).toContain(job.error?.code);
      expect(JSON.stringify(job)).not.toContain("secret detail");
      expect(facilitator.settle).not.toHaveBeenCalled();
    }
  });

  it("on-success work that outlasts the payment authorization fails the job without a charge", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    // maxTimeoutSeconds 30 leaves 20 s for the work, 10 s to settle [S2]; the handler's own limit is longer.
    const handler = () => (started(), new Promise(() => {}));
    const { createJob, facilitator, payment } = setup({ handler, timeoutSeconds: 600, provider: { maxTimeoutSeconds: 30 } });
    const pending = createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment() });

    await running;
    await vi.advanceTimersByTimeAsync(19_000);
    expect(facilitator.settle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    const job = (await (await pending).json()) as JobView;
    expect(job).toMatchObject({ status: "failed", charged: false, error: { code: "timeout" } });
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("the challenge always equals the manifest payment option plus the service price", async () => {
    const { createJob, provider } = setup();
    const response = await createJob({ text: "hi" }, ids);
    expect(response.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!);
    expect(checkChallenge(provider.manifest, "echo", challenge)).toEqual([]);
    // [P6]: generic x402 clients can discover the service from the challenge.
    expect(challenge.extensions?.["bazaar"]).toMatchObject({ info: { input: { type: "http", method: "POST", bodyType: "json" } } });
  });

  it("a client without Idempotency-Key and Job-Token gets a provider-generated job id and token", async () => {
    const { createJob, getJob, payment, facilitator } = setup();
    const response = await createJob({ text: "hi" }, { "PAYMENT-SIGNATURE": await payment() });
    const job = (await response.json()) as JobView;

    expect(job.jobToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await getJob(job.jobId, job.jobToken)).status).toBe(200);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("a settled response carries PAYMENT-RESPONSE and a receipt for the payer the provider checked", async () => {
    const { createJob, payment } = setup();
    const response = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": await payment() });
    expect(decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!).success).toBe(true);
    expect(((await response.json()) as JobView).payment).toMatchObject({ payer: payer.publicKey(), payTo, amount: "100000" });
  });

  it("a malformed service name in the path is not found, not an error", async () => {
    const { provider } = setup();
    const response = await provider.fetch(new Request("http://localhost:8787/agent/services/%E0%A4%A/jobs", { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
  });

  it("only one of Idempotency-Key and Job-Token is a bad request", async () => {
    const { createJob } = setup();
    expect((await createJob({ text: "hi" }, { "Idempotency-Key": jobId })).status).toBe(400);
  });

  it("a body over maxInputBytes is refused with 413 before it is read in full", async () => {
    const small = defineService({
      name: "small",
      description: "Small inputs only.",
      price: "0.01",
      maxInputBytes: 64,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: () => ({}),
    });
    const { createJob } = testProvider([small]);
    expect((await createJob("small", { text: "x".repeat(100) })).status).toBe(413);
  });
});
