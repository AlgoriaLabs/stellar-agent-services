// Durable JobStore on the built-in node:sqlite (Node >= 22.13, no native dependency).
//
// One file holds jobs and payment fingerprints. Several processes on one machine may share it (an
// HTTP server and separate workers, say): every check-and-write runs in a BEGIN IMMEDIATE
// transaction, which SQLite serializes across processes, and WAL mode lets readers proceed meanwhile.
// Commits are fsynced (synchronous = FULL): a paid job is on disk before the client hears about it.
//
// Each job is one row: the columns the queue and sweeps query, plus the whole StoredJob as JSON.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { applyPatch, FINAL_STATUSES, type ClaimResult, type JobStore, type StoredJob } from "./store.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    charge TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    queue_seq INTEGER,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    data TEXT NOT NULL
  ) STRICT;
  CREATE INDEX jobs_queue ON jobs (service, status, queue_seq);
  CREATE INDEX jobs_sweep ON jobs (status, created_at);
  CREATE INDEX jobs_finished ON jobs (finished_at) WHERE finished_at IS NOT NULL;
  CREATE TABLE payments (
    fingerprint TEXT PRIMARY KEY,
    job_id TEXT NOT NULL
  ) STRICT;
`;

export interface SqliteStoreOptions {
  /** How long a write waits for another process's transaction, in ms. Default 5000. */
  busyTimeoutMs?: number;
}

/** A JobStore in the SQLite file at `path` (created if missing). ":memory:" is a private, non-durable one. */
export function sqliteStore(path: string, options: SqliteStoreOptions = {}): JobStore {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  migrate(db);

  const statement = (sql: string) => {
    const prepared = db.prepare(sql);
    return {
      get: (...params: SQLInputValue[]) => prepared.get(...params) as Record<string, SQLInputValue> | undefined,
      all: (...params: SQLInputValue[]) => prepared.all(...params) as Record<string, SQLInputValue>[],
      run: (...params: SQLInputValue[]) => prepared.run(...params),
    };
  };
  const sql = {
    get: statement("SELECT data FROM jobs WHERE job_id = ?"),
    insert: statement(
      `INSERT INTO jobs (job_id, service, charge, status, created_at, finished_at, queue_seq, lease_owner, lease_expires_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    write: statement("UPDATE jobs SET status = ?, finished_at = ?, queue_seq = ?, lease_owner = ?, lease_expires_at = ?, data = ? WHERE job_id = ?"),
    paymentUsed: statement("SELECT 1 FROM payments WHERE fingerprint = ?"),
    reservePayment: statement("INSERT INTO payments (fingerprint, job_id) VALUES (?, ?)"),
    nextSeq: statement("SELECT COALESCE(MAX(queue_seq), 0) + 1 AS seq FROM jobs"),
    load: statement("SELECT status, COUNT(*) AS n FROM jobs WHERE service = ? AND status IN ('pending', 'queued', 'running') GROUP BY status"),
    running: statement("SELECT COUNT(*) AS n FROM jobs WHERE service = ? AND status = 'running'"),
    ahead: statement("SELECT COUNT(*) AS n FROM jobs WHERE service = ? AND status = 'queued' AND queue_seq < ?"),
    orphan: statement(
      `SELECT data FROM jobs WHERE service = ? AND charge = 'upfront' AND status = 'running' AND lease_expires_at < ? AND lease_owner != ?
       ORDER BY queue_seq LIMIT 1`,
    ),
    nextQueued: statement("SELECT data FROM jobs WHERE service = ? AND charge = 'upfront' AND status = 'queued' ORDER BY queue_seq LIMIT 1"),
    list: (count: number) =>
      statement(`SELECT data FROM jobs WHERE status IN (${Array(count).fill("?").join(", ")}) AND created_at < ? ORDER BY created_at LIMIT ?`),
    expired: statement("SELECT job_id, data FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ? AND status IN ('succeeded', 'failed')"),
    deleteJob: statement("DELETE FROM jobs WHERE job_id = ?"),
    deletePayment: statement("DELETE FROM payments WHERE fingerprint = ?"),
  };

  const read = (row: Record<string, SQLInputValue> | undefined): StoredJob | undefined =>
    row === undefined ? undefined : (JSON.parse(String(row["data"])) as StoredJob);
  const columns = (job: StoredJob): SQLInputValue[] => [
    job.status,
    job.finishedAt ?? null,
    job.queueSeq ?? null,
    job.lease?.owner ?? null,
    job.lease?.expiresAt ?? null,
    JSON.stringify(job),
  ];
  const write = (job: StoredJob) => {
    sql.write.run(...columns(job), job.jobId);
    return job;
  };
  const enqueue = (job: StoredJob) => {
    job.queueSeq = Number(sql.nextSeq.get()!["seq"]);
  };
  const count = (row: Record<string, SQLInputValue> | undefined) => Number(row?.["n"] ?? 0);

  /** Runs fn in a write transaction, so a check and the write after it are atomic across processes. */
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    async get(jobId) {
      return read(sql.get.get(jobId));
    },

    async claim(job) {
      return transaction((): ClaimResult => {
        const existing = read(sql.get.get(job.jobId));
        if (existing !== undefined) {
          const same = existing.bindingHash === job.bindingHash && existing.tokenHash === job.tokenHash;
          return same ? { outcome: "existing", job: existing } : { outcome: "conflict" };
        }
        if (sql.paymentUsed.get(job.claim.fingerprint) !== undefined) return { outcome: "payment_used" };
        const stored = structuredClone(job);
        if (stored.status === "queued") enqueue(stored);
        sql.reservePayment.run(job.claim.fingerprint, job.jobId);
        const [status, ...rest] = columns(stored);
        sql.insert.run(stored.jobId, stored.service, stored.charge, status!, stored.createdAt, ...rest);
        return { outcome: "created", job: stored };
      });
    },

    async update(jobId, from, patch, owner) {
      return transaction(() => {
        const job = read(sql.get.get(jobId));
        if (job === undefined || job.status !== from || FINAL_STATUSES.includes(job.status)) return undefined;
        if (owner !== undefined && job.lease?.owner !== owner) return undefined;
        applyPatch(job, patch, new Date());
        if (patch.status === "queued" && from !== "queued") enqueue(job);
        return write(job);
      });
    },

    async load(service) {
      const load = { pending: 0, queued: 0, running: 0 };
      for (const row of sql.load.all(service)) load[row["status"] as keyof typeof load] = Number(row["n"]);
      return load;
    },

    async position(jobId) {
      const job = read(sql.get.get(jobId));
      if (job?.status !== "queued") return undefined;
      return count(sql.ahead.get(job.service, job.queueSeq!)) + 1;
    },

    async start(jobId, concurrency) {
      return transaction(() => {
        const job = read(sql.get.get(jobId));
        if (job?.status !== "queued") return undefined;
        const busy = count(sql.running.get(job.service)) + count(sql.ahead.get(job.service, job.queueSeq!));
        return busy < concurrency ? write(applyPatch(job, { status: "running" }, new Date())) : undefined;
      });
    },

    async lease(service, concurrency, owner, leaseSeconds) {
      return transaction(() => {
        const now = Date.now();
        const lease = { owner, expiresAt: now + leaseSeconds * 1000 };
        const orphan = read(sql.orphan.get(service, now, owner));
        if (orphan !== undefined) {
          orphan.lease = lease;
          orphan.attempts = (orphan.attempts ?? 0) + 1;
          orphan.updatedAt = new Date(now).toISOString();
          return write(orphan);
        }
        if (count(sql.running.get(service)) >= concurrency) return undefined;
        const next = read(sql.nextQueued.get(service));
        if (next === undefined) return undefined;
        applyPatch(next, { status: "running" }, new Date(now));
        next.lease = lease;
        next.attempts = (next.attempts ?? 0) + 1;
        return write(next);
      });
    },

    async renew(jobId, owner, leaseSeconds) {
      return transaction(() => {
        const job = read(sql.get.get(jobId));
        if (job?.status !== "running" || job.lease?.owner !== owner) return false;
        job.lease.expiresAt = Date.now() + leaseSeconds * 1000;
        write(job);
        return true;
      });
    },

    async list({ statuses, createdBefore, limit }) {
      if (statuses.length === 0) return [];
      return sql
        .list(statuses.length)
        .all(...statuses, createdBefore, limit)
        .map((row) => read(row)!);
    },

    async deleteFinishedBefore(before) {
      return transaction(() => {
        const rows = sql.expired.all(before);
        for (const row of rows) {
          const job = read(row)!;
          if (!FINAL_STATUSES.includes(job.status)) continue;
          sql.deleteJob.run(job.jobId);
          sql.deletePayment.run(job.claim.fingerprint);
        }
        return rows.length;
      });
    },

    close() {
      db.close();
    },
  };
}

function migrate(db: DatabaseSync): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) throw new Error(`the job database has schema version ${version}; this provider-kit knows ${SCHEMA_VERSION}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have migrated while this one waited for the lock.
    const now = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (now === 0) db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
