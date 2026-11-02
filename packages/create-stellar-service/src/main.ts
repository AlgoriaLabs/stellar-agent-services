// create-stellar-service, run as `npm create stellar-service`: a new project that sells an AI service on Stellar,
// ready to run, try and deploy.
//
// It asks at most five questions: the folder; what to make (an API the developer already runs, behind the gateway, or
// a new TypeScript or Python service); for an API, its OpenAPI document or the URL a paid call goes to; one sentence on
// what the service offers, which is what search matches; and the price of a call. Then it writes the project
// (files.ts), with fly.toml, and installs it. No wallet is needed to start: `npm run dev` makes a throwaway testnet
// account to be paid to, and `npm run launch` sets up the developer's own wallet when the service goes live. --wallet
// sets it up now instead, with `provider-kit trustline`. Flags answer every question, for scripts and coding agents.
//
// Testnet unless --network mainnet, which writes mainnet's facilitator (it wants an API key, FACILITATOR_AUTH) and a
// Soroban RPC instead, and leaves out the testnet-only steps. It never asks for, makes or stores a secret key, and
// never pays.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  adaptInitConfig,
  DEFAULT_PRICE,
  dockerignore,
  envFile,
  FACILITATOR_KEYS,
  gitignore,
  KINDS,
  packageJson,
  pythonGatewayConfig,
  readme,
  TEMPLATE_DESCRIPTION,
  TEMPLATE_FILES,
  template,
  type Kind,
  type Network,
  type Project,
} from "./files.js";
import { KIT_CLI, KIT_PACKAGES, kitDependencies, kitSource, unbuilt, type KitSource } from "./kit.js";

const OPTIONS = {
  kind: { type: "string" },
  openapi: { type: "string" },
  upstream: { type: "string" },
  name: { type: "string" },
  description: { type: "string" },
  price: { type: "string" },
  network: { type: "string" },
  "pay-to": { type: "string" },
  wallet: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

export const USAGE = `create-stellar-service: a new paid AI service on Stellar, ready to run, try and deploy

Usage:
  npm create stellar-service [<folder>] [-- <options>]
  create-stellar-service [<folder>] [--kind wrap|typescript|python] [--openapi <file | url>]
                         [--upstream <url>] [--name <text>] [--description <text>] [--price <usdc>]
                         [--network testnet|mainnet] [--wallet | --pay-to <G...>] [--yes]

--kind          wrap: an API you already run, in any language, behind the Provider Kit gateway. No
                code changes: --openapi reads its OpenAPI document (FastAPI serves /openapi.json) and
                makes a service of each POST endpoint; without one, --upstream is the URL a paid call
                goes to.
                typescript: a new service, with the Provider Kit library.
                python: a new FastAPI service, behind the gateway.
--description   One sentence on what it offers. Search matches it and the name: use the words buyers type.
--name          The provider's name. Default: the folder's, or the OpenAPI document's title.
--price         What a call costs, in USDC. Default 0.01.
--network       testnet (default): test money, nothing to set up. mainnet: real USDC, through mainnet's
                facilitator, which wants an API key (FACILITATOR_AUTH in .env); no throwaway accounts.
--wallet        Sets up the account clients pay now: a page opens where your own wallet approves a USDC
                trustline, and the address goes in .env as PAY_TO. --pay-to takes an address you have.
                Without either, nothing is needed until npm run launch: on testnet, npm run dev pays a
                throwaway account meanwhile.
--yes           Takes the defaults for questions no flag answers. Without a terminal it never asks, and
                --kind is needed.

Testnet unless --network mainnet. It never asks for a secret key, and never pays.`;

const DEFAULT_FOLDER = "my-stellar-service";
const MAKING: Record<Kind, string> = { wrap: "a gateway in front of your API", typescript: "a new TypeScript service", python: "a new Python service" };
const DEFAULT_OPENAPI = "http://127.0.0.1:8000/openapi.json";
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;
/** A price in USDC: up to 7 decimals, as Stellar counts USDC. */
const PRICE = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,7})?$/;

/** A mistake in how it was called: printed with the usage text, exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** Ctrl+C or Ctrl+D at a question. */
export class Cancelled extends Error {
  override name = "Cancelled";
}

export interface RunResult {
  code: number;
  output: string;
}

/** Where the scaffolder meets the terminal, the network and other programs. Tests replace it. */
export interface CreateIo {
  log(text?: string): void;
  /** A line that shows what is running on a terminal, replaced by the next one. "" clears it. */
  status(text: string): void;
  interactive: boolean;
  /** Asks one question and returns the trimmed answer. Rejects with Cancelled on Ctrl+C or Ctrl+D. */
  ask(question: string): Promise<string>;
  /** Runs a program in `cwd`. With `echo`, its output also shows as it comes. */
  run(command: string, args: string[], options: { cwd: string; echo?: boolean }): Promise<RunResult>;
  /** Whether a program, such as uv, is installed. */
  has(program: string): Promise<boolean>;
  fetch: typeof fetch;
  kit: KitSource;
}

export function createIo(): CreateIo {
  const tty = process.stdout.isTTY === true;
  return {
    log: (text = "") => console.log(text),
    status: (text) => {
      if (tty) process.stdout.write(`\r\x1b[K${text}`);
    },
    interactive: tty && process.stdin.isTTY === true,
    async ask(question) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const stop = new AbortController();
      terminal.on("SIGINT", () => stop.abort());
      terminal.on("close", () => stop.abort());
      try {
        return (await terminal.question(question, { signal: stop.signal })).trim();
      } catch {
        throw new Cancelled("cancelled");
      } finally {
        terminal.close();
      }
    },
    run: runProgram,
    has: async (program) => (await runProgram(program, ["--version"], { cwd: process.cwd() }).catch(() => ({ code: 1, output: "" }))).code === 0,
    fetch: (input, init) => fetch(input, init),
    kit: kitSource(),
  };
}

export async function create(argv: string[], io: CreateIo = createIo()): Promise<number> {
  const { values: flags, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });
  if (flags.help) {
    io.log(USAGE);
    return 0;
  }
  if (positionals.length > 1) throw new UsageError("give one folder");
  if (flags["pay-to"] !== undefined && !STELLAR_ACCOUNT.test(flags["pay-to"])) throw new UsageError("--pay-to must be a public Stellar account address, G...");
  if (flags["pay-to"] !== undefined && flags.wallet === true) throw new UsageError("--pay-to and --wallet both set the payout account: pick one");
  if (flags.price !== undefined && !validPrice(flags.price)) throw new UsageError(`--price must be a price in USDC above zero, such as 0.05, not "${flags.price}"`);
  if (flags.network !== undefined && parseNetwork(flags.network) === undefined) throw new UsageError(`--network must be testnet or mainnet, not "${flags.network}"`);
  if (io.kit.from === "clone") {
    const missing = unbuilt(io.kit.packages);
    if (missing.length > 0) throw new Error(`the Provider Kit in ${dirname(io.kit.packages)} isn't built (no ${missing[0]}): run npm install && npm run build there first`);
  }

  let answers: Answers;
  try {
    answers = await answer(flags, positionals[0], io);
  } catch (error) {
    if (error instanceof Cancelled) {
      io.log("\nCancelled. Nothing was written.");
      return 130;
    }
    throw error;
  }
  return build(answers, io);
}

interface Answers {
  directory: string;
  kind: Kind;
  /** For a gateway: the API's OpenAPI document (and --upstream, its address), or else the URL a paid call goes to. */
  source?: { openapi: string; upstream?: string } | { upstream: string };
  name?: string;
  description?: string;
  /** Each service's price in USDC. */
  price: string;
  network: Network;
  /** Set up the payout account in the developer's wallet now, rather than at launch. */
  wallet: boolean;
  payTo?: string;
}

/** The answers: from flags, else from questions on a terminal, else the defaults. */
async function answer(flags: Flags, folder: string | undefined, io: CreateIo): Promise<Answers> {
  const asking = io.interactive && !flags.yes;
  const directory = await askUntil(io, asking, folder, `Project folder [${DEFAULT_FOLDER}]: `, DEFAULT_FOLDER, (value) => {
    const path = resolve(value);
    if (!existsSync(path)) return undefined;
    if (!statSync(path).isDirectory() || readdirSync(path).length > 0) return `${value} already exists and isn't empty: pick another folder`;
    return undefined;
  });

  const kind = await askKind(flags.kind, asking, io);

  let source: Answers["source"];
  if (kind === "wrap") {
    if (flags.openapi !== undefined) {
      source = { openapi: flags.openapi, ...(flags.upstream === undefined ? {} : { upstream: flags.upstream }) };
      const problem = await unreadable(flags.openapi, io.fetch);
      if (problem !== undefined) throw new Error(`can't read the OpenAPI document ${flags.openapi}: ${problem}. Start the API, or pass the URL a paid call goes to (--upstream). Nothing was written.`);
    } else if (flags.upstream !== undefined) {
      source = { upstream: flags.upstream };
    } else if (!asking) {
      throw new UsageError("--kind wrap needs --openapi <file | url>, or --upstream <url>");
    } else {
      // The document is read now, so a mistyped URL or a stopped API is caught before anything is written.
      for (;;) {
        source = classify((await io.ask(`Your API's OpenAPI document, or the URL a paid call goes to [${DEFAULT_OPENAPI}]: `)) || DEFAULT_OPENAPI);
        const problem = "openapi" in source ? await unreadable(source.openapi, io.fetch) : undefined;
        if (problem === undefined) break;
        io.log(`  Can't read it: ${problem}. Start the API and press Enter, or give the URL a paid call goes to.`);
      }
    }
  } else if (flags.openapi !== undefined || flags.upstream !== undefined) {
    throw new UsageError("--openapi and --upstream are for --kind wrap");
  }

  let description = flags.description;
  if (description === undefined && asking) {
    const keep = kind !== "wrap" ? clip(TEMPLATE_DESCRIPTION, 40) : source !== undefined && "openapi" in source ? "Enter: the document's" : "Enter: write it later";
    io.log("In one sentence, what does it offer? Agents search for it by these words and its name.");
    description = (await io.ask(`[${keep}]: `)) || undefined;
  }

  let price = flags.price;
  if (price === undefined && asking) {
    price = await askUntil(io, true, undefined, `What does a call cost, in USDC? [${DEFAULT_PRICE}]: `, DEFAULT_PRICE, (value) => (validPrice(value) ? undefined : "a price in USDC above zero, such as 0.05"));
  }
  return {
    directory: resolve(directory),
    kind,
    ...(source === undefined ? {} : { source }),
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(description === undefined ? {} : { description }),
    price: price ?? DEFAULT_PRICE,
    network: flags.network === undefined ? "stellar:testnet" : parseNetwork(flags.network)!,
    wallet: flags.wallet ?? false,
    ...(flags["pay-to"] === undefined ? {} : { payTo: flags["pay-to"] }),
  };
}

/** A price in USDC above zero, with at most 7 decimals. */
function validPrice(value: string): boolean {
  return PRICE.test(value) && Number(value) > 0;
}

/** --network as a network id: testnet, or mainnet (also written pubnet), as provider-kit takes them. */
function parseNetwork(value: string): Network | undefined {
  if (["testnet", "stellar:testnet"].includes(value)) return "stellar:testnet";
  if (["mainnet", "pubnet", "public", "stellar:pubnet"].includes(value)) return "stellar:pubnet";
  return undefined;
}

/** Writes and installs the project, then sets up the payout account if asked. */
async function build(answers: Answers, io: CreateIo): Promise<number> {
  const { directory, kind, network } = answers;
  const testnet = network === "stellar:testnet";
  const folder = basename(directory);
  const vendored = io.kit.from === "clone";
  io.log(`\nCreating ${folder}: ${MAKING[kind]}, paid in USDC on Stellar ${testnet ? "testnet" : "mainnet, real money"}\n`);
  await mkdir(directory, { recursive: true });
  const write = (file: string, text: string) => writeAt(directory, file, text);

  const project: Project = {
    kind,
    package: packageName(folder),
    app: flyAppName(folder),
    name: answers.name ?? titleCase(folder),
    description: answers.description ?? TEMPLATE_DESCRIPTION,
    price: answers.price,
    network,
    vendored,
    // uv runs a Python API with its packages, so there is no virtual environment to make first.
    ...(kind === "python" ? { uv: await io.has("uv") } : {}),
  };
  const packed = vendored ? await step(io, "Packed the Provider Kit from your clone into vendor/", () => pack(io, directory)) : {};
  await write("package.json", packageJson(project, kitDependencies(io.kit, packed)));
  await write(".gitignore", gitignore(project));
  const installed = await step(io, "Installed packages (npm install)", async () => {
    const result = await io.run("npm", ["install", "--no-audit", "--no-fund"], { cwd: directory });
    if (result.code !== 0) throw new Error(`npm install failed:\n${tail(result.output)}`);
  }).then(
    () => true,
    (error: Error) => {
      io.log(`\n${error.message}\n\nThe project is in ${directory}, without its packages. Fix the problem, then run npm install there.`);
      return false;
    },
  );
  if (!installed) return 1;

  let variables: string[] = [];
  let services = "the summarize service, in front of app.py";
  let upstream: string | undefined;
  if (kind === "wrap") {
    const made = await gatewayFromInit(answers, project, io);
    project.name = made.name;
    project.description = made.description;
    ({ variables, services } = made);
    upstream = made.upstream;
  } else if (kind === "python") {
    await write("provider.config.json", pythonGatewayConfig(project));
    upstream = "http://127.0.0.1:8000/summarize";
  }

  for (const [templates, file] of TEMPLATE_FILES[kind]) await write(file, template(templates, file, project));
  if (kind === "python") await chmod(join(directory, "start.sh"), 0o755);
  await write(".dockerignore", dockerignore(project));
  await write(".env.example", envFile(project, { variables }, true));
  await write(".env", envFile(project, { ...(answers.payTo === undefined ? {} : { payTo: answers.payTo }), variables }));
  await write("README.md", readme(project, { services, ...(upstream === undefined ? {} : { upstream }) }));
  io.log(`  ✓ Wrote ${kind === "typescript" ? "the service, " : "provider.config.json, "}.env, a Dockerfile, fly.toml and a README`);

  let payTo = answers.payTo;
  if (answers.wallet) {
    payTo = await connectWallet(io, directory, network);
    if (payTo !== undefined) await write(".env", envFile(project, { payTo, variables }));
  }

  io.log(`\n✓ Created ${folder} in ${directory}`);
  const first: string[] = [];
  if (variables.length > 0) first.push(`set ${variables.join(", ")} in .env   the gateway sends ${variables.length === 1 ? "it" : "them"} to your API`);
  // Without uv, the Python packages are left to the developer's own shell: a Python started from here could pick
  // packages for another processor, such as when Node runs under Rosetta on an Apple silicon Mac.
  if (kind === "python" && !project.uv) first.push("python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   installs the API's packages, once");
  const starts = { wrap: "the gateway in front of your API,", typescript: "the service", python: "the API and the gateway in front of it," }[kind];
  const steps = testnet
    ? [
        `cd ${shellWord(folder)}`,
        ...first,
        `npm run dev        starts ${starts} at http://localhost:8787${payTo === undefined ? ": no wallet needed yet" : ""}`,
        "npm run try        pays for one call with test money, from another terminal",
        "npm run launch     takes it live: one approval in your wallet, then Fly.io",
      ]
    : [
        `cd ${shellWord(folder)}`,
        ...first,
        `set FACILITATOR_AUTH in .env   mainnet's facilitator key, as "Bearer <key>": ${FACILITATOR_KEYS}`,
        "npm run launch     takes it live on mainnet: one approval in your wallet (with a few XLM), then Fly.io",
        `npm run dev        starts ${starts} at http://localhost:8787${payTo === undefined ? ", once launch has set PAY_TO" : ""}`,
      ];
  io.log(`\nNext:\n${steps.map((line) => `  ${line}`).join("\n")}\n\nnpm run status shows where it stands at any time. README.md has the rest.`);
  return 0;
}

/** The wrap kind's config: `provider-kit init` from the OpenAPI document or for the one URL, made to run anywhere. */
async function gatewayFromInit(answers: Answers, project: Project, io: CreateIo): Promise<{ name: string; description: string; variables: string[]; services: string; upstream?: string }> {
  const { directory } = answers;
  const source = answers.source!;
  const out = join(directory, "provider.config.json");
  const init = (args: string[]) => io.run(process.execPath, [KIT_CLI, "init", ...args, "--out", "provider.config.json"], { cwd: directory });

  let result: RunResult | undefined;
  if ("openapi" in source) {
    const document = /^https?:\/\//i.test(source.openapi) ? source.openapi : resolve(source.openapi);
    result = await init(["--openapi", document, ...(source.upstream === undefined ? [] : ["--upstream", source.upstream])]);
    // init's own next steps are for a config on its own; this project's come at the end.
    const shown = result.output.split("\n");
    const next = shown.findIndex((line) => line === "Next:");
    const lines = shown.slice(0, next === -1 ? undefined : next).join("\n").trimEnd().split("\n");
    io.log(`\n${lines.map((line) => (line === "" ? line : `    ${line}`)).join("\n")}\n`);
    if (result.code !== 0 && existsSync(out)) await rm(out);
  }
  const fromDocument = result !== undefined && result.code === 0;
  if (!fromDocument) {
    const url = "upstream" in source && !("openapi" in source) ? source.upstream : undefined;
    const starter = await init(url === undefined ? [] : ["--upstream", url]);
    if (starter.code !== 0) throw new Error(`provider-kit init failed:\n${tail(starter.output)}`);
    io.log(
      result === undefined
        ? `  ✓ provider.config.json: a service to edit, my-service, which calls ${url}`
        : "  ! provider.config.json is a starter instead, with one service to edit: see the reason above",
    );
  }

  const adapted = adaptInitConfig(
    await readFile(out, "utf8"),
    {
      ...(answers.name !== undefined || !fromDocument ? { name: project.name } : {}),
      ...(answers.description === undefined ? {} : { description: answers.description }),
      price: project.price,
    },
    project.network,
  );
  await writeFile(out, adapted.config);
  const config = JSON.parse(adapted.config) as { provider: { name: string; description?: string }; services: { name: string; upstream: { url: string } }[] };
  const names = config.services.map((service) => service.name);
  return {
    name: config.provider.name,
    description: config.provider.description ?? "",
    variables: adapted.variables,
    services: `${names.length === 1 ? "1 service" : `${names.length} services`}: ${names.join(", ")}`,
    ...(config.services[0]?.upstream.url.startsWith("http") ? { upstream: new URL(config.services[0].upstream.url).origin } : {}),
  };
}

/** Packs each kit package from the clone into vendor/, and returns the file names. */
async function pack(io: CreateIo, directory: string): Promise<Partial<Record<(typeof KIT_PACKAGES)[number], string>>> {
  if (io.kit.from !== "clone") return {};
  const vendor = join(directory, "vendor");
  await mkdir(vendor, { recursive: true });
  const files: Partial<Record<(typeof KIT_PACKAGES)[number], string>> = {};
  for (const name of KIT_PACKAGES) {
    const result = await io.run("npm", ["pack", "--json", "--pack-destination", vendor], { cwd: join(io.kit.packages, name) });
    if (result.code !== 0) throw new Error(`npm pack failed for ${name}:\n${tail(result.output)}`);
    const parsed = JSON.parse(result.output.slice(result.output.indexOf("["))) as { filename: string }[];
    files[name] = basename(parsed[0]!.filename);
  }
  return files;
}

/**
 * Sets up the account clients pay: `provider-kit trustline` opens a page where the developer's own wallet approves a
 * USDC trustline on the project's network, then prints the account as PAY_TO=G.... Its address, or undefined if it
 * didn't finish.
 */
async function connectWallet(io: CreateIo, directory: string, network: Network): Promise<string | undefined> {
  io.log("\nSetting up the account clients pay, in your wallet:\n");
  // Ctrl+C on the approval page stops provider-kit trustline, not the rest of this.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    const result = await io.run(process.execPath, [KIT_CLI, "trustline", "--network", network === "stellar:testnet" ? "testnet" : "mainnet"], { cwd: directory, echo: true });
    const address = /PAY_TO=(G[A-Z2-7]{55})\b/.exec(result.output)?.[1];
    if (result.code === 0 && address !== undefined) {
      io.log(`  ✓ PAY_TO=${address} in .env`);
      return address;
    }
  } finally {
    process.off("SIGINT", ignore);
  }
  io.log("  ! The account wasn't set up. npm run launch sets it up when the service goes live.");
  return undefined;
}

/** Asks until `check` passes, or takes `given` (from a flag or argument), or `fallback` when not asking. */
async function askUntil(io: CreateIo, asking: boolean, given: string | undefined, question: string, fallback: string, check: (value: string) => string | undefined): Promise<string> {
  if (given !== undefined || !asking) {
    const value = given ?? fallback;
    const problem = check(value);
    if (problem !== undefined) throw new UsageError(problem);
    return value;
  }
  for (;;) {
    const value = (await io.ask(question)) || fallback;
    const problem = check(value);
    if (problem === undefined) return value;
    io.log(`  ${problem}`);
  }
}

/** What to make: --kind, else a question. */
async function askKind(flag: string | undefined, asking: boolean, io: CreateIo): Promise<Kind> {
  if (flag !== undefined) {
    const kind = parseKind(flag);
    if (kind === undefined) throw new UsageError(`--kind must be wrap, typescript or python, not "${flag}"`);
    return kind;
  }
  if (!asking) throw new UsageError("--kind is needed when there are no questions: wrap, typescript or python");
  const menu = Object.values(KINDS).map((label, index) => `  ${index + 1}. ${label}`);
  io.log(`What are you making?\n${menu.join("\n")}`);
  return parseKind(await askUntil(io, true, undefined, "Pick 1, 2 or 3 [1]: ", "1", (value) => (parseKind(value) === undefined ? "answer 1, 2 or 3" : undefined)))!;
}

function parseKind(value: string): Kind | undefined {
  const kinds = Object.keys(KINDS) as Kind[];
  return kinds.find((kind, index) => value === kind || value === String(index + 1));
}

/** An answer that names a document (a file, or a URL that looks like one) or else the URL a paid call goes to. */
export function classify(answer: string): { openapi: string } | { upstream: string } {
  if (!/^https?:\/\//i.test(answer)) return { openapi: answer };
  const path = new URL(answer).pathname;
  return /openapi|swagger|api-docs|schema|\.(json|ya?ml)$/i.test(path) ? { openapi: answer } : { upstream: answer };
}

/** Why the document can't be read now, or undefined. Checked before anything is written. */
async function unreadable(source: string, fetcher: typeof fetch): Promise<string | undefined> {
  if (!/^https?:\/\//i.test(source)) return existsSync(source) ? undefined : "there's no such file";
  try {
    const response = await fetcher(source, { signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return response.ok ? undefined : `it answered ${response.status}`;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return cause === "ECONNREFUSED" ? "nothing answers there" : (error as Error).message;
  }
}

/** Runs one step: "  … label" while it runs, on a terminal, then "  ✓ label", or "  ✗ label" and the error. */
async function step<T>(io: CreateIo, label: string, work: () => Promise<T>): Promise<T> {
  io.status(`  … ${label}`);
  try {
    const value = await work();
    io.status("");
    io.log(`  ✓ ${label}`);
    return value;
  } catch (error) {
    io.status("");
    io.log(`  ✗ ${label}`);
    throw error;
  }
}

async function writeAt(directory: string, file: string, text: string): Promise<void> {
  const path = join(directory, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function runProgram(command: string, args: string[], options: { cwd: string; echo?: boolean }): Promise<RunResult> {
  return new Promise((done, fail) => {
    // npm is npm.cmd on Windows, which only a shell runs.
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" && command === "npm" });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (options.echo) process.stderr.write(chunk);
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });
}

/** An npm package name from a folder name. */
export function packageName(folder: string): string {
  return folder.toLowerCase().replace(/[^a-z0-9._~-]+/g, "-").replace(/^[._-]+|-+$/g, "") || "stellar-service";
}

/** A Fly.io app name from a folder name: lowercase letters, digits and dashes, starting with a letter. */
export function flyAppName(folder: string): string {
  const name = folder.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 63);
  return name === "" ? "stellar-service" : name;
}

/** "my-stellar-service" as a name: "My Stellar Service". */
export function titleCase(folder: string): string {
  return folder
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The last lines of a program's output, for an error message. */
function tail(output: string, lines = 15): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}
