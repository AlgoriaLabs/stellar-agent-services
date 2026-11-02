// provider-kit dev and the throwaway payout account: a provider runs on this computer with no wallet, its payTo a testnet
// account whose key is dropped once it holds a USDC trustline, and only public values reach .env. Also the .env writer
// that dev and launch share. Nothing here touches the network.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { devPayTo, payToKind, throwawayPayTo } from "../src/cli/dev-account.js";
import { dev, type DevIo } from "../src/cli/dev.js";
import { loadEnvFile, readEnvFile, updateEnvFile } from "../src/cli/env-file.js";
import type { Started } from "../src/cli/processes.js";
import type { GatewayOptions } from "../src/cli/serve.js";
import { UsageError } from "../src/cli/shared.js";
import { fakeChain } from "./support/owner.js";

const directory = mkdtempSync(join(tmpdir(), "provider-kit-dev-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;
const file = (name: string, text: string) => {
  const path = join(directory, `${++files}-${name}`);
  writeFileSync(path, text);
  return path;
};

const ENV = "# The account clients pay.\nPAY_TO=\n# Where clients reach it.\nPUBLIC_ORIGIN=http://localhost:8787\n# AGENT_ID=\n";

describe(".env files", () => {
  it("sets values in place, fills a commented-out line, appends new ones with their comment, and removes", async () => {
    const path = file(".env", ENV);
    expect(await updateEnvFile(path, { PAY_TO: "GABC", AGENT_ID: "42", DEV_PAY_TO: "GABC" }, { comments: { DEV_PAY_TO: "A throwaway account.\nNobody holds its key." } })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(
      "# The account clients pay.\nPAY_TO=GABC\n# Where clients reach it.\nPUBLIC_ORIGIN=http://localhost:8787\nAGENT_ID=42\n\n# A throwaway account.\n# Nobody holds its key.\nDEV_PAY_TO=GABC\n",
    );
    await updateEnvFile(path, { DEV_PAY_TO: undefined, PUBLIC_ORIGIN: "https://my service.example" });
    expect(await readEnvFile(path)).toEqual({ PAY_TO: "GABC", PUBLIC_ORIGIN: "https://my service.example", AGENT_ID: "42" });
  });

  it("writes nothing without the file, unless asked to create it, and never a value that could break the file", async () => {
    const missing = join(directory, "missing.env");
    expect(await updateEnvFile(missing, { PAY_TO: "GABC" })).toBe(false);
    expect(await readEnvFile(missing)).toEqual({});
    await expect(updateEnvFile(file(".env", ENV), { PAY_TO: 'G"\nSECRET=1' })).rejects.toThrow(/can't write/);
  });

  it("loads like node --env-file: what the environment already has wins", async () => {
    const env: NodeJS.ProcessEnv = { PAY_TO: "GSET" };
    expect(await loadEnvFile(file(".env", "PAY_TO=GFILE\nPORT=9000\n"), env)).toBe(true);
    expect(env).toEqual({ PAY_TO: "GSET", PORT: "9000" });
  });
});

describe("the throwaway payout account", () => {
  it("is a new testnet account that signs only its own USDC trustline, and its key goes nowhere", async () => {
    const chain = fakeChain();
    const keypair = Keypair.random();
    expect(await throwawayPayTo(chain, keypair)).toBe(keypair.publicKey());
    expect(chain.funded).toEqual([keypair.publicKey()]);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.source).toBe(keypair.publicKey());
    expect(chain.sent[0]!.operations.map((operation) => operation.type)).toEqual(["changeTrust"]);
    expect(chain.accounts.get(keypair.publicKey())).toEqual({ usdcTrustline: true });
  });

  it("is made when PAY_TO is empty, and saved with DEV_PAY_TO so launch can tell it from yours", async () => {
    const path = file(".env", ENV);
    const env: NodeJS.ProcessEnv = { PAY_TO: "" };
    const chain = fakeChain();
    const made = await devPayTo({ env, network: "stellar:testnet", chain: () => chain, envFile: path });
    expect(made).toMatchObject({ kind: "throwaway", made: true });
    expect(env["PAY_TO"]).toBe(made.payTo);
    expect(payToKind(env)).toBe("throwaway");
    const saved = readFileSync(path, "utf8");
    expect(await readEnvFile(path)).toMatchObject({ PAY_TO: made.payTo, DEV_PAY_TO: made.payTo });
    // Public addresses only: no secret seed (S...) anywhere in the file.
    expect(saved).not.toMatch(/\bS[A-Z2-7]{55}\b/);

    // The next run uses it again, with nothing signed.
    const again = await devPayTo({ env, network: "stellar:testnet", chain: () => chain, envFile: path });
    expect(again).toEqual({ payTo: made.payTo, kind: "throwaway", made: false });
    expect(chain.sent).toHaveLength(1);
  });

  it("is never made on Mainnet, and an address you set is yours", async () => {
    await expect(devPayTo({ env: {}, network: "stellar:pubnet", chain: () => fakeChain("stellar:pubnet") })).rejects.toThrow(/must be an account in your own wallet/);
    const yours = Keypair.random().publicKey();
    expect(await devPayTo({ env: { PAY_TO: yours }, network: "stellar:pubnet", chain: () => fakeChain("stellar:pubnet") })).toEqual({ payTo: yours, kind: "yours", made: false });
    await expect(devPayTo({ env: { PAY_TO: "not-an-address" }, network: "stellar:testnet", chain: () => fakeChain() })).rejects.toThrow(/not a Stellar address/);
  });
});

/** A dev io that records what dev runs instead of running it. */
function fakeDev(env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const served: { path: string; options: GatewayOptions }[] = [];
  const started: { command: string; args: string[]; env: NodeJS.ProcessEnv; shell: boolean }[] = [];
  const chain = fakeChain();
  const waited: string[] = [];
  let exit!: (code: number) => void;
  const io: DevIo = {
    log: (line) => void lines.push(line),
    chain: () => chain,
    tunnel: async (port) => ({ url: `https://calm-river-${port}.trycloudflare.com`, stop: async () => {} }),
    serve: async (path, options = {}) => {
      served.push({ path, options });
      return { server: { close: async () => {} } } as unknown as Awaited<ReturnType<DevIo["serve"]>>;
    },
    start: (command, args, options) => {
      started.push({ command, args, ...options });
      const process: Started = { exited: new Promise((resolve) => (exit = resolve)), output: () => "", stop: async () => exit(143) };
      return process;
    },
    untilStopped: () => {},
    waitForPort: async (host, port) => void waited.push(`${host}:${port}`),
    env,
  };
  return { io, lines, served, started, chain, waited, exit: (code: number) => exit(code), output: () => lines.join("\n") };
}

const CONFIG = JSON.stringify({ network: "stellar:testnet", listen: { port: 8899 }, services: [{ upstream: { url: "http://127.0.0.1:8000/summarize" } }] });

describe("provider-kit dev", () => {
  it("serves a gateway config in dev mode, paid to a throwaway account made first", async () => {
    const config = file("provider.config.json", CONFIG);
    const envFile = file(".env", ENV);
    const fake = fakeDev();
    expect(await dev({ config, "env-file": envFile }, [], fake.io)).toBe(-1);
    expect(fake.served).toHaveLength(1);
    expect(fake.served[0]).toMatchObject({ path: config, options: { dev: true } });
    expect(fake.served[0]!.options.env!["PAY_TO"]).toMatch(/^G[A-Z2-7]{55}$/);
    expect(fake.output()).toContain("is a throwaway testnet account");
    expect((await readEnvFile(envFile))["PAY_TO"]).toBe(fake.served[0]!.options.env!["PAY_TO"]);
  });

  it("runs a provider's own command with PAY_TO and PORT, and ends with its exit code", async () => {
    const yours = Keypair.random().publicKey();
    const fake = fakeDev({ PAY_TO: yours });
    const running = dev({ "env-file": file(".env", "") }, ["node", "dist/server.js"], fake.io);
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    expect(fake.started).toEqual([{ command: "node", args: ["dist/server.js"], shell: false, env: expect.objectContaining({ PAY_TO: yours, PORT: "8787" }) }]);
    expect(fake.chain.sent).toEqual([]);
    fake.exit(0);
    expect(await running).toBe(0);
  });

  it("serves under a public HTTPS address with --tunnel, outside dev mode, and runs the API next to the gateway with --with", async () => {
    const config = file("provider.config.json", CONFIG);
    const fake = fakeDev({ PAY_TO: Keypair.random().publicKey() });
    expect(await dev({ config, tunnel: true, with: "uvicorn app:app --port 8000", "env-file": file(".env", "") }, [], fake.io)).toBe(-1);
    expect(fake.served[0]!.options).toMatchObject({ dev: false, baseUrl: "https://calm-river-8899.trycloudflare.com" });
    expect(fake.started).toEqual([expect.objectContaining({ command: "uvicorn app:app --port 8000", shell: true })]);
    // The gateway serves only once the API takes connections.
    expect(fake.waited).toEqual(["127.0.0.1:8000"]);
    expect(fake.output()).toContain("it changes every run");
  });

  it("points to check, not try, on Mainnet, where clients pay real USDC", async () => {
    const yours = Keypair.random().publicKey();
    const gateway = fakeDev({ PAY_TO: yours });
    const config = file("provider.config.json", JSON.stringify({ ...JSON.parse(CONFIG), network: "stellar:pubnet" }));
    expect(await dev({ config, "env-file": file(".env", "") }, [], gateway.io)).toBe(-1);
    expect(gateway.output()).toContain("This is Stellar Mainnet: clients pay real USDC");
    expect(gateway.output()).not.toMatch(/\btry\b/);

    // A provider's own command says its network in STELLAR_NETWORK, as the TypeScript template reads it.
    const command = fakeDev({ PAY_TO: yours, STELLAR_NETWORK: "stellar:pubnet" });
    const running = dev({ "env-file": file(".env", "") }, ["node", "dist/server.js"], command.io);
    await vi.waitFor(() => expect(command.started).toHaveLength(1));
    expect(command.output()).toContain("This is Stellar Mainnet: clients pay real USDC");
    command.exit(0);
    expect(await running).toBe(0);
    expect([...gateway.chain.sent, ...command.chain.sent]).toEqual([]);
  });

  it("refuses what it can't run", async () => {
    const fake = fakeDev();
    await expect(dev({ config: "x.json", "env-file": file(".env", "") }, ["node", "server.js"], fake.io)).rejects.toThrow(UsageError);
    await expect(dev({ "env-file": join(directory, "none.env") }, [], fake.io)).rejects.toThrow(/doesn't exist/);
  });
});
