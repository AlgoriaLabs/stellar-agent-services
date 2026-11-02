// provider-kit dev: runs a provider on this computer, on testnet, with nothing to set up first
// (docs/provider-setup-guide.md §2).
//
//   provider-kit dev [--config <file>] [--port <n>] [--with '<command>'] [--tunnel]   a gateway, in this process
//   provider-kit dev [--port <n>] [--tunnel] -- <command> [args...]                   any other provider, by its command
//
// 1. Reads .env (or --env-file), as `node --env-file` does: a variable already set wins.
// 2. PAY_TO: the one set, else a throwaway testnet account made now (dev-account.ts), so test payments work before any
//    wallet is connected. The provider only ever sees the public address.
// 3. Runs the provider: the gateway from --config (default ./provider.config.json) in dev mode, or the command after
//    `--` with PAY_TO in its environment. --with runs the API the gateway calls next to it, such as
//    `uvicorn app:app`, waits until it takes connections, and stops both when either one stops.
// 4. --tunnel also serves it at a public HTTPS address (tunnel.ts), to try it from anywhere.
// `provider-kit try` then pays it once; `provider-kit launch` takes it live.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { DEFAULT_PORT } from "../gateway/config.js";
import { devPayTo, type DevPayTo } from "./dev-account.js";
import { ENV_FILE, loadEnvFile } from "./env-file.js";
import { rpcOwnerChain, shortAddress, type OwnerChain } from "./owner-chain.js";
import { startCommand, startForeground, type Started } from "./processes.js";
import { serveGateway, stopOnSignals } from "./serve.js";
import { DEFAULT_CONFIG, nextCommand, UsageError, type CliFlags } from "./shared.js";
import { quickTunnel, type Tunnel } from "./tunnel.js";

/** Where `dev` reaches the outside world. Tests replace it. */
export interface DevIo {
  log(line: string): void;
  chain(network: StellarNetwork): OwnerChain;
  tunnel(port: number): Promise<Tunnel>;
  serve: typeof serveGateway;
  /** Runs the provider's own command, or the --with command, in this terminal. */
  start(command: string, args: string[], options: { env: NodeJS.ProcessEnv; shell: boolean }): Started;
  /** Keeps running until a signal, then runs `stop`: the gateway's way to end. */
  untilStopped(stop: () => Promise<void>): void;
  /** Resolves once something takes connections at host:port. Rejects when `exited` resolves first, or after `timeoutMs`. */
  waitForPort(host: string, port: number, exited: Promise<number>, timeoutMs: number): Promise<void>;
  env: NodeJS.ProcessEnv;
}

export function devIo(): DevIo {
  const log = (line: string) => console.log(line);
  return {
    log,
    chain: (network) => rpcOwnerChain(network),
    tunnel: (port) => quickTunnel(port),
    serve: serveGateway,
    start: (command, args, { env, shell }) => (shell ? startCommand(command, { env, show: true }) : startForeground(command, args, { env })),
    untilStopped: (stop) => stopOnSignals(stop, log),
    waitForPort,
    env: process.env,
  };
}

/** How long --with's API may take to start: uv may be installing its packages the first time. */
const API_START_MS = 180_000;

async function waitForPort(host: string, port: number, exited: Promise<number>, timeoutMs: number): Promise<void> {
  let stopped: number | undefined;
  void exited.then((code) => (stopped = code));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopped !== undefined) throw new Error(`it stopped (exit code ${stopped})`);
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`nothing took connections at ${host}:${port} in ${Math.round(timeoutMs / 1000)} s`);
}

/** provider-kit dev [-- <command> ...]: -1 while a gateway runs, else the command's exit code. */
export async function dev(flags: CliFlags, command: string[], io: DevIo = devIo()): Promise<number> {
  if (command.length > 0 && (flags.config !== undefined || flags.with !== undefined)) {
    throw new UsageError("dev runs a gateway (--config, --with) or your provider's own command (after --), not both");
  }
  const envFile = flags["env-file"] ?? ENV_FILE;
  if (flags["env-file"] !== undefined && !existsSync(envFile)) throw new UsageError(`${envFile} doesn't exist`);
  await loadEnvFile(envFile, io.env);

  const config = command.length > 0 ? undefined : (flags.config ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined));
  if (command.length === 0 && config === undefined) {
    throw new UsageError(`dev needs a gateway config (--config, or ./${DEFAULT_CONFIG}), or your provider's command after --, such as: provider-kit dev -- node dist/server.js`);
  }
  const network = config === undefined ? commandNetwork(io.env) : await configNetwork(config);
  const port = flags.port === undefined ? (io.env["PORT"] === undefined ? (config === undefined ? DEFAULT_PORT : undefined) : Number(io.env["PORT"])) : Number(flags.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new UsageError("--port must be a port number");

  const payTo = await devPayTo({ env: io.env, network, chain: () => io.chain(network), envFile, log: io.log });

  let tunnel: Tunnel | undefined;
  if (flags.tunnel) {
    const tunnelPort = port ?? (config === undefined ? DEFAULT_PORT : await configPort(config));
    io.log(`  … Opening a public HTTPS address for port ${tunnelPort} (cloudflared)`);
    tunnel = await io.tunnel(tunnelPort);
    io.log(`  ✓ Public address ${tunnel.url}: it changes every run, so it is for trying things out, not for registering`);
  }

  if (config === undefined) return runCommand(command, { io, payTo, tunnel, port: port ?? DEFAULT_PORT });
  return runGateway(config, { io, payTo, tunnel, port, with: flags.with });
}

/** The gateway, in this process, with the --with command next to it. Keeps running: -1. */
async function runGateway(config: string, options: { io: DevIo; payTo: DevPayTo; tunnel: Tunnel | undefined; port: number | undefined; with: string | undefined }): Promise<number> {
  const { io, tunnel } = options;
  let companion: Started | undefined;
  if (options.with !== undefined) {
    io.log(`  … Starting ${options.with}`);
    companion = io.start(options.with, [], { env: io.env, shell: true });
    // The gateway serves once the API takes connections, so the first paid call doesn't arrive before it.
    const api = await upstreamAddress(config, io.env);
    if (api !== undefined) {
      try {
        await io.waitForPort(api.host, api.port, companion.exited, API_START_MS);
      } catch (error) {
        await companion.stop();
        await tunnel?.stop();
        throw new Error(`${options.with} didn't start: ${(error as Error).message}`);
      }
      io.log(`  ✓ ${options.with} takes connections at ${api.host}:${api.port}`);
    }
  }
  let served;
  try {
    served = await io.serve(config, {
      dev: tunnel === undefined,
      env: io.env,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(tunnel === undefined ? {} : { baseUrl: tunnel.url }),
      log: io.log,
    });
  } catch (error) {
    await companion?.stop();
    await tunnel?.stop();
    throw error;
  }
  const { server } = served;
  printNext(io, options.payTo);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await companion?.stop();
    await tunnel?.stop();
    await server.close();
  };
  void companion?.exited.then(async (code) => {
    // A stop signal reaches this process too: give its handler the first word.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (stopped) return;
    io.log(`provider-kit: ${options.with} stopped (exit code ${code}), so the gateway stops too`);
    await stop();
    process.exit(code === 0 ? 1 : code);
  });
  io.untilStopped(stop);
  return -1;
}

/** The provider's own command, with PAY_TO (and the tunnel's PUBLIC_ORIGIN) in its environment. Its exit code. */
async function runCommand(command: string[], options: { io: DevIo; payTo: DevPayTo; tunnel: Tunnel | undefined; port: number }): Promise<number> {
  const { io, payTo, tunnel } = options;
  const env: NodeJS.ProcessEnv = { ...io.env, PAY_TO: payTo.payTo, PORT: String(options.port), ...(tunnel === undefined ? {} : { PUBLIC_ORIGIN: tunnel.url }) };
  printNext(io, payTo);
  const child = io.start(command[0]!, command.slice(1), { env, shell: false });
  // Ctrl+C reaches the command too: it stops, and so does this, with its exit code.
  const ignore = () => {};
  const forward = () => void child.stop();
  process.on("SIGINT", ignore);
  process.on("SIGTERM", forward);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", forward);
    await tunnel?.stop();
  }
}

function printNext(io: DevIo, payTo: DevPayTo): void {
  if (payTo.kind === "throwaway") {
    io.log(`  payTo      ${shortAddress(payTo.payTo)} is a throwaway testnet account: test payments land there, and nobody can spend them.`);
    io.log(`             ${nextCommand("launch")} connects your own wallet and takes the service live.`);
  }
  io.log(`\nNext, from another terminal: ${nextCommand("try")} pays for one call with test money.\n`);
}

/** The network of a gateway config, as written in it. */
async function configNetwork(path: string): Promise<StellarNetwork> {
  let network: unknown;
  try {
    network = (JSON.parse(await readFile(path, "utf8")) as { network?: unknown }).network;
  } catch (error) {
    throw new Error(`${path} can't be read: ${(error as Error).message}`);
  }
  if (network !== "stellar:testnet" && network !== "stellar:pubnet") throw new Error(`${path} has no network: stellar:testnet or stellar:pubnet`);
  return network;
}

/** Where a gateway config's first service calls its API, when that is on this computer: what --with starts. */
async function upstreamAddress(path: string, env: NodeJS.ProcessEnv): Promise<{ host: string; port: number } | undefined> {
  const services = (JSON.parse(await readFile(path, "utf8")) as { services?: { upstream?: { url?: unknown } }[] }).services;
  let url = services?.[0]?.upstream?.url;
  if (typeof url === "string" && url.startsWith("env:")) url = env[url.slice("env:".length)];
  if (typeof url !== "string") return undefined;
  try {
    const { hostname, port, protocol } = new URL(url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return undefined;
    return { host: hostname === "[::1]" ? "::1" : hostname, port: Number(port || (protocol === "https:" ? 443 : 80)) };
  } catch {
    return undefined;
  }
}

/** The port a gateway config listens on, for the tunnel. */
async function configPort(path: string): Promise<number> {
  const listen = (JSON.parse(await readFile(path, "utf8")) as { listen?: { port?: unknown } }).listen;
  return typeof listen?.port === "number" ? listen.port : DEFAULT_PORT;
}

/** A provider run by its own command reads STELLAR_NETWORK, as the TypeScript template does. Testnet by default. */
function commandNetwork(env: NodeJS.ProcessEnv): StellarNetwork {
  const network = env["STELLAR_NETWORK"] ?? "stellar:testnet";
  if (network !== "stellar:testnet" && network !== "stellar:pubnet") throw new UsageError(`STELLAR_NETWORK must be stellar:testnet or stellar:pubnet, not "${network}"`);
  return network;
}
