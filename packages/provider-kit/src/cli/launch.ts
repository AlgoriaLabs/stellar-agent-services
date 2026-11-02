// provider-kit launch: takes a provider live in one go (docs/provider-setup-guide.md §4).
//
//   provider-kit launch [--config <file> | --start '<command>' | --manifest <url>] [--url <https origin>]
//                       [--validator <G...> | --no-validation] [--deploy | --no-deploy] [--no-wait]
//
// 1. The public address: --url, else the app in fly.toml (https://<app>.fly.dev), else an https:// PUBLIC_ORIGIN. It is
//    known before the first deploy, so the service is registered first and deployed once, with its agent id.
// 2. The manifest as that address will serve it, checked against the standard: built from the gateway config, from the
//    provider's own command started here with PUBLIC_ORIGIN set (--start), or read from a deployed provider (--manifest).
// 3. One approval page and one wallet for every owner step: test XLM for a new testnet account, the USDC trustline [P2],
//    the Stellar 8004 registration [I1]–[I3] (or its update, when the manifest moved), and a validation request to a
//    verifier (docs/verification.md), which `verifier watch` answers by itself. The account that connects becomes
//    payTo, unless PAY_TO already names an account of yours. Nothing is registered twice: a new agent's id is saved
//    even when a later step stops.
// 4. Saves what it settled: PAY_TO and AGENT_ID in .env, the agent id in the gateway config (or its env:AGENT_ID), and
//    the public settings in fly.toml's [env], with a command-run provider's STELLAR_NETWORK.
// 5. With fly.toml and your yes (--deploy), stages the variables that may hold keys as Fly secrets (the ones a gateway
//    config reads; FACILITATOR_AUTH and SOROBAN_RPC_URL for a command), deploys with flyctl, waits until the public
//    manifest serves the agent id on the network it registered on, and checks the registration from outside.
// No key reaches provider-kit: the wallet signs on a page on this computer (approval.ts). Scripts and CI use `register`
// and `request-validation` with --source instead.

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_MANIFEST_PATH, stellarAddressKind, type ProviderManifest, type StellarNetwork } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { loadGatewayConfig } from "../gateway/config.js";
import { checkManifest } from "../manifest.js";
import { createProvider } from "../provider.js";
import { inspectRegistration, mayActFor, registrationDataUri, registrationFile, registryConfig } from "../registration.js";
import { prepareValidationRequest, ValidationRequestError, type PreparedValidationRequest } from "../validation-request.js";
import { ApprovalError, describeOutcome, type ApprovalPlan, type ApprovalStep } from "./approval.js";
import { DEV_PAY_TO, payToKind } from "./dev-account.js";
import { ENV_FILE, loadEnvFile, updateEnvFile } from "./env-file.js";
import { FLY_TOML, flyApp, flyDeploy, flySecrets, setFlyEnv, type FlyApp, type FlyRunner } from "./fly.js";
import { explorerUrl, networkName, shortAddress } from "./owner-chain.js";
import { accountSteps, registerStep, validationRequestStep } from "./owner-steps.js";
import { freePort, runProgram, startCommand, waitForManifest, type Started } from "./processes.js";
import { saveAgentId } from "./register.js";
import { DEFAULT_CONFIG, nextCommand, ownerIo, plain, UsageError, type CliFlags, type OwnerIo } from "./shared.js";
import { isTemporaryUrl } from "./tunnel.js";
import { defaultValidator } from "./validators.js";

/** Settings the gateway config and the deploy read from the environment, which launch settles itself. */
const SETTINGS = new Set(["PAY_TO", "PUBLIC_ORIGIN", "JOB_DB_PATH", "AGENT_ID", DEV_PAY_TO, "PORT"]);
/**
 * What a provider run by its own command may read that holds a key, as the TypeScript template does: the facilitator's
 * Authorization header (mainnet's facilitator wants an API key) and a Soroban RPC URL, which often carries one.
 */
const COMMAND_SECRETS = ["FACILITATOR_AUTH", "SOROBAN_RPC_URL"];
/** How long launch waits for a deploy to serve the new manifest. */
const LIVE_WAIT_MS = 5 * 60_000;
const LIVE_POLL_MS = 5000;

/** Where `launch` reaches the outside world. Tests replace it. */
export interface LaunchIo extends OwnerIo {
  log(line: string): void;
  /** Whether someone is there to answer a question. */
  interactive: boolean;
  /** Asks yes or no. Enter means yes. */
  confirm(question: string): Promise<boolean>;
  fetch: typeof fetch;
  /** Starts the provider's own command in the background, with `env` added. */
  start(command: string, env: NodeJS.ProcessEnv): Started;
  freePort(): Promise<number>;
  fly: FlyRunner;
  sleep(ms: number): Promise<void>;
  env: NodeJS.ProcessEnv;
}

export function launchIo(flags: CliFlags): LaunchIo {
  return {
    ...ownerIo(flags),
    log: (line) => console.log(line),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    async confirm(question) {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string | undefined>((resolve) => {
          readline.once("SIGINT", () => resolve(undefined));
          readline.question(question).then(resolve, () => resolve(undefined));
        });
        return answer !== undefined && /^(y|yes)?$/i.test(answer.trim());
      } finally {
        readline.close();
      }
    },
    fetch: (input, init) => fetch(input, init),
    start: (command, env) => startCommand(command, { env }),
    freePort,
    fly: (args, options = {}) => runProgram("fly", args, options),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: process.env,
  };
}

/** The provider to launch, as its public address will serve it. */
interface Launchable {
  manifest: ProviderManifest;
  manifestUrl: string;
  /** Where the agent id is saved: a gateway config's provider.agentId (literal, or the variable it reads), or AGENT_ID. */
  agentIdGoes: { config: string } | { variable: string };
  /** Public settings the deployed provider reads too, for fly.toml's [env]: a command-run provider's network. */
  settings: Record<string, string>;
  /** Variables that may hold keys, staged as Fly secrets from .env. `required`: the provider can't start without them. */
  secrets: { names: string[]; required: boolean };
}

export async function launch(flags: CliFlags, io: LaunchIo = launchIo(flags)): Promise<number> {
  if ([flags.config, flags.start, flags.manifest].filter((source) => source !== undefined).length > 1) {
    throw new UsageError("launch takes the provider from one of --config, --start or --manifest");
  }
  if (flags.deploy && flags["no-deploy"]) throw new UsageError("--deploy or --no-deploy, not both");
  if (flags.validator !== undefined && flags["no-validation"]) throw new UsageError("--validator or --no-validation, not both");
  if (flags.source !== undefined) throw new UsageError("launch signs in your wallet. With --source, use provider-kit register and request-validation");
  if (flags.validator !== undefined && stellarAddressKind(flags.validator) !== "account") throw new UsageError("--validator must be a G... account address");

  const envFile = flags["env-file"] ?? ENV_FILE;
  if (flags["env-file"] !== undefined && !existsSync(envFile)) throw new UsageError(`${envFile} doesn't exist`);
  await loadEnvFile(envFile, io.env);
  const fly = await flyApp(FLY_TOML);
  const config = flags.start === undefined && flags.manifest === undefined ? (flags.config ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined)) : undefined;
  if (config === undefined && flags.start === undefined && flags.manifest === undefined) {
    throw new UsageError(
      `launch needs your provider: --config <file> (a gateway; ./${DEFAULT_CONFIG} by default), --start '<command>' (any provider this computer runs, such as 'node dist/server.js'), or --manifest <url> (one already deployed)`,
    );
  }

  // 1 and 2: the public address, and the manifest as it will serve it.
  const kind = payToKind(io.env);
  const yours = kind === "yours" ? io.env["PAY_TO"]! : undefined;
  // Until a wallet connects, the manifest is built with a stand-in payTo: the registration doesn't name payTo, and the
  // registry makes the registering account the agent's wallet [I3].
  const standIn = yours ?? Keypair.random().publicKey();
  const knownAgentId = io.env["AGENT_ID"] === undefined || io.env["AGENT_ID"] === "" ? undefined : io.env["AGENT_ID"];
  let target: Launchable;
  let origin: string;
  if (flags.manifest !== undefined) {
    const loaded = await deployedTarget(flags.manifest, io.fetch);
    if ("problems" in loaded) return refuse(io, loaded.problems);
    target = loaded;
    origin = new URL(loaded.manifestUrl).origin;
  } else {
    origin = publicOrigin(flags.url, fly, io.env);
    try {
      target =
        config !== undefined
          ? await gatewayTarget(config, origin, standIn, io.env)
          : await commandTarget(flags.start!, origin, standIn, knownAgentId, io);
    } catch (error) {
      if (error instanceof ManifestProblems) return refuse(io, error.problems);
      throw error;
    }
  }
  const { manifest, manifestUrl } = target;
  const { network } = manifest.payment.accepts[0];
  // With --manifest, payTo is what the provider serves.
  const servedPayTo = flags.manifest !== undefined ? manifest.payment.accepts[0].payTo : yours;
  const name = plain(manifest.provider.name);
  io.log(`Launching ${name} on ${networkName(network)}`);
  io.log(`  manifest   ${manifestUrl}`);
  io.log(`  services   ${manifest.services.map((service) => service.name).join(", ")}`);

  // 3: what the chain has already.
  const registry = io.registry(network, flags.rpc);
  const chain = io.chain(network, flags.rpc);
  let agentUri: string;
  try {
    agentUri = registrationDataUri(registrationFile(manifest, manifestUrl));
  } catch {
    throw new Error("the registration file is over 8 KiB: shorten the provider's description, or host the file and use provider-kit register --agent-uri");
  }
  const existing = manifest.provider.agentId ?? (knownAgentId === undefined ? undefined : Number(knownAgentId));
  if (existing !== undefined && !(Number.isInteger(existing) && existing >= 0)) throw new UsageError(`AGENT_ID must be an agent id, not "${knownAgentId}"`);
  let owner: string | undefined;
  let payTo = servedPayTo;
  let registration: "new" | "update" | "current" = "new";
  if (existing !== undefined) {
    owner = await registry.agentOwner(existing);
    if (owner === undefined) return refuse(io, [`agent ${existing} doesn't exist in the ${network} identity registry [I2]. To register a new agent, empty AGENT_ID (or provider.agentId).`]);
    const wallet = await registry.agentWallet(existing);
    if (payTo !== undefined && wallet !== undefined && wallet !== payTo) {
      return refuse(io, [`agent ${existing}'s wallet is ${wallet}, but PAY_TO is ${payTo} [I3]. Set PAY_TO to the agent's wallet, or empty AGENT_ID to register anew.`]);
    }
    payTo ??= wallet ?? owner;
    registration = (await registry.agentUri(existing)) === agentUri ? "current" : "update";
  }

  const validator = flags["no-validation"] ? undefined : (flags.validator ?? defaultValidator(network, io.env));
  // A new or moved registration gets a new request. One already registered gets one when this verifier has none yet.
  const validating =
    validator !== undefined &&
    (registration !== "current" || flags.validate === true || !(await registry.agentValidations(existing!)).some((record) => record.validator === validator));
  if (validator === undefined && !flags["no-validation"]) {
    io.log(`  verifier   none named, so no validation is requested: --validator <G...> names one (or STELLAR_VALIDATOR)`);
  }

  // A payout account that won't connect here, such as an agent's wallet other than its owner, needs USDC already [P2].
  if (payTo !== undefined && registration !== "new" && payTo !== owner && stellarAddressKind(payTo) === "account" && !(await chain.account(payTo)).usdcTrustline) {
    return refuse(io, [`payTo ${payTo} has no USDC trustline, so it can't be paid [P2]: provider-kit trustline --network ${network === "stellar:pubnet" ? "mainnet" : "testnet"} adds one`]);
  }

  if (flags["dry-run"]) {
    const what = { new: "register a new agent", update: `update agent ${existing}'s registration`, current: `keep agent ${existing}'s registration, which is up to date` }[registration];
    io.log(`\nDry run. Without --dry-run, a page opens where your wallet would ${what}${validating ? `, and ask ${shortAddress(validator!)} for validation` : ""}. Nothing was signed.`);
    return 0;
  }

  // A deployed provider's settings are wherever it runs, not in this .env or fly.toml.
  const savedKind = flags.manifest !== undefined ? "yours" : kind;
  const savedFly = flags.manifest !== undefined ? undefined : fly;

  // 3: one approval page, for everything to sign.
  let connected: string | undefined;
  let registered: number | undefined;
  let sentRegistration = false;
  let requested: PreparedValidationRequest | undefined;
  let skipValidation = !validating;
  const agentIdNow = () => registered ?? existing;
  const needsSigning = registration !== "current" || validating || payTo === undefined || (stellarAddressKind(payTo) === "account" && !(await chain.account(payTo)).usdcTrustline);
  if (needsSigning) {
    const identity = registryConfig(network).contracts.identity;
    const outline: ApprovalPlan["outline"] = [{ id: "trustline", title: "Receive USDC" }];
    if (registration !== "current") outline.push({ id: "register", title: registration === "update" ? "Update registration" : "Register" });
    if (validating) outline.push({ id: "request-validation", title: "Ask for verification" });
    const plan: ApprovalPlan = {
      command: "provider-kit launch",
      title: registration === "new" ? "Launch your service" : "Update your service",
      intro:
        registration === "new"
          ? `Get paid for ${name} in your own wallet, list it in the Stellar 8004 registry so agents find it${validating ? ", and ask a verifier to check it" : ""}.`
          : `Point agent ${existing}'s registration at ${manifestUrl}${validating ? ", and ask a verifier to check it" : ""}.`,
      network,
      ...accountToConnect(registration, payTo, owner),
      outline,
      async steps(address) {
        if (registration === "new" && payTo !== undefined && address !== payTo) {
          throw new ApprovalError("Connect your payout account", `Your wallet connected ${shortAddress(address)}. Switch it to ${shortAddress(payTo)}, PAY_TO: the account that registers becomes the agent's wallet, which must be payTo [I3].`, "connect");
        }
        if (registration !== "new" && !(await mayActFor(registry, existing!, owner!, address))) {
          throw new ApprovalError("This account can't change the registration", `Your wallet connected ${shortAddress(address)}. Switch it to agent ${existing}'s owner, ${shortAddress(owner!)}, or an address it approved.`, "connect");
        }
        connected = address;
        const paidTo = payTo ?? address;
        const steps: ApprovalStep[] = await accountSteps(chain, address, { trustline: paidTo === address });
        // Connecting again after a later step failed: what already landed isn't done twice.
        if (registration !== "current" && !sentRegistration) {
          const step = registerStep(chain, {
            identity,
            caller: address,
            agentUri,
            manifestUrl,
            providerName: manifest.provider.name,
            ...(registration === "update" ? { agentId: existing! } : {}),
            onRegistered: (id) => (registered = id),
          });
          steps.push(afterDone(step, () => (sentRegistration = true)));
        }
        if (!skipValidation && requested === undefined) {
          if ([paidTo, owner, address].includes(validator)) {
            skipValidation = true;
            io.log(`  ! ${shortAddress(validator!)} is this provider's own account, so it can't validate it: no validation is requested`);
          } else {
            const prepare = async () => {
              const ready = structuredClone(manifest);
              ready.payment.accepts[0].payTo = paidTo;
              ready.provider.agentId = agentIdNow()!;
              try {
                return await prepareValidationRequest(ready, manifestUrl, { validator: validator!, registry, signer: address, now: () => io.now() });
              } catch (error) {
                if (error instanceof ValidationRequestError) throw new ApprovalError("Verification can't be requested yet", error.problems.join(" "), "rebuild");
                throw error;
              }
            };
            steps.push(validationRequestStep(chain, address, prepare, (prepared) => (requested = prepared)));
          }
        }
        return steps;
      },
      result() {
        const agentId = agentIdNow();
        return {
          title: registration === "new" ? "Your service is launched" : "Your service is updated",
          message: `${agentId === undefined ? "" : `It is agent ${agentId} on ${networkName(network)}. `}provider-kit saves the settings and goes on in your terminal.`,
          details: [
            ...(agentId === undefined ? [] : [{ label: "Agent", value: String(agentId) }]),
            ...(connected === undefined ? [] : [{ label: "Paid to", value: payTo ?? connected, mono: true, href: explorerUrl(network, "account", payTo ?? connected) }]),
            ...(requested === undefined ? [] : [{ label: "Verification request", value: requested.requestHash, mono: true }]),
          ],
        };
      },
    };
    const outcome = await io.approve(plan, chain);
    payTo ??= connected;
    // A new agent's id is saved even when a later step stopped: registering again would make a second agent.
    if (registered !== undefined || outcome.status === "done") await save(io, { target, envFile, fly: savedFly, origin, payTo, kind: savedKind, agentId: agentIdNow(), registered: registered !== undefined });
    if (outcome.status !== "done") {
      io.log(describeOutcome(outcome));
      if (registered !== undefined) io.log(`Agent ${registered} is registered and saved. Run ${nextCommand("launch")} again to finish.`);
      return 1;
    }
  } else {
    io.log(`  ✓ agent ${existing} is registered, and its registration names this manifest: nothing to sign`);
    await save(io, { target, envFile, fly: savedFly, origin, payTo: payTo!, kind: savedKind, agentId: existing, registered: false });
  }

  const agentId = agentIdNow()!;
  io.log(`\n✓ ${name} is agent ${agentId} on ${networkName(network)}, paid to ${payTo}`);
  if (requested !== undefined) {
    io.log(`✓ Validation requested from ${requested.request.validator} (request ${requested.requestHash.slice(0, 16)}…): its answer lands in the Validation Registry`);
  }

  // 5: deploy, then wait for the public manifest.
  if (flags.manifest !== undefined) {
    if (registered !== undefined) io.log(`\nNext: set AGENT_ID=${agentId} (or provider.agentId) where the provider runs, and restart it [I2]. ${nextCommand("status")} then shows it live.`);
    return 0;
  }
  // Inside a deployed container, 127.0.0.1 is the container: every paid call would fail, after an upfront charge.
  const unreachable = config === undefined ? [] : await loopbackUpstreams(config);
  if (unreachable.length > 0) {
    io.log(`\n  ! ${unreachable.join(", ")} ${unreachable.length === 1 ? "calls its API" : "call their API"} at 127.0.0.1, which in a deployed container is the container itself.`);
    io.log(`    Before deploying, set each upstream.url in ${config} to an address the container reaches, such as your API's public URL.`);
  }
  const deploying = fly !== undefined && unreachable.length === 0 && (await shouldDeploy(flags, io, fly));
  if (fly !== undefined && unreachable.length > 0 && flags.deploy) {
    io.log(`  ✗ Not deployed. Once upstream.url is set, ${nextCommand("deploy", "fly deploy --ha=false")}.`);
    return 1;
  }
  if (deploying) {
    await stageSecrets(io, fly!, target);
    const problem = await flyDeploy(io.fly, fly!, io.log);
    if (problem !== undefined) {
      io.log(`  ✗ ${problem}`);
      io.log(`Everything else is saved: deploy again with ${nextCommand("deploy", "fly deploy --ha=false")}, then ${nextCommand("status")}.`);
      return 1;
    }
  } else {
    printDeploy(io, { fly, origin, payTo: payTo!, agentId, target });
  }
  if (!deploying || flags["no-wait"]) {
    io.log(`\n${nextCommand("status")} shows where it stands: live, registered, verified.`);
    return 0;
  }
  return checkLive(io, { manifestUrl, agentId, payTo: payTo!, network, rpc: flags.rpc });
}

/** The public origin: --url, fly.toml's app, or an https:// PUBLIC_ORIGIN. */
function publicOrigin(url: string | undefined, fly: FlyApp | undefined, env: NodeJS.ProcessEnv): string {
  const fromEnv = env["PUBLIC_ORIGIN"]?.startsWith("https://") ? env["PUBLIC_ORIGIN"] : undefined;
  const candidate = url ?? fly?.origin ?? fromEnv;
  if (candidate === undefined) {
    throw new UsageError("launch needs the HTTPS address your service will have: --url https://api.example.com, an app in fly.toml, or an https:// PUBLIC_ORIGIN");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new UsageError(`${candidate} is not a URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new UsageError(`the public address must be https://, with no user name: ${candidate} [M6]`);
  if (isTemporaryUrl(candidate)) {
    throw new UsageError(`${parsed.host} is a quick tunnel's address, which changes every run: the registry would soon point nowhere. Deploy the service, then launch with its address`);
  }
  return candidate.replace(/\/+$/, "");
}

class ManifestProblems extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

/** A gateway's manifest at `origin`, built from its config as `serve` builds it. Variables it needs only to run get stand-ins. */
async function gatewayTarget(config: string, origin: string, payTo: string, env: NodeJS.ProcessEnv): Promise<Launchable> {
  const parsed = JSON.parse(await readFile(config, "utf8")) as { provider?: { agentId?: unknown } };
  const local: NodeJS.ProcessEnv = { ...env, PAY_TO: payTo };
  const agentIdVariable = typeof parsed.provider?.agentId === "string" ? parsed.provider.agentId.slice("env:".length) : undefined;
  for (const { name, field } of variablesRead(parsed)) {
    if (name === agentIdVariable || (local[name] !== undefined && local[name] !== "")) continue;
    // Only the manifest is built here: what the gateway needs only to run, such as the API's key, gets a stand-in.
    local[name] = /url|origin|facilitator/i.test(field) ? "https://stand-in.invalid" : "stand-in";
  }
  let built;
  try {
    const { config: providerConfig } = await loadGatewayConfig(config, { env: local, openStore: false, overrides: { baseUrl: origin, dev: false } });
    const provider = createProvider(providerConfig);
    await provider.close();
    built = provider;
  } catch (error) {
    throw new ManifestProblems([(error as Error).message]);
  }
  const agentId = parsed.provider?.agentId;
  const secrets = new Set(variablesRead(parsed).map(({ name }) => name).filter((name) => !SETTINGS.has(name) && name !== agentIdVariable));
  return {
    manifest: built.manifest,
    manifestUrl: built.manifestUrl,
    agentIdGoes: typeof agentId === "string" && agentId.startsWith("env:") ? { variable: agentId.slice("env:".length) } : { config },
    // The image carries the config, network and all.
    settings: {},
    secrets: { names: [...secrets], required: true },
  };
}

/** Any provider's manifest at `origin`: its own command, started here on a free port with PUBLIC_ORIGIN set, then stopped. */
async function commandTarget(command: string, origin: string, payTo: string, agentId: string | undefined, io: LaunchIo): Promise<Launchable> {
  const port = await io.freePort();
  // The command's job database, used for a few seconds and then thrown away.
  const database = join(tmpdir(), `provider-kit-launch-${process.pid}-${port}.sqlite`);
  io.log(`  … Starting ${command} to read its manifest as ${origin} will serve it`);
  const started = io.start(command, { PUBLIC_ORIGIN: origin, PAY_TO: payTo, PORT: String(port), JOB_DB_PATH: database, AGENT_ID: agentId ?? "" });
  try {
    const manifest = await waitForManifest(`http://127.0.0.1:${port}${DEFAULT_MANIFEST_PATH}`, { exited: started.exited, timeoutMs: 90_000, fetch: io.fetch });
    const manifestUrl = new URL(DEFAULT_MANIFEST_PATH, new URL(origin).origin).toString();
    const problems = checkManifest(manifest, manifestUrl, false).map((violation) => `[${violation.rule}] ${violation.pointer || "/"}: ${violation.message}`);
    if (typeof manifest.baseUrl === "string" && !manifest.baseUrl.startsWith(origin)) {
      problems.push(`its baseUrl is ${manifest.baseUrl}, not under ${origin}: have it read PUBLIC_ORIGIN, as the template's src/server.ts does`);
    }
    if (problems.length > 0) throw new ManifestProblems(problems);
    const facilitatorUrl = io.env["FACILITATOR_URL"];
    return {
      manifest,
      manifestUrl,
      agentIdGoes: { variable: "AGENT_ID" },
      // The deployed provider must take payments on the network registered here: it reads STELLAR_NETWORK, as this one
      // did from .env (the TypeScript template's default is testnet).
      settings: { STELLAR_NETWORK: manifest.payment.accepts[0].network, ...(facilitatorUrl ? { FACILITATOR_URL: facilitatorUrl } : {}) },
      secrets: { names: COMMAND_SECRETS, required: false },
    };
  } catch (error) {
    if (error instanceof ManifestProblems) throw error;
    const output = started.output().trim().split("\n").slice(-12).join("\n");
    throw new Error(`${command} didn't serve its manifest: ${(error as Error).message}${output === "" ? "" : `\nIts output:\n${output}`}`);
  } finally {
    await started.stop();
    await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(`${database}${suffix}`, { force: true })));
  }
}

/**
 * The services of a gateway config that call an API on 127.0.0.1 or localhost, which a container can't reach unless
 * the API runs inside it too, as the Python kind's does (start.sh starts both).
 */
async function loopbackUpstreams(config: string): Promise<string[]> {
  if (existsSync(join(dirname(config), "start.sh"))) return [];
  const { services } = JSON.parse(await readFile(config, "utf8")) as { services?: { name?: string; upstream?: { url?: unknown } }[] };
  return (services ?? []).flatMap((service) => {
    const url = service.upstream?.url;
    if (typeof url !== "string" || url.startsWith("env:")) return [];
    try {
      return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) ? [service.name ?? "a service"] : [];
    } catch {
      return [];
    }
  });
}

/** A deployed provider's manifest, read and checked as a client reads it. */
async function deployedTarget(url: string, fetcher: typeof fetch): Promise<Launchable | { problems: string[] }> {
  if (!url.startsWith("https://")) return { problems: [`${url} isn't https://: a deployed provider's manifest is served over HTTPS [M6]`] };
  const response = await fetcher(url, { redirect: "manual", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200) return { problems: [`[M1] the manifest answered ${response.status}; redirects are not followed [M3]`] };
  let manifest: ProviderManifest;
  try {
    manifest = (await response.json()) as ProviderManifest;
  } catch {
    return { problems: ["the manifest is not valid JSON"] };
  }
  const violations = checkManifest(manifest, url, false);
  if (violations.length > 0) return { problems: violations.map((violation) => `[${violation.rule}] ${violation.pointer || "/"}: ${violation.message}`) };
  return { manifest, manifestUrl: url, agentIdGoes: { variable: "AGENT_ID" }, settings: {}, secrets: { names: [], required: false } };
}

/** Every "env:NAME" a gateway config reads, with the field it fills. */
function variablesRead(value: unknown, field = ""): { name: string; field: string }[] {
  if (typeof value === "string") return value.startsWith("env:") ? [{ name: value.slice("env:".length), field }] : [];
  if (Array.isArray(value)) return value.flatMap((item) => variablesRead(item, field));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => variablesRead(item, key));
  return [];
}

/** The account the page asks for: payTo for a new agent when PAY_TO names one, the owner for an update, else any. */
function accountToConnect(registration: "new" | "update" | "current", payTo: string | undefined, owner: string | undefined): Pick<ApprovalPlan, "account"> {
  if (registration === "new") {
    return payTo === undefined ? {} : { account: { address: payTo, label: "Payout account", reason: "PAY_TO: the account clients pay. Registering from it makes it the agent's owner and wallet." } };
  }
  return { account: { address: owner!, label: "Agent owner", reason: "Only the agent's owner, the address approved for it, or an operator of the owner's can change it." } };
}

/** A step that also runs `then` once it has gone through. */
function afterDone(step: ApprovalStep, then: () => void): ApprovalStep {
  if (step.kind !== "sign") return step;
  return {
    ...step,
    async done(sent) {
      const note = await step.done(sent);
      then();
      return note;
    },
  };
}

function refuse(io: LaunchIo, problems: string[]): number {
  io.log(`Not launched. Nothing was signed:\n${problems.map((problem) => `  ✗ ${problem}`).join("\n")}`);
  return 1;
}

/** Saves what launch settled: PAY_TO and the agent id where the provider reads them, and fly.toml's public settings. */
async function save(
  io: LaunchIo,
  options: { target: Launchable; envFile: string; fly: FlyApp | undefined; origin: string; payTo: string | undefined; kind: string; agentId: number | undefined; registered: boolean },
): Promise<void> {
  const { target, envFile, fly, payTo, agentId } = options;
  const values: Record<string, string | undefined> = {};
  if (payTo !== undefined && options.kind !== "yours") Object.assign(values, { PAY_TO: payTo, [DEV_PAY_TO]: undefined });
  let savedTo: string | undefined;
  if (agentId !== undefined && "variable" in target.agentIdGoes) values[target.agentIdGoes.variable] = String(agentId);
  else if (agentId !== undefined && options.registered && "config" in target.agentIdGoes) {
    savedTo = (await saveAgentId(target.agentIdGoes.config, agentId)) ? target.agentIdGoes.config : undefined;
  }
  if (Object.keys(values).length > 0) {
    const written = await updateEnvFile(envFile, values, { comments: { AGENT_ID: "Your Stellar 8004 agent id: provider-kit launch saved it." } });
    const shown = Object.entries(values).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${value}`);
    if (written) io.log(`  ✓ Saved ${shown.join(", ")} in ${envFile}`);
    else io.log(`  ! No ${envFile} here: set ${shown.join(" ")} where the provider runs`);
  }
  if (savedTo !== undefined) io.log(`  ✓ Saved "agentId": ${agentId} to ${savedTo} [I2]`);
  // fly.toml gets the address launch registered, its own app's or a domain of yours that points at it.
  if (fly !== undefined) {
    const settings: Record<string, string> = { PUBLIC_ORIGIN: options.origin };
    if (payTo !== undefined) settings["PAY_TO"] = payTo;
    if (agentId !== undefined && "variable" in target.agentIdGoes) settings[target.agentIdGoes.variable] = String(agentId);
    Object.assign(settings, target.settings);
    await setFlyEnv(fly.path, settings);
    io.log(`  ✓ Saved ${Object.keys(settings).join(", ")} in ${fly.path}'s [env], for every deploy`);
  }
}

async function shouldDeploy(flags: CliFlags, io: LaunchIo, fly: FlyApp): Promise<boolean> {
  if (flags["no-deploy"]) return false;
  if (flags.deploy) return true;
  if (!io.interactive) {
    io.log(`\nNot deployed: --deploy deploys to Fly.io (fly deploy, app ${fly.app}) without asking.`);
    return false;
  }
  return io.confirm(`\nDeploy to Fly.io now (fly deploy, app ${fly.app})? [Y/n] `);
}

/**
 * The provider's variables that may hold keys, such as its API's key or the facilitator's, staged as Fly secrets from
 * .env for the deploy. A required one that isn't set here is named: the deployed provider can't start without it.
 */
async function stageSecrets(io: LaunchIo, fly: FlyApp, target: Launchable): Promise<void> {
  const secrets: Record<string, string> = {};
  const unset: string[] = [];
  for (const name of target.secrets.names) {
    const value = io.env[name];
    if (value !== undefined && value !== "") secrets[name] = value;
    else if (target.secrets.required) unset.push(name);
  }
  const names = Object.keys(secrets);
  if (names.length > 0) {
    if (await flySecrets(io.fly, fly.app, secrets)) io.log(`  ✓ Staged ${names.join(", ")} as Fly secrets, from your environment`);
    else io.log(`  ! ${names.join(", ")} couldn't be staged as Fly secrets: fly secrets set them, or the service can't start`);
  }
  if (unset.length > 0) {
    io.log(`  ! ${unset.join(", ")} ${unset.length === 1 ? "isn't" : "aren't"} set here, so not staged: unless Fly has ${unset.length === 1 ? "it" : "them"} already, the service can't start. fly secrets set ${unset[0]}=...`);
  }
}

function printDeploy(io: LaunchIo, options: { fly: FlyApp | undefined; origin: string; payTo: string; agentId: number; target: Launchable }): void {
  if (options.fly !== undefined) {
    io.log(`\nDeploy when you're ready: ${nextCommand("deploy", "fly deploy --ha=false")}. fly.toml has the settings.`);
    return;
  }
  const { agentIdGoes, settings: more, secrets } = options.target;
  const settings = [
    `PUBLIC_ORIGIN=${options.origin}`,
    `PAY_TO=${options.payTo}`,
    ...("variable" in agentIdGoes ? [`${agentIdGoes.variable}=${options.agentId}`] : []),
    ...Object.entries(more).map(([name, value]) => `${name}=${value}`),
  ];
  io.log(`\nDeploy it at ${options.origin} with these settings, and a persistent volume for its job database (JOB_DB_PATH):`);
  io.log(`  ${settings.join(" ")}`);
  // Only the names: their values stay in .env, to be set as secrets where it runs.
  const kept = secrets.names.filter((name) => io.env[name] !== undefined && io.env[name] !== "");
  if (kept.length > 0) io.log(`  and, as secrets there, ${kept.join(", ")} from .env`);
}

/** Waits for the public manifest to serve the agent id, then checks the registration from outside [I1]–[I3]. */
async function checkLive(io: LaunchIo, options: { manifestUrl: string; agentId: number; payTo: string; network: StellarNetwork; rpc: string | undefined }): Promise<number> {
  io.log(`\n  … Waiting for ${options.manifestUrl} to serve agent ${options.agentId}`);
  const deadline = Date.now() + LIVE_WAIT_MS;
  let served: ProviderManifest | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await io.fetch(options.manifestUrl, { redirect: "manual", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (response.status === 200) {
        const manifest = (await response.json()) as ProviderManifest;
        if (manifest.provider?.agentId === options.agentId && manifest.payment?.accepts?.[0]?.payTo === options.payTo) {
          served = manifest;
          break;
        }
      } else {
        await response.body?.cancel();
      }
    } catch {
      // Not up yet.
    }
    await io.sleep(LIVE_POLL_MS);
  }
  if (served === undefined) {
    io.log(`  ! It doesn't serve agent ${options.agentId} yet. ${nextCommand("status")} checks again later.`);
    return 1;
  }
  // Testnet and mainnet never mix: an agent registered on one network must take payments on that network.
  const servedNetwork = served.payment.accepts[0]?.network;
  if (servedNetwork !== options.network) {
    io.log(`  ✗ It serves agent ${options.agentId} with payments on ${JSON.stringify(servedNetwork)}, but the agent is registered on ${options.network}.`);
    io.log(`    Its deployed settings must name ${options.network}: fix them, deploy again, then ${nextCommand("status")}.`);
    return 1;
  }
  io.log(`  ✓ Live: ${options.manifestUrl}`);
  const { findings } = await inspectRegistration(served, options.manifestUrl, { registry: io.registry(options.network, options.rpc), fetch: io.fetch });
  for (const finding of findings) io.log(`  ${finding.ok ? "✓" : "✗"} 8004 [${finding.rule}]: ${finding.message}`);
  return findings.every((finding) => finding.ok) ? 0 : 1;
}
