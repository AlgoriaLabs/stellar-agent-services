// provider-kit serve --config <file>: gateway mode.
//
// Loads and checks the config (failing closed), runs the startup checks, then listens. SIGTERM and
// SIGINT stop it gracefully: no new connections, requests in flight finish, the store closes. Paid
// jobs that were still queued or running resume on the next start.
//
// serveGateway() is the same start, for `provider-kit dev` and for `try` when it starts the provider itself.

import { discoveryDocumentUrls } from "@stellar-agent-services/protocol";
import { loadGatewayConfig } from "../gateway/config.js";
import { listen, type Listening } from "../http/node-server.js";
import { createProvider, type Provider, type ProviderConfig } from "../provider.js";
import { UsageError, type CliFlags } from "./shared.js";

export interface GatewayOptions {
  /** Allows http://localhost [M6]. */
  dev?: boolean;
  noWorkers?: boolean;
  port?: number;
  /** Serves under another origin than the config's, such as a tunnel's. */
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the summary goes. Default: the console. */
  log?: (line: string) => void;
}

export interface ServedGateway {
  config: ProviderConfig;
  provider: Provider;
  server: Listening;
}

/** Loads and checks a gateway config, starts the provider and listens, then prints what it serves. */
export async function serveGateway(path: string, options: GatewayOptions = {}): Promise<ServedGateway> {
  const log = options.log ?? ((line: string) => console.log(line));
  const { config, listen: where } = await loadGatewayConfig(path, {
    ...(options.env === undefined ? {} : { env: options.env }),
    overrides: {
      ...(options.dev ? { dev: true } : {}),
      ...(options.noWorkers ? { runQueuedJobs: false } : {}),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    },
  });
  const provider = createProvider(config);
  try {
    await provider.ready();
  } catch (error) {
    await provider.close();
    throw error;
  }
  const server = await listen(provider, where);

  log(`provider-kit: serving ${config.provider.name}`);
  log(`  listening  ${server.url}`);
  log(`  manifest   ${provider.manifestUrl}`);
  if (config.discoveryDocuments !== false) {
    const documents = discoveryDocumentUrls(provider.manifestUrl);
    log(`  discovery  ${documents.openapi} and ${documents.llmsTxt}`);
  }
  log(`  network    ${config.network}, payTo ${config.payTo}`);
  for (const service of provider.manifest.services) {
    const usdc = Number(service.price.amount) / 1e7;
    log(`  service    ${service.name}: ${usdc} USDC, ${service.charge}, ${service.capacity?.concurrency} at a time`);
  }
  if (config.dev) log("  dev mode: http://localhost is allowed. Never use it in production.");
  return { config, provider, server };
}

export async function serve(flags: CliFlags): Promise<number> {
  if (flags.config === undefined) throw new UsageError("serve needs --config <file>");
  const port = flags.port === undefined ? undefined : Number(flags.port);
  const { server } = await serveGateway(flags.config, {
    ...(flags.dev ? { dev: true } : {}),
    ...(flags["no-workers"] ? { noWorkers: true } : {}),
    ...(port === undefined ? {} : { port }),
  });
  stopOnSignals(() => server.close(), (line) => console.log(line));
  return -1;
}

/** On SIGTERM or SIGINT: runs `stop` once, then exits 0, or 1 when it fails. */
export function stopOnSignals(stop: () => Promise<unknown>, log: (line: string) => void): void {
  let stopping = false;
  const handle = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`provider-kit: ${signal}, finishing requests in flight`);
    stop().then(
      () => process.exit(0),
      (error) => {
        console.error("provider-kit: shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => handle("SIGTERM"));
  process.on("SIGINT", () => handle("SIGINT"));
}
