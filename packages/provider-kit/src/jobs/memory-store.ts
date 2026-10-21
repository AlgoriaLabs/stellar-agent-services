// In-memory JobStore for tests and local development. It is not durable, and the manifest must not
// advertise recovery beyond the process lifetime when this store is used.

import type { ClaimResult, JobStore, StoredJob, StoredStatus } from "./store.js";

export function memoryStore(): JobStore {
  const jobs = new Map<string, StoredJob>();
  const payments = new Set<string>();

  return {
    async get(jobId) {
      const job = jobs.get(jobId);
      return job && structuredClone(job);
    },

    // No await inside, so the check and the insert are atomic on the event loop.
    async claim(job, paymentFingerprint): Promise<ClaimResult> {
      const existing = jobs.get(job.jobId);
      if (existing !== undefined) {
        const same = existing.bindingHash === job.bindingHash && existing.tokenHash === job.tokenHash;
        return same ? { outcome: "existing", job: structuredClone(existing) } : { outcome: "conflict" };
      }
      if (payments.has(paymentFingerprint)) return { outcome: "payment_used" };
      payments.add(paymentFingerprint);
      jobs.set(job.jobId, structuredClone(job));
      return { outcome: "created", job: structuredClone(job) };
    },

    async update(jobId, from: StoredStatus, patch) {
      const job = jobs.get(jobId);
      if (job === undefined || job.status !== from) return undefined;
      Object.assign(job, structuredClone(patch), { updatedAt: new Date().toISOString() });
      return structuredClone(job);
    },
  };
}
