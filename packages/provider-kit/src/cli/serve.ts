// provider-kit serve --config <file>: gateway mode.
//
// Loads and checks the config (failing closed), runs the startup checks, then listens. SIGTERM and
// SIGINT stop it gracefully: no new connections, requests in flight finish, the store closes. Paid
// jobs that were still queued or running resume on the next start.

import { loadGatewayConfig } from "../gateway/config.js";
import { listen } from "../http/node-server.js";
import { createProvider } from "../provider.js";
import { UsageError, type CliFlags } from "./shared.js";

export async function serve(flags: CliFlags): Promise<number> {
  if (flags.config === undefined) throw new UsageError("serve needs --config <file>");
  const port = flags.port === undefined ? undefined : Number(flags.port);
  const { config, listen: where } = await loadGatewayConfig(flags.config, {
    overrides: {
      ...(flags.dev ? { dev: true } : {}),
      ...(flags["no-workers"] ? { runQueuedJobs: false } : {}),
      ...(port === undefined ? {} : { port }),
    },
  });
  const provider = createProvider(config);
  await provider.ready();
  const server = await listen(provider, where);

  console.log(`provider-kit: serving ${config.provider.name}`);
  console.log(`  listening  ${server.url}`);
  console.log(`  manifest   ${provider.manifestUrl}`);
  console.log(`  network    ${config.network}, payTo ${config.payTo}`);
  for (const service of provider.manifest.services) {
    const usdc = Number(service.price.amount) / 1e7;
    console.log(`  service    ${service.name}: ${usdc} USDC, ${service.charge}, ${service.capacity?.concurrency} at a time`);
  }
  if (config.dev) console.log("  dev mode: http://localhost is allowed. Never use it in production.");

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`provider-kit: ${signal}, finishing requests in flight`);
    server.close().then(
      () => process.exit(0),
      (error) => {
        console.error("provider-kit: shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  return -1;
}
