// provider-kit status: each stage read from this computer, the chain and the public address, and the one command to run
// next, as a project goes from nothing running to verified. With a fake network: nothing here touches it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MANIFEST_PATH, HORIZON_URL, USDC_ISSUER, VALIDATION_TAG } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/cli/env-file.js";
import { findStatus as find, status, type StatusIo } from "../src/cli/status.js";
import { createProvider, defineService, registrationDataUri, registrationFile } from "../src/index.js";
import { fakeChain, fakeRegistry } from "./support/owner.js";

const root = mkdtempSync(join(tmpdir(), "provider-kit-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = process.cwd();
afterEach(() => process.chdir(home));
let projects = 0;

const LOCAL = `http://localhost:8787${DEFAULT_MANIFEST_PATH}`;
const PUBLIC = `https://status-test.fly.dev${DEFAULT_MANIFEST_PATH}`;
const VALIDATOR = Keypair.random().publicKey();
const service = defineService({ name: "echo", description: "Echoes its input back, for testing status.", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: (input) => input });

/** findStatus() with the project's .env loaded, as `status` loads it. */
async function findStatus(flags: Parameters<typeof find>[0], io: StatusIo) {
  await loadEnvFile(".env", io.env);
  return find(flags, io);
}

function manifest(baseUrl: string, payTo: string, agentId?: number) {
  return createProvider({
    baseUrl,
    dev: baseUrl.startsWith("http://"),
    network: "stellar:testnet",
    payTo,
    provider: { name: "Status test", ...(agentId === undefined ? {} : { agentId }) },
    services: [service],
    facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: false, errorReason: "test" }) },
    rpc: false,
  }).manifest;
}

/** A project directory, made the working directory, with `.env` lines and optionally fly.toml. */
function project(env: string, options: { fly?: boolean } = {}): void {
  const directory = join(root, `project-${++projects}`);
  mkdirSync(directory);
  writeFileSync(join(directory, ".env"), env);
  if (options.fly) writeFileSync(join(directory, "fly.toml"), 'app = "status-test"\n');
  process.chdir(directory);
}

function setup(state: { local?: boolean; usdc?: string; payTo: string; agentId?: number; live?: boolean; answered?: boolean; requested?: boolean }) {
  const chain = fakeChain();
  chain.accounts.set(state.payTo, { usdcTrustline: true });
  const world = fakeRegistry();
  if (state.agentId !== undefined) {
    world.agents.set(state.agentId, { owner: state.payTo, wallet: state.payTo, uri: registrationDataUri(registrationFile(manifest("https://status-test.fly.dev", state.payTo, state.agentId), PUBLIC)) });
  }
  if (state.requested || state.answered) {
    world.validations.set("ab".repeat(32), { validator: VALIDATOR, agentId: state.agentId!, hasResponse: state.answered === true, response: 100, responseHash: "", tag: state.answered ? VALIDATION_TAG : "", lastUpdate: 1 });
  }
  const lines: string[] = [];
  const io: StatusIo = {
    log: (line) => void lines.push(line),
    fetch: async (input) => {
      const url = String(input);
      if (url === LOCAL && state.local) return Response.json(manifest("http://localhost:8787", state.payTo));
      if (url === PUBLIC && state.live) return Response.json(manifest("https://status-test.fly.dev", state.payTo, state.agentId));
      if (url === `${HORIZON_URL["stellar:testnet"]}/accounts/${state.payTo}`) {
        return Response.json({ balances: [{ asset_type: "native", balance: "10000.0000000" }, { asset_code: "USDC", asset_issuer: USDC_ISSUER["stellar:testnet"], balance: state.usdc ?? "0.0000000" }] });
      }
      throw new TypeError("fetch failed");
    },
    chain: () => chain,
    registry: () => world.registry,
    env: {},
  };
  return { io, lines };
}

describe("provider-kit status", () => {
  it("starts with dev when nothing runs, then try, then launch", async () => {
    const throwaway = Keypair.random().publicKey();
    project(`PAY_TO=${throwaway}\nDEV_PAY_TO=${throwaway}\n`);
    let found = await findStatus({}, setup({ payTo: throwaway }).io);
    expect(found.stages.map((stage) => [stage.id, stage.ok])).toEqual([
      ["local", false],
      ["payTo", true],
      ["paid", false],
      ["registered", false],
      ["live", false],
      ["verified", false],
    ]);
    expect(found.stages[1]!.detail).toContain("a throwaway testnet account (test payments only)");
    expect(found.next.command).toBe("provider-kit dev");

    found = await findStatus({}, setup({ payTo: throwaway, local: true }).io);
    expect(found.next.command).toBe("provider-kit try");

    found = await findStatus({}, setup({ payTo: throwaway, local: true, usdc: "0.0200000" }).io);
    expect(found.stages.find((stage) => stage.id === "paid")).toEqual({ id: "paid", ok: true, detail: "payTo holds 0.0200000 USDC: paid calls reached it" });
    expect(found.next.command).toBe("provider-kit launch");
  });

  it("says to deploy once registered, finds the public manifest from fly.toml, and is done once a verifier answered", async () => {
    const yours = Keypair.random().publicKey();
    project(`PAY_TO=${yours}\nAGENT_ID=42\n`, { fly: true });
    let found = await findStatus({}, setup({ payTo: yours, agentId: 42 }).io);
    expect(found.stages.find((stage) => stage.id === "registered")).toMatchObject({ ok: true, detail: `agent 42: its registration lists ${PUBLIC}, its wallet is payTo` });
    expect(found.stages.find((stage) => stage.id === "live")).toMatchObject({ ok: false });
    expect(found.next.command).toBe("fly deploy --ha=false");

    found = await findStatus({}, setup({ payTo: yours, agentId: 42, live: true, requested: true }).io);
    expect(found.stages.find((stage) => stage.id === "verified")).toMatchObject({ ok: false, detail: expect.stringContaining("no answer yet") });
    expect(found.next).toEqual({ why: expect.stringContaining("Waiting for the verifier") });

    const done = setup({ payTo: yours, agentId: 42, live: true, answered: true });
    expect(await status({ json: true }, done.io)).toBe(0);
    const printed = JSON.parse(done.lines.join("\n"));
    // Nothing runs on this computer any more, and that's fine: the public stages are what count now.
    expect(Object.fromEntries(printed.stages.map((stage: { id: string; ok: boolean | null }) => [stage.id, stage.ok]))).toMatchObject({ local: false, registered: true, live: true, verified: true });
    expect(printed.stages.find((stage: { id: string }) => stage.id === "verified")).toMatchObject({ ok: true, detail: expect.stringContaining("answered with 100 of 100") });
    expect(printed.next.why).toContain("Nothing");
  });

  it("finds the public manifest from the registration itself, without fly.toml", async () => {
    const yours = Keypair.random().publicKey();
    project(`PAY_TO=${yours}\nAGENT_ID=42\n`);
    const found = await findStatus({}, setup({ payTo: yours, agentId: 42, live: true }).io);
    expect(found.stages.find((stage) => stage.id === "live")).toEqual({ id: "live", ok: true, detail: `${PUBLIC} answers` });
  });
});
