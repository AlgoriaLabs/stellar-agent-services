// The local wallet: where its key is kept (wallet-store.ts), how it signs the owner's steps in place of a wallet app
// (local-wallet.ts), and `provider-kit wallet` (wallet.ts). With a fake chain and a temporary directory: nothing here
// touches the network or the OS keychain.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { approveWithLocalWallet, fundingAsk } from "../src/cli/local-wallet.js";
import type { OwnerIo } from "../src/cli/shared.js";
import { UsageError, type CliFlags } from "../src/cli/shared.js";
import { trustline } from "../src/cli/trustline.js";
import { wallet, type WalletIo } from "../src/cli/wallet.js";
import { privateFile, walletStore, type SecretBackend, type WalletStore } from "../src/cli/wallet-store.js";
import { fakeChain, fakeRegistry, ownerIo, type FakeChain } from "./support/owner.js";

const root = mkdtempSync(join(tmpdir(), "provider-kit-wallet-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
let directories = 0;

/** A store in its own temporary directory, keeping keys in private files. */
function store(backends?: (directory: string) => SecretBackend[]): { wallets: WalletStore; directory: string } {
  const directory = join(root, `home-${++directories}`);
  return { wallets: walletStore({ directory, ...(backends === undefined ? { backends: [privateFile(directory)] } : { backends: backends(directory) }) }), directory };
}

/** Every file under `directory`, as text. */
function everything(directory: string): string {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

/** The owner commands' world, signing with a local wallet. `lines` is what the wallet logged. */
function localIo(chain: FakeChain, wallets: WalletStore, options: { project?: string; sleep?: () => Promise<void>; now?: () => number } = {}) {
  const lines: string[] = [];
  const io: OwnerIo = ownerIo({
    chain,
    registry: fakeRegistry(chain.network).registry,
    approve: (plan, planChain) =>
      approveWithLocalWallet(plan, planChain, {
        wallets,
        project: options.project ?? "/projects/one",
        log: (line) => void lines.push(line),
        sleep: options.sleep ?? (async () => {}),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
  });
  return { io, lines };
}

describe("the wallet store", () => {
  it("keeps a new wallet's key in a file only the user can read, and only public facts in the index", async () => {
    const { wallets, directory } = store();
    const record = await wallets.create("/projects/one");

    const keypair = await wallets.keypair(record.address);
    expect(keypair?.publicKey()).toBe(record.address);
    expect(await wallets.list()).toEqual([record]);
    expect(record).toMatchObject({ project: "/projects/one", keptIn: "file" });

    const keyFile = join(directory, "wallets", `${record.address}.key`);
    if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, "wallets.json"), "utf8")).not.toContain(keypair!.secret());
  });

  it("falls back to the next place when one doesn't work, and never lists a wallet whose key can't be read back", async () => {
    const broken: SecretBackend = { name: "broken", describe: () => "a broken keychain", put: async () => { throw new Error("no keychain here"); }, get: async () => undefined };
    const forgetful: SecretBackend = { name: "forgetful", describe: () => "a keychain that forgets", put: async () => {}, get: async () => undefined };
    const { wallets } = store((directory) => [broken, forgetful, privateFile(directory)]);
    expect((await wallets.create("/projects/one")).keptIn).toBe("file");

    const nowhere = store(() => [broken, forgetful]);
    await expect(nowhere.wallets.create("/projects/one")).rejects.toThrow(/can't be kept on this computer/);
    expect(await nowhere.wallets.list()).toEqual([]);
  });

  it("knows an account that isn't a local wallet, and refuses a key that isn't the account's", async () => {
    const other = Keypair.random();
    const swapped: SecretBackend = { name: "swapped", describe: () => "a keychain", put: async () => {}, get: async () => other.secret() };
    const { wallets } = store();
    expect(await wallets.keypair(Keypair.random().publicKey())).toBeUndefined();
    await expect(store(() => [swapped]).wallets.create("/projects/one")).rejects.toThrow(/can't be kept/);
  });
});

describe("--local-wallet", () => {
  it("makes the project's wallet, funds it on testnet and signs the steps, without ever showing the key", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const chain = fakeChain();
    const { wallets, directory } = store();
    const { io, lines } = localIo(chain, wallets);

    expect(await trustline({}, io)).toBe(0);

    const [record] = await wallets.list();
    expect(chain.funded).toEqual([record!.address]);
    expect(chain.sent.map((transaction) => transaction.source)).toEqual([record!.address]);
    expect(chain.accounts.get(record!.address)?.usdcTrustline).toBe(true);
    // The key is in its file and nowhere else: not in what was logged, not in the index.
    const secret = (await wallets.keypair(record!.address))!.secret();
    const shown = [...lines, ...output.mock.calls.flat().map(String)].join("\n");
    expect(shown).toContain(record!.address);
    expect(shown).not.toContain(secret);
    expect(everything(directory).split(secret)).toHaveLength(2);
  });

  it("uses the same wallet when the project runs again, and another one for another project", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const chain = fakeChain();
    const { wallets } = store();
    expect(await trustline({}, localIo(chain, wallets).io)).toBe(0);
    expect(await trustline({}, localIo(chain, wallets).io)).toBe(0);
    expect(await wallets.list()).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);

    expect(await trustline({}, localIo(chain, wallets, { project: "/projects/two" }).io)).toBe(0);
    expect((await wallets.list()).map((record) => record.project)).toEqual(["/projects/one", "/projects/two"]);
  });

  it("on Mainnet, asks for XLM sized to the steps, and asks for more instead of sending what the account can't pay", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const chain = fakeChain("stellar:pubnet");
    const { wallets } = store();
    let polls = 0;
    const { io, lines } = localIo(chain, wallets, {
      sleep: async () => {
        polls += 1;
        const [record] = await wallets.list();
        // The person sends 1 XLM first: enough for the account to exist, not for its trustline's reserve. Then more.
        if (polls === 1) chain.accounts.set(record!.address, { usdcTrustline: false, xlm: 10_000_000n });
        if (polls === 2) chain.accounts.set(record!.address, { usdcTrustline: false, xlm: 20_000_000n });
      },
    });

    expect(await trustline({ network: "mainnet" }, io)).toBe(0);

    const [record] = await wallets.list();
    const shown = lines.join("\n");
    expect(shown).toContain("Send 2 XLM to this account on Stellar Mainnet");
    expect(shown).toContain(record!.address);
    expect(shown).toContain("holds 1 XLM, of which Stellar keeps 1.5 XLM in reserve");
    expect(shown).toContain("Send it 1 XLM more on Stellar Mainnet");
    expect(shown).toContain("✓ Received: it holds 2 XLM");
    expect(shown).toContain("back it up: run provider-kit wallet export");
    // Friendbot is never asked on Mainnet, and the trustline is sent once, when the account can pay for it.
    expect(chain.funded).toEqual([]);
    expect(chain.sent).toHaveLength(1);
  });

  it("sizes the first request by what the plan stores on chain", () => {
    const xlm = (stores?: number[]) => Number(fundingAsk(stores === undefined ? {} : { stores })) / 1e7;
    // A trustline alone; a typical launch (registration and validation request); the largest registration file.
    expect(xlm()).toBe(2);
    expect(xlm([501, 600])).toBe(2.5);
    expect(xlm([8192, 600])).toBe(4);
  });

  it("gives up when no XLM arrives, signs nothing, and waits for the same account the next time", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const chain = fakeChain("stellar:pubnet");
    const { wallets } = store();
    let clock = 0;
    const waiting = { sleep: async () => void (clock += 60_000), now: () => clock };

    expect(await trustline({ network: "mainnet" }, localIo(chain, wallets, waiting).io)).toBe(1);
    expect(chain.sent).toEqual([]);

    const [record] = await wallets.list();
    chain.accounts.set(record!.address, { usdcTrustline: false, xlm: 30_000_000n });
    expect(await trustline({ network: "mainnet" }, localIo(chain, wallets, waiting).io)).toBe(0);
    expect(await wallets.list()).toHaveLength(1);
    expect(chain.sent.map((transaction) => transaction.source)).toEqual([record!.address]);
  });

  it("refuses an account whose key isn't here: nothing is signed, and no wallet is made", async () => {
    const chain = fakeChain();
    const { wallets } = store();
    const theirs = Keypair.random().publicKey();
    const outcome = await approveWithLocalWallet(
      { command: "provider-kit register", title: "", intro: "", network: "stellar:testnet", account: { address: theirs, label: "Payout account", reason: "" }, outline: [], steps: async () => [], result: () => ({ title: "", message: "", details: [] }) },
      chain,
      { wallets, project: "/projects/one", log: () => {} },
    );
    expect(outcome).toMatchObject({ status: "failed", reason: expect.stringContaining("isn't a local wallet on this computer") });
    expect(await wallets.list()).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  it("stops when a transaction's fate is unknown, and never sends it again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const chain = fakeChain();
    chain.answers.push("unknown");
    const { wallets } = store();
    expect(await trustline({}, localIo(chain, wallets).io)).toBe(1);
    expect(chain.sent).toHaveLength(1);
  });

  it("builds a refused transaction again, a limited number of times", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const once = fakeChain();
    once.answers.push("failed");
    expect(await trustline({}, localIo(once, store().wallets).io)).toBe(0);
    expect(once.sent).toHaveLength(2);

    const always = fakeChain();
    always.answers.push("failed", "failed", "failed", "failed");
    expect(await trustline({}, localIo(always, store().wallets).io)).toBe(1);
    expect(always.sent).toHaveLength(3);
  });

  it("never sends again by itself a transaction that failed in a ledger: its fee was paid", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const chain = fakeChain();
    chain.answers.push("charged");
    const { wallets } = store();
    expect(await trustline({}, localIo(chain, wallets).io)).toBe(1);
    expect(chain.sent).toHaveLength(1);
    expect(output.mock.calls.flat().join("\n")).toContain("its fee was paid, and it wasn't sent again");

    // The next run goes on from what is on chain, with the same wallet.
    expect(await trustline({}, localIo(chain, wallets).io)).toBe(0);
    expect(await wallets.list()).toHaveLength(1);
    expect(chain.sent).toHaveLength(2);
  });

  it("keeps waiting for XLM while the network doesn't answer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const chain = fakeChain("stellar:pubnet");
    const { wallets } = store();
    const account = chain.account;
    let outage = false;
    chain.account = async (address) => {
      if (outage) throw new Error("fetch failed");
      return account(address);
    };
    let polls = 0;
    const { io, lines } = localIo(chain, wallets, {
      sleep: async () => {
        polls += 1;
        outage = polls < 3;
        if (polls === 3) chain.accounts.set((await wallets.list())[0]!.address, { usdcTrustline: false, xlm: 20_000_000n });
      },
    });

    expect(await trustline({ network: "mainnet" }, io)).toBe(0);
    // Said once for the outage, not on every read.
    expect(lines.filter((line) => line.includes("isn't answering. Still waiting."))).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);
  });

  it("says a local wallet would sign on a dry run, and makes none", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const { wallets } = store();
    expect(await trustline({ "dry-run": true, "local-wallet": true }, localIo(fakeChain(), wallets).io)).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("a local wallet on this computer adds a USDC trustline");
    expect(await wallets.list()).toEqual([]);
  });
});

describe("provider-kit wallet", () => {
  async function setUp(options: { network?: "stellar:testnet" | "stellar:pubnet"; interactive?: boolean; answer?: string } = {}) {
    const chain = fakeChain(options.network ?? "stellar:testnet");
    const { wallets } = store();
    const record = await wallets.create("/projects/one");
    chain.accounts.set(record.address, { usdcTrustline: true, xlm: 25_000_000n, usdc: 123_400_000n });
    const mine = Keypair.random().publicKey();
    chain.accounts.set(mine, { usdcTrustline: true });
    const lines: string[] = [];
    const asked: string[] = [];
    const io: WalletIo = {
      wallets,
      chain: () => chain,
      log: (line) => void lines.push(line),
      interactive: options.interactive ?? false,
      ask: async (question) => {
        asked.push(question);
        return options.answer;
      },
      project: "/projects/one",
    };
    const run = (flags: CliFlags, ...args: string[]) => wallet(flags, args, io);
    return { chain, wallets, record, mine, lines, asked, run, output: () => lines.join("\n") };
  }

  it("shows each wallet, where its key is and what it holds, without the key", async () => {
    const t = await setUp();
    expect(await t.run({ network: "testnet" })).toBe(0);
    expect(t.output()).toContain(`${t.record.address}  (this project)`);
    expect(t.output()).toContain("2.5 XLM, 12.34 USDC");
    expect(t.output()).not.toContain((await t.wallets.keypair(t.record.address))!.secret());

    t.lines.length = 0;
    expect(await t.run({ network: "testnet", json: true })).toBe(0);
    expect(JSON.parse(t.output())).toMatchObject({ wallets: [{ address: t.record.address, thisProject: true, balances: { "stellar:testnet": { xlm: "2.5 XLM", usdc: "12.34 USDC" } } }] });
  });

  it("withdraws all the USDC to an account that can take it, signed by the wallet", async () => {
    const t = await setUp();
    expect(await t.run({ to: t.mine, network: "testnet", yes: true, memo: "deposit 42" }, "withdraw")).toBe(0);
    expect(t.chain.sent).toHaveLength(1);
    const [sent] = t.chain.sent;
    expect(sent!.source).toBe(t.record.address);
    expect(sent!.memo.value?.toString()).toBe("deposit 42");
    expect(sent!.operations[0]).toMatchObject({ type: "payment", destination: t.mine, amount: "12.3400000", asset: { code: "USDC" } });
    expect(t.output()).toContain("12.34 USDC (all of it)");
  });

  it("withdraws a named amount of XLM", async () => {
    const t = await setUp();
    expect(await t.run({ to: t.mine, network: "testnet", yes: true, asset: "xlm", amount: "0.5" }, "withdraw")).toBe(0);
    expect(t.chain.sent[0]!.operations[0]).toMatchObject({ type: "payment", amount: "0.5000000", asset: { code: "XLM" } });
  });

  it("pays out XLM only from what is above the reserve and the fee", async () => {
    const t = await setUp();
    // It holds 2.5 XLM; the account and its trustline lock 1.5, and the payment's fee is at most 0.001.
    expect(await t.run({ to: t.mine, network: "testnet", yes: true, asset: "xlm", amount: "1.5" }, "withdraw")).toBe(1);
    expect(t.chain.sent).toEqual([]);
    expect(t.output()).toContain("Stellar keeps 1.5 XLM in reserve. It can pay out 0.999 XLM at most.");

    expect(await t.run({ to: t.mine, network: "testnet", yes: true, asset: "xlm", amount: "0.999" }, "withdraw")).toBe(0);
    expect(t.chain.sent).toHaveLength(1);
  });

  it("asks before paying, and pays only on a yes", async () => {
    const no = await setUp({ interactive: true, answer: "" });
    expect(await no.run({ to: no.mine, network: "testnet" }, "withdraw")).toBe(1);
    expect(no.asked).toHaveLength(1);
    expect(no.chain.sent).toEqual([]);

    const yes = await setUp({ interactive: true, answer: "y" });
    expect(await yes.run({ to: yes.mine, network: "testnet" }, "withdraw")).toBe(0);
    expect(yes.chain.sent).toHaveLength(1);

    const nobody = await setUp();
    expect(await nobody.run({ to: nobody.mine, network: "testnet" }, "withdraw")).toBe(1);
    expect(nobody.chain.sent).toEqual([]);
  });

  it("sends nothing to an account that can't take it, or more than the wallet holds", async () => {
    const t = await setUp();
    const noTrustline = Keypair.random().publicKey();
    t.chain.accounts.set(noTrustline, { usdcTrustline: false });
    expect(await t.run({ to: noTrustline, network: "testnet", yes: true }, "withdraw")).toBe(1);
    expect(await t.run({ to: Keypair.random().publicKey(), network: "testnet", yes: true }, "withdraw")).toBe(1);
    expect(await t.run({ to: t.mine, network: "testnet", yes: true, amount: "13" }, "withdraw")).toBe(1);
    expect(t.chain.sent).toEqual([]);
    expect(t.output()).toContain("has no USDC trustline");
    expect(t.output()).toContain("doesn't exist");
    expect(t.output()).toContain("less than 13.00 USDC");
  });

  it("never moves money on a network by default, and checks what it is given", async () => {
    const t = await setUp();
    await expect(t.run({ to: t.mine, yes: true }, "withdraw")).rejects.toThrow(UsageError);
    await expect(t.run({ network: "testnet", yes: true }, "withdraw")).rejects.toThrow(UsageError);
    await expect(t.run({ to: "not-an-address", network: "testnet" }, "withdraw")).rejects.toThrow(UsageError);
    await expect(t.run({ to: t.record.address, network: "testnet" }, "withdraw")).rejects.toThrow(UsageError);
    await expect(t.run({ to: t.mine, network: "testnet", asset: "xlm" }, "withdraw")).rejects.toThrow(UsageError);
    await expect(t.run({ to: t.mine, network: "testnet", amount: "1.123456789" }, "withdraw")).rejects.toThrow(UsageError);
    expect(t.chain.sent).toEqual([]);
  });

  it("reports a payment whose fate is unknown as unknown, never as failed", async () => {
    const t = await setUp();
    t.chain.answers.push("unknown");
    expect(await t.run({ to: t.mine, network: "testnet", yes: true }, "withdraw")).toBe(1);
    expect(t.output()).toContain("isn't confirmed");
    expect(t.output()).toContain("Look it up before trying again");
  });

  it("exports the key only to a person at a terminal who asks for it", async () => {
    const script = await setUp();
    const secret = (await script.wallets.keypair(script.record.address))!.secret();
    expect(await script.run({}, "export")).toBe(1);
    expect(await script.run({ yes: true }, "export")).toBe(1);
    expect(script.output()).not.toContain(secret);

    const agent = await setUp({ interactive: true, answer: "show" });
    expect(await agent.run({ yes: true }, "export")).toBe(1);
    expect(agent.asked).toEqual([]);

    const unsure = await setUp({ interactive: true, answer: "y" });
    expect(await unsure.run({}, "export")).toBe(1);
    expect(unsure.output()).not.toContain((await unsure.wallets.keypair(unsure.record.address))!.secret());

    const person = await setUp({ interactive: true, answer: "show" });
    expect(await person.run({}, "export")).toBe(0);
    expect(person.output()).toContain((await person.wallets.keypair(person.record.address))!.secret());
  });
});
