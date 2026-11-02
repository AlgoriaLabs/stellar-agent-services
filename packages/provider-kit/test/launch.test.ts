// provider-kit launch: one approval page for every owner step (USDC trustline, 8004 registration, validation request),
// then the settings saved where the provider and the deploy read them, then the deploy and the live check. With a fake
// chain, registry, wallet, flyctl and network: nothing here touches the network.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MANIFEST_PATH, validationRequestBytes, type JsonObject } from "@stellar-agent-services/protocol";
import { Keypair, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalSession, type ApprovalOutcome, type ApprovalPlan } from "../src/cli/approval.js";
import { readEnvFile } from "../src/cli/env-file.js";
import { launch, type LaunchIo } from "../src/cli/launch.js";
import type { OwnerChain } from "../src/cli/owner-chain.js";
import type { Started } from "../src/cli/processes.js";
import { UsageError, type CliFlags } from "../src/cli/shared.js";
import { createProvider, defineService, registrationDataUri, registrationFile } from "../src/index.js";
import { fakeChain, fakeRegistry, ownerIo, signed, walletApproves, type FakeChain } from "./support/owner.js";

const root = mkdtempSync(join(tmpdir(), "provider-kit-launch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = process.cwd();
let projects = 0;
afterEach(() => process.chdir(home));

const VALIDATOR = Keypair.random().publicKey();
const ORIGIN = "https://launch-test.fly.dev";
const MANIFEST_URL = `${ORIGIN}${DEFAULT_MANIFEST_PATH}`;

/** A project as `npm create stellar-service --kind wrap` makes it, with a throwaway PAY_TO from `provider-kit dev`. Becomes the working directory. */
function project(options: { fly?: boolean; env?: string; upstream?: string } = {}): string {
  const directory = join(root, `project-${++projects}`);
  mkdirSync(directory);
  const throwaway = Keypair.random().publicKey();
  const config = {
    baseUrl: "env:PUBLIC_ORIGIN",
    network: "stellar:testnet",
    payTo: "env:PAY_TO",
    facilitator: "https://x402.org/facilitator",
    provider: { name: "Launch test", description: "Summaries of English text, for agents.", agentId: "env:AGENT_ID" },
    store: "env:JOB_DB_PATH",
    services: [
      {
        name: "summarize",
        description: "Summarizes English text up to 20,000 characters, keeping the first sentences.",
        price: "0.01",
        inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
        outputSchema: { type: "object" },
        upstream: { url: options.upstream ?? "http://127.0.0.1:8000/summarize", headers: { "X-API-Key": "env:UPSTREAM_KEY" } },
      },
    ],
  };
  writeFileSync(join(directory, "provider.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(directory, ".env"),
    options.env ??
      `PAY_TO=${throwaway}\nPUBLIC_ORIGIN=http://localhost:8787\nJOB_DB_PATH=./jobs.sqlite\nAGENT_ID=\nUPSTREAM_KEY=key-from-env\n\n# A throwaway account.\nDEV_PAY_TO=${throwaway}\n`,
  );
  if (options.fly !== false) writeFileSync(join(directory, "fly.toml"), `app = "launch-test"\nprimary_region = "iad"\n\n[env]\n  JOB_DB_PATH = "/data/jobs.sqlite"\n\n[[mounts]]\n  source = "data"\n  destination = "/data"\n`);
  process.chdir(directory);
  return directory;
}

/** The chain and registry, wired so registering and asking for validation show up in the registry, as on chain. */
function world() {
  const chain = fakeChain();
  const registry = fakeRegistry();
  chain.returnValue = nativeToScVal(42, { type: "u32" });
  chain.onLanded = (call) => {
    const args = call.args.map((arg) => scValToNative(arg) as unknown);
    if (call.method === "register_with_uri") registry.agents.set(42, { owner: args[0] as string, uri: args[1] as string, wallet: args[0] as string });
    if (call.method === "set_agent_uri") registry.agents.get(args[1] as number)!.uri = args[2] as string;
    if (call.method === "validation_request") {
      registry.validations.set(Buffer.from(args[4] as Buffer).toString("hex"), { validator: args[1] as string, agentId: args[2] as number, hasResponse: false, response: 0, responseHash: "", tag: "", lastUpdate: 1 });
    }
  };
  return { chain, registry };
}

/** A wallet that signs until the page shows `stopAt`, and closes the page there. */
function walletStopsAt(keypair: Keypair, stopAt: string) {
  return async (plan: ApprovalPlan, chain: OwnerChain): Promise<ApprovalOutcome> => {
    const session = new ApprovalSession(plan, chain);
    await session.connect(keypair.publicKey(), "Test wallet");
    while (session.state === "review") {
      const { review } = session.view();
      if (review === undefined || review.stepId === stopAt) break;
      await session.submit(review.stepId, signed(review.xdr, keypair, chain.passphrase));
    }
    if (!["done", "failed", "cancelled"].includes(session.state)) session.cancel();
    return session.finished;
  };
}

function io(options: { chain: FakeChain; registry: ReturnType<typeof fakeRegistry>["registry"]; approve?: LaunchIo["approve"]; fetch?: typeof fetch; start?: LaunchIo["start"]; fly?: LaunchIo["fly"] }) {
  const lines: string[] = [];
  const flyCalls: { args: string[]; input?: string }[] = [];
  const launchIo: LaunchIo = {
    ...ownerIo({ chain: options.chain, registry: options.registry, ...(options.approve === undefined ? {} : { approve: options.approve }) }),
    log: (line) => void lines.push(line),
    interactive: false,
    confirm: async () => true,
    fetch: options.fetch ?? (async () => new Response("not found", { status: 404 })),
    start:
      options.start ??
      (() => {
        throw new Error("this test starts no command");
      }),
    freePort: async () => 4321,
    fly:
      options.fly ??
      (async (args, flyOptions = {}) => {
        flyCalls.push({ args, ...(flyOptions.input === undefined ? {} : { input: flyOptions.input }) });
        return { code: 0, output: "" };
      }),
    sleep: async () => {},
    env: {},
  };
  return { io: launchIo, lines, flyCalls, output: () => lines.join("\n") };
}

beforeEach(() => process.chdir(home));

describe("provider-kit launch", () => {
  it("does every owner step on one page from the wallet that connects, and saves what the provider and the deploy read", async () => {
    const directory = project();
    const { chain, registry } = world();
    const wallet = Keypair.random();
    const approves = walletApproves(wallet);
    const t = io({ chain, registry: registry.registry, approve: approves.approve });

    expect(await launch({ validator: VALIDATOR, "no-deploy": true }, t.io)).toBe(0);

    // One page: test XLM, the trustline, the registration and the validation request, all from the wallet's account.
    expect(approves.views).toHaveLength(1);
    expect(approves.views[0]!.steps.map((step) => step.id)).toEqual(["fund", "trustline", "register", "request-validation"]);
    expect(chain.sent.every((transaction) => transaction.source === wallet.publicKey())).toBe(true);
    expect(chain.invoked.map(({ call }) => call.method)).toEqual(["register_with_uri", "validation_request"]);

    // The registration names the manifest at the public address [I1]; the agent's wallet is the one that connected [I3].
    const agent = registry.agents.get(42)!;
    expect(agent).toMatchObject({ owner: wallet.publicKey(), wallet: wallet.publicKey() });
    const file = JSON.parse(Buffer.from(agent.uri.split(",")[1]!, "base64").toString("utf8")) as { services: { name: string; endpoint: string }[] };
    expect(file.services).toContainEqual({ name: "stellar-agent-services", endpoint: MANIFEST_URL, version: "1" });

    // The validation request names agent 42 and that manifest, for the verifier.
    const [requestHash, request] = [...registry.validations][0]!;
    expect(request).toMatchObject({ validator: VALIDATOR, agentId: 42 });
    const sent = chain.invoked[1]!.call.args.map((arg) => scValToNative(arg) as unknown);
    const document = JSON.parse(Buffer.from((sent[3] as string).split(",")[1]!, "base64").toString("utf8")) as JsonObject;
    expect(document).toMatchObject({ agentId: 42, manifest: { url: MANIFEST_URL }, validator: VALIDATOR });
    expect(Buffer.from(sent[4] as Buffer).toString("hex")).toBe(requestHash);
    expect(validationRequestBytes(document as never).length).toBeGreaterThan(0);

    // Saved: the wallet's address replaces the throwaway, the agent id goes where the config reads it, fly.toml gets both.
    const env = await readEnvFile(join(directory, ".env"));
    expect(env).toMatchObject({ PAY_TO: wallet.publicKey(), AGENT_ID: "42", UPSTREAM_KEY: "key-from-env" });
    expect(env["DEV_PAY_TO"]).toBeUndefined();
    const flyToml = readFileSync(join(directory, "fly.toml"), "utf8");
    expect(flyToml).toContain(`[env]\n  JOB_DB_PATH = "/data/jobs.sqlite"\n  PUBLIC_ORIGIN = "${ORIGIN}"\n  PAY_TO = "${wallet.publicKey()}"\n  AGENT_ID = "42"\n\n[[mounts]]`);
    expect(JSON.parse(readFileSync(join(directory, "provider.config.json"), "utf8")).provider.agentId).toBe("env:AGENT_ID");
    expect(t.output()).toContain(`Launch test is agent 42 on Stellar Testnet, paid to ${wallet.publicKey()}`);
    expect(t.output()).toContain(`Validation requested from ${VALIDATOR}`);
  });

  it("signs nothing when it runs again: the registration names the manifest, and the verifier was asked", async () => {
    project();
    const { chain, registry } = world();
    const wallet = Keypair.random();
    expect(await launch({ validator: VALIDATOR, "no-deploy": true }, io({ chain, registry: registry.registry, approve: walletApproves(wallet).approve }).io)).toBe(0);
    const sent = chain.sent.length;

    const again = io({ chain, registry: registry.registry });
    expect(await launch({ validator: VALIDATOR, "no-deploy": true }, again.io)).toBe(0);
    expect(chain.sent).toHaveLength(sent);
    expect(again.output()).toContain("agent 42 is registered, and its registration names this manifest: nothing to sign");
  });

  it("keeps a new agent's id when the page stops after registering, and asks only for what is missing next time", async () => {
    const directory = project();
    const { chain, registry } = world();
    const wallet = Keypair.random();
    const stopped = io({ chain, registry: registry.registry, approve: walletStopsAt(wallet, "request-validation") });
    expect(await launch({ validator: VALIDATOR, "no-deploy": true }, stopped.io)).toBe(1);
    expect((await readEnvFile(join(directory, ".env")))["AGENT_ID"]).toBe("42");
    expect(stopped.output()).toContain("Agent 42 is registered and saved.");

    const approves = walletApproves(wallet);
    expect(await launch({ validator: VALIDATOR, "no-deploy": true }, io({ chain, registry: registry.registry, approve: approves.approve }).io)).toBe(0);
    // One agent and one request landed: the first page built the request, but nobody signed it.
    expect(registry.agents.size).toBe(1);
    expect(registry.validations.size).toBe(1);
    expect(chain.invoked.filter(({ call }) => call.method === "register_with_uri")).toHaveLength(1);
    expect(approves.views[0]!.steps.map((step) => step.id)).toEqual(["request-validation"]);
  });

  it("asks for no validation from the provider's own account", async () => {
    project();
    const { chain, registry } = world();
    const wallet = Keypair.random();
    const t = io({ chain, registry: registry.registry, approve: walletApproves(wallet).approve });
    expect(await launch({ validator: wallet.publicKey(), "no-deploy": true }, t.io)).toBe(0);
    expect(chain.invoked.map(({ call }) => call.method)).toEqual(["register_with_uri"]);
    expect(t.output()).toContain("is this provider's own account, so it can't validate it");
  });

  it("builds any provider's manifest from its own command, started with the public address", async () => {
    const directory = project({ fly: false, env: "PAY_TO=\nAGENT_ID=\n" });
    const { chain, registry } = world();
    const wallet = Keypair.random();
    const service = defineService({ name: "echo", description: "Echoes its input back, for testing launch.", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: (input) => input });
    let started: NodeJS.ProcessEnv | undefined;
    let fetcher: typeof fetch = async () => new Response("", { status: 503 });
    const start = (command: string, env: NodeJS.ProcessEnv): Started => {
      expect(command).toBe("node dist/server.js");
      started = env;
      const provider = createProvider({
        baseUrl: env["PUBLIC_ORIGIN"]!,
        network: "stellar:testnet",
        payTo: env["PAY_TO"]!,
        provider: { name: "Command provider", ...(env["AGENT_ID"] ? { agentId: Number(env["AGENT_ID"]) } : {}) },
        services: [service],
        facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: false, errorReason: "test" }) },
        rpc: false,
      });
      fetcher = async (input, init) => provider.fetch(new Request(input, init));
      return { exited: new Promise(() => {}), output: () => "", stop: () => provider.close() };
    };
    const t = io({ chain, registry: registry.registry, approve: walletApproves(wallet).approve, start, fetch: (input, init) => fetcher(input, init) });

    expect(await launch({ start: "node dist/server.js", url: "https://api.example.com", validator: VALIDATOR }, t.io)).toBe(0);
    expect(started).toMatchObject({ PUBLIC_ORIGIN: "https://api.example.com", PORT: "4321", AGENT_ID: "" });
    const agent = registry.agents.get(42)!;
    expect(agent.uri).toBe(registrationDataUri(registrationFile({ ...(await (await fetcher(`http://127.0.0.1:4321${DEFAULT_MANIFEST_PATH}`)).json()) }, `https://api.example.com${DEFAULT_MANIFEST_PATH}`)));
    expect(await readEnvFile(join(directory, ".env"))).toMatchObject({ PAY_TO: wallet.publicKey(), AGENT_ID: "42" });
    expect(t.output()).toContain(`Deploy it at https://api.example.com with these settings`);
    expect(t.output()).toContain(`PAY_TO=${wallet.publicKey()} AGENT_ID=42`);
  });

  it("deploys with flyctl when asked, staging the API's key as a secret, then waits for the live manifest and checks it", async () => {
    project({ upstream: "https://api.example.com/summarize" });
    const { chain, registry } = world();
    const wallet = Keypair.random();
    let deployed = false;
    const calls: { args: string[]; input?: string }[] = [];
    const fly: LaunchIo["fly"] = async (args, options = {}) => {
      calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) });
      if (args[0] === "status") return { code: 1, output: "Error: Could not find App \"launch-test\"" };
      if (args[0] === "deploy") deployed = true;
      return { code: 0, output: "" };
    };
    // Until the deploy, the public address answers 404; then it serves the manifest with the agent id.
    const fetcher: typeof fetch = async (input) => {
      if (!deployed || String(input) !== MANIFEST_URL) return new Response("", { status: 404 });
      const config = JSON.parse(readFileSync("provider.config.json", "utf8"));
      const provider = createProvider({
        baseUrl: ORIGIN,
        network: "stellar:testnet",
        payTo: wallet.publicKey(),
        provider: { name: config.provider.name, description: config.provider.description, agentId: 42 },
        services: [defineService({ ...config.services[0], handler: () => ({}) })],
        facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: false, errorReason: "test" }) },
        rpc: false,
      });
      return Response.json(provider.manifest);
    };
    const t = io({ chain, registry: registry.registry, approve: walletApproves(wallet).approve, fly, fetch: fetcher });

    expect(await launch({ validator: VALIDATOR, deploy: true }, t.io)).toBe(0);
    expect(calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual(["secrets import", "version", "auth whoami", "status --app", "apps create", "deploy --config"]);
    expect(calls[0]).toEqual({ args: ["secrets", "import", "--stage", "--app", "launch-test"], input: "UPSTREAM_KEY=key-from-env" });
    expect(calls.at(-1)!.args).toEqual(["deploy", "--config", "fly.toml", "--app", "launch-test", "--ha=false"]);
    expect(t.output()).toContain(`✓ Live: ${MANIFEST_URL}`);
    expect(t.output()).toContain("✓ 8004 [I1]: the registration file lists this manifest");
    expect(t.output()).toContain("✓ 8004 [I3]: the agent wallet is the manifest's payTo");
  });

  it("doesn't deploy a gateway whose API is on 127.0.0.1, which a container can't reach", async () => {
    project();
    const { chain, registry } = world();
    const calls: string[] = [];
    const t = io({ chain, registry: registry.registry, approve: walletApproves(Keypair.random()).approve, fly: async (args) => (calls.push(args[0]!), { code: 0, output: "" }) });
    expect(await launch({ validator: VALIDATOR, deploy: true }, t.io)).toBe(1);
    expect(calls).toEqual([]);
    expect(t.output()).toContain("summarize calls its API at 127.0.0.1, which in a deployed container is the container itself.");
    // Registered all the same, and saved: deploying is all that's left.
    expect(registry.agents.size).toBe(1);
    expect(t.output()).toContain("✗ Not deployed.");
  });

  it("refuses a temporary or http address, an agent that doesn't exist, and conflicting flags, before anything is signed", async () => {
    project();
    const { chain, registry } = world();
    await expect(launch({ url: "https://calm-river-1234.trycloudflare.com" }, io({ chain, registry: registry.registry }).io)).rejects.toThrow(/quick tunnel/);
    await expect(launch({ url: "http://api.example.com" }, io({ chain, registry: registry.registry }).io)).rejects.toThrow(UsageError);
    await expect(launch({ deploy: true, "no-deploy": true } as CliFlags, io({ chain, registry: registry.registry }).io)).rejects.toThrow(UsageError);
    await expect(launch({ source: "owner" }, io({ chain, registry: registry.registry }).io)).rejects.toThrow(/--source, use provider-kit register/);

    writeFileSync(".env", `${readFileSync(".env", "utf8")}AGENT_ID=7\n`);
    const t = io({ chain, registry: registry.registry });
    expect(await launch({ "no-deploy": true }, t.io)).toBe(1);
    expect(t.output()).toContain("agent 7 doesn't exist in the stellar:testnet identity registry [I2]");
    expect(chain.sent).toEqual([]);
    expect(existsSync("fly.toml")).toBe(true);
  });
});
