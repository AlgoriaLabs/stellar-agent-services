// Makes a project with create-stellar-service and checks it as a developer would use it, for one kind and network:
// the files and settings it writes, that it installs and builds, and that it starts a provider the verifier passes, with
// payments on the network asked for. No key and no payment: the facilitator and the verifier's chain lookup are stand-ins
// on this computer, unless --real-facilitator, and only --pay pays, with test money. Run after `npm run build`.
//
//   node scripts/scaffold-check.mjs --kind wrap|typescript|python --network testnet|mainnet
//     --scaffolder '<command>'   how to run create-stellar-service. Default: this clone's build.
//     --kit vendor|npm           where the project gets the kit: packed from this clone (default), or a registry
//     --real-facilitator         start it against its real facilitator. Mainnet's needs FACILITATOR_AUTH.
//     --pay                      then pay for one call with test money: provider-kit try --yes (typescript, testnet)
//     --docker                   build its Dockerfile too
//     --keep                     keep the project folder

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";

const built = (path) => import(new URL(`../packages/${path}`, import.meta.url).href);
const { USDC_ASSET } = await built("protocol/dist/index.js");
const { verifyProvider } = await built("verifier/dist/index.js");
const { FACILITATORS, MAINNET_RPC } = await built("create-stellar-service/dist/files.js");
const CLONE_SCAFFOLDER = fileURLToPath(new URL("../packages/create-stellar-service/dist/index.js", import.meta.url));

const NETWORKS = { testnet: "stellar:testnet", mainnet: "stellar:pubnet" };
const KINDS = ["wrap", "typescript", "python"];
const DESCRIPTION = "Summaries of English text, for checking the scaffolder.";
const KIT_CLI = "node_modules/@stellar-agent-services/provider-kit/dist/cli/index.js";

const { values } = parseArgs({
  options: {
    kind: { type: "string" },
    network: { type: "string" },
    scaffolder: { type: "string" },
    kit: { type: "string", default: "vendor" },
    "real-facilitator": { type: "boolean", default: false },
    pay: { type: "boolean", default: false },
    docker: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});
const usage = (message) => {
  console.error(`scaffold-check: ${message}`);
  process.exit(2);
};
if (!KINDS.includes(values.kind)) usage("--kind must be wrap, typescript or python");
if (!(values.network in NETWORKS)) usage("--network must be testnet or mainnet");
if (values.kit !== "vendor" && values.kit !== "npm") usage("--kit must be vendor or npm");
if (values.pay && (values.kind !== "typescript" || values.network !== "testnet")) usage("--pay is for --kind typescript --network testnet");

const kind = values.kind;
const network = NETWORKS[values.network];
const mainnet = network === "stellar:pubnet";
const root = mkdtempSync(join(tmpdir(), `scaffold-${kind}-${values.network}-`));
const project = join(root, "svc");
const stops = [];

console.log(`create-stellar-service --kind ${kind} --network ${values.network}, kit from ${values.kit === "npm" ? "a registry" : "this clone"}`);
try {
  await check();
  console.log(`\n✓ ${kind} on ${network}: every check passed`);
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  for (const stop of stops.reverse()) await stop();
  if (values.keep) console.log(`The project is in ${project}`);
  else rmSync(root, { recursive: true, force: true });
}

async function check() {
  const scaffolder = values.scaffolder?.split(" ").filter(Boolean) ?? [process.execPath, CLONE_SCAFFOLDER];
  const [command, ...prefix] = scaffolder;
  const upstream = kind === "wrap" ? ["--upstream", "http://127.0.0.1:8000/summarize"] : [];
  run(command, [...prefix, "svc", "--kind", kind, "--network", values.network, "--description", DESCRIPTION, "--price", "0.01", "--yes", ...upstream], { cwd: root });

  step("the files and settings it wrote", () => checkFiles());
  if (kind === "typescript") run("npm", ["run", "build"], { cwd: project });
  if (kind === "python") checkPython();
  if (values.docker) run("docker", ["build", "-t", `scaffold-check-${kind}-${values.network}`, "."], { cwd: project });

  if (mainnet) await step("it won't start on mainnet without the facilitator's API key", () => refusesWithoutKey());
  await step("it starts, and the verifier passes it", () => startAndVerify());
  if (values.pay) step("a paid call with test money: provider-kit try --yes", () => pay());
}

function checkFiles() {
  const wanted = ["package.json", ".env", ".env.example", "Dockerfile", "fly.toml", "README.md"];
  if (kind === "typescript") wanted.push("tsconfig.json", "src/server.ts", "src/services/summarize.ts");
  else wanted.push("provider.config.json");
  if (kind === "python") wanted.push("app.py", "requirements.txt", "start.sh");
  const missing = wanted.filter((file) => !existsSync(join(project, file)));
  if (missing.length > 0) throw new Error(`missing: ${missing.join(", ")}`);

  const pkg = readJson("package.json");
  const scripts = ["dev", "check", "status", "launch", "deploy", "start", ...(kind === "typescript" ? ["build"] : [])];
  const absent = scripts.filter((script) => pkg.scripts?.[script] === undefined);
  if (absent.length > 0) throw new Error(`package.json has no ${absent.join(", ")} script`);
  if (mainnet && pkg.scripts.try !== undefined) throw new Error("a mainnet project has a try script: try pays with test money, which mainnet has none of");
  if (!mainnet && pkg.scripts.try === undefined) throw new Error("a testnet project has no try script");

  const kit = pkg.dependencies?.["@stellar-agent-services/provider-kit"] ?? "";
  if (values.kit === "vendor" && !(kit.startsWith("file:vendor/") && existsSync(join(project, "vendor")))) throw new Error(`the kit dependency is "${kit}", not a file in vendor/`);
  if (values.kit === "npm" && !(/^\d+\.\d+\.\d+/.test(kit) && !existsSync(join(project, "vendor")))) throw new Error(`the kit dependency is "${kit}", not a released version`);
  if (!existsSync(join(project, KIT_CLI))) throw new Error("the kit isn't installed");

  const env = parseEnv(readFileSync(join(project, ".env"), "utf8"));
  const example = parseEnv(readFileSync(join(project, ".env.example"), "utf8"));
  if (env.PAY_TO !== "") throw new Error(`.env sets PAY_TO to "${env.PAY_TO}": it starts empty`);
  if (kind === "typescript" && env.STELLAR_NETWORK !== network) throw new Error(`.env sets STELLAR_NETWORK to "${env.STELLAR_NETWORK}"`);
  if (mainnet && !(env.FACILITATOR_AUTH === "" && env.SOROBAN_RPC_URL === MAINNET_RPC)) throw new Error(".env has no empty FACILITATOR_AUTH, or SOROBAN_RPC_URL isn't mainnet's");
  if (!mainnet && "FACILITATOR_AUTH" in env) throw new Error("a testnet .env asks for FACILITATOR_AUTH");
  const differ = [...new Set([...Object.keys(env), ...Object.keys(example)])].filter((key) => !(key in env && key in example));
  if (differ.length > 0) throw new Error(`.env and .env.example differ: ${differ.join(", ")}`);

  if (kind !== "typescript") {
    const config = readJson("provider.config.json");
    if (config.network !== network || config.facilitator !== FACILITATORS[network]) throw new Error(`provider.config.json: network ${config.network}, facilitator ${config.facilitator}`);
    const keyed = config.facilitatorHeaders?.Authorization === "env:FACILITATOR_AUTH" && config.rpcUrl === "env:SOROBAN_RPC_URL";
    if (mainnet !== keyed) throw new Error(`provider.config.json ${mainnet ? "doesn't read" : "reads"} FACILITATOR_AUTH and SOROBAN_RPC_URL`);
  }
  const readme = readFileSync(join(project, "README.md"), "utf8");
  if (mainnet !== readme.includes("FACILITATOR_AUTH")) throw new Error(`README.md ${mainnet ? "doesn't mention" : "mentions"} FACILITATOR_AUTH`);
  return `${wanted.length} files; scripts ${Object.keys(pkg.scripts).join(", ")}; kit ${kit}`;
}

function checkPython() {
  run("sh", ["-n", "start.sh"], { cwd: project });
  const python = spawnSync("python3", ["--version"]);
  if (python.status === 0) run("python3", ["-m", "py_compile", "app.py"], { cwd: project });
  else console.log("  (no python3 here: app.py not compiled)");
}

/** Mainnet's facilitator wants an API key: without FACILITATOR_AUTH the provider stops at start and says so. */
async function refusesWithoutKey() {
  const env = baseEnv(await freePort(), Keypair.random().publicKey());
  delete env.FACILITATOR_AUTH;
  delete env.FACILITATOR_URL;
  const started = start(env);
  const code = await Promise.race([started.exited, new Promise((resolve) => setTimeout(() => resolve("running"), 30_000))]);
  if (code === "running") {
    await started.stop();
    throw new Error("it started without FACILITATOR_AUTH");
  }
  if (code === 0 || !started.output().includes("FACILITATOR_AUTH")) throw new Error(`it exited with ${code} without naming FACILITATOR_AUTH:\n${started.output()}`);
  return `exits with ${code}, naming FACILITATOR_AUTH`;
}

async function startAndVerify() {
  const facilitator = values["real-facilitator"] ? undefined : await fakeFacilitator();
  const port = await freePort();
  const payTo = Keypair.random().publicKey();
  const env = providerEnv(port, payTo, facilitator);
  const started = start(env, facilitator);
  stops.push(started.stop);
  const base = `http://localhost:${port}`;
  const manifest = await waitForManifest(`${base}/.well-known/stellar-agent-services.json`, started);

  const accepts = manifest.payment?.accepts?.[0];
  if (accepts?.network !== network || accepts?.asset !== USDC_ASSET[network] || accepts?.payTo !== payTo) {
    throw new Error(`the manifest takes ${JSON.stringify(accepts)}, not USDC on ${network} to PAY_TO`);
  }
  if (manifest.provider?.description !== DESCRIPTION) throw new Error(`the manifest's provider.description is ${JSON.stringify(manifest.provider?.description)}`);
  if (facilitator !== undefined) {
    const sent = facilitator.authorizations();
    if (mainnet && !sent.every((value) => value === env.FACILITATOR_AUTH)) throw new Error(`the facilitator got Authorization ${JSON.stringify(sent)}`);
    if (!mainnet && sent.some((value) => value !== undefined)) throw new Error("a testnet provider sent the facilitator an Authorization header");
    if (sent.length === 0) throw new Error("it never asked the facilitator what it supports");
  }

  // The verifier's own checks, with a stand-in for its one chain lookup: payTo's USDC trustline [P2].
  const report = await verifyProvider({ manifestUrl: `${base}/.well-known/stellar-agent-services.json`, dev: true, rpc: trustingChain(), registry: false });
  const wanted = { C1: "passed", C2: "skipped", C3: "passed", C4: "skipped", C5: "skipped", C6: "passed", C7: "passed" };
  const wrong = report.results.filter((result) => wanted[result.check] !== result.status);
  if (wrong.length > 0) {
    const detail = wrong.map((result) => `${result.check} ${result.status}: ${(result.findings ?? []).map((finding) => `[${finding.rule}] ${finding.message}`).join("; ") || result.reason || ""}`);
    throw new Error(`the verifier:\n  ${detail.join("\n  ")}`);
  }
  await started.stop();
  return `${manifest.services.length} service(s) on ${network}; C1, C3, C6 and C7 pass${facilitator === undefined ? ", with the real facilitator" : ""}`;
}

/** One paid call on testnet, from a throwaway account with test money, as `npm run try` makes it. */
function pay() {
  const result = spawnSync("npm", ["run", "--silent", "try", "--", "--yes", "--json"], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 300_000 });
  let summary;
  try {
    summary = JSON.parse(result.stdout);
  } catch {
    throw new Error(`try printed no JSON (exit ${result.status}):\n${result.stdout}`);
  }
  if (!summary.ok || summary.payment?.confirmed !== true) throw new Error(`the call didn't go through: ${JSON.stringify(summary, null, 2)}`);
  return `${summary.service} ${summary.status}, ${summary.payment.amount} paid and confirmed on chain: ${summary.payment.url}`;
}

/** The environment the project's own scripts give it: .env, then what this check sets. */
function baseEnv(port, payTo) {
  const env = { ...process.env, ...parseEnv(readFileSync(join(project, ".env"), "utf8")) };
  return Object.assign(env, { PORT: String(port), PUBLIC_ORIGIN: `http://localhost:${port}`, PAY_TO: payTo, JOB_DB_PATH: join(root, `jobs-${port}.sqlite`) });
}

/** baseEnv(), with the facilitator: the stand-in, or the real one with mainnet's API key. */
function providerEnv(port, payTo, facilitator) {
  const env = baseEnv(port, payTo);
  if (facilitator !== undefined) {
    if (kind === "typescript") env.FACILITATOR_URL = facilitator.url;
    if (mainnet) env.FACILITATOR_AUTH = "Bearer scaffold-check";
  } else if (mainnet) {
    if (!process.env.FACILITATOR_AUTH) throw new Error("--real-facilitator on mainnet needs the facilitator's API key in FACILITATOR_AUTH");
    env.FACILITATOR_AUTH = process.env.FACILITATOR_AUTH;
  }
  return env;
}

/** Starts the provider as `npm start` would: the TypeScript server, or the gateway on its config. */
function start(env, facilitator) {
  let args;
  if (kind === "typescript") args = ["--disable-warning=ExperimentalWarning", "dist/server.js"];
  else {
    let config = "provider.config.json";
    if (facilitator !== undefined) {
      // The same config, pointed at the stand-in facilitator; dev mode allows its http://localhost address.
      config = "provider.config.check.json";
      writeFileSync(join(project, config), JSON.stringify({ ...readJson("provider.config.json"), facilitator: facilitator.url }));
    }
    args = ["--disable-warning=ExperimentalWarning", KIT_CLI, "serve", "--config", config, "--dev", "--port", env.PORT];
  }
  const child = spawn(process.execPath, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return {
    exited,
    output: () => output,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

/** The x402 facilitator's /supported, for one network with sponsored fees. It is never asked to settle here. */
async function fakeFacilitator() {
  const authorizations = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/supported") {
      response.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network, extra: { areFeesSponsored: true } }] }));
      return;
    }
    response.statusCode = 500;
    response.end(JSON.stringify({ error: "this check pays nothing" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stops.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://localhost:${server.address().port}`, authorizations: () => [...authorizations] };
}

/** A chain where every account exists and holds an authorized USDC trustline: what verifier's C3 reads for payTo. */
function trustingChain() {
  const refuse = async () => {
    throw new Error("this check reads no transactions");
  };
  return {
    getLedgerEntries: async () => ({
      latestLedger: 1,
      entries: [{ val: { switch: () => ({ name: "account" }) } }, { val: { switch: () => ({ name: "trustline" }), trustLine: () => ({ flags: () => 1 }) } }],
    }),
    getLatestLedger: async () => ({ id: "0", sequence: 1, protocolVersion: 23 }),
    getTransaction: refuse,
    getEvents: refuse,
  };
}

async function waitForManifest(url, started) {
  const deadline = Date.now() + 60_000;
  let exitCode;
  void started.exited.then((code) => (exitCode = code));
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error(`it exited with ${exitCode}:\n${started.output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no manifest at ${url} after 60 s:\n${started.output()}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function run(command, args, options) {
  console.log(`\n$ ${[command, ...args].map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`);
  const result = spawnSync(command, args, { ...options, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed (${result.error?.message ?? `exit ${result.status}`})`);
}

/** Runs one check and prints what it found. */
function step(title, check) {
  const done = (detail) => console.log(`\n✓ ${title}${detail ? `: ${detail}` : ""}`);
  const failed = (error) => new Error(`${title}: ${error instanceof Error ? error.message : error}`);
  let result;
  try {
    result = check();
  } catch (error) {
    throw failed(error);
  }
  if (result instanceof Promise) return result.then(done, (error) => Promise.reject(failed(error)));
  done(result);
}

function readJson(file) {
  return JSON.parse(readFileSync(join(project, file), "utf8"));
}
