// Builds the Provider Standard v1 manifest from the provider config, and checks it at startup.
//
// The payment option and every URL come from the same config, so the 402 challenge and the manifest
// can never disagree. createProvider() refuses to start with a manifest that fails the manifest JSON
// Schema [M9] or checkManifestRules() (§2.4): what a client or verifier would reject is caught before
// anyone can pay. The router serves it with Cache-Control max-age=300 [M4].

import {
  checkManifestRules,
  PROVIDER_STANDARD,
  USDC_ASSET,
  type JsonObject,
  type JsonValue,
  type ProviderManifest,
  type RuleViolation,
  type ServiceDescriptor,
} from "@stellar-agent-services/protocol";
import schema from "@stellar-agent-services/protocol/manifest.schema.json" with { type: "json" };
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Service } from "./define-service.js";
import { laneFor } from "./jobs/scheduler.js";
import type { ProviderConfig } from "./provider.js";

export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

export function buildManifest(config: ProviderConfig, services: readonly Service[]): ProviderManifest {
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  const manifest: ProviderManifest = {
    standard: PROVIDER_STANDARD,
    provider: config.provider,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    payment: {
      protocol: "x402",
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: config.network,
          asset: USDC_ASSET[config.network],
          payTo: config.payTo,
          maxTimeoutSeconds,
          extra: { areFeesSponsored: true },
        },
      ],
    },
    services: services.map((service) => describe(service, maxTimeoutSeconds)),
  };
  if (config.retentionSeconds !== undefined) manifest.jobs = { retentionSeconds: config.retentionSeconds };
  return manifest;
}

function describe(service: Service, maxTimeoutSeconds: number): ServiceDescriptor {
  const descriptor: ServiceDescriptor = {
    name: service.name,
    description: service.description,
    price: { amount: service.amount },
    charge: service.charge,
    inputSchema: service.inputSchema,
    outputSchema: service.outputSchema,
  };
  if (service.title !== undefined) descriptor.title = service.title;
  if (service.expectedDurationSeconds !== undefined) descriptor.expectedDurationSeconds = service.expectedDurationSeconds;
  if (service.examples !== undefined) descriptor.examples = service.examples;
  if (service.tags !== undefined) descriptor.tags = service.tags;
  if (service.maxInputBytes !== undefined) descriptor.maxInputBytes = service.maxInputBytes;
  // What the lane enforces, so the hint matches the 503s [Q2].
  const lane = laneFor(service, maxTimeoutSeconds);
  descriptor.capacity = { concurrency: lane.concurrency, maxQueueWaitSeconds: lane.maxQueued === 0 ? 0 : lane.maxWaitSeconds };
  return descriptor;
}

const validateSchema = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(schema as JsonObject);
const examples = new Ajv2020({ strict: false, validateFormats: false });

/**
 * Every violation a client or verifier would find in this manifest, served from `manifestUrl`
 * (§2.4). With `dev`, a loopback http:// provider is checked as if it were served over HTTPS [M6].
 */
export function checkManifest(manifest: ProviderManifest, manifestUrl: string, dev = false): RuleViolation[] {
  const local = dev && isLoopback(manifestUrl);
  const https = (url: string | undefined) => (local && url !== undefined && isLoopback(url) ? url.replace(/^http:/, "https:") : url);
  const checked = structuredClone(manifest);
  checked.baseUrl = https(checked.baseUrl)!;
  for (const field of ["homepage", "termsUrl"] as const) {
    const url = https(checked.provider[field]);
    if (url !== undefined) checked.provider[field] = url;
  }

  const violations: RuleViolation[] = [];
  if (!validateSchema(checked)) {
    for (const error of validateSchema.errors ?? []) {
      violations.push({ rule: "M9", pointer: error.instancePath, message: error.message ?? "does not match the manifest JSON Schema" });
    }
    return violations;
  }
  return checkManifestRules(checked, {
    manifestUrl: https(manifestUrl)!,
    validateExample: (exampleSchema: JsonObject, value: JsonValue) => examples.validate(exampleSchema, value) as boolean,
  });
}

function isLoopback(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}
