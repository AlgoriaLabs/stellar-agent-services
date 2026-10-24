import type { JobView, Problem } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProvider,
  defineService,
  memoryStore,
  scheduler,
  type CapacityConfig,
  type Facilitator,
  type JobStore,
  type ProviderConfig,
  type ServiceConfig,
  type StoredJob,
} from "../src/index.js";
import { client } from "./support/harness.js";

// Capacity and queuing (docs/provider-standard.md §5.8): a busy provider queues or turns requests
// away before payment, and never answers with an error because of load.

const payTo = Keypair.random().publicKey();
const baseUrl = "http://localhost:8787";

afterEach(() => {
  vi.useRealTimers();
});

/** A provider with one service whose jobs run until the test lets them finish. */
function setup(
  options: { capacity?: CapacityConfig; charge?: "upfront" | "on-success"; expectedDurationSeconds?: number; provider?: Partial<ProviderConfig> } = {},
) {
  const gates: (() => void)[] = [];
  const started: number[] = [];
  const config: ServiceConfig<{ n: number }, { n: number }> = {
    name: "gated",
    description: "Finishes when the test says so.",
    price: "0.01",
    charge: options.charge ?? "upfront",
    expectedDurationSeconds: options.expectedDurationSeconds ?? 1,
    inputSchema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
    outputSchema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
    handler: async ({ n }) => {
      started.push(n);
      await new Promise<void>((resolve) => gates.push(resolve));
      return { n };
    },
  };
  if (options.capacity !== undefined) config.capacity = options.capacity;

  const facilitator = {
    verify: vi.fn<Facilitator["verify"]>(async () => ({ isValid: true })),
    settle: vi.fn<Facilitator["settle"]>(async (_payload, requirements) => ({ success: true, transaction: "ab".repeat(32), network: requirements.network })),
  };
  const provider = createProvider({
    baseUrl,
    dev: true,
    network: "stellar:testnet",
    payTo,
    provider: { name: "Test" },
    services: [defineService(config)],
    facilitator,
    holdSeconds: 0,
    rpc: false,
    ...options.provider,
  });

  const { payment, ...http } = client(provider);
  const createJob = async (n: number, { paid = true, headers = {} }: { paid?: boolean; headers?: Record<string, string> } = {}) =>
    http.createJob("gated", { n }, { ...(paid ? { "PAYMENT-SIGNATURE": await payment("gated") } : {}), ...headers });
  const getJob = async (job: JobView) => {
    const response = await provider.fetch(new Request(`${baseUrl}/jobs/${job.jobId}`, { headers: { "Job-Token": job.jobToken! } }));
    return (await response.json()) as JobView;
  };
  /** Lets the oldest running job finish, and the next one start. */
  const finishOne = async () => {
    gates.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { provider, facilitator, createJob, getJob, finishOne, started };
}

async function view(response: Response): Promise<JobView> {
  expect(response.status).toBe(202);
  return (await response.json()) as JobView;
}

describe("capacity", () => {
  it("runs `concurrency` jobs at once and queues the rest in order, with their positions", async () => {
    const { createJob, getJob, finishOne, started } = setup({ capacity: { concurrency: 2 } });
    const jobs: JobView[] = [];
    for (const n of [1, 2, 3, 4, 5]) jobs.push(await view(await createJob(n)));

    expect(jobs.map((job) => job.status)).toEqual(["running", "running", "queued", "queued", "queued"]);
    expect(jobs.map((job) => job.queue?.position)).toEqual([undefined, undefined, 1, 2, 3]);
    expect(Date.parse(jobs[2]!.queue!.estimatedStartAt)).toBeGreaterThan(Date.now() - 1000);
    expect(jobs.every((job) => job.charged === true)).toBe(true);
    expect(started).toEqual([1, 2]);

    await finishOne();
    const after = await Promise.all(jobs.map(getJob));
    expect(after.map((job) => job.status)).toEqual(["succeeded", "running", "running", "queued", "queued"]);
    expect(after.map((job) => job.queue?.position)).toEqual([undefined, undefined, undefined, 1, 2]);
    expect(started).toEqual([1, 2, 3]);
  });

  it("sends a queued job's Retry-After from its estimated start", async () => {
    const { createJob } = setup({ capacity: { concurrency: 1 }, expectedDurationSeconds: 5 });
    await createJob(1);
    const queued = await createJob(2);

    expect(((await queued.json()) as JobView).queue?.position).toBe(1);
    expect(queued.headers.get("Retry-After")).toBe("5");
  });

  it("answers 503 with Retry-After before the 402 when the queue is full, and charges nothing", async () => {
    const { createJob, facilitator, finishOne } = setup({ capacity: { concurrency: 1, maxQueued: 1 } });
    await createJob(1);
    await createJob(2);

    for (const paid of [true, false]) {
      const busy = await createJob(3, { paid });
      expect(busy.status).toBe(503);
      expect(busy.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect(Number(busy.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect((await busy.json()) as Problem).toMatchObject({ code: "unavailable", detail: expect.stringMatching(/nothing was charged/) });
    }
    expect(facilitator.verify).toHaveBeenCalledTimes(2);
    expect(facilitator.settle).toHaveBeenCalledTimes(2);

    await finishOne();
    expect((await createJob(3, { paid: false })).status).toBe(402);
  });

  it("turns a job away when its expected wait is above maxQueueWaitSeconds", async () => {
    const { createJob, provider } = setup({ capacity: { concurrency: 1, maxQueueWaitSeconds: 5 }, expectedDurationSeconds: 4 });
    expect(provider.manifest.services[0]?.capacity).toEqual({ concurrency: 1, maxQueueWaitSeconds: 5 });
    await createJob(1);
    expect((await view(await createJob(2))).queue?.position).toBe(1);

    const busy = await createJob(3);
    expect(busy.status).toBe(503);
    // Position 2 would wait 8 s, 3 s over the limit, but no slot frees up before a job's 4 s.
    expect(busy.headers.get("Retry-After")).toBe("4");
  });

  it("without a queue, a service with every slot busy answers 503", async () => {
    const { createJob, provider } = setup({ capacity: { concurrency: 1, maxQueueWaitSeconds: 0 } });
    expect(provider.manifest.services[0]?.capacity).toEqual({ concurrency: 1, maxQueueWaitSeconds: 0 });
    expect((await view(await createJob(1))).status).toBe("running");
    expect((await createJob(2)).status).toBe(503);
  });

  it("gives the place back when the payment is refused or never sent", async () => {
    const { createJob, facilitator } = setup({ capacity: { concurrency: 1, maxQueued: 0 } });
    for (const n of [1, 2, 3]) expect((await createJob(n, { paid: false })).status).toBe(402);
    facilitator.verify.mockResolvedValueOnce({ isValid: false, invalidReason: "invalid_signature" });
    expect((await createJob(4)).status).toBe(402);

    expect((await view(await createJob(5))).status).toBe("running");
  });

  it("answers ten requests at once: two run, eight queue, and the eleventh gets 503 before payment", async () => {
    const { createJob, getJob, finishOne, facilitator } = setup({ capacity: { concurrency: 2, maxQueueWaitSeconds: 4 } });
    const responses = await Promise.all(Array.from({ length: 11 }, (_, n) => createJob(n)));

    expect(responses.map((response) => response.status).sort()).toEqual([...Array(10).fill(202), 503]);
    const jobs = await Promise.all(responses.filter((response) => response.status === 202).map(view));
    expect(jobs.filter((job) => job.status === "running")).toHaveLength(2);
    expect(jobs.flatMap((job) => job.queue?.position ?? []).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(facilitator.settle).toHaveBeenCalledTimes(10);

    for (let i = 0; i < 10; i++) await finishOne();
    expect((await Promise.all(jobs.map(getJob))).every((job) => job.status === "succeeded")).toBe(true);
  });
});

describe("capacity for on-success jobs", () => {
  it("queues a job only as long as its payment lasts [S2]", async () => {
    // maxTimeoutSeconds 60: 10 s to settle and 20 s of work leave 30 s to wait.
    const { createJob, provider } = setup({ charge: "on-success", capacity: { concurrency: 1 }, expectedDurationSeconds: 20 });
    expect(provider.manifest.services[0]?.capacity).toEqual({ concurrency: 1, maxQueueWaitSeconds: 30 });

    await createJob(1);
    const queued = await view(await createJob(2));
    expect(queued).toMatchObject({ status: "queued", charged: false, queue: { position: 1 } });
    expect((await createJob(3)).status).toBe(503);
  });

  it("fails a queued job whose payment expired with timeout, without running or charging it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { createJob, getJob, finishOne, facilitator, started } = setup({ charge: "on-success", capacity: { concurrency: 1 } });
    await createJob(1);
    const queued = await view(await createJob(2));

    vi.setSystemTime(Date.now() + 60_000);
    await finishOne();

    expect(await getJob(queued)).toMatchObject({ status: "failed", charged: false, error: { code: "timeout" } });
    expect(started).toEqual([1]);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });
});

describe("turns with a slow store", () => {
  it("a job whose wait ends while the store is starting it doesn't block the next one", async () => {
    const inner = memoryStore();
    // A store whose start() takes a real round trip, as a networked database's would.
    const store: JobStore = { ...inner, start: async (jobId, concurrency) => (await new Promise((resolve) => setTimeout(resolve, 50)), inner.start(jobId, concurrency)) };
    const queue = scheduler({ store, lanes: [{ service: "s", charge: "on-success", concurrency: 2, maxQueued: 10, maxWaitSeconds: 60, expectedSeconds: 1 }], owner: "o", leaseSeconds: 30, pollMs: 1000 });
    const claim = async (n: number) => {
      const now = new Date().toISOString();
      const job: StoredJob = { jobId: `0192d3a4-7c1e-7b2a-9f00-00000000000${n}`, service: "s", charge: "on-success", bindingHash: "b", tokenHash: "t", status: "queued", claim: { fingerprint: `f${n}`, payer: "G", nonce: String(n), expirationLedger: 1 }, createdAt: now, updatedAt: now };
      return ((await inner.claim(job)) as { job: StoredJob }).job;
    };
    const [a, b] = [await claim(1), await claim(2)];

    const turnA = queue.waitForTurn(a, Date.now() + 20);
    const turnB = queue.waitForTurn(b, Date.now() + 2000);
    expect(await turnA).toBeUndefined();
    expect(await turnB).toMatchObject({ jobId: b.jobId, status: "running" });
  });
});

describe("rate limit", () => {
  const rateLimit = { requests: 2, windowSeconds: 60, key: (request: Request) => request.headers.get("X-Caller") ?? undefined };

  it("answers 429 with Retry-After per caller, before the 402", async () => {
    const { createJob } = setup({ provider: { rateLimit } });
    const a = { paid: false, headers: { "X-Caller": "a" } };
    expect((await createJob(1, a)).status).toBe(402);
    expect((await createJob(2, a)).status).toBe(402);

    const limited = await createJob(3, a);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(55);
    expect((await limited.json()) as Problem).toMatchObject({ code: "rate_limited" });

    expect((await createJob(4, { paid: false, headers: { "X-Caller": "b" } })).status).toBe(402);
    expect((await createJob(5, { paid: false })).status).toBe(402);
  });

  it("never limits check-status or get-result [Q7]", async () => {
    const { createJob, getJob } = setup({ provider: { rateLimit } });
    const job = await view(await createJob(1, { headers: { "X-Caller": "a" } }));
    await createJob(2, { paid: false, headers: { "X-Caller": "a" } });
    expect((await createJob(3, { paid: false, headers: { "X-Caller": "a" } })).status).toBe(429);

    for (let i = 0; i < 5; i++) expect((await getJob(job)).jobId).toBe(job.jobId);
  });
});

describe("capacity config", () => {
  it("rejects a concurrency below 1 or a negative queue", () => {
    const service = { name: "x", description: "x", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: () => ({}) };
    expect(() => defineService({ ...service, capacity: { concurrency: 0 } })).toThrow(RangeError);
    expect(() => defineService({ ...service, capacity: { maxQueued: -1 } })).toThrow(RangeError);
    expect(() => defineService({ ...service, capacity: { maxQueueWaitSeconds: 1.5 } })).toThrow(RangeError);
  });
});
