// Gateway mode: run the Provider Kit in front of an existing HTTP API, in any language, with no code
// changes to that API (docs/provider-standard.md, "Ways to implement").
//
// The config file is JSON, described by schemas/gateway-config.schema.json (point "$schema" at it for
// editor help). Loading it fails closed, listing every problem: the file's own schema first, then
// everything createProvider() checks, the manifest included.
//
// Secrets stay out of the file: the upstream's API key, a facilitator key and deployment values may be
// written "env:NAME" and are read from the environment. There is never a Stellar secret key to
// configure: the gateway, like any provider runtime, holds none.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { JsonObject, ProviderInfo, StellarNetwork } from "@stellar-agent-services/protocol";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { defineService, type CapacityConfig } from "../define-service.js";
import { memoryStore } from "../jobs/memory-store.js";
import { sqliteStore } from "../jobs/sqlite-store.js";
import { httpFacilitator } from "../payments/facilitator.js";
import type { ProviderConfig } from "../provider.js";
import { upstreamHandler } from "./upstream.js";

/** The config file, as written. */
export interface GatewayConfig {
  baseUrl: string;
  network: StellarNetwork;
  payTo: string;
  facilitator: string;
  facilitatorHeaders?: Record<string, string>;
  provider: Omit<ProviderInfo, "agentId"> & { agentId?: number | string };
  rpcUrl?: string;
  store?: string;
  listen?: { host?: string; port?: number };
  maxTimeoutSeconds?: number;
  settleTimeoutSeconds?: number;
  retentionSeconds?: number;
  manifestPath?: string;
  holdSeconds?: number;
  runQueuedJobs?: boolean;
  leaseSeconds?: number;
  rateLimit?: { requests: number; windowSeconds: number; keyHeader: string };
  dev?: boolean;
  services: GatewayService[];
}

export interface GatewayService {
  name: string;
  title?: string;
  description: string;
  price: string;
  charge?: "on-success" | "upfront";
  expectedDurationSeconds?: number;
  timeoutSeconds?: number;
  inputSchema: JsonObject | string;
  outputSchema: JsonObject | string;
  examples?: { input: JsonObject; output: JsonObject }[];
  tags?: string[];
  maxInputBytes?: number;
  capacity?: CapacityConfig;
  upstream: { url: string; headers?: Record<string, string> };
}

export interface LoadedGateway {
  config: ProviderConfig;
  listen: { host: string; port: number };
}

export class GatewayConfigError extends Error {
  override name = "GatewayConfigError";
}

/** The schema ships next to dist/, so editors can use it too. Compiled on first use. */
export const GATEWAY_CONFIG_SCHEMA_URL = new URL("../../schemas/gateway-config.schema.json", import.meta.url);
let validateConfig: ValidateFunction | undefined;

export const DEFAULT_PORT = 8787;

/**
 * Reads and checks a gateway config file. `overrides` are applied on top (CLI flags), and `env` is
 * where "env:NAME" values come from.
 */
export async function loadGatewayConfig(
  path: string,
  options: {
    env?: NodeJS.ProcessEnv;
    overrides?: Partial<Pick<GatewayConfig, "dev" | "runQueuedJobs">> & { port?: number };
    /** false: use a memory store and leave the job database alone (check, register). Default true. */
    openStore?: boolean;
  } = {},
): Promise<LoadedGateway> {
  const env = options.env ?? process.env;
  const directory = dirname(resolve(path));
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new GatewayConfigError(`the config file can't be read: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GatewayConfigError(`the config file is not valid JSON: ${(error as Error).message}`);
  }
  validateConfig ??= new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(GATEWAY_CONFIG_SCHEMA_URL, "utf8")));
  if (!validateConfig(raw)) {
    const problems = (validateConfig.errors ?? []).map((error) => `  ${error.instancePath || "/"} ${error.message ?? ""}`);
    throw new GatewayConfigError(`the config file does not match the gateway config schema:\n${problems.join("\n")}`);
  }
  const file = { ...(raw as GatewayConfig), ...stripUndefined({ dev: options.overrides?.dev, runQueuedJobs: options.overrides?.runQueuedJobs }) };

  const fromEnv = (value: string, field: string): string => {
    if (!value.startsWith("env:")) return value;
    const name = value.slice("env:".length);
    const found = env[name];
    if (found === undefined || found === "") throw new GatewayConfigError(`${field} reads the environment variable ${name}, which is not set`);
    return found;
  };
  const headers = (values: Record<string, string> | undefined, field: string) =>
    values === undefined ? undefined : Object.fromEntries(Object.entries(values).map(([name, value]) => [name, fromEnv(value, `${field}.${name}`)]));
  const loadSchema = async (value: JsonObject | string, field: string): Promise<JsonObject> => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(await readFile(resolve(directory, value), "utf8")) as JsonObject;
    } catch (error) {
      throw new GatewayConfigError(`${field}: the schema file ${value} can't be read: ${(error as Error).message}`);
    }
  };

  const services = [];
  for (const [index, service] of file.services.entries()) {
    const at = `services[${index}]`;
    const upstreamHeaders = headers(service.upstream.headers, `${at}.upstream.headers`);
    try {
      services.push(
        defineService({
          ...stripUndefined({
            title: service.title,
            charge: service.charge,
            expectedDurationSeconds: service.expectedDurationSeconds,
            timeoutSeconds: service.timeoutSeconds,
            examples: service.examples,
            tags: service.tags,
            maxInputBytes: service.maxInputBytes,
            capacity: service.capacity,
          }),
          name: service.name,
          description: service.description,
          price: service.price,
          inputSchema: await loadSchema(service.inputSchema, `${at}.inputSchema`),
          outputSchema: await loadSchema(service.outputSchema, `${at}.outputSchema`),
          handler: upstreamHandler({
            url: fromEnv(service.upstream.url, `${at}.upstream.url`),
            ...(upstreamHeaders === undefined ? {} : { headers: upstreamHeaders }),
          }),
        }),
      );
    } catch (error) {
      if (error instanceof GatewayConfigError) throw error;
      throw new GatewayConfigError(`${at}: ${(error as Error).message}`);
    }
  }

  const { agentId: configuredAgentId, ...info } = file.provider;
  const provider: ProviderInfo = info;
  if (configuredAgentId !== undefined) {
    const agentId = Number(typeof configuredAgentId === "string" ? fromEnv(configuredAgentId, "provider.agentId") : configuredAgentId);
    if (!Number.isInteger(agentId) || agentId < 0 || agentId > 0xffffffff) throw new GatewayConfigError("provider.agentId must be a Stellar 8004 agent id (a u32)");
    provider.agentId = agentId;
  }

  const dev = file.dev ?? false;
  const storePath = fromEnv(file.store ?? "./jobs.sqlite", "store");
  const facilitatorExtra = headers(file.facilitatorHeaders, "facilitatorHeaders");
  let facilitator;
  try {
    facilitator = httpFacilitator(fromEnv(file.facilitator, "facilitator"), {
      dev,
      ...stripUndefined({ headers: facilitatorExtra, settleTimeoutSeconds: file.settleTimeoutSeconds }),
    });
  } catch (error) {
    throw new GatewayConfigError(`facilitator: ${(error as Error).message}`);
  }
  const keyHeader = file.rateLimit?.keyHeader;
  const config: ProviderConfig = {
    ...stripUndefined({
      maxTimeoutSeconds: file.maxTimeoutSeconds,
      settleTimeoutSeconds: file.settleTimeoutSeconds,
      retentionSeconds: file.retentionSeconds,
      manifestPath: file.manifestPath,
      holdSeconds: file.holdSeconds,
      runQueuedJobs: file.runQueuedJobs,
      leaseSeconds: file.leaseSeconds,
    }),
    baseUrl: fromEnv(file.baseUrl, "baseUrl"),
    network: file.network,
    payTo: fromEnv(file.payTo, "payTo"),
    provider,
    services,
    facilitator,
    ...(file.rpcUrl === undefined ? {} : { rpc: fromEnv(file.rpcUrl, "rpcUrl") }),
    store: storePath === "memory" || options.openStore === false ? memoryStore() : sqliteStore(resolve(directory, storePath)),
    dev,
  };
  if (file.rateLimit !== undefined && keyHeader !== undefined) {
    config.rateLimit = {
      requests: file.rateLimit.requests,
      windowSeconds: file.rateLimit.windowSeconds,
      // A proxy may append to X-Forwarded-For; the first entry is the client it saw.
      key: (request) => request.headers.get(keyHeader)?.split(",")[0]?.trim() || undefined,
    };
  }

  const port = options.overrides?.port ?? (env["PORT"] === undefined ? undefined : Number(env["PORT"])) ?? file.listen?.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new GatewayConfigError(`the port must be 0–65535, not ${port}`);
  return { config, listen: { host: file.listen?.host ?? "0.0.0.0", port } };
}

/** Drops undefined members, for exactOptionalPropertyTypes. */
function stripUndefined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
