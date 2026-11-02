// verifier watch: answers validation requests by itself (docs/verification.md). It follows the Stellar 8004
// Validation Registry for requests naming the validator, the address of a Stellar CLI key (--source); checks
// each provider with the test payer (VERIFIER_PAYER_SECRET); serves receipts and badges for --public-url;
// and publishes validation_response, signed by the Stellar CLI. The validator key never enters this
// process. The engine is ../watch.ts.
//
// It runs until SIGINT or SIGTERM, then finishes the step in progress; a second signal stops it at once.

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stellarAddressKind, type StellarNetwork } from "@stellar-agent-services/protocol";
import { rpcChain, type ChainReader } from "../chain.js";
import { formatUsdc } from "../payments.js";
import { rpcRegistry } from "../registry.js";
import { DEFAULT_MAX_PRICE, DEFAULT_MAX_SPEND } from "../verify.js";
import { DEFAULT_RETRY_FOR_MS, isPublicUrl, openWatcher } from "../watch.js";
import { lockDataDir } from "../watch-state.js";
import { testPayer, usdc } from "./run.js";
import { serveHttp, type Served } from "./serve.js";
import { UsageError, type CliFlags, type Io } from "./shared.js";

/** The networks watch works on, by their Stellar CLI names, which sign the responses. */
const NETWORKS: Readonly<Record<string, StellarNetwork>> = { testnet: "stellar:testnet", mainnet: "stellar:pubnet" };
const DEFAULT_PORT = "8080";
const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 5;

export async function watch(flags: CliFlags, io: Io): Promise<number> {
  for (const flag of ["pay", "dev", "json", "service", "input", "validator", "out", "request-hash", "response-uri", "max-age", "dry-run"] as const) {
    if (flags[flag] !== undefined) throw new UsageError(`--${flag} does not apply to watch`);
  }
  const source = flags.source;
  const publicUrl = flags["public-url"]?.replace(/\/+$/, "");
  if (source === undefined || publicUrl === undefined) {
    throw new UsageError("watch needs --source (a key in the Stellar CLI keychain) and --public-url (the https:// URL it is served at)");
  }
  if (!isPublicUrl(publicUrl)) throw new UsageError("--public-url must be an https:// URL without user info, query or fragment: the chain links the receipts there");
  const cliNetwork = flags.network ?? "testnet";
  const network = NETWORKS[cliNetwork];
  if (network === undefined) throw new UsageError("--network must be testnet or mainnet, as the Stellar CLI names them");
  if (network === "stellar:pubnet" && !flags["allow-pubnet"]) throw new UsageError("on mainnet the test payer pays providers real money: add --allow-pubnet");
  const port = Number(flags.port ?? io.env["PORT"] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be a port number");
  const intervalS = positive(flags.interval, "--interval", "a number of seconds", DEFAULT_INTERVAL_S);
  if (intervalS < MIN_INTERVAL_S) throw new UsageError(`--interval must be at least ${MIN_INTERVAL_S} seconds`);
  const retryForMs = positive(flags["retry-for"], "--retry-for", "a number of hours", DEFAULT_RETRY_FOR_MS / 3600_000) * 3600_000;
  const maxPrice = usdc(flags["max-price"], "--max-price") ?? DEFAULT_MAX_PRICE;
  const maxSpend = usdc(flags["max-spend"], "--max-spend") ?? DEFAULT_MAX_SPEND;
  const dataDir = resolve(flags.data ?? "verifier-data");
  const payer = testPayer(io, flags.rpc, "watch");
  let chain: ChainReader;
  try {
    chain = io.chain ?? rpcChain(network, flags.rpc);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  // The validator is the Stellar CLI key's address. The key stays in the keychain.
  const stellar = io.stellar;
  if (stellar === undefined) throw new Error("watch needs the Stellar CLI, which signs its answers: https://developers.stellar.org/docs/tools/cli");
  let validator: string;
  try {
    validator = (await stellar(["keys", "address", source])).trim();
  } catch {
    throw new Error(`the Stellar CLI could not read key "${source}". Create it with: stellar keys generate ${source} --network ${cliNetwork} --fund`);
  }
  if (stellarAddressKind(validator) !== "account") throw new Error(`key "${source}" is not a G... account`);
  if (validator === payer.address) throw new UsageError("the test payer is the validator: give each its own account, so the validator key never enters this process");

  await mkdir(dataDir, { recursive: true });
  const lock = await lockDataDir(dataDir);
  let server: Served | undefined;
  let release = () => {};
  try {
    const now = io.now ?? Date.now;
    const watcher = await openWatcher({
      network,
      validator,
      registry: io.registry ?? rpcRegistry(network, flags.rpc),
      chain,
      payer,
      publicUrl,
      dataDir,
      stellar,
      source,
      cliNetwork,
      maxPrice,
      maxSpend,
      allowPubnet: flags["allow-pubnet"] ?? false,
      retryForMs,
      now,
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      log: (line) => io.out(`${new Date(now()).toISOString()}  ${line}`),
    });
    server = await (io.serve ?? serveHttp)((request) => watcher.handle(request), port);

    io.out(`verifier watch: answering validation requests to ${validator} on ${network}`);
    io.out(`  validator   Stellar CLI key "${source}" (${cliNetwork}); the key stays in its keychain`);
    io.out(`  test payer  ${payer.address}: at most ${formatUsdc(maxPrice)} a job and ${formatUsdc(maxSpend)} a run`);
    io.out(`  receipts    ${publicUrl}/receipts/<sha256>.json`);
    io.out(`  listening   ${server.url}`);
    io.out(`  data        ${dataDir}`);
    io.out(`  every ${intervalS} s; a provider that is not reachable yet is checked again for ${retryForMs / 3600_000} h`);

    let signal = io.signal;
    if (signal === undefined) ({ signal, release } = processSignals(io));
    if (signal.aborted) watcher.stop();
    else signal.addEventListener("abort", () => watcher.stop(), { once: true });
    const sleep = io.sleep ?? ((ms: number, until: AbortSignal) => delay(ms, undefined, { signal: until }).catch(() => {}));
    while (!signal.aborted) {
      await watcher.tick();
      if (signal.aborted) break;
      await sleep(intervalS * 1000, signal);
    }
  } finally {
    release();
    await server?.close();
    await lock.release();
  }
  io.out("verifier watch: stopped");
  return 0;
}

/** SIGINT or SIGTERM stops the watcher after its current step; a second one stops the process at once. */
function processSignals(io: Io): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const stop = (name: NodeJS.Signals) => {
    if (controller.signal.aborted) process.exit(1);
    io.out(`verifier watch: ${name}, stopping after the current step (send it again to stop now)`);
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return {
    signal: controller.signal,
    release() {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}

function positive(value: string | undefined, flag: string, what: string, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${flag} must be ${what} above zero`);
  return number;
}
