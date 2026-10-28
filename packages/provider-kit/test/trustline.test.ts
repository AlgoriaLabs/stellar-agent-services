import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USDC_ISSUER } from "@stellar-agent-services/protocol";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError, type StellarCli } from "../src/cli/shared.js";
import { trustline } from "../src/cli/trustline.js";
import { account, fakeChain, fakeRegistry, ownerIo, walletApproves } from "./support/owner.js";

// provider-kit trustline: the payout account gets its USDC trustline [P2], approved in its own wallet. Nothing is
// signed when it already has one.

const directory = mkdtempSync(join(tmpdir(), "provider-kit-trustline-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;

function gateway(payTo: string): string {
  const path = join(directory, `provider-${++files}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      baseUrl: "http://localhost:8787",
      dev: true,
      network: "stellar:testnet",
      payTo,
      facilitator: "https://x402.org/facilitator",
      provider: { name: "Trustline test" },
      store: "memory",
      services: [{ name: "echo", description: "Echoes.", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, upstream: { url: "http://127.0.0.1:5000/echo" } }],
    }),
  );
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

describe("provider-kit trustline", () => {
  it("adds USDC to the provider's payTo, from its own wallet", async () => {
    const payout = account();
    const chain = fakeChain();
    chain.accounts.set(payout.publicKey(), { usdcTrustline: false });
    const wallet = walletApproves(payout);
    expect(await trustline({ config: gateway(payout.publicKey()) }, ownerIo({ chain, registry: fakeRegistry().registry, approve: wallet.approve }))).toBe(0);
    expect(chain.sent.map((transaction) => [transaction.source, transaction.operations[0]!.type])).toEqual([[payout.publicKey(), "changeTrust"]]);
    expect(chain.accounts.get(payout.publicKey())).toEqual({ usdcTrustline: true });
    expect(output.join("\n")).toContain(`${payout.publicKey()} can now receive USDC on stellar:testnet.`);
    expect(output.join("\n")).not.toContain("PAY_TO=");
  });

  it("signs nothing, and opens nothing, when payTo already has a USDC trustline", async () => {
    const payout = account();
    const chain = fakeChain();
    chain.accounts.set(payout.publicKey(), { usdcTrustline: true });
    expect(await trustline({ config: gateway(payout.publicKey()) }, ownerIo({ chain, registry: fakeRegistry().registry }))).toBe(0);
    expect(output.join("\n")).toContain("already has a USDC trustline on stellar:testnet. Nothing to sign.");
  });

  it("needs no trustline for a contract payTo", async () => {
    const chain = fakeChain();
    const contract = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    expect(await trustline({ config: gateway(contract) }, ownerIo({ chain, registry: fakeRegistry().registry }))).toBe(0);
    expect(output.join("\n")).toContain(`payTo ${contract} is a contract: it holds USDC without a trustline.`);
  });

  it("asks for payTo's wallet, and adds nothing from another account", async () => {
    const payout = account();
    const chain = fakeChain();
    chain.accounts.set(payout.publicKey(), { usdcTrustline: false });
    const stranger = walletApproves(account());
    expect(await trustline({ config: gateway(payout.publicKey()) }, ownerIo({ chain, registry: fakeRegistry().registry, approve: stranger.approve }))).toBe(1);
    expect(stranger.views[0]!.error).toMatchObject({ title: "Connect your payout account" });
    expect(chain.sent).toEqual([]);
  });

  it("without a provider, sets up the account the wallet connects, funds a new testnet one, and prints it as PAY_TO", async () => {
    const fresh = account();
    const chain = fakeChain();
    const wallet = walletApproves(fresh);
    expect(await trustline({}, ownerIo({ chain, registry: fakeRegistry().registry, approve: wallet.approve }))).toBe(0);
    expect(chain.funded).toEqual([fresh.publicKey()]);
    expect(wallet.views[0]).toMatchObject({ state: "done", result: { title: "Ready to receive USDC" } });
    expect(output.join("\n")).toContain(`Use it as your payout address: PAY_TO=${fresh.publicKey()}`);
  });

  it("says so, and signs nothing, when the connected account already holds USDC", async () => {
    const ready = account();
    const chain = fakeChain();
    chain.accounts.set(ready.publicKey(), { usdcTrustline: true });
    const wallet = walletApproves(ready);
    expect(await trustline({ network: "testnet" }, ownerIo({ chain, registry: fakeRegistry().registry, approve: wallet.approve }))).toBe(0);
    expect(chain.sent).toEqual([]);
    expect(wallet.views[0]!.result!.message).toMatch(/already had a USDC trustline/);
  });

  it("with --source, signs change_trust with the Stellar CLI keychain, only for payTo's key", async () => {
    const payout = account();
    const chain = fakeChain();
    chain.accounts.set(payout.publicKey(), { usdcTrustline: false });
    const calls: string[][] = [];
    const stellar: StellarCli = async (args) => {
      calls.push(args);
      return args[0] === "keys" ? `${payout.publicKey()}\n` : "";
    };
    const io = ownerIo({ chain, registry: fakeRegistry().registry, stellar });
    expect(await trustline({ config: gateway(payout.publicKey()), source: "payto" }, io)).toBe(0);
    expect(calls.at(-1)).toEqual(["tx", "new", "change-trust", "--source-account", "payto", "--network", "testnet", "--line", `USDC:${USDC_ISSUER["stellar:testnet"]}`]);
    expect(output.join("\n")).toContain(`${payout.publicKey()} can now receive USDC on stellar:testnet.`);

    calls.length = 0;
    expect(await trustline({ config: gateway(account().publicKey()), source: "payto" }, io)).toBe(1);
    expect(calls).toEqual([["keys", "address", "payto"]]);
    expect(output.join("\n")).toContain("not the manifest's payTo");
  });

  it("takes --network only without a provider, and only testnet or mainnet", async () => {
    const io = ownerIo({ chain: fakeChain(), registry: fakeRegistry().registry });
    await expect(trustline({ network: "futurenet" }, io)).rejects.toThrow(UsageError);
    await expect(trustline({ network: "testnet", config: gateway(account().publicKey()) }, io)).rejects.toThrow(/comes from the provider's manifest/);
  });
});
