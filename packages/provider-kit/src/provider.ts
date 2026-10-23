// createProvider(): wires services, payments, the job store, the queue and the HTTP routes into one
// Fetch-API handler.
//
// Returns { fetch(request) } for Hono, Node, Workers, Deno or Bun. The provider holds no Stellar
// secret key: it knows its payTo address, and the facilitator verifies and settles.
//
// Startup, in order:
// 1. createProvider() checks the config and the manifest it builds, and throws on any problem a client
//    or verifier would reject (§2.4), so a broken provider never takes a payment.
// 2. ready() checks that the facilitator settles this network with sponsored fees, runs the recovery
//    sweep for jobs a restart left behind, and starts the queue's workers. create-job awaits it, and
//    answers 503 (nothing charged) until it has succeeded; it is retried after a failure.
// Each service gets a lane with its capacity (jobs/scheduler.ts), and create-job can have a per-caller
// rate limit (http/rate-limit.ts): docs/provider-standard.md §5.8.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { DEFAULT_MANIFEST_PATH, DEFAULT_RETENTION_SECONDS, stellarAddressKind, type ProviderInfo, type ProviderManifest, type StellarNetwork } from "@stellar-agent-services/protocol";
import type { Service } from "./define-service.js";
import { rateLimiter, type RateLimitConfig } from "./http/rate-limit.js";
import { MAX_HOLD_SECONDS, route } from "./http/router.js";
import { memoryStore } from "./jobs/memory-store.js";
import { strandedJobs, sweep } from "./jobs/recovery.js";
import { runLeased } from "./jobs/runner.js";
import { laneFor, scheduler } from "./jobs/scheduler.js";
import type { JobStore } from "./jobs/store.js";
import { buildManifest, checkManifest, DEFAULT_MAX_TIMEOUT_SECONDS } from "./manifest.js";
import { checkFacilitator, httpFacilitator, settleTimeoutSeconds, type Facilitator } from "./payments/facilitator.js";

export interface ProviderConfig {
  /** Public HTTPS URL that job paths are relative to. http://localhost only with `dev`. */
  baseUrl: string;
  network: StellarNetwork;
  /** The address that receives payments. Public, never a secret key. */
  payTo: string;
  provider: ProviderInfo;
  services: Service[];
  /** A facilitator URL, or a client: httpFacilitator(url, options) for API-key headers, a fake in tests. */
  facilitator: string | Facilitator;
  /** Default: memoryStore(), which loses jobs on restart. Use sqliteStore(path) in production. */
  store?: JobStore;
  /** How long a signed payment is valid, 30–300 (§4.1). Default 60. */
  maxTimeoutSeconds?: number;
  /**
   * How long a settlement may take before the job is payment_uncertain. Default maxTimeoutSeconds + 30,
   * since the facilitator waits for the transaction's ledger. A later answer is still recorded.
   */
  settleTimeoutSeconds?: number;
  /** How long finished jobs stay retrievable [J15]. At least 3600; default 86400. */
  retentionSeconds?: number;
  /** Default /.well-known/stellar-agent-services.json on the baseUrl origin. */
  manifestPath?: string;
  /** How long create-job waits before answering 202. Default and maximum 30 [J9]. */
  holdSeconds?: number;
  /** Per-caller limit on create-job requests (429). Default: none. Capacity is set per service. */
  rateLimit?: RateLimitConfig;
  /**
   * Whether this process runs queued upfront jobs. Default true. Set false on HTTP-only instances when
   * separate worker processes, with the same services and store, run them.
   */
  runQueuedJobs?: boolean;
  /** How long a worker's claim on a running upfront job lasts without renewal. Default 30. */
  leaseSeconds?: number;
  /** Allows an http://localhost baseUrl and facilitator for local development [M6]. */
  dev?: boolean;
  /** Test-only response-loss drill (docs/job-recovery.md). Never enable in production. */
  loseCreateJobResponse?: boolean;
}

export interface Provider {
  manifest: ProviderManifest;
  manifestUrl: string;
  fetch(request: Request): Promise<Response>;
  /** Startup checks, recovery and workers. Call it before serving; it throws if payments can't work. */
  ready(): Promise<void>;
  /** Stops the workers and timers and closes the store. Jobs in progress are resumed by the next start. */
  close(): Promise<void>;
}

const QUEUE_POLL_MS = 1000;
const SWEEP_INTERVAL_MS = 30_000;
const READY_RETRY_MS = 10_000;

export function createProvider(config: ProviderConfig): Provider {
  const baseUrl = new URL(config.baseUrl);
  const local = baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(config.dev && local)) {
    throw new TypeError("baseUrl must be https:// (http://localhost is allowed with dev: true)");
  }
  if (stellarAddressKind(config.payTo) === undefined) throw new TypeError("payTo must be a valid G... or C... address");
  const holdSeconds = config.holdSeconds ?? MAX_HOLD_SECONDS;
  if (holdSeconds < 0 || holdSeconds > MAX_HOLD_SECONDS) throw new RangeError(`holdSeconds must be 0–${MAX_HOLD_SECONDS}`);
  const leaseSeconds = config.leaseSeconds ?? 30;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 3) throw new RangeError("leaseSeconds must be a whole number of at least 3");

  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  const settleSeconds = config.settleTimeoutSeconds ?? settleTimeoutSeconds(maxTimeoutSeconds);
  if (!Number.isInteger(settleSeconds) || settleSeconds < 1) throw new RangeError("settleTimeoutSeconds must be a whole number of at least 1");
  const names = new Set<string>();
  for (const service of config.services) {
    if (names.has(service.name)) throw new TypeError(`two services are named "${service.name}" [M7]`);
    names.add(service.name);
    // The signed payment expires about maxTimeoutSeconds after signing, so on-success work must
    // finish well inside it [S2].
    if (service.charge === "on-success" && service.expectedDurationSeconds! > maxTimeoutSeconds / 2) {
      throw new RangeError(`service "${service.name}": on-success work must take at most half of maxTimeoutSeconds [S2]; use charge "upfront"`);
    }
  }

  const manifest = buildManifest(config, config.services);
  const manifestPath = config.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const manifestUrl = new URL(manifestPath, baseUrl.origin).toString();
  const violations = checkManifest(manifest, manifestUrl, config.dev);
  if (violations.length > 0) {
    const list = violations.map((violation) => `  [${violation.rule}] ${violation.pointer || "/"}: ${violation.message}`).join("\n");
    throw new TypeError(`the manifest would not pass Provider Standard v1 checks:\n${list}`);
  }

  const facilitator =
    typeof config.facilitator === "string"
      ? httpFacilitator(config.facilitator, { dev: config.dev ?? false, settleTimeoutSeconds: settleSeconds })
      : config.facilitator;
  const store = config.store ?? memoryStore();
  const services = new Map(config.services.map((service) => [service.name, service]));
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const queue = scheduler({
    store,
    lanes: config.services.map((service) => laneFor(service, maxTimeoutSeconds)),
    owner,
    leaseSeconds,
    pollMs: QUEUE_POLL_MS,
    ...(config.runQueuedJobs === false ? {} : { work: (job) => runLeased(job, { store, services, scheduler: queue, owner, leaseSeconds }) }),
  });
  const sweepOptions = {
    maxTimeoutSeconds,
    settleTimeoutSeconds: settleSeconds,
    retentionSeconds: config.retentionSeconds ?? DEFAULT_RETENTION_SECONDS,
  };

  let starting: Promise<void> | undefined;
  let sweeps: NodeJS.Timeout | undefined;
  let closed = false;
  const ready = (): Promise<void> => {
    if (closed) return Promise.reject(new Error("the provider is closed"));
    starting ??= (async () => {
      await checkFacilitator(facilitator, config.network);
      await sweep(store, sweepOptions);
      const stranded = await strandedJobs(store, services);
      if (stranded.size > 0) {
        const list = [...stranded].map(([service, count]) => `${count} of "${service}"`).join(", ");
        console.warn(`[provider-kit] paid jobs of services this provider no longer offers wait until they are offered again: ${list}`);
      }
      queue.start();
      sweeps = setInterval(() => {
        sweep(store, sweepOptions).catch((error) => console.error("[provider-kit] the recovery sweep failed:", error));
      }, SWEEP_INTERVAL_MS);
      sweeps.unref();
    })().catch((error) => {
      // Try again on a later request, not on every one.
      setTimeout(() => (starting = undefined), READY_RETRY_MS).unref();
      throw error;
    });
    return starting;
  };

  const context = {
    manifest,
    manifestPath,
    services,
    store,
    facilitator,
    scheduler: queue,
    ready,
    rateLimit: config.rateLimit === undefined ? undefined : rateLimiter(config.rateLimit),
    holdSeconds,
    settleTimeoutMs: settleSeconds * 1000,
    retentionSeconds: sweepOptions.retentionSeconds,
    loseCreateJobResponse: config.loseCreateJobResponse ?? false,
  };

  return {
    manifest,
    manifestUrl,
    fetch: (request) => route(request, context),
    ready,
    async close() {
      closed = true;
      queue.stop();
      clearInterval(sweeps);
      await store.close?.();
    },
  };
}
