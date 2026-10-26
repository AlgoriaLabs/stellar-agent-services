// verifyProvider(): runs checks C1–C7 against a provider (docs/verification.md) and returns the report
// a receipt is issued from.
//
// Order: C1 manifest, C2 identity, C3 challenge, C4 paid call, C5 recovery, C6's probes, C7 load, then
// C6 over every exchange of the run. The load test runs late, so a provider's rate limit can't turn
// away the other checks' requests, and C6 runs last so it sees everything.
//
// Without a payer, C4 and C5 are skipped and C7 runs its unpaid burst only: that is `verifier check`.

import {
  CHECK_IDS,
  CONFORMANCE_SCORES,
  conformanceLevel,
  type CheckId,
  type CheckResult,
  type ConformanceLevel,
  type JsonObject,
  type PaymentReceipt,
  type StellarNetwork,
} from "@stellar-agent-services/protocol";
import { rpcChain, type ChainReader } from "./chain.js";
import { checkChallenge } from "./checks/challenge.js";
import { checkHygiene, probeHygiene } from "./checks/hygiene.js";
import { checkIdentity } from "./checks/identity.js";
import { checkLoad } from "./checks/load.js";
import { checkManifest } from "./checks/manifest.js";
import { checkPaidCall } from "./checks/paid-call.js";
import { checkRecovery } from "./checks/recovery.js";
import type { ProbeInput, RunContext } from "./context.js";
import { httpClient } from "./http.js";
import { Wallet, type Payer } from "./payments.js";
import { rpcRegistry, type Registry } from "./registry.js";
import { firstSchemaError, matchesSchema, sampleInput } from "./schemas.js";

/** 0.10 USDC: the most one job may cost the test payer, unless the caller allows more. */
export const DEFAULT_MAX_PRICE = 1_000_000n;
/** 1 USDC: the most one run may sign for. */
export const DEFAULT_MAX_SPEND = 10_000_000n;
/** Unpaid create-job requests in the load burst [Q1]. */
export const DEFAULT_BURST_SIZE = 20;

export interface VerifyOptions {
  manifestUrl: string;
  /** Development mode: accept a provider on a loopback http:// address [M6]. No receipt is issued for it. */
  dev?: boolean;
  /** The service to pay for and load. Default: the cheapest one with an example. */
  service?: string;
  /** The input for `service`, instead of its example. Must match its inputSchema. */
  input?: JsonObject;
  /** The test payer. Without it, C4 and C5 are skipped, and C7 sends unpaid requests only. */
  payer?: Payer;
  /** Highest price of one job, in base units. Default DEFAULT_MAX_PRICE. */
  maxPrice?: bigint;
  /** Most the run may sign for, in base units. Default DEFAULT_MAX_SPEND. */
  maxSpend?: bigint;
  /** Pay a pubnet provider: real money. */
  allowPubnet?: boolean;
  /** A Soroban RPC URL (default: the network's public one), a ChainReader, or false for none. */
  rpc?: string | ChainReader | false;
  /** The 8004 registry reads (default: through the RPC), or false for none. */
  registry?: Registry | false;
  fetch?: typeof fetch;
  /** Unpaid requests in the load burst. Default 20. */
  burstSize?: number;
  /** Called with each check's result as it finishes. */
  onResult?: (result: CheckResult) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface VerificationReport {
  manifestUrl: string;
  dev: boolean;
  network?: StellarNetwork;
  agentId?: number;
  manifestSha256?: string;
  /** RFC 3339. */
  startedAt: string;
  checkedAt: string;
  /** The highest conformance level whose checks all passed (provider-standard.md §8). */
  level: ConformanceLevel;
  score: number;
  /** C1 to C7, in order. */
  results: CheckResult[];
  /** The C4 payment, confirmed on chain. */
  payment?: PaymentReceipt;
  /** The test payer's address, when there was one. */
  payer?: string;
  /** Base units the test payer signed for. */
  spent: string;
}

/** The options can't work with this provider, such as a --service it doesn't offer. Nothing was paid. */
export class InvalidOptionsError extends Error {
  override name = "InvalidOptionsError";
}

export async function verifyProvider(options: VerifyOptions): Promise<VerificationReport> {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  if (options.input !== undefined && options.service === undefined) throw new InvalidOptionsError("an input needs the service it is for");
  // A bad RPC URL is the caller's mistake: found before any request is sent.
  if (typeof options.rpc === "string") toOptionsError(() => rpcChain("stellar:testnet", options.rpc as string, { dev: options.dev ?? false }));

  const http = httpClient(options.fetch);
  const ctx: RunContext = {
    manifestUrl: options.manifestUrl,
    dev: options.dev ?? false,
    http,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now,
    service: options.service,
    input: options.input,
    burstSize: options.burstSize ?? DEFAULT_BURST_SIZE,
    payer: options.payer,
    manifest: undefined,
    manifestSha256: undefined,
    usable: false,
    conformant: false,
    chain: undefined,
    registry: undefined,
    wallet: undefined,
    inputs: new Map(),
    target: undefined,
    challenges: new Map(),
    paidJob: undefined,
    payment: undefined,
    transactions: new Map(),
  };
  const results = new Map<CheckId, CheckResult>();
  const record = (result: CheckResult) => {
    results.set(result.check, result);
    options.onResult?.(result);
  };

  record(await checkManifest(ctx));
  if (ctx.manifest !== undefined && ctx.usable) {
    // From here on, requests go to the provider's origin only.
    http.restrictTo(new URL(ctx.manifestUrl).origin);
    connect(ctx, options);
    chooseInputs(ctx, options);
  }
  record(await checkIdentity(ctx));
  record(await checkChallenge(ctx));
  record(await checkPaidCall(ctx));
  record(await checkRecovery(ctx));
  const hygiene = await probeHygiene(ctx);
  const load = await checkLoad(ctx);
  record(checkHygiene(ctx, hygiene));
  record(load);

  const ordered = CHECK_IDS.map((check) => results.get(check)!);
  const level = conformanceLevel(ordered);
  const report: VerificationReport = {
    manifestUrl: options.manifestUrl,
    dev: ctx.dev,
    startedAt,
    checkedAt: new Date(now()).toISOString(),
    level,
    score: CONFORMANCE_SCORES[level],
    results: ordered,
    spent: (ctx.wallet?.spent ?? 0n).toString(),
  };
  if (ctx.manifest !== undefined) {
    report.network = ctx.manifest.payment.accepts[0].network;
    if (ctx.manifest.provider.agentId !== undefined) report.agentId = ctx.manifest.provider.agentId;
  }
  if (ctx.manifestSha256 !== undefined) report.manifestSha256 = ctx.manifestSha256;
  if (ctx.payment !== undefined) report.payment = ctx.payment;
  if (options.payer !== undefined) report.payer = options.payer.address;
  return report;
}

/** The chain, the registry and the wallet, for the manifest's network. */
function connect(ctx: RunContext, options: VerifyOptions): void {
  const network = ctx.manifest!.payment.accepts[0].network;
  const rpcUrl = typeof options.rpc === "string" ? options.rpc : undefined;
  if (options.rpc !== false) ctx.chain = typeof options.rpc === "object" ? options.rpc : rpcChain(network, rpcUrl, { dev: ctx.dev });
  if (options.registry !== false) ctx.registry = options.registry ?? rpcRegistry(network, rpcUrl);
  if (options.payer !== undefined && ctx.chain !== undefined) {
    ctx.wallet = new Wallet(options.payer, ctx.chain, {
      maxPrice: options.maxPrice ?? DEFAULT_MAX_PRICE,
      maxSpend: options.maxSpend ?? DEFAULT_MAX_SPEND,
      allowPubnet: options.allowPubnet ?? false,
    });
  }
}

/**
 * The input each service is probed with: the caller's, else its first example that matches its
 * inputSchema, else one built from the schema. The target, which C4 pays for and C7 loads, is the
 * caller's service, else the cheapest with an example (then with any input), first in the manifest on a tie.
 */
function chooseInputs(ctx: RunContext, options: VerifyOptions): void {
  const services = ctx.manifest!.services;
  if (options.service !== undefined) {
    const chosen = services.find((service) => service.name === options.service);
    if (chosen === undefined) throw new InvalidOptionsError(`the provider has no service "${options.service}"`);
    if (options.input !== undefined && matchesSchema(chosen.inputSchema, options.input) !== true) {
      throw new InvalidOptionsError(`the input does not match the inputSchema of "${chosen.name}": ${firstSchemaError(chosen.inputSchema, options.input)}`);
    }
  }
  for (const service of services) {
    let probe: ProbeInput | undefined;
    if (service.name === options.service && options.input !== undefined) probe = { input: options.input, source: "option" };
    const example = service.examples?.find((candidate) => matchesSchema(service.inputSchema, candidate.input) === true);
    if (probe === undefined && example !== undefined) probe = { input: example.input, source: "example" };
    const sample = probe === undefined ? sampleInput(service.inputSchema) : undefined;
    if (sample !== undefined) probe = { input: sample, source: "sample" };
    if (probe !== undefined) ctx.inputs.set(service.name, probe);
  }

  const rank = { option: 0, example: 1, sample: 2 } as const;
  const candidates = services.filter((service) => ctx.inputs.has(service.name) && (options.service === undefined || service.name === options.service));
  ctx.target = candidates.reduce<(typeof candidates)[number] | undefined>((best, service) => {
    if (best === undefined) return service;
    const byInput = rank[ctx.inputs.get(service.name)!.source] - rank[ctx.inputs.get(best.name)!.source];
    if (byInput !== 0) return byInput < 0 ? service : best;
    return BigInt(service.price.amount) < BigInt(best.price.amount) ? service : best;
  }, undefined);
  if (ctx.target === undefined && options.service !== undefined) ctx.target = services.find((service) => service.name === options.service);
}

function toOptionsError(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    throw new InvalidOptionsError((error as Error).message);
  }
}
