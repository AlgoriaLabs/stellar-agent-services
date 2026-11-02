// provider-kit init: writes a starter gateway config. It never overwrites a file.
//
//   provider-kit init [--upstream <url>]                  one service to edit, which forwards to --upstream
//   provider-kit init --openapi <file | url> [--upstream <base url>]
//                                                         a service per POST endpoint of an OpenAPI document,
//                                                         such as FastAPI's /openapi.json (gateway/openapi.ts),
//                                                         then loaded as `provider-kit serve` loads it
// --json prints what it wrote and skipped as JSON, for scripts and coding agents.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { JsonObject } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { loadGatewayConfig, type GatewayService } from "../gateway/config.js";
import { DESCRIPTION_TO_WRITE, FIRST_GUESS, gatewayFromOpenApi, PROVIDER_DESCRIPTION_TO_WRITE, readOpenApi, type SkippedOperation } from "../gateway/openapi.js";
import { createProvider } from "../provider.js";
import { quote, type CliFlags } from "./shared.js";

const DEFAULT_OUT = "provider.config.json";
/** Skipped operations listed, before "and N more". */
const SKIPPED_SHOWN = 15;

export async function init(flags: CliFlags): Promise<number> {
  const out = flags.out ?? DEFAULT_OUT;
  if (flags.openapi !== undefined) return initFromOpenApi(flags.openapi, out, flags.upstream, flags.json === true);

  const service: GatewayService = {
    name: "my-service",
    title: "My service",
    description: DESCRIPTION_TO_WRITE,
    price: FIRST_GUESS.price,
    charge: FIRST_GUESS.charge,
    expectedDurationSeconds: FIRST_GUESS.expectedDurationSeconds,
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 10000 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    capacity: { ...FIRST_GUESS.capacity },
    upstream: { url: flags.upstream ?? "http://127.0.0.1:5000/run" },
  };
  await write(out, gatewayConfig({ name: "My provider", description: PROVIDER_DESCRIPTION_TO_WRITE }, [service]));
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, out, services: [{ name: service.name, url: service.upstream.url, headers: [] }], skipped: [], warnings: [], credentials: [] }, null, 2));
    return 0;
  }
  console.log(`Wrote ${out}. Next:
  1. Edit the service: name, description, price, schemas and upstream URL.
  2. provider-kit dev --config ${out}   runs it here. With PAY_TO empty, a throwaway testnet account is paid.
  3. provider-kit try my-service '{"text":"Hello"}' --config ${out}   one paid testnet call, from another terminal
  4. provider-kit launch --config ${out} --url https://your.domain   registers it from your wallet, to go live
  Where it runs in production, set baseUrl to your public HTTPS URL and remove "dev".`);
  return 0;
}

/** init --openapi: a service per POST endpoint the gateway can call, and every other operation with the reason. */
async function initFromOpenApi(source: string, out: string, upstream: string | undefined, json: boolean): Promise<number> {
  // With --json, standard output holds only the JSON at the end.
  const say = json ? () => {} : (line: string) => console.log(line);
  // Checked first, so nothing is read for a file that won't be written.
  if (existsSync(out)) throw new Error(`${out} already exists; nothing was written`);
  const { document, url } = await readOpenApi(source);
  const gateway = await gatewayFromOpenApi(document, { ...(url === undefined ? {} : { url }), ...(upstream === undefined ? {} : { upstream }) });
  const { api, services } = gateway;
  say(`Read ${api.title}${api.version === undefined ? "" : ` ${api.version}`} (OpenAPI ${api.openapi}) from ${source}`);
  if (services.length === 0) {
    printSkipped(gateway.skipped, say);
    throw new Error("none of its operations can be a service: the gateway POSTs a JSON object to the API and takes a JSON object back. Nothing was written.");
  }

  await write(out, gatewayConfig({ name: gateway.provider.name, description: gateway.provider.description ?? PROVIDER_DESCRIPTION_TO_WRITE }, services));
  say(`\nWrote ${out} with ${count(services.length, "service")}:`);
  const width = Math.max(...services.map((service) => service.name.length));
  for (const service of services) {
    const headers = Object.keys(service.upstream.headers ?? {});
    say(`  ${service.name.padEnd(width)}  POST ${service.upstream.url}${headers.length === 0 ? "" : `  with ${headers.join(", ")}`}`);
  }
  if (gateway.skipped.length > 0) printSkipped(gateway.skipped, say);
  for (const warning of gateway.warnings) say(`\n! ${warning}`);

  const problem = await loadAsServeWould(out, ["PAY_TO", ...gateway.credentials.map((credential) => credential.name)]);
  if (problem === undefined) say("\n✓ The config passes Provider Standard v1, checked as provider-kit serve checks it.");
  else say(`\n✗ The config doesn't load yet:\n  ${problem.split("\n").join("\n  ")}`);

  const steps = [
    `Review ${out}: each service's price (${FIRST_GUESS.price} USDC for now), charge and description, which agents choose by.` +
      (gateway.undescribed.length === 0 ? "" : `\n     Write one for ${gateway.undescribed.join(", ")}: the document gives only a summary, or nothing.`),
    ...gateway.credentials.map((credential) => `export ${credential.name}=...   ${credential.holds}`),
    `provider-kit dev --config ${quote(out)}   runs it here. With PAY_TO empty, a throwaway testnet account is paid.`,
    `${tryCommand(services, out)}   one paid testnet call, from another terminal`,
    `provider-kit launch --config ${quote(out)} --url https://your.domain   registers it from your wallet, to go live`,
  ];
  say(`\nNext:\n${steps.map((step, index) => `  ${index + 1}. ${step}`).join("\n")}`);
  if (json) {
    const report = {
      ok: problem === undefined,
      out,
      api: { title: api.title, ...(api.version === undefined ? {} : { version: api.version }), openapi: api.openapi },
      services: services.map((service) => ({ name: service.name, url: service.upstream.url, headers: Object.keys(service.upstream.headers ?? {}), described: !gateway.undescribed.includes(service.name) })),
      skipped: gateway.skipped,
      warnings: gateway.warnings,
      credentials: gateway.credentials.map(({ name, holds }) => ({ name, holds })),
      ...(problem === undefined ? {} : { problem }),
    };
    console.log(JSON.stringify(report, null, 2));
  }
  return problem === undefined ? 0 : 1;
}

/** A gateway config for development on testnet, as both kinds of init write it. */
function gatewayConfig(provider: { name: string; description: string }, services: GatewayService[]): JsonObject {
  return {
    $schema: "./node_modules/@stellar-agent-services/provider-kit/schemas/gateway-config.schema.json",
    baseUrl: "http://localhost:8787",
    dev: true,
    network: "stellar:testnet",
    payTo: "env:PAY_TO",
    facilitator: "https://x402.org/facilitator",
    provider: { ...provider, dataUse: { storesInputs: false, trainsOnInputs: false } },
    store: "./jobs.sqlite",
    services: services as unknown as JsonObject[],
  };
}

async function write(out: string, config: JsonObject): Promise<void> {
  try {
    await writeFile(out, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${out} already exists; nothing was written`);
    throw error;
  }
}

/**
 * Loads the written config as `provider-kit serve` does: the gateway config's schema, every service, the manifest
 * against the standard. Variables it reads that aren't set here get stand-ins: only the file is checked. The
 * problems, or undefined.
 */
async function loadAsServeWould(path: string, variables: string[]): Promise<string | undefined> {
  const env = { ...process.env };
  for (const name of variables) {
    if (env[name] === undefined || env[name] === "") env[name] = name === "PAY_TO" ? Keypair.random().publicKey() : "stand-in";
  }
  try {
    const { config } = await loadGatewayConfig(path, { env, openStore: false });
    await createProvider(config).close();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function printSkipped(skipped: SkippedOperation[], say: (line: string) => void): void {
  say(`\nSkipped ${count(skipped.length, "operation")}:`);
  const shown = skipped.slice(0, SKIPPED_SHOWN);
  const methods = Math.max(...shown.map((operation) => operation.method.length));
  const paths = Math.min(40, Math.max(...shown.map((operation) => operation.path.length)));
  for (const { method, path, reason } of shown) say(`  ${method.padEnd(methods)}  ${path.padEnd(paths)}  ${reason}`);
  if (skipped.length > shown.length) say(`  … and ${skipped.length - shown.length} more`);
}

/** How to try the first service: with its example input when it has one. */
function tryCommand(services: GatewayService[], out: string): string {
  const service = services.find((candidate) => candidate.examples !== undefined) ?? services[0]!;
  return `provider-kit try ${service.name}${service.examples === undefined ? " '<input JSON>'" : ""}${out === DEFAULT_OUT ? "" : ` --config ${quote(out)}`}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
