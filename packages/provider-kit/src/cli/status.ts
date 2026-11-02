// provider-kit status: where a provider stands, from this computer to verified, and the one command to run next
// (docs/provider-setup-guide.md). --json prints the same for scripts and coding agents.
//
//   local       the provider on this computer answers, with a manifest that passes the standard
//   payTo       PAY_TO: a throwaway testnet account (provider-kit dev made it) or yours, with a USDC trustline [P2]
//   paid        payTo holds USDC: a paid call reached it
//   registered  the agent (AGENT_ID) exists, its registration lists the public manifest and its wallet is payTo [I1]–[I3]
//   live        the public manifest answers, naming the agent [I2]
//   verified    a verifier answered a validation request for the agent (docs/verification.md)
// The public manifest comes from --url, fly.toml or an https:// PUBLIC_ORIGIN, else from the registration itself.
// It only reads: no key, no payment, no transaction.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DEFAULT_MANIFEST_PATH, HORIZON_URL, USDC_ISSUER, VALIDATION_TAG, type ProviderManifest, type StellarNetwork } from "@stellar-agent-services/protocol";
import { DEFAULT_PORT, gatewayManifestUrl } from "../gateway/config.js";
import { checkManifest } from "../manifest.js";
import { inspectRegistration, REGISTRATION_SERVICE_NAME, rpcRegistry, type RegistryReader } from "../registration.js";
import { payToKind } from "./dev-account.js";
import { ENV_FILE, loadEnvFile } from "./env-file.js";
import { FLY_TOML, flyApp } from "./fly.js";
import { networkName, rpcOwnerChain, shortAddress, type OwnerChain } from "./owner-chain.js";
import { DEFAULT_CONFIG, nextCommand, plain, UsageError, type CliFlags } from "./shared.js";

export type StageId = "local" | "payTo" | "paid" | "registered" | "live" | "verified";

export interface Stage {
  id: StageId;
  /** true: done; false: not yet; null: can't tell from here. */
  ok: boolean | null;
  detail: string;
}

export interface Status {
  network: StellarNetwork;
  stages: Stage[];
  next: { command?: string; why: string };
}

/** Where `status` reaches the outside world. Tests replace it. */
export interface StatusIo {
  log(line: string): void;
  fetch: typeof fetch;
  chain(network: StellarNetwork, rpcUrl?: string): OwnerChain;
  registry(network: StellarNetwork, rpcUrl?: string): RegistryReader;
  env: NodeJS.ProcessEnv;
}

export function statusIo(): StatusIo {
  return {
    log: (line) => console.log(line),
    fetch: (input, init) => fetch(input, init),
    chain: rpcOwnerChain,
    registry: rpcRegistry,
    env: process.env,
  };
}

const MARK = { true: "✓", false: "✗", null: "·" } as const;
const TIMEOUT_MS = 8000;

export async function status(flags: CliFlags, io: StatusIo = statusIo()): Promise<number> {
  const envFile = flags["env-file"] ?? ENV_FILE;
  if (flags["env-file"] !== undefined && !existsSync(envFile)) throw new UsageError(`${envFile} doesn't exist`);
  await loadEnvFile(envFile, io.env);
  const result = await findStatus(flags, io);
  if (flags.json) {
    io.log(JSON.stringify(result, null, 2));
  } else {
    io.log(`Status on ${networkName(result.network)}`);
    for (const stage of result.stages) io.log(`  ${MARK[String(stage.ok) as keyof typeof MARK]} ${stage.id.padEnd(10)} ${stage.detail}`);
    io.log(`\nNext: ${result.next.command === undefined ? result.next.why : `${result.next.command}   ${result.next.why}`}`);
  }
  return 0;
}

/** Every stage, read from this computer, the chain and the public address. */
export async function findStatus(flags: CliFlags, io: StatusIo): Promise<Status> {
  const config = flags.config ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
  const configFile = config === undefined ? undefined : await readConfig(config);

  // local
  const localUrl = flags.manifest ?? (await localManifestUrl(config, io.env));
  const local = await readManifest(io.fetch, localUrl);
  const localProblems = local.manifest === undefined ? [] : checkManifest(local.manifest, localUrl, true);
  const stages: Stage[] = [
    local.manifest === undefined
      ? { id: "local", ok: false, detail: `nothing serves ${localUrl}: ${local.problem}` }
      : localProblems.length > 0
        ? { id: "local", ok: false, detail: `${localUrl} fails the standard: [${localProblems[0]!.rule}] ${localProblems[0]!.message}` }
        : { id: "local", ok: true, detail: `${plain(local.manifest.provider.name, 60)} runs at ${localUrl}` },
  ];
  const network: StellarNetwork =
    local.manifest?.payment.accepts[0].network ?? configFile?.network ?? (io.env["STELLAR_NETWORK"] === "stellar:pubnet" ? "stellar:pubnet" : "stellar:testnet");
  const chain = io.chain(network, flags.rpc);
  const registry = io.registry(network, flags.rpc);

  // payTo and paid
  const kind = payToKind(io.env);
  const payTo = kind === "unset" ? local.manifest?.payment.accepts[0].payTo : io.env["PAY_TO"];
  let paidUsdc: string | undefined;
  if (payTo === undefined) {
    stages.push({
      id: "payTo",
      ok: false,
      detail: network === "stellar:testnet" ? "PAY_TO is empty: provider-kit dev makes a throwaway testnet account, launch connects your wallet" : "PAY_TO is empty: launch connects your wallet",
    });
  } else {
    const what = kind === "throwaway" ? "a throwaway testnet account (test payments only)" : "your account";
    try {
      const account = payTo.startsWith("C") ? { exists: true, usdcTrustline: true } : await chain.account(payTo);
      stages.push(
        !account.exists
          ? { id: "payTo", ok: false, detail: `${shortAddress(payTo)} doesn't exist on ${networkName(network)}` }
          : !account.usdcTrustline
            ? { id: "payTo", ok: false, detail: `${shortAddress(payTo)}, ${what}, has no USDC trustline [P2]` }
            : { id: "payTo", ok: true, detail: `${shortAddress(payTo)}, ${what}, can receive USDC` },
      );
      paidUsdc = account.exists ? await usdcBalance(io.fetch, network, payTo) : undefined;
    } catch (error) {
      stages.push({ id: "payTo", ok: null, detail: `the chain can't be read: ${(error as Error).message}` });
    }
  }
  stages.push(
    paidUsdc === undefined
      ? { id: "paid", ok: null, detail: "payTo's USDC balance can't be read" }
      : Number(paidUsdc) > 0
        ? { id: "paid", ok: true, detail: `payTo holds ${paidUsdc} USDC: paid calls reached it` }
        : { id: "paid", ok: false, detail: "payTo holds no USDC yet: no paid call has reached it" },
  );

  // registered, live, verified
  const agentText = io.env["AGENT_ID"] !== undefined && io.env["AGENT_ID"] !== "" ? io.env["AGENT_ID"] : configFile?.agentId;
  const agentId = agentText === undefined ? undefined : Number(agentText);
  const fly = await flyApp(FLY_TOML);
  const origin = flags.url ?? fly?.origin ?? (io.env["PUBLIC_ORIGIN"]?.startsWith("https://") ? io.env["PUBLIC_ORIGIN"] : undefined);
  let publicUrl = origin === undefined ? undefined : new URL(DEFAULT_MANIFEST_PATH, new URL(origin).origin).toString();
  let registered = false;
  if (agentId === undefined || !Number.isInteger(agentId)) {
    stages.push({ id: "registered", ok: false, detail: "no AGENT_ID: not registered in Stellar 8004 yet" });
  } else {
    try {
      // Read once for the manifest URL the registration names, when nothing here says where the service lives.
      const probe = await inspectRegistration(pretend(network, agentId, payTo ?? ""), publicUrl ?? "", { registry, fetch: io.fetch });
      publicUrl ??= listedManifest(probe.file);
      const { findings } = publicUrl === undefined ? probe : await inspectRegistration(pretend(network, agentId, payTo ?? ""), publicUrl, { registry, fetch: io.fetch });
      const failed = findings.filter((finding) => !finding.ok);
      registered = failed.length === 0;
      stages.push(registered ? { id: "registered", ok: true, detail: `agent ${agentId}: its registration lists ${publicUrl}, its wallet is payTo` } : { id: "registered", ok: false, detail: `agent ${agentId}: [${failed[0]!.rule}] ${failed[0]!.message}` });
    } catch (error) {
      stages.push({ id: "registered", ok: null, detail: `the identity registry can't be read: ${(error as Error).message}` });
    }
  }

  let live = false;
  if (publicUrl === undefined) {
    stages.push({ id: "live", ok: false, detail: "no public address yet: launch takes one from --url, fly.toml or PUBLIC_ORIGIN" });
  } else {
    const served = await readManifest(io.fetch, publicUrl);
    if (served.manifest === undefined) {
      stages.push({ id: "live", ok: false, detail: `${publicUrl}: ${served.problem}` });
    } else if (agentId !== undefined && served.manifest.provider.agentId !== agentId) {
      stages.push({ id: "live", ok: false, detail: `${publicUrl} answers, but names ${served.manifest.provider.agentId === undefined ? "no agent" : `agent ${served.manifest.provider.agentId}`}, not ${agentId}: deploy again [I2]` });
    } else {
      live = true;
      stages.push({ id: "live", ok: true, detail: `${publicUrl} answers` });
    }
  }

  let verified = false;
  let requested: string | undefined;
  if (agentId === undefined || !Number.isInteger(agentId)) {
    stages.push({ id: "verified", ok: false, detail: "not registered, so there is nothing to verify yet" });
  } else {
    try {
      const records = (await registry.agentValidations(agentId)).filter((record) => record.tag === VALIDATION_TAG || !record.hasResponse);
      const answered = records.filter((record) => record.hasResponse).at(-1);
      requested = records.at(-1)?.validator;
      if (answered !== undefined) {
        verified = true;
        stages.push({ id: "verified", ok: true, detail: `${shortAddress(answered.validator)} answered with ${answered.response} of 100` });
      } else {
        stages.push({ id: "verified", ok: false, detail: requested === undefined ? "no validation requested" : `requested from ${shortAddress(requested)}, no answer yet` });
      }
    } catch (error) {
      stages.push({ id: "verified", ok: null, detail: `the Validation Registry can't be read: ${(error as Error).message}` });
    }
  }

  return { network, stages, next: whatNext({ network, local: local.manifest !== undefined, paid: Number(paidUsdc ?? 0) > 0, kind, registered, live, verified, requested, fly: fly !== undefined }) };
}

function whatNext(state: {
  network: StellarNetwork;
  local: boolean;
  paid: boolean;
  kind: string;
  registered: boolean;
  live: boolean;
  verified: boolean;
  requested: string | undefined;
  fly: boolean;
}): Status["next"] {
  const launch = { command: nextCommand("launch"), why: "connects your wallet, registers the service and deploys it" };
  if (state.registered && state.live && state.verified) return { why: "Nothing: agents can find it, pay it and check its verification." };
  if (state.registered && state.live) {
    return state.requested === undefined
      ? { command: `${nextCommand("launch")} --validator <G...>`, why: "asks a verifier to check it" }
      : { why: `Waiting for the verifier ${shortAddress(state.requested)} to answer: it checks the service and answers on chain.` };
  }
  if (state.registered) return { command: state.fly ? nextCommand("deploy", "fly deploy --ha=false") : "deploy it", why: "serves the manifest with the agent id at the public address" };
  // Testnet has test money and throwaway accounts: run it and pay it before launching. Mainnet has neither.
  if (state.network !== "stellar:testnet") return launch;
  if (!state.local) return { command: nextCommand("dev"), why: "runs it on this computer, with no wallet needed" };
  if (!state.paid && state.kind !== "yours") return { command: nextCommand("try"), why: "pays for one call with test money" };
  return launch;
}

/** The fields of a manifest inspectRegistration() reads, for a provider known by its agent id and payTo. */
function pretend(network: StellarNetwork, agentId: number, payTo: string): ProviderManifest {
  return { provider: { name: "", agentId }, payment: { accepts: [{ network, payTo }] } } as unknown as ProviderManifest;
}

/** The manifest URL a registration file lists [I1]. */
function listedManifest(file: Record<string, unknown> | undefined): string | undefined {
  const services = Array.isArray(file?.["services"]) ? (file["services"] as { name?: unknown; endpoint?: unknown }[]) : [];
  const endpoint = services.find((service) => service.name === REGISTRATION_SERVICE_NAME)?.endpoint;
  return typeof endpoint === "string" && endpoint.startsWith("https://") ? endpoint : undefined;
}

async function readConfig(path: string): Promise<{ network?: StellarNetwork; agentId?: string } | undefined> {
  try {
    const file = JSON.parse(await readFile(path, "utf8")) as { network?: unknown; provider?: { agentId?: unknown } };
    const network = file.network === "stellar:testnet" || file.network === "stellar:pubnet" ? file.network : undefined;
    const agentId = typeof file.provider?.agentId === "number" ? String(file.provider.agentId) : undefined;
    return { ...(network === undefined ? {} : { network }), ...(agentId === undefined ? {} : { agentId }) };
  } catch {
    return undefined;
  }
}

/** The local provider's manifest URL: the gateway config's, when it is on this computer, else the default port. */
async function localManifestUrl(config: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  if (config !== undefined) {
    try {
      const url = await gatewayManifestUrl(config, env);
      if (/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return url;
    } catch {
      // A config whose baseUrl isn't set here: the default port, below.
    }
  }
  return new URL(DEFAULT_MANIFEST_PATH, `http://localhost:${env["PORT"] ?? DEFAULT_PORT}`).toString();
}

async function readManifest(fetcher: typeof fetch, url: string): Promise<{ manifest?: ProviderManifest; problem?: string }> {
  try {
    const response = await fetcher(url, { redirect: "manual", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { problem: `it answered ${response.status}` };
    }
    return { manifest: (await response.json()) as ProviderManifest };
  } catch (error) {
    return { problem: error instanceof TypeError ? "nothing answers" : (error as Error).message };
  }
}

/** payTo's USDC balance from Horizon, such as "0.0300000", or undefined when it can't be read. */
async function usdcBalance(fetcher: typeof fetch, network: StellarNetwork, payTo: string): Promise<string | undefined> {
  if (payTo.startsWith("C")) return undefined;
  try {
    const response = await fetcher(`${HORIZON_URL[network]}/accounts/${payTo}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const account = (await response.json()) as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
    return account.balances.find((balance) => balance.asset_code === "USDC" && balance.asset_issuer === USDC_ISSUER[network])?.balance ?? "0";
  } catch {
    return undefined;
  }
}
