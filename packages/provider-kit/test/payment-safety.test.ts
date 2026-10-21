import { checkChallenge, type JobView } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { createProvider, defineService, type Facilitator } from "../src/index.js";

// Payment-safety tests that must exist before the pilot (IMPLEMENTATION_PLAN.md §7).

const payTo = Keypair.random().publicKey();
const jobId = "0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d";
const token = "q7Zt3m0bX0s8b6f5JmS2kQ9xg3Y1rZcV4nL8pW2eA0c";

function setup(options: { settle?: Facilitator["settle"]; handler?: () => unknown } = {}) {
  const facilitator = {
    verify: vi.fn<Facilitator["verify"]>(async () => ({ isValid: true })),
    settle: vi.fn<Facilitator["settle"]>(
      options.settle ??
        (async (_payload, requirements) => ({ success: true, transaction: "ab".repeat(32), network: requirements.network })),
    ),
  };
  const echo = defineService({
    name: "echo",
    description: "Echoes the text.",
    price: "0.01",
    charge: "on-success",
    expectedDurationSeconds: 1,
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    handler: (options.handler ?? ((input: { text: string }) => ({ text: input.text }))) as (input: { text: string }) => { text: string },
  });
  const provider = createProvider({
    baseUrl: "http://localhost:8787/agent",
    dev: true,
    network: "stellar:testnet",
    payTo,
    provider: { name: "Test" },
    services: [echo],
    facilitator,
  });
  const requirements = provider.manifest.payment.accepts[0] as unknown as PaymentRequirements;
  const payment = (signature: string) =>
    encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: { ...requirements, amount: "100000" },
      payload: { transaction: signature },
    });
  const createJob = (input: unknown, headers: Record<string, string> = {}) =>
    provider.fetch(
      new Request("http://localhost:8787/agent/services/echo/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(input),
      }),
    );
  const getJob = (id: string, jobToken?: string) =>
    provider.fetch(new Request(`http://localhost:8787/agent/jobs/${id}/result`, { headers: jobToken ? { "Job-Token": jobToken } : {} }));
  return { provider, facilitator, createJob, getJob, payment };
}

const ids = { "Idempotency-Key": jobId, "Job-Token": token };

describe("payment safety", () => {
  it("repeated create-job with the same key and input returns the same job without a second charge", async () => {
    const { createJob, facilitator, payment } = setup();
    const first = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": payment("tx-1") });
    expect(first.status).toBe(200);

    // Without a payment: no new 402. With another payment: it is not settled [J5].
    const repeat = await createJob({ text: "hi" }, ids);
    const repaid = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": payment("tx-2") });
    for (const response of [repeat, repaid]) {
      expect(response.status).toBe(200);
      expect(((await response.json()) as JobView).jobId).toBe(jobId);
    }
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("the same key with a different input or token returns 422", async () => {
    const { createJob, payment } = setup();
    await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": payment("tx-1") });

    expect((await createJob({ text: "other" }, ids)).status).toBe(422);
    expect((await createJob({ text: "hi" }, { ...ids, "Job-Token": token.replace("q", "r") })).status).toBe(422);
  });

  it.todo("a request for a job still being claimed or settled returns 409");

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
    await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": payment("tx-1") });

    expect((await getJob(jobId, token)).status).toBe(200);
    expect((await getJob(jobId, token.replace("q", "r"))).status).toBe(404);
    expect((await getJob(jobId)).status).toBe(404);
    expect((await getJob("0192d3a4-7c1e-7b2a-9f00-000000000000", token)).status).toBe(404);
  });

  it("one signed payment cannot pay for two jobs (fingerprint)", async () => {
    const { createJob, facilitator, payment } = setup();
    await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": payment("tx-1") });

    const second = await createJob({ text: "hi" }, { "PAYMENT-SIGNATURE": payment("tx-1") });
    expect(second.status).toBe(402);
    expect(decodePaymentRequiredHeader(second.headers.get("PAYMENT-REQUIRED")!).error).toBe("payment_already_used");
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("a facilitator timeout or 5xx becomes payment_uncertain, never failed", async () => {
    const { createJob, payment } = setup({
      settle: async () => {
        throw new Error("timeout");
      },
    });
    const response = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": payment("tx-1") });

    expect(response.status).toBe(202);
    const job = (await response.json()) as JobView;
    expect(job).toMatchObject({ status: "payment_uncertain", charged: "unknown" });
    expect(job.output).toBeUndefined();
  });

  it("an on-success handler failure or invalid output settles nothing", async () => {
    for (const handler of [
      () => {
        throw new Error("boom: secret detail");
      },
      () => ({ wrong: true }),
    ]) {
      const { createJob, facilitator, payment } = setup({ handler });
      const response = await createJob({ text: "hi" }, { ...ids, "PAYMENT-SIGNATURE": payment("tx-1") });
      const job = (await response.json()) as JobView;

      expect(job).toMatchObject({ status: "failed", charged: false });
      expect(["service_failed", "output_invalid"]).toContain(job.error?.code);
      expect(JSON.stringify(job)).not.toContain("secret detail");
      expect(facilitator.settle).not.toHaveBeenCalled();
    }
  });

  it.todo("on-success work that outlasts the payment authorization fails the job without a charge");

  it("the challenge always equals the manifest payment option plus the service price", async () => {
    const { createJob, provider } = setup();
    const response = await createJob({ text: "hi" }, ids);
    expect(response.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!);
    expect(checkChallenge(provider.manifest, "echo", challenge)).toEqual([]);
  });

  it("a client without Idempotency-Key and Job-Token gets a provider-generated job id and token", async () => {
    const { createJob, getJob, payment, facilitator } = setup();
    const response = await createJob({ text: "hi" }, { "PAYMENT-SIGNATURE": payment("tx-1") });
    const job = (await response.json()) as JobView;

    expect(job.jobToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await getJob(job.jobId, job.jobToken)).status).toBe(200);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("only one of Idempotency-Key and Job-Token is a bad request", async () => {
    const { createJob } = setup();
    expect((await createJob({ text: "hi" }, { "Idempotency-Key": jobId })).status).toBe(400);
  });
});
