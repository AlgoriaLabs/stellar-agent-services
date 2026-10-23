// In-memory JobStore for tests and local development. It is not durable: jobs, queued ones included,
// are lost on restart, so a provider using it can't recover jobs beyond the process lifetime. Use
// sqliteStore() for anything users pay for.
//
// No method awaits inside, so each check-and-write is atomic on the event loop.

import { applyPatch, FINAL_STATUSES, type ClaimResult, type JobStore, type StoredJob } from "./store.js";

export function memoryStore(): JobStore {
  const jobs = new Map<string, StoredJob>();
  const payments = new Map<string, string>();
  let queueSeq = 0;

  const copy = (job: StoredJob | undefined) => job && structuredClone(job);
  const ofService = (service: string) => [...jobs.values()].filter((job) => job.service === service);
  const enqueue = (job: StoredJob) => {
    job.queueSeq = ++queueSeq;
  };
  const toRunning = (job: StoredJob, lease?: StoredJob["lease"]) => {
    applyPatch(job, { status: "running" }, new Date());
    if (lease !== undefined) {
      job.lease = lease;
      job.attempts = (job.attempts ?? 0) + 1;
    }
    return copy(job);
  };

  return {
    async get(jobId) {
      return copy(jobs.get(jobId));
    },

    async claim(job): Promise<ClaimResult> {
      const existing = jobs.get(job.jobId);
      if (existing !== undefined) {
        const same = existing.bindingHash === job.bindingHash && existing.tokenHash === job.tokenHash;
        return same ? { outcome: "existing", job: copy(existing)! } : { outcome: "conflict" };
      }
      if (payments.has(job.claim.fingerprint)) return { outcome: "payment_used" };
      const stored = structuredClone(job);
      if (stored.status === "queued") enqueue(stored);
      payments.set(job.claim.fingerprint, job.jobId);
      jobs.set(job.jobId, stored);
      return { outcome: "created", job: copy(stored)! };
    },

    async update(jobId, from, patch, owner) {
      const job = jobs.get(jobId);
      if (job === undefined || job.status !== from || FINAL_STATUSES.includes(job.status)) return undefined;
      if (owner !== undefined && job.lease?.owner !== owner) return undefined;
      applyPatch(job, patch, new Date());
      if (patch.status === "queued" && from !== "queued") enqueue(job);
      return copy(job);
    },

    async load(service) {
      const load = { pending: 0, queued: 0, running: 0 };
      for (const job of ofService(service)) {
        if (job.status === "pending" || job.status === "queued" || job.status === "running") load[job.status]++;
      }
      return load;
    },

    async position(jobId) {
      const job = jobs.get(jobId);
      if (job?.status !== "queued") return undefined;
      return ofService(job.service).filter((other) => other.status === "queued" && other.queueSeq! < job.queueSeq!).length + 1;
    },

    async start(jobId, concurrency) {
      const job = jobs.get(jobId);
      if (job?.status !== "queued") return undefined;
      const others = ofService(job.service);
      const running = others.filter((other) => other.status === "running").length;
      const ahead = others.filter((other) => other.status === "queued" && other.queueSeq! < job.queueSeq!).length;
      return running + ahead < concurrency ? toRunning(job) : undefined;
    },

    async lease(service, concurrency, owner, leaseSeconds) {
      const now = Date.now();
      const lease = { owner, expiresAt: now + leaseSeconds * 1000 };
      const upfront = ofService(service)
        .filter((job) => job.charge === "upfront")
        .sort((a, b) => a.queueSeq! - b.queueSeq!);
      const orphan = upfront.find((job) => job.status === "running" && job.lease !== undefined && job.lease.expiresAt < now && job.lease.owner !== owner);
      if (orphan !== undefined) {
        orphan.lease = lease;
        orphan.attempts = (orphan.attempts ?? 0) + 1;
        orphan.updatedAt = new Date(now).toISOString();
        return copy(orphan);
      }
      const running = ofService(service).filter((job) => job.status === "running").length;
      const next = upfront.find((job) => job.status === "queued");
      return next !== undefined && running < concurrency ? toRunning(next, lease) : undefined;
    },

    async renew(jobId, owner, leaseSeconds) {
      const job = jobs.get(jobId);
      if (job?.status !== "running" || job.lease?.owner !== owner) return false;
      job.lease.expiresAt = Date.now() + leaseSeconds * 1000;
      return true;
    },

    async list({ statuses, createdBefore, limit }) {
      return [...jobs.values()]
        .filter((job) => statuses.includes(job.status) && job.createdAt < createdBefore)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map((job) => copy(job)!);
    },

    async deleteFinishedBefore(before) {
      let deleted = 0;
      for (const [jobId, job] of jobs) {
        if (FINAL_STATUSES.includes(job.status) && job.finishedAt !== undefined && job.finishedAt < before) {
          jobs.delete(jobId);
          payments.delete(job.claim.fingerprint);
          deleted++;
        }
      }
      return deleted;
    },
  };
}
