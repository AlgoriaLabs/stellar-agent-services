import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobError } from "@stellar-agent-services/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { memoryStore, sqliteStore, type JobStore, type StoredJob } from "../src/index.js";

// The JobStore contract (src/jobs/store.ts). Every store must pass it, including one a provider
// writes for its own database.

const directory = mkdtempSync(join(tmpdir(), "provider-kit-store-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let files = 0;
const stores: [string, () => JobStore][] = [
  ["memoryStore", () => memoryStore()],
  ["sqliteStore", () => sqliteStore(join(directory, `jobs-${++files}.sqlite`))],
];

let ids = 0;
function job(overrides: Partial<StoredJob> = {}): StoredJob {
  const n = ++ids;
  const now = new Date().toISOString();
  return {
    jobId: `0192d3a4-7c1e-7b2a-9f00-${n.toString().padStart(12, "0")}`,
    service: "svc",
    charge: "upfront",
    bindingHash: `binding-${n}`,
    tokenHash: `token-${n}`,
    status: "queued",
    claim: { fingerprint: `payment-${n}`, payer: "GPAYER", nonce: String(n), expirationLedger: 100 },
    input: { n },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe.each(stores)("%s", (_name, open) => {
  it("claims a job once, and binds the id to one request and the payment to one job [J4]–[J6], [P9]", async () => {
    const store = open();
    const first = job();
    expect(await store.claim(first)).toMatchObject({ outcome: "created", job: { jobId: first.jobId } });
    expect(await store.claim(first)).toMatchObject({ outcome: "existing", job: { jobId: first.jobId } });
    expect(await store.claim({ ...first, bindingHash: "other" })).toEqual({ outcome: "conflict" });
    expect(await store.claim({ ...first, tokenHash: "other" })).toEqual({ outcome: "conflict" });
    expect(await store.claim(job({ claim: first.claim }))).toEqual({ outcome: "payment_used" });
    expect((await store.get(first.jobId))?.input).toEqual(first.input);
    expect(await store.get("0192d3a4-7c1e-7b2a-9f00-ffffffffffff")).toBeUndefined();
  });

  it("updates only from the expected status, and never out of a final one [J12]", async () => {
    const store = open();
    const claimed = job({ status: "pending" });
    await store.claim(claimed);
    expect(await store.update(claimed.jobId, "queued", { status: "running" })).toBeUndefined();
    expect(await store.update(claimed.jobId, "pending", { status: "queued" })).toMatchObject({ status: "queued" });

    await store.update(claimed.jobId, "queued", { status: "running" });
    const done = await store.update(claimed.jobId, "running", { status: "succeeded", output: { ok: true } });
    expect(done).toMatchObject({ status: "succeeded", output: { ok: true } });
    // A final job keeps its output but not its input [dataUse.storesInputs].
    expect(done?.input).toBeUndefined();
    expect(done?.finishedAt).toBeDefined();
    for (const from of ["queued", "running", "succeeded"] as const) {
      expect(await store.update(claimed.jobId, from, { status: "failed" })).toBeUndefined();
    }
  });

  it("drops a failed job's output", async () => {
    const store = open();
    const claimed = job({ status: "running", charge: "on-success" });
    await store.claim(claimed);
    await store.update(claimed.jobId, "running", { status: "running", output: { draft: true }, settlingSince: new Date().toISOString() });
    const failed = await store.update(claimed.jobId, "running", { status: "failed", error: jobError("payment_failed") });
    expect(failed?.output).toBeUndefined();
    expect(failed?.settlingSince).toBeUndefined();
  });

  it("counts a service's load and keeps queue order and positions", async () => {
    const store = open();
    const jobs = [job(), job(), job(), job({ status: "pending" }), job({ service: "other" })];
    for (const each of jobs) await store.claim(each);
    expect(await store.load("svc")).toEqual({ pending: 1, queued: 3, running: 0 });
    expect(await Promise.all(jobs.map((each) => store.position(each.jobId)))).toEqual([1, 2, 3, undefined, 1]);

    // The pending job queues behind the others once it is settled.
    await store.update(jobs[3]!.jobId, "pending", { status: "queued" });
    expect(await store.position(jobs[3]!.jobId)).toBe(4);
  });

  it("starts a queued job only when its turn has come", async () => {
    const store = open();
    const [a, b, c] = [job({ charge: "on-success" }), job({ charge: "on-success" }), job({ charge: "on-success" })];
    for (const each of [a, b, c]) await store.claim(each!);
    // b is behind a: with one slot, only a may start.
    expect(await store.start(b!.jobId, 1)).toBeUndefined();
    expect(await store.start(a!.jobId, 1)).toMatchObject({ status: "running" });
    expect(await store.start(b!.jobId, 1)).toBeUndefined();
    expect(await store.start(b!.jobId, 2)).toMatchObject({ status: "running" });
    expect(await store.load("svc")).toEqual({ pending: 0, queued: 1, running: 2 });
    expect(await store.position(c!.jobId)).toBe(1);
  });

  it("leases upfront jobs in order up to the concurrency, and hands a dead worker's job to another", async () => {
    const store = open();
    const [a, b] = [job(), job()];
    await store.claim(a!);
    await store.claim(b!);

    const leased = await store.lease("svc", 1, "worker-1", 30);
    expect(leased).toMatchObject({ jobId: a!.jobId, status: "running", attempts: 1, lease: { owner: "worker-1" } });
    expect(await store.lease("svc", 1, "worker-2", 30)).toBeUndefined();
    expect(await store.renew(a!.jobId, "worker-1", 30)).toBe(true);
    expect(await store.renew(a!.jobId, "worker-2", 30)).toBe(false);

    // worker-1 stops renewing: once its lease runs out, worker-2 takes the same job over.
    await store.renew(a!.jobId, "worker-1", -1);
    expect(await store.lease("svc", 1, "worker-2", 30)).toMatchObject({ jobId: a!.jobId, attempts: 2, lease: { owner: "worker-2" } });
    // The old worker can no longer finish it.
    expect(await store.update(a!.jobId, "running", { status: "succeeded", output: {} }, "worker-1")).toBeUndefined();
    expect(await store.update(a!.jobId, "running", { status: "succeeded", output: {} }, "worker-2")).toMatchObject({ status: "succeeded" });

    expect(await store.lease("svc", 1, "worker-2", 30)).toMatchObject({ jobId: b!.jobId });
  });

  it("does not lease on-success jobs, which only their own process can settle", async () => {
    const store = open();
    await store.claim(job({ charge: "on-success" }));
    expect(await store.lease("svc", 4, "worker", 30)).toBeUndefined();
  });

  it("lists jobs for the recovery sweeps, oldest first", async () => {
    const store = open();
    const old = job({ status: "pending", createdAt: "2026-01-01T00:00:00.000Z" });
    const older = job({ status: "pending", createdAt: "2025-01-01T00:00:00.000Z" });
    const recent = job({ status: "pending" });
    for (const each of [old, older, recent]) await store.claim(each);
    const listed = await store.list({ statuses: ["pending"], createdBefore: "2026-06-01T00:00:00.000Z", limit: 10 });
    expect(listed.map((each) => each.jobId)).toEqual([older.jobId, old.jobId]);
  });

  it("deletes final jobs after retention, with their payment fingerprints", async () => {
    const store = open();
    const done = job({ status: "running" });
    const waiting = job();
    await store.claim(done);
    await store.claim(waiting);
    await store.update(done.jobId, "running", { status: "succeeded", output: {}, finishedAt: "2026-01-01T00:00:00.000Z" });

    expect(await store.deleteFinishedBefore("2026-01-02T00:00:00.000Z")).toBe(1);
    expect(await store.get(done.jobId)).toBeUndefined();
    expect(await store.get(waiting.jobId)).toBeDefined();
    // The signed payment expired long before retention ends, so its fingerprint can go too.
    expect((await store.claim(job({ claim: done.claim }))).outcome).toBe("created");
  });
});

describe("sqliteStore", () => {
  it("keeps jobs, payments and queue order across a restart", async () => {
    const path = join(directory, "restart.sqlite");
    const before = sqliteStore(path);
    const [a, b] = [job(), job()];
    await before.claim(a!);
    await before.claim(b!);
    await before.close?.();

    const after = sqliteStore(path);
    expect(await after.get(a!.jobId)).toMatchObject({ status: "queued", input: a!.input });
    expect(await after.position(b!.jobId)).toBe(2);
    expect(await after.claim(job({ claim: a!.claim }))).toEqual({ outcome: "payment_used" });
    await after.close?.();
  });

  it("shares one queue between processes: two connections never lease the same job", async () => {
    const path = join(directory, "shared.sqlite");
    const [one, two] = [sqliteStore(path), sqliteStore(path)];
    for (let i = 0; i < 4; i++) await one.claim(job());
    const leased = await Promise.all([
      one.lease("svc", 3, "one", 30),
      two.lease("svc", 3, "two", 30),
      one.lease("svc", 3, "one", 30),
      two.lease("svc", 3, "two", 30),
    ]);
    const jobIds = leased.flatMap((each) => each?.jobId ?? []);
    expect(jobIds).toHaveLength(3);
    expect(new Set(jobIds).size).toBe(3);
    await one.close?.();
    await two.close?.();
  });
});
