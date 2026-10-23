import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { defineService, memoryStore, sqliteStore, type JobStore, type StoredJob } from "../src/index.js";
import { sweep } from "../src/jobs/recovery.js";
import { client, fakeFacilitator, ids, jobId, testProvider, token } from "./support/harness.js";

// Job Recovery: create-job, check-status, get-result (docs/provider-standard.md §5), and a queue that
// survives restarts and dead workers (§5.8 [Q4]).

const directory = mkdtempSync(join(tmpdir(), "provider-kit-recovery-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
});

/** An upfront service whose jobs finish when the test says so. */
function gatedReport() {
  const gates: (() => void)[] = [];
  const runs: string[] = [];
  const service = defineService({
    name: "report",
    description: "Writes a report.",
    price: "0.02",
    charge: "upfront",
    expectedDurationSeconds: 5,
    inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } },
    outputSchema: { type: "object", required: ["report"], properties: { report: { type: "string" } } },
    handler: async ({ topic }: { topic: string }, { jobId: id }) => {
      runs.push(id);
      await new Promise<void>((resolve) => gates.push(resolve));
      return { report: `on ${topic}` };
    },
  });
  return { service, runs, finish: () => gates.shift()?.() };
}

const quick = defineService({
  name: "quick",
  description: "Answers at once.",
  price: "0.01",
  charge: "upfront",
  inputSchema: { type: "object" },
  outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
  handler: () => ({ ok: true }),
});

describe("job recovery", () => {
  it("after a lost response, check-status and get-result return the stored result, with one settlement", async () => {
    const { provider, facilitator, payment, getJob, view } = testProvider([quick], { loseCreateJobResponse: true });
    const { createJob } = client(provider);
    await expect(createJob("quick", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("quick") })).rejects.toThrow(/response-loss drill/);

    const status = await getJob(jobId, token, false);
    expect(status.status).toBe(200);
    expect(await view(status)).toMatchObject({ status: "succeeded", charged: true });
    expect((await view(await getJob(jobId, token))).output).toEqual({ ok: true });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("create-job answers 200 when the job finishes within the hold time", async () => {
    const { createJob, payment, view } = testProvider([quick]);
    const response = await createJob("quick", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("quick") });
    expect(response.status).toBe(200);
    expect(await view(response)).toMatchObject({ status: "succeeded", output: { ok: true }, charged: true });
  });

  it("an upfront job answers 202 with Location, moves to succeeded, and its result is retrievable", async () => {
    const report = gatedReport();
    const { provider, createJob, getJob, payment, view } = testProvider([report.service], { holdSeconds: 0 });
    const response = await createJob("report", { topic: "tides" }, { ...ids, "PAYMENT-SIGNATURE": await payment("report") });
    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toBe(`${provider.manifest.baseUrl}/jobs/${jobId}`);
    expect(await view(response)).toMatchObject({ status: "running", charged: true, payment: { amount: "200000" } });

    report.finish();
    await vi.waitFor(async () => expect((await getJob(jobId, token, false)).status).toBe(200));
    expect(await view(await getJob(jobId, token))).toMatchObject({ status: "succeeded", output: { report: "on tides" } });
  });

  it("finished jobs never change again, even when create-job is repeated", async () => {
    const { createJob, getJob, payment, view, facilitator } = testProvider([quick]);
    await createJob("quick", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("quick") });
    const first = await view(await getJob(jobId, token));
    await createJob("quick", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("quick") });
    expect(await view(await getJob(jobId, token))).toEqual(first);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("expired jobs answer 404 after retentionSeconds, and the sweep deletes them [J15]", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = memoryStore();
    const { createJob, getJob, payment } = testProvider([quick], { store, retentionSeconds: 3600 });
    await createJob("quick", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("quick") });
    expect((await getJob(jobId, token)).status).toBe(200);

    vi.setSystemTime(Date.now() + 3601_000);
    expect((await getJob(jobId, token)).status).toBe(404);
    await sweep(store, { maxTimeoutSeconds: 60, settleTimeoutSeconds: 90, retentionSeconds: 3600 });
    expect(await store.get(jobId)).toBeUndefined();
  });
});

describe("a durable queue [Q4]", () => {
  let files = 0;
  const path = () => join(directory, `jobs-${++files}.sqlite`);

  it("runs a paid upfront job after a restart, without charging again", async () => {
    const file = path();
    const report = gatedReport();
    // The first process takes the payment and stops before running the job.
    const before = testProvider([report.service], { store: sqliteStore(file), runQueuedJobs: false, holdSeconds: 0 });
    const paid = await before.createJob("report", { topic: "restart" }, { ...ids, "PAYMENT-SIGNATURE": await before.payment("report") });
    expect(await before.view(paid)).toMatchObject({ status: "queued", charged: true, queue: { position: 1 } });
    await before.provider.close();

    const after = testProvider([report.service], { store: sqliteStore(file) });
    await after.provider.ready();
    await vi.waitFor(() => expect(report.runs).toEqual([jobId]));
    report.finish();
    await vi.waitFor(async () => expect(await after.view(await after.getJob(jobId, token))).toMatchObject({ status: "succeeded", output: { report: "on restart" } }));
    expect(before.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(after.facilitator.settle).not.toHaveBeenCalled();
    await after.provider.close();
  });

  it("hands a dead worker's job to another worker once its lease runs out", async () => {
    const file = path();
    const report = gatedReport();
    const store = sqliteStore(file);
    const { createJob, payment, provider } = testProvider([report.service], { store, runQueuedJobs: false, holdSeconds: 0 });
    await createJob("report", { topic: "takeover" }, { ...ids, "PAYMENT-SIGNATURE": await payment("report") });
    // A worker took the job and died: its lease has run out.
    expect(await store.lease("report", 1, "dead-worker", -1)).toMatchObject({ jobId, status: "running" });
    await provider.close();

    const survivor = testProvider([report.service], { store: sqliteStore(file) });
    await survivor.provider.ready();
    await vi.waitFor(() => expect(report.runs).toEqual([jobId]));
    report.finish();
    await vi.waitFor(async () => expect(await survivor.view(await survivor.getJob(jobId, token))).toMatchObject({ status: "succeeded" }));
    await survivor.provider.close();
  });

  it("lets HTTP-only processes take jobs that separate worker processes run", async () => {
    const file = path();
    const report = gatedReport();
    const http = testProvider([report.service], { store: sqliteStore(file), runQueuedJobs: false, holdSeconds: 0 });
    const worker = testProvider([report.service], { store: sqliteStore(file) });
    await worker.provider.ready();

    await http.createJob("report", { topic: "split" }, { ...ids, "PAYMENT-SIGNATURE": await http.payment("report") });
    await vi.waitFor(() => expect(report.runs).toEqual([jobId]), { timeout: 3000 });
    report.finish();
    await vi.waitFor(async () => expect(await http.view(await http.getJob(jobId, token))).toMatchObject({ status: "succeeded" }), { timeout: 3000 });
    await http.provider.close();
    await worker.provider.close();
  });

  it("gives up on a job that keeps killing its worker", async () => {
    const store = memoryStore();
    const report = gatedReport();
    const { createJob, payment, getJob, view } = testProvider([report.service], { store, runQueuedJobs: false, holdSeconds: 0 });
    await createJob("report", { topic: "crash" }, { ...ids, "PAYMENT-SIGNATURE": await payment("report") });
    for (let attempt = 0; attempt < 3; attempt++) await store.lease("report", 1, `worker-${attempt}`, -1);

    const next = testProvider([report.service], { store });
    await next.provider.ready();
    await vi.waitFor(async () => expect(await view(await getJob(jobId, token))).toMatchObject({ status: "failed", charged: true, error: { code: "service_failed" } }));
    expect(report.runs).toEqual([]);
  });
});

describe("slow and late settlements [J13]", () => {
  /** A facilitator whose settle answers only when the test releases it. */
  function slowFacilitator() {
    const facilitator = fakeFacilitator();
    const answer = facilitator.settle.getMockImplementation()!;
    let release!: () => void;
    facilitator.settle.mockImplementation(async (payload, requirements) => {
      await new Promise<void>((resolve) => (release = resolve));
      return answer(payload, requirements);
    });
    return { facilitator, release: () => release() };
  }

  it("marks a settlement past its deadline uncertain, then runs the paid job when the answer comes", async () => {
    const { facilitator, release } = slowFacilitator();
    const store = memoryStore();
    const { createJob, payment } = testProvider([quick], { store, facilitator, holdSeconds: 0, settleTimeoutSeconds: 1 });
    await createJob("quick", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("quick") });
    await vi.waitFor(async () => expect(await store.get(jobId)).toMatchObject({ status: "payment_uncertain", settlement: { reason: "the settlement did not answer in 1 s" } }), { timeout: 3000 });

    release();
    await vi.waitFor(async () => expect(await store.get(jobId)).toMatchObject({ status: "succeeded", output: { ok: true }, payment: { amount: "100000" } }));
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("records a settlement that lands after a sweep marked the job uncertain", async () => {
    const { facilitator, release } = slowFacilitator();
    const store = memoryStore();
    const { createJob, payment } = testProvider([quick], { store, facilitator, holdSeconds: 0 });
    await createJob("quick", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("quick") });
    // Another process's sweep, long after: it takes this process for dead.
    await sweep(store, { maxTimeoutSeconds: 60, settleTimeoutSeconds: 90, retentionSeconds: 86400 }, Date.now() + 151_000);
    expect(await store.get(jobId)).toMatchObject({ status: "payment_uncertain" });

    release();
    await vi.waitFor(async () => expect(await store.get(jobId)).toMatchObject({ status: "succeeded", payment: { amount: "100000" } }));
  });
});

describe("a service the provider stopped offering", () => {
  it("keeps its paid jobs queued and answering check-status, and runs them once it is offered again", async () => {
    const store = memoryStore();
    const before = testProvider([quick], { store, runQueuedJobs: false, holdSeconds: 0 });
    await before.createJob("quick", {}, { ...ids, "PAYMENT-SIGNATURE": await before.payment("quick") });
    const other = defineService({ name: "other", description: "Something else.", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: () => ({}) });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const without = testProvider([other], { store });
    await without.provider.ready();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 of "quick"'));
    warn.mockRestore();
    const status = await without.getJob(jobId, token, false);
    expect(status.status).toBe(202);
    expect(await without.view(status)).toMatchObject({ status: "queued", charged: true });
    await without.provider.close();

    const again = testProvider([quick], { store });
    await again.provider.ready();
    await vi.waitFor(async () => expect(await again.view(await again.getJob(jobId, token))).toMatchObject({ status: "succeeded" }));
  });
});

describe("recovery sweep", () => {
  const options = { maxTimeoutSeconds: 60, settleTimeoutSeconds: 90, retentionSeconds: 86400 };
  const longAgo = new Date(Date.now() - 3600_000).toISOString();
  let n = 0;
  const job = (overrides: Partial<StoredJob>): StoredJob => ({
    jobId: `0192d3a4-7c1e-7b2a-9f00-${(++n).toString().padStart(12, "0")}`,
    service: "svc",
    charge: "upfront",
    bindingHash: "b",
    tokenHash: "t",
    status: "queued",
    claim: { fingerprint: `f-${n}`, payer: "G", nonce: String(n), expirationLedger: 1 },
    createdAt: longAgo,
    updatedAt: longAgo,
    ...overrides,
  });
  const claimAll = async (store: JobStore, jobs: StoredJob[]) => {
    for (const each of jobs) await store.claim(each);
  };

  it("marks a settlement that never answered as payment_uncertain, keeping an on-success output [J13], [J14]", async () => {
    const store = memoryStore();
    const upfront = job({ status: "pending", settlingSince: longAgo });
    const onSuccess = job({ charge: "on-success", status: "running", settlingSince: longAgo, output: { kept: true } });
    const recent = job({ status: "pending", settlingSince: new Date().toISOString(), createdAt: new Date().toISOString() });
    await claimAll(store, [upfront, onSuccess, recent]);
    await sweep(store, options);

    expect(await store.get(upfront.jobId)).toMatchObject({ status: "payment_uncertain" });
    expect(await store.get(onSuccess.jobId)).toMatchObject({ status: "payment_uncertain", output: { kept: true } });
    expect(await store.get(recent.jobId)).toMatchObject({ status: "pending" });
  });

  it("never mistakes a long upfront job for a stuck settlement", async () => {
    const store = memoryStore();
    const upfront = job({ status: "pending", settlingSince: longAgo });
    await claimAll(store, [upfront]);
    expect(await store.update(upfront.jobId, "pending", { status: "queued" })).not.toHaveProperty("settlingSince");
    await store.lease("svc", 1, "worker", 600);
    await sweep(store, options);
    expect(await store.get(upfront.jobId)).toMatchObject({ status: "running" });
  });

  it("fails on-success jobs whose payment expired before settlement started, uncharged [S2]", async () => {
    const store = memoryStore();
    const queued = job({ charge: "on-success", status: "queued" });
    const running = job({ charge: "on-success", status: "running" });
    const upfront = job({ status: "queued" });
    await claimAll(store, [queued, running, upfront]);
    await sweep(store, options);

    for (const each of [queued, running]) expect(await store.get(each.jobId)).toMatchObject({ status: "failed", error: { code: "timeout" } });
    // A paid upfront job keeps its place, however long it waits.
    expect(await store.get(upfront.jobId)).toMatchObject({ status: "queued" });
  });
});

describe("startup", () => {
  it("answers 503 before payment while the facilitator check fails, and recovers", async () => {
    const facilitator = { ...fakeFacilitator(), supported: vi.fn(async () => ({ kinds: [] as { x402Version: number; scheme: string; network: string }[] })) };
    const { provider, createJob, payment } = testProvider([quick], { facilitator });
    await expect(provider.ready()).rejects.toThrow(/does not support/);
    const response = await createJob("quick", {}, { "PAYMENT-SIGNATURE": await payment("quick") });
    expect(response.status).toBe(503);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
});
