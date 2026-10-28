import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentMethod } from "@stellar-agent-services/payment-client";
import { USDC_ISSUER, type StellarNetwork } from "@stellar-agent-services/protocol";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rpcOwnerChain } from "../src/cli/owner-chain.js";
import { UsageError, type CliFlags } from "../src/cli/shared.js";
import { tryCall, type TryIo } from "../src/cli/try.js";
import { createProvider, defineService, type Facilitator, type Provider, type Service } from "../src/index.js";
import { signTestPayment } from "../src/testing.js";
import { fakeChain, type FakeChain } from "./support/owner.js";

// provider-kit try: one paid testnet call, the way any client makes it. The payer is a throwaway key, funded with
// test XLM and exactly the price in test USDC. It is approved first, pays once, and only a job that succeeded with a
// payment confirmed on chain exits 0. Here the provider is real and offline: a fake facilitator, a fake chain.

const MANIFEST = "http://localhost:8787/.well-known/stellar-agent-services.json";
const payTo = Keypair.random().publicKey();

const directory = mkdtempSync(join(tmpdir(), "provider-kit-try-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const providers: Provider[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

const countWords = {
  name: "text-stats",
  description: "Counts words.",
  price: "0.01",
  charge: "on-success",
  expectedDurationSeconds: 1,
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false },
  outputSchema: { type: "object", required: ["words"], properties: { words: { type: "integer" } } },
  examples: [{ input: { text: "Hello world." }, output: { words: 2 } }],
} as const;

const textStats = defineService({ ...countWords, handler: ({ text }: { text: string }) => ({ words: text.split(/\s+/).filter(Boolean).length }) });

const report = defineService({
  name: "report",
  description: "Writes a report.",
  price: "0.02",
  charge: "upfront",
  inputSchema: { type: "object", properties: { topic: { type: "string" } } },
  outputSchema: { type: "object" },
  handler: () => ({ report: "done" }),
});

function setup(options: { services?: Service[]; network?: StellarNetwork; answer?: boolean; interactive?: boolean; chain?: FakeChain; facilitator?: Facilitator } = {}) {
  const payer = Keypair.random();
  let settled = 0;
  const facilitator = {
    verify: vi.fn<Facilitator["verify"]>(async () => ({ isValid: true, payer: payer.publicKey() })),
    settle: vi.fn<Facilitator["settle"]>(async (_payload, requirements) => ({
      success: true,
      transaction: (++settled).toString(16).padStart(64, "0"),
      network: requirements.network,
      payer: payer.publicKey(),
    })),
    ...options.facilitator,
  };
  const provider = createProvider({
    baseUrl: "http://localhost:8787",
    dev: true,
    network: options.network ?? "stellar:testnet",
    payTo,
    provider: { name: "Try test" },
    services: options.services ?? [textStats],
    facilitator,
    rpc: false,
  });
  providers.push(provider);
  const chain = options.chain ?? fakeChain();
  // Signs a real payment offline, so the provider's own payment checks run, and confirms it.
  const method = {
    id: "test-exact",
    matches: (requirements: PaymentRequirements) => requirements.scheme === "exact",
    createPayload: vi.fn<PaymentMethod["createPayload"]>(async (requirements) => ({ x402Version: 2, payload: (await signTestPayment(requirements, payer)).payload })),
    confirm: vi.fn<PaymentMethod["confirm"]>(async () => ({ confirmed: true })),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => provider.fetch(new Request(input, init)));
  const lines: string[] = [];
  const asked: string[] = [];
  const io: TryIo = {
    log: (line) => void lines.push(line),
    status: () => {},
    interactive: options.interactive ?? true,
    confirm: async (question) => {
      asked.push(question);
      return options.answer ?? true;
    },
    chain: () => chain,
    payer: () => payer,
    client: { fetch, methods: [method], pollMs: 10 },
  };
  return { provider, payer, facilitator, chain, method, fetch, io, asked, output: () => lines.join("\n") };
}

function run(flags: CliFlags, args: string[], io: TryIo) {
  return tryCall(flags, args, io);
}

describe("provider-kit try", () => {
  it("pays once for the service's example, from a funded throwaway payer, and shows the result", async () => {
    const t = setup();
    expect(await run({ manifest: MANIFEST }, ["text-stats"], t.io)).toBe(0);

    // The exact terms, then the question, before anything is funded or signed.
    expect(t.output()).toContain(`Pay to   ${payTo}`);
    expect(t.output()).toContain('Input    {"text":"Hello world."}  (its example)');
    expect(t.output()).toContain("Price    0.01 USDC, charged only if the work succeeds");
    expect(t.asked).toEqual(["Pay 0.01 USDC in test money? [Y/n] "]);

    // Test XLM, then one transaction, signed by the payer, that adds the trustline and buys exactly the price.
    expect(t.chain.funded).toEqual([t.payer.publicKey()]);
    expect(t.chain.sent).toHaveLength(1);
    const purchase = t.chain.sent[0]!;
    expect(purchase.source).toBe(t.payer.publicKey());
    expect(purchase.signatures).toHaveLength(1);
    expect(purchase.operations).toMatchObject([
      { type: "changeTrust", line: { code: "USDC", issuer: USDC_ISSUER["stellar:testnet"] } },
      { type: "pathPaymentStrictReceive", destination: t.payer.publicKey(), destAmount: "0.0100000" },
    ]);

    // One payment, through the provider's own checks, and the result.
    expect(t.method.createPayload).toHaveBeenCalledTimes(1);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(t.output()).toMatch(/✓ text-stats succeeded: \d+\.\d s from payment to result/);
    expect(t.output()).toContain("✓ Paid 0.01 USDC, confirmed on chain: https://stellar.expert/explorer/testnet/tx/");
    expect(t.output()).toContain('"words": 2');
    expect(t.output()).toMatch(/\(payTo\) received 0\.01 USDC\./);
  });

  it("asks first, and a no funds, signs and pays nothing", async () => {
    const t = setup({ answer: false });
    expect(await run({ manifest: MANIFEST }, ["text-stats"], t.io)).toBe(1);
    expect(t.output()).toContain("Not paid. Nothing was signed.");
    expect(t.chain.funded).toEqual([]);
    expect(t.method.createPayload).not.toHaveBeenCalled();
    expect(t.facilitator.verify).not.toHaveBeenCalled();
  });

  it("pays without asking with --yes, and refuses a script without it before reaching the provider", async () => {
    const script = setup({ interactive: false });
    await expect(run({ manifest: MANIFEST }, ["text-stats"], script.io)).rejects.toThrow(UsageError);
    expect(script.fetch).not.toHaveBeenCalled();

    const t = setup({ interactive: false });
    expect(await run({ manifest: MANIFEST, yes: true }, ["text-stats"], t.io)).toBe(0);
    expect(t.asked).toEqual([]);
  });

  it("takes the input as JSON, or from a file with @", async () => {
    const t = setup();
    expect(await run({ manifest: MANIFEST, yes: true }, ["text-stats", '{"text":"one two three"}'], t.io)).toBe(0);
    expect(t.output()).toContain('"words": 3');

    const file = join(directory, "input.json");
    writeFileSync(file, '{"text":"four words right here"}');
    const u = setup();
    expect(await run({ manifest: MANIFEST, yes: true }, ["text-stats", `@${file}`], u.io)).toBe(0);
    expect(u.output()).toContain('"words": 4');
  });

  it("needs a JSON object as input, and an input for a service without an example", async () => {
    const t = setup({ services: [textStats, report] });
    await expect(run({ manifest: MANIFEST, yes: true }, ["text-stats", "[1, 2]"], t.io)).rejects.toThrow(/must be a JSON object/);
    await expect(run({ manifest: MANIFEST, yes: true }, ["text-stats", "{nope"], t.io)).rejects.toThrow(/must be a JSON object/);
    await expect(run({ manifest: MANIFEST, yes: true }, ["report"], t.io)).rejects.toThrow(/report has no example input, so pass one/);
    await expect(run({ manifest: MANIFEST, yes: true }, ["translate"], t.io)).rejects.toThrow(/has no service "translate"\. It has text-stats, report\./);
    expect(t.chain.funded).toEqual([]);
  });

  it("lists the services to pick from when there are several and none is named", async () => {
    const t = setup({ services: [textStats, report] });
    expect(await run({ manifest: MANIFEST }, [], t.io)).toBe(2);
    expect(t.output()).toContain(`provider-kit try text-stats --manifest ${MANIFEST}   0.01 USDC`);
    expect(t.output()).toContain(`provider-kit try report     --manifest ${MANIFEST}   0.02 USDC`);
    expect(t.asked).toEqual([]);
  });

  it("refuses a provider on Mainnet before anything is signed", async () => {
    const t = setup({ network: "stellar:pubnet" });
    await expect(run({ manifest: MANIFEST, yes: true }, ["text-stats"], t.io)).rejects.toThrow(/is on Stellar Mainnet\..*testnet only\. Nothing was signed\./);
    expect(t.chain.funded).toEqual([]);
    expect(t.method.createPayload).not.toHaveBeenCalled();
  });

  it("shows the provider's refusal of the input before anything is funded", async () => {
    const t = setup();
    await expect(run({ manifest: MANIFEST, yes: true }, ["text-stats", '{"text":""}'], t.io)).rejects.toThrow(
      "text-stats didn't quote a price: the provider answered 400 invalid_input: /text must NOT have fewer than 1 characters. Nothing was signed.",
    );
    expect(t.chain.funded).toEqual([]);
  });

  it("stops before paying when the test USDC can't be bought", async () => {
    const chain = fakeChain();
    chain.answers.push("failed");
    const t = setup({ chain });
    await expect(run({ manifest: MANIFEST, yes: true }, ["text-stats"], t.io)).rejects.toThrow(/^Buying test USDC failed: .*Nothing was paid to text-stats\.$/);
    expect(t.output()).toContain("✗ Test USDC from the testnet DEX: 0.01 USDC");
    expect(t.method.createPayload).not.toHaveBeenCalled();
  });

  it("says when nothing answers at the provider's address", async () => {
    const t = setup();
    t.fetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(run({ manifest: MANIFEST, yes: true }, ["text-stats"], t.io)).rejects.toThrow(/nothing answers at http:\/\/localhost:8787\/\.well-known/);
  });

  it("reports a job that failed as not charged, and exits 1", async () => {
    const failing = defineService({ ...countWords, handler: () => Promise.reject(new Error("the model is down")) });
    const t = setup({ services: [failing] });
    // The only service is picked without naming it.
    expect(await run({ manifest: MANIFEST, yes: true }, [], t.io)).toBe(1);
    expect(t.output()).toMatch(/✗ text-stats failed: /);
    expect(t.output()).toContain("✓ Not charged");
    expect(t.facilitator.settle).not.toHaveBeenCalled();
  });

  it("reports a payment the provider refused as not charged", async () => {
    const t = setup({ facilitator: { verify: async () => ({ isValid: false, invalidReason: "insufficient_funds" }), settle: vi.fn() } });
    expect(await run({ manifest: MANIFEST, yes: true }, ["text-stats"], t.io)).toBe(1);
    expect(t.output()).toMatch(/✗ Not paid: the provider rejected the payment.*Nothing was charged\./);
  });

  it("never calls a lost answer to the paid request unpaid", async () => {
    const t = setup();
    t.fetch.mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) throw new TypeError("fetch failed");
      return t.provider.fetch(new Request(input, init));
    });
    expect(await run({ manifest: MANIFEST, yes: true }, ["text-stats"], t.io)).toBe(1);
    expect(t.output()).toMatch(/! The payment may have gone through, but the answer was lost: the paid request failed/);
    expect(t.output()).toContain("Don't pay again.");
    expect(t.output()).not.toContain("Not paid");
  });

  it("finds the provider from a config's baseUrl, without the rest of the provider's environment", async () => {
    const t = setup();
    const config = join(directory, "provider.config.json");
    writeFileSync(config, JSON.stringify({ baseUrl: "env:TRY_TEST_ORIGIN", payTo: "env:TRY_TEST_PAY_TO", services: [] }));
    vi.stubEnv("TRY_TEST_ORIGIN", "http://localhost:8787");
    try {
      expect(await run({ config, yes: true }, ["text-stats"], t.io)).toBe(0);
      expect(t.fetch.mock.calls[0]![0]).toBe(MANIFEST);
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(run({ config, yes: true }, ["text-stats"], t.io)).rejects.toThrow(/reads the environment variable TRY_TEST_ORIGIN, which is not set\. Set it as the provider has it, or pass --manifest <url>\./);
    await expect(run({ config, manifest: MANIFEST, yes: true }, ["text-stats"], t.io)).rejects.toThrow(UsageError);
  });
});

describe("the throwaway payer's test USDC", () => {
  it("is one transaction from the payer: the trustline, then exactly the price, bought with test XLM", async () => {
    const payer = Keypair.random().publicKey();
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockResolvedValue({
      entries: [{ val: { account: () => ({ seqNum: () => ({ toString: () => "41" }) }) } }],
      latestLedger: 1,
    } as never);
    const transaction = await rpcOwnerChain("stellar:testnet").buyTestUsdc(payer, "100000");
    expect(transaction.source).toBe(payer);
    expect(transaction.sequence).toBe("42");
    expect(transaction.operations).toMatchObject([
      { type: "changeTrust", line: { code: "USDC", issuer: USDC_ISSUER["stellar:testnet"] } },
      { type: "pathPaymentStrictReceive", sendMax: "5000.0000000", destination: payer, destAmount: "0.0100000", path: [] },
    ]);
  });

  it("is testnet only", async () => {
    await expect(rpcOwnerChain("stellar:pubnet", "https://rpc.example.com").buyTestUsdc(Keypair.random().publicKey(), "100000")).rejects.toMatchObject({
      title: "No test USDC on Mainnet",
    });
  });
});
