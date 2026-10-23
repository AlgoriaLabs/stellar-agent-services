// Capacity: how many jobs run at once, how many wait, and when to turn a request away
// (docs/provider-standard.md §5.8).
//
// Each service has a lane: `concurrency` jobs run at once and the others wait in arrival order.
// create-job asks for a place at step 5 of §5.4, before the 402 and before the payment is verified, so
// a full lane answers 503 while nothing is signed or charged [Q1], [Q2]. The reservation holds the
// place while the payment is verified and claimed. run() turns it into a queued job, and release()
// gives it back when the request ends without one.
//
// Waits are estimated from the lane's average job duration, seeded with expectedDurationSeconds, times
// the number of rounds ahead. They are hints [Q5].
//
// In-process: one provider process has one set of lanes. Several processes behind a load balancer each
// enforce their own limits.
// TODO: a shared queue with worker leases, on a durable JobStore, so workers scale apart from the
// HTTP servers and a queued upfront job survives a restart [Q4].

import type { QueuePosition } from "@stellar-agent-services/protocol";
import type { Service } from "../define-service.js";
import { SETTLE_MARGIN_SECONDS } from "./runner.js";

export interface LaneConfig {
  service: string;
  concurrency: number;
  maxQueued: number;
  /** Longest a new job may expect to wait before it is turned away [Q2]. */
  maxWaitSeconds: number;
  /** Seeds the average job duration until jobs finish. */
  expectedSeconds: number;
}

export type Admission = { accepted: true; reservation: Reservation } | { accepted: false; retryAfterSeconds: number };

export interface Reservation {
  /** Queues the job's work and starts it when a slot is free. Resolves with what the work returns. */
  run<T>(jobId: string, work: () => Promise<T>): Promise<T>;
  /** The request did not become a job. Safe to call more than once, and after run(). */
  release(): void;
}

export interface Scheduler {
  admit(service: string): Admission;
  /** Where a waiting job stands [Q5], or undefined once it runs. */
  position(jobId: string): QueuePosition | undefined;
}

/** Used when a service sets no expectedDurationSeconds. */
const DEFAULT_EXPECTED_SECONDS = 10;
/** Bounds of the Retry-After a busy lane sends [Q1]. */
const RETRY_AFTER_MIN_SECONDS = 1;
const RETRY_AFTER_MAX_SECONDS = 60;
/** Weight of the newest job in the average duration. */
const AVERAGE_WEIGHT = 0.2;

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
  return { service: service.name, concurrency, maxQueued, maxWaitSeconds, expectedSeconds };
}

interface Lane extends LaneConfig {
  running: number;
  /** Admitted, with the payment still being verified and claimed. */
  reserved: number;
  waiting: { jobId: string; start: () => void }[];
  averageMs: number;
}

export function localScheduler(configs: readonly LaneConfig[]): Scheduler {
  const lanes = new Map<string, Lane>(
    configs.map((config) => [config.service, { ...config, running: 0, reserved: 0, waiting: [], averageMs: config.expectedSeconds * 1000 }]),
  );
  const waitingIn = new Map<string, Lane>();

  /** Seconds until the job at `position` (1 = next) is expected to start. */
  const waitSeconds = (lane: Lane, position: number) => Math.ceil(position / lane.concurrency) * (lane.averageMs / 1000);

  const startNext = (lane: Lane) => {
    while (lane.running < lane.concurrency && lane.waiting.length > 0) {
      const next = lane.waiting.shift()!;
      waitingIn.delete(next.jobId);
      next.start();
    }
  };

  const reserve = (lane: Lane): Reservation => {
    let held = true;
    const giveBack = () => {
      if (held) lane.reserved--;
      held = false;
    };
    return {
      release: giveBack,
      run<T>(jobId: string, work: () => Promise<T>): Promise<T> {
        giveBack();
        return new Promise<T>((resolve, reject) => {
          const start = () => {
            lane.running++;
            const startedAt = Date.now();
            work()
              .then(resolve, reject)
              .finally(() => {
                lane.running--;
                lane.averageMs += AVERAGE_WEIGHT * (Date.now() - startedAt - lane.averageMs);
                startNext(lane);
              });
          };
          if (lane.running < lane.concurrency && lane.waiting.length === 0) return start();
          lane.waiting.push({ jobId, start });
          waitingIn.set(jobId, lane);
        });
      },
    };
  };

  return {
    admit(service) {
      const lane = lanes.get(service);
      if (lane === undefined) throw new Error(`no lane for service "${service}"`);
      const ahead = lane.running + lane.reserved + lane.waiting.length;
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
      return { accepted: true, reservation: reserve(lane) };
    },

    position(jobId) {
      const lane = waitingIn.get(jobId);
      if (lane === undefined) return undefined;
      const position = lane.waiting.findIndex((entry) => entry.jobId === jobId) + 1;
      return { position, estimatedStartAt: new Date(Date.now() + waitSeconds(lane, position) * 1000).toISOString() };
    },
  };
}
