import { defineService } from "@stellar-agent-services/provider-kit";
import { describe, expect, it } from "vitest";
import { ProviderBusyError } from "../src/index.js";
import { manifestUrl, setup, slowReport } from "./support/harness.js";

// A busy provider (docs/provider-standard.md §5.8): the client waits out 429 and 503 with the same
// request, never signs twice, and is never charged for a job the provider turned away.

/** One job at a time and no queue; each job runs until the test lets it finish. */
function oneAtATime() {
  const gates: (() => void)[] = [];
  const service = defineService({
    name: "one-at-a-time",
    description: "Runs one job at a time.",
    price: "0.01",
    charge: "upfront",
    expectedDurationSeconds: 1,
    capacity: { concurrency: 1, maxQueued: 0 },
    inputSchema: { type: "object", properties: { n: { type: "integer" } } },
    outputSchema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
    handler: async ({ n }: { n?: number }) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return { n: n ?? 0 };
    },
  });
  return { service, finishOne: () => gates.shift()!() };
}

async function busySetup(busyWaitSeconds: number) {
  const { service, finishOne } = oneAtATime();
  const harness = await setup({ provider: { services: [service], holdSeconds: 0 }, client: { followSeconds: 0, busyWaitSeconds } });
  /** Pays for a job that keeps the only slot busy. */
  const occupy = async () => {
    const { job } = await harness.client.pay(await harness.client.quote(manifestUrl, "one-at-a-time", { n: 1 }), { approved: true });
    expect(job.status).toBe("running");
  };
  return { ...harness, finishOne, occupy };
}

describe("busy provider", () => {
  it("quote() gives up after busyWaitSeconds with ProviderBusyError, and nothing is signed", async () => {
    const { client, method, occupy } = await busySetup(0);
    await occupy();

    const error = await client.quote(manifestUrl, "one-at-a-time", { n: 2 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderBusyError);
    expect(error).toMatchObject({ status: 503, retryAfterSeconds: 1, problem: { code: "unavailable" } });
    expect(method.createPayload).toHaveBeenCalledTimes(1);
  });

  it("quote() waits out Retry-After and gets the 402 once there is room", async () => {
    const { client, occupy, finishOne } = await busySetup(5);
    await occupy();
    setTimeout(finishOne, 200);

    const quote = await client.quote(manifestUrl, "one-at-a-time", { n: 2 });
    expect(quote.challengeViolations).toEqual([]);
  });

  it("sends a turned-away paid request again with the same signed payment, and pays once", async () => {
    const { client, method, facilitator, occupy, finishOne, journal } = await busySetup(5);
    const quote = await client.quote(manifestUrl, "one-at-a-time", { n: 2 });
    await occupy();
    setTimeout(finishOne, 200);

    const { job } = await client.pay(quote, { approved: true });
    expect(job).toMatchObject({ jobId: quote.jobId, charged: true });
    // One signature per job: the occupying job's and this one's.
    expect(method.createPayload).toHaveBeenCalledTimes(2);
    // The turned-away attempt was answered before the payment was verified.
    expect(facilitator.verify).toHaveBeenCalledTimes(2);
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
    expect(journal.forJob(quote.jobId).map((entry) => entry.event)).toEqual(["intent", "approved", "sending", "settled"]);
  });

  it("journals a paid request that stays busy as failed and not charged", async () => {
    const { client, facilitator, occupy, journal } = await busySetup(0);
    const quote = await client.quote(manifestUrl, "one-at-a-time", { n: 2 });
    await occupy();

    await expect(client.pay(quote, { approved: true })).rejects.toThrow(ProviderBusyError);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    const entries = journal.forJob(quote.jobId);
    expect(entries.map((entry) => entry.event)).toEqual(["intent", "approved", "sending", "failed"]);
    expect(entries.at(-1)?.details).toEqual({ charged: false, reason: "unavailable" });
    expect(journal.spentSince(new Date(0))).toBe(100000n);
  });

  it("keeps following a job when a poll gets a busy answer", async () => {
    let polls = 0;
    const { client } = await setup({
      provider: { holdSeconds: 0 },
      tamper: async (request, response) => {
        if (request.method !== "GET" || !request.url.endsWith("/result") || ++polls > 1) return response;
        return new Response(JSON.stringify({ code: "rate_limited" }), { status: 429, headers: { "Retry-After": "1" } });
      },
    });
    const quote = await client.quote(manifestUrl, slowReport.name, { topic: "queues" });

    const { job } = await client.pay(quote, { approved: true });
    expect(job).toMatchObject({ status: "succeeded", output: { report: "report on queues" } });
    expect(polls).toBeGreaterThan(1);
  });
});
