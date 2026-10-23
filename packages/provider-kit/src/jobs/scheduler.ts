// Capacity: how many jobs run at once, how many wait, and when to turn a request away
// (docs/provider-standard.md §5.8).
//
// Each service has a lane: `concurrency` jobs run at once and the others wait in queue order. The
// queue itself is in the JobStore (store.ts), so it is shared by every process using the store and is
// as durable as the store. This module drives it from one process:
// - admit(): at step 5 of §5.4, before the 402 and before the payment is verified, so a full lane
//   answers 503 while nothing is signed or charged [Q1], [Q2]. It counts the store's pending, queued
//   and running jobs plus this process's reservations: requests admitted and not yet claimed. The
//   claim runs under the same lane lock (exclusive()), so a request is never counted twice.
// - on-success jobs wait for their turn here (waitForTurn): they have to run in the process that
//   verified their payment, because that process settles it after the work.
// - upfront jobs are paid before they queue, so any process may run them: workers lease them from the
//   store, and a job whose worker died is taken over when the lease runs out [Q4].
// The lane wakes on local events (a job queued or finished) and polls the store for other processes'.
//
// Waits are estimated from the lane's average job duration, seeded with expectedDurationSeconds, times
// the number of rounds ahead. They are hints [Q5]. With several processes, each averages its own jobs.

import type { Charge, QueuePosition } from "@stellar-agent-services/protocol";
import type { Service } from "../define-service.js";
import type { JobStore, StoredJob } from "./store.js";

export interface LaneConfig {
  service: string;
  charge: Charge;
  concurrency: number;
  maxQueued: number;
  /** Longest a new job may expect to wait before it is turned away [Q2]. */
  maxWaitSeconds: number;
  /** Seeds the average job duration until jobs finish. */
  expectedSeconds: number;
}

export type Admission = { accepted: true; reservation: Reservation } | { accepted: false; retryAfterSeconds: number };

/** A place held for a request between admission and its claim. */
export interface Reservation {
  /** Safe to call more than once. */
  release(): void;
}

export interface SchedulerOptions {
  store: JobStore;
  lanes: readonly LaneConfig[];
  /** Runs a leased upfront job to its end. Without it, this process runs no upfront jobs (HTTP only). */
  work?: (job: StoredJob) => Promise<void>;
  /** This process's worker id, written on its leases. */
  owner: string;
  leaseSeconds: number;
  /** How often to look for work other processes queued or left behind. */
  pollMs: number;
}

export interface Scheduler {
  admit(service: string): Promise<Admission>;
  /** Runs fn under the lane's admission lock. The claim runs here, so admission never counts it twice. */
  exclusive<T>(service: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Waits until it is a queued on-success job's turn and starts it (queued → running). Resolves with
   * the running job, or undefined if the turn did not come before `deadline` (epoch ms).
   */
  waitForTurn(job: StoredJob, deadline: number): Promise<StoredJob | undefined>;
  /** Something changed in the lane (a job queued or finished): start whatever can start now. */
  wake(service: string): void;
  /** Resolves the next time a lane wakes or one of this process's jobs finishes: a cue to look again. */
  changed(): Promise<void>;
  /** Where a queued job stands [Q5], or undefined once it is no longer queued. */
  position(job: StoredJob): Promise<QueuePosition | undefined>;
  /** Feeds a finished job's duration into the wait estimates. */
  record(service: string, durationMs: number): void;
  /** Starts the poll that picks up work queued or left behind by other processes. */
  start(): void;
  stop(): void;
}

/** Used when a service sets no expectedDurationSeconds. */
const DEFAULT_EXPECTED_SECONDS = 10;
/** Bounds of the Retry-After a busy lane sends [Q1]. */
const RETRY_AFTER_MIN_SECONDS = 1;
const RETRY_AFTER_MAX_SECONDS = 60;
/** Weight of the newest job in the average duration. */
const AVERAGE_WEIGHT = 0.2;
/** Room left, after an "on-success" job's work, to settle before the signed payment expires [S2]. */
export const SETTLE_MARGIN_SECONDS = 10;

/**
 * The lane for a service. An "on-success" job is settled after its work, before the payment expires
 * [S2], so it may wait only as long as leaves room for the work and the settlement.
 */
export function laneFor(service: Service, maxTimeoutSeconds: number): LaneConfig {
  const { concurrency, maxQueued, maxQueueWaitSeconds } = service.capacity;
  const expectedSeconds = service.expectedDurationSeconds ?? DEFAULT_EXPECTED_SECONDS;
  const maxWaitSeconds =
    service.charge === "on-success"
      ? Math.min(maxQueueWaitSeconds, Math.max(0, maxTimeoutSeconds - SETTLE_MARGIN_SECONDS - expectedSeconds))
      : maxQueueWaitSeconds;
  return { service: service.name, charge: service.charge, concurrency, maxQueued, maxWaitSeconds, expectedSeconds };
}

interface Waiter {
  jobId: string;
  resolve: (job: StoredJob | undefined) => void;
  timer: NodeJS.Timeout;
}

interface Lane extends LaneConfig {
  /** Admitted here, with the payment still being verified and claimed. */
  reserved: number;
  /** This process's on-success jobs waiting for their turn, in queue order. */
  waiters: Waiter[];
  averageMs: number;
  lock: Promise<unknown>;
  pumping: boolean;
  again: boolean;
}

export function scheduler(options: SchedulerOptions): Scheduler {
  const { store, work, owner, leaseSeconds } = options;
  const lanes = new Map<string, Lane>(
    options.lanes.map((config) => [
      config.service,
      { ...config, reserved: 0, waiters: [], averageMs: config.expectedSeconds * 1000, lock: Promise.resolve(), pumping: false, again: false },
    ]),
  );
  let poll: NodeJS.Timeout | undefined;
  let change = deferred();
  const signal = () => {
    change.resolve();
    change = deferred();
  };

  const laneOf = (service: string) => {
    const lane = lanes.get(service);
    if (lane === undefined) throw new Error(`no lane for service "${service}"`);
    return lane;
  };

  /** Seconds until the job at `position` (1 = next) is expected to start. */
  const waitSeconds = (lane: Lane, position: number) => Math.ceil(position / lane.concurrency) * (lane.averageMs / 1000);

  const exclusive = <T>(lane: Lane, fn: () => Promise<T>): Promise<T> => {
    const run = lane.lock.then(fn);
    lane.lock = run.catch(() => undefined);
    return run;
  };

  /** Starts what can start: waiting on-success jobs in order, then upfront jobs for this process's workers. */
  const pump = (lane: Lane) => {
    if (lane.pumping) {
      lane.again = true;
      return;
    }
    lane.pumping = true;
    void (async () => {
      try {
        do {
          lane.again = false;
          while (lane.waiters.length > 0) {
            const waiter = lane.waiters[0]!;
            const started = await store.start(waiter.jobId, lane.concurrency);
            // It timed out while the store answered. Its runner fails the job, from running if it started.
            const index = lane.waiters.indexOf(waiter);
            if (index === -1) continue;
            // FIFO: if the first waiter's turn hasn't come, no later one's has.
            if (started === undefined) break;
            lane.waiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(started);
          }
          if (work !== undefined && lane.charge === "upfront") {
            for (;;) {
              const job = await store.lease(lane.service, lane.concurrency, owner, leaseSeconds);
              if (job === undefined) break;
              void work(job)
                .catch((error) => console.error(`[provider-kit] job ${job.jobId} crashed:`, error))
                .finally(() => {
                  signal();
                  pump(lane);
                });
            }
          }
        } while (lane.again);
      } catch (error) {
        console.error(`[provider-kit] the "${lane.service}" queue could not be read:`, error);
      } finally {
        lane.pumping = false;
      }
    })();
  };

  return {
    admit(service) {
      const lane = laneOf(service);
      return exclusive(lane, async (): Promise<Admission> => {
        const load = await store.load(service);
        const ahead = load.pending + load.queued + load.running + lane.reserved;
        const position = ahead - lane.concurrency + 1;
        if (position > 0) {
          const wait = waitSeconds(lane, position);
          if (position > lane.maxQueued || wait > lane.maxWaitSeconds) {
            // About when enough of the queue has drained for this request to fit.
            const seconds = Math.ceil(Math.max(wait - lane.maxWaitSeconds, lane.averageMs / 1000 / lane.concurrency));
            return { accepted: false, retryAfterSeconds: Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, seconds)) };
          }
        }
        lane.reserved++;
        let held = true;
        return {
          accepted: true,
          reservation: {
            release() {
              if (held) lane.reserved--;
              held = false;
            },
          },
        };
      });
    },

    exclusive: (service, fn) => exclusive(laneOf(service), fn),

    waitForTurn(job, deadline) {
      const lane = laneOf(job.service);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          lane.waiters = lane.waiters.filter((waiter) => waiter.jobId !== job.jobId);
          resolve(undefined);
        }, Math.max(0, deadline - Date.now()));
        timer.unref();
        lane.waiters.push({ jobId: job.jobId, resolve, timer });
        pump(lane);
      });
    },

    wake(service) {
      signal();
      pump(laneOf(service));
    },

    changed: () => change.promise,

    async position(job) {
      // A job of a service this provider no longer offers has no lane, and no estimate.
      const lane = lanes.get(job.service);
      if (lane === undefined) return undefined;
      const position = await store.position(job.jobId);
      if (position === undefined) return undefined;
      return { position, estimatedStartAt: new Date(Date.now() + waitSeconds(lane, position) * 1000).toISOString() };
    },

    record(service, durationMs) {
      const lane = laneOf(service);
      lane.averageMs += AVERAGE_WEIGHT * (durationMs - lane.averageMs);
    },

    start() {
      if (poll !== undefined) return;
      for (const lane of lanes.values()) pump(lane);
      poll = setInterval(() => {
        for (const lane of lanes.values()) if (lane.waiters.length > 0 || (work !== undefined && lane.charge === "upfront")) pump(lane);
      }, options.pollMs);
      poll.unref();
    },

    stop() {
      clearInterval(poll);
      poll = undefined;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
