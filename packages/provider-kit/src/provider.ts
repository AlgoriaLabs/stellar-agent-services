// createProvider(): wires services, payments, the job store and the HTTP routes into one Fetch-API handler.
//
// Returns { fetch(request) } for Hono, Node, Workers, Deno or Bun. The provider holds no Stellar
// secret key: it knows its payTo address, and the facilitator verifies and settles.
//
// Each service gets a lane with its capacity (jobs/scheduler.ts), and create-job can have a per-caller
// rate limit (http/rate-limit.ts): docs/provider-standard.md §5.8.
//
// TODO:
// - Startup check that facilitator getSupported() includes the network with scheme "exact".
// - Validate the built manifest with the JSON Schema and checkManifestRules().

import {
  DEFAULT_MANIFEST_PATH,
  stellarAddressKind,
  type ProviderInfo,
  type ProviderManifest,
  type StellarNetwork,
} from "@stellar-agent-services/protocol";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { Service } from "./define-service.js";
import { rateLimiter, type RateLimitConfig } from "./http/rate-limit.js";
import { MAX_HOLD_SECONDS, route } from "./http/router.js";
import { memoryStore } from "./jobs/memory-store.js";
import { laneFor, localScheduler } from "./jobs/scheduler.js";
import type { JobStore } from "./jobs/store.js";
import { buildManifest } from "./manifest.js";
import type { Facilitator } from "./payments/settlement.js";

export interface ProviderConfig {
  /** Public HTTPS URL that job paths are relative to. http://localhost only with `dev`. */
  baseUrl: string;
  network: StellarNetwork;
  /** The address that receives payments. Public, never a secret key. */
  payTo: string;
  provider: ProviderInfo;
  services: Service[];
  /** A facilitator URL, or a client (tests). */
  facilitator: string | Facilitator;
  /** Default: memoryStore(), which loses jobs on restart. */
  store?: JobStore;
  maxTimeoutSeconds?: number;
  retentionSeconds?: number;
  /** Default /.well-known/stellar-agent-services.json on the baseUrl origin. */
  manifestPath?: string;
  /** How long create-job waits before answering 202. Default and maximum 30 [J9]. */
  holdSeconds?: number;
  /** Per-caller limit on create-job requests (429). Default: none. Capacity is set per service. */
  rateLimit?: RateLimitConfig;
  /** Allows an http://localhost baseUrl for local development [M6]. */
  dev?: boolean;
  /** Test-only response-loss drill (docs/job-recovery.md). Never enable in production. */
  loseCreateJobResponse?: boolean;
}

export interface Provider {
  manifest: ProviderManifest;
  manifestUrl: string;
  fetch(request: Request): Promise<Response>;
}

export function createProvider(config: ProviderConfig): Provider {
  const baseUrl = new URL(config.baseUrl);
  const local = baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(config.dev && local)) {
    throw new TypeError("baseUrl must be https:// (http://localhost is allowed with dev: true)");
  }
  if (stellarAddressKind(config.payTo) === undefined) throw new TypeError("payTo must be a valid G... or C... address");
  const holdSeconds = config.holdSeconds ?? MAX_HOLD_SECONDS;
  if (holdSeconds < 0 || holdSeconds > MAX_HOLD_SECONDS) throw new RangeError(`holdSeconds must be 0–${MAX_HOLD_SECONDS}`);

  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 60;
  for (const service of config.services) {
    // The signed payment expires about maxTimeoutSeconds after signing, so on-success work must
    // finish well inside it [S2].
    if (service.charge === "on-success" && service.expectedDurationSeconds! > maxTimeoutSeconds / 2) {
      throw new RangeError(`service "${service.name}": on-success work must take at most half of maxTimeoutSeconds [S2]; use charge "upfront"`);
    }
  }

  const manifest = buildManifest(config, config.services);
  const manifestPath = config.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const facilitator =
    typeof config.facilitator === "string" ? new HTTPFacilitatorClient({ url: config.facilitator }) : config.facilitator;
  const context = {
    manifest,
    manifestPath,
    services: new Map(config.services.map((service) => [service.name, service])),
    store: config.store ?? memoryStore(),
    facilitator,
    scheduler: localScheduler(config.services.map((service) => laneFor(service, maxTimeoutSeconds))),
    rateLimit: config.rateLimit === undefined ? undefined : rateLimiter(config.rateLimit),
    holdSeconds,
    loseCreateJobResponse: config.loseCreateJobResponse ?? false,
  };

  return {
    manifest,
    manifestUrl: new URL(manifestPath, baseUrl.origin).toString(),
    fetch: (request) => route(request, context),
  };
}
