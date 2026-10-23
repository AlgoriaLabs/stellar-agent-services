// Builds the Provider Standard v1 manifest from the provider config.
//
// The payment option and every URL come from the same config, so the 402 challenge and the manifest
// can never disagree.
//
// TODO:
// - Validate the result with the manifest JSON Schema and checkManifestRules() at startup.
// - Serve it with Cache-Control max-age <= 300.

import { PROVIDER_STANDARD, USDC_ASSET, type ProviderManifest, type ServiceDescriptor } from "@stellar-agent-services/protocol";
import type { Service } from "./define-service.js";
import { laneFor } from "./jobs/scheduler.js";
import type { ProviderConfig } from "./provider.js";

export function buildManifest(config: ProviderConfig, services: readonly Service[]): ProviderManifest {
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 60;
  const manifest: ProviderManifest = {
    standard: PROVIDER_STANDARD,
    provider: config.provider,
    baseUrl: config.baseUrl,
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
