import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { register, saveAgentId } from "../src/cli/register.js";
import type { CliFlags, StellarCli } from "../src/cli/shared.js";
import { loadTarget } from "../src/cli/target.js";
import { registrationDataUri, registrationFile } from "../src/registration.js";
import { account, fakeChain, fakeRegistry, ownerIo, walletApproves } from "./support/owner.js";

// provider-kit register: by default the payout account's own wallet signs on the approval page, so no key ever
// reaches the CLI. A new agent's id goes into the config, and --source still signs with the Stellar CLI keychain.

const directory = mkdtempSync(join(tmpdir(), "provider-kit-register-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;

/** A gateway config whose payTo is `payTo`, as provider-kit init writes it (two-space JSON). */
function gateway(payTo: string, provider: Record<string, unknown> = { name: "Register test" }): string {
  const path = join(directory, `provider-${++files}.json`);
  const config = {
    $schema: "./node_modules/@stellar-agent-services/provider-kit/schemas/gateway-config.schema.json",
    baseUrl: "https://api.example.com/agent",
    network: "stellar:testnet",
    payTo,
    facilitator: "https://x402.org/facilitator",
    provider,
    store: "memory",
    services: [{ name: "echo", description: "Echoes.", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, upstream: { url: "https://upstream.example.com/echo" } }],
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

let output: string[] = [];
beforeEach(() => {
  output = [];
  const capture = (...args: unknown[]) => void output.push(args.join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const payout = account();
  const chain = fakeChain();
  const world = fakeRegistry();
  chain.returnValue = nativeToScVal(42, { type: "u32" });
  return { payout, chain, world };
}

describe("provider-kit register, approved in the wallet", () => {
  it("registers from the payout account, adds USDC first, and saves the new agent id to the config", async () => {
    const { payout, chain, world } = setup();
    chain.accounts.set(payout.publicKey(), { usdcTrustline: false });
    const path = gateway(payout.publicKey());
    const before = JSON.parse(readFileSync(path, "utf8"));
    const wallet = walletApproves(payout, { wallet: "Freighter" });

    expect(await register({ config: path }, ownerIo({ chain, registry: world.registry, approve: wallet.approve }))).toBe(0);

    // The trustline, then the registration, both signed in the wallet by payTo.
    expect(chain.sent.map((transaction) => transaction.operations[0]!.type)).toEqual(["changeTrust", "invokeHostFunction"]);
    expect(chain.sent.every((transaction) => transaction.source === payout.publicKey())).toBe(true);
    const [{ call }] = chain.invoked as [(typeof chain.invoked)[0]];
    expect(call.method).toBe("register_with_uri");
    expect(scValToNative(call.args[0]!)).toBe(payout.publicKey());
    const target = await loadTarget({ config: path });
    if ("problems" in target) throw new Error(target.problems.join("\n"));
    expect(scValToNative(call.args[1]!)).toBe(registrationDataUri(registrationFile(target.manifest, target.manifestUrl)));

    // The config keeps everything it had, in order, and gains the agent id [I2].
    const after = readFileSync(path, "utf8");
    expect(JSON.parse(after)).toEqual({ ...before, provider: { ...before.provider, agentId: 42 } });
    expect(Object.keys(JSON.parse(after))).toEqual(Object.keys(before));
    expect(output.join("\n")).toContain(`Registered agent 42 on stellar:testnet.\nSaved "agentId": 42 to ${path} [I2].\nNext: restart the provider`);
    expect(wallet.views[0]).toMatchObject({
      state: "done",
      result: {
        title: "Your service is registered",
        details: [
          { label: "Agent", value: "42" },
          { label: "Owner and wallet", value: payout.publicKey() },
        ],
      },
    });
  });

  it("gets test XLM for a new testnet account first", async () => {
    const { payout, chain, world } = setup();
    const wallet = walletApproves(payout);
    expect(await register({ config: gateway(payout.publicKey()) }, ownerIo({ chain, registry: world.registry, approve: wallet.approve }))).toBe(0);
    expect(chain.funded).toEqual([payout.publicKey()]);
    expect(wallet.views[0]!.steps.map((step) => step.id)).toEqual(["fund", "trustline", "register"]);
  });

  it("registers only from the payout account, so the agent wallet is payTo [I3]", async () => {
    const { payout, chain, world } = setup();
    const path = gateway(payout.publicKey());
    const before = readFileSync(path, "utf8");
    const stranger = walletApproves(account());

    expect(await register({ config: path }, ownerIo({ chain, registry: world.registry, approve: stranger.approve }))).toBe(1);
    expect(stranger.views[0]).toMatchObject({ state: "connect", error: { title: "Connect your payout account", message: expect.stringMatching(/payTo \[I3\]/) } });
    expect(chain.invoked).toEqual([]);
    expect(chain.sent).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(output.join("\n")).toContain("Cancelled. Nothing more was signed.");
  });

  it("updates an agent from its owner or an operator of the owner's, and refuses anyone else", async () => {
    const { payout, chain, world } = setup();
    const owner = account();
    const operator = account();
    world.agents.set(7, { owner: owner.publicKey(), uri: "data:application/json;base64,e30=", wallet: payout.publicKey() });
    world.operators.add(`${owner.publicKey()} ${operator.publicKey()}`);
    for (const signer of [owner, operator]) chain.accounts.set(signer.publicKey(), { usdcTrustline: false });
    const path = gateway(payout.publicKey(), { name: "Register test", agentId: 7 });
    const before = readFileSync(path, "utf8");

    for (const signer of [owner, operator]) {
      const wallet = walletApproves(signer);
      expect(await register({ config: path }, ownerIo({ chain, registry: world.registry, approve: wallet.approve }))).toBe(0);
      expect(wallet.views[0]!.steps.map((step) => step.id)).toEqual(["register"]);
    }
    expect(chain.invoked.map(({ call }) => [call.method, scValToNative(call.args[1]!)])).toEqual([
      ["set_agent_uri", 7],
      ["set_agent_uri", 7],
    ]);
    expect(output.join("\n")).toContain("Updated the registration of agent 7 on stellar:testnet.");

    const stranger = walletApproves(account());
    expect(await register({ config: path }, ownerIo({ chain, registry: world.registry, approve: stranger.approve }))).toBe(1);
    expect(stranger.views[0]!.error).toMatchObject({ title: "This account can't change the registration" });
    expect(chain.invoked).toHaveLength(2);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses to update an agent that doesn't exist", async () => {
    const { payout, chain, world } = setup();
    expect(await register({ config: gateway(payout.publicKey(), { name: "Register test", agentId: 9 }) }, ownerIo({ chain, registry: world.registry }))).toBe(1);
    expect(output.join("\n")).toContain("Agent 9 does not exist in the stellar:testnet identity registry [I2]");
  });

  it("signs nothing and opens nothing on a dry run", async () => {
    const { payout, chain, world } = setup();
    expect(await register({ config: gateway(payout.publicKey()), "dry-run": true }, ownerIo({ chain, registry: world.registry }))).toBe(0);
    expect(output.join("\n")).toContain("Dry run. Without --dry-run, a page opens where your wallet signs register_with_uri on stellar:testnet.");
    expect(chain.invoked).toEqual([]);
  });
});

describe("provider-kit register --source", () => {
  it("signs with the Stellar CLI keychain, and saves the new agent id to the config too", async () => {
    const { payout, chain, world } = setup();
    const calls: string[][] = [];
    const stellar: StellarCli = async (args) => {
      calls.push(args);
      return args[0] === "keys" ? `${payout.publicKey()}\n` : '"42"\n';
    };
    const path = gateway(payout.publicKey());
    const flags: CliFlags = { config: path, source: "payto" };
    expect(await register(flags, ownerIo({ chain, registry: world.registry, stellar }))).toBe(0);
    expect(calls.at(-1)).toEqual(expect.arrayContaining(["--source-account", "payto", "register_with_uri", "--caller", payout.publicKey()]));
    expect(JSON.parse(readFileSync(path, "utf8")).provider.agentId).toBe(42);
    expect(chain.invoked).toEqual([]);
  });
});

describe("saveAgentId", () => {
  it("keeps the file's indentation and key order", async () => {
    const path = join(directory, "tabs.json");
    writeFileSync(path, '{\n\t"provider": {\n\t\t"name": "Tabs",\n\t\t"description": "Indented with tabs."\n\t},\n\t"store": "./jobs.sqlite"\n}\n');
    expect(await saveAgentId(path, 5)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{\n\t"provider": {\n\t\t"name": "Tabs",\n\t\t"description": "Indented with tabs.",\n\t\t"agentId": 5\n\t},\n\t"store": "./jobs.sqlite"\n}\n');
  });

  it("leaves an agent id read from the environment alone", async () => {
    const path = join(directory, "env.json");
    const text = '{\n  "provider": { "name": "Env", "agentId": "env:AGENT_ID" }\n}\n';
    writeFileSync(path, text);
    expect(await saveAgentId(path, 5)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});
