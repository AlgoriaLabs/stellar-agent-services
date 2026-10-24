import { createHash } from "node:crypto";
import { chargedFor, USDC_ASSET } from "@stellar-agent-services/protocol";
import { Keypair, Networks, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkPayment,
  defineService,
  ledgerClock,
  memoryStore,
  reconcile,
  rpcChain,
  SEARCH_WINDOW_LEDGERS,
  type CheckedPayment,
  type JobStore,
  type LedgerClock,
  type PaymentClaim,
  type StoredJob,
} from "../src/index.js";
import { sweep } from "../src/jobs/recovery.js";
import { signTestPayment } from "../src/testing.js";
import { fakeChain, LEDGER_SECONDS, transferEvent, type FakeTransaction } from "./support/chain.js";
import { ids, jobId, payer, payTo, testProvider, token } from "./support/harness.js";

// Reconciliation [J13]: a payment_uncertain job is decided from on-chain data, by the transaction that
// carries the payer's signed auth entry with the job's nonce. And the ledger clock: on-success jobs
// are timed by their payment's expiration ledger [S2].

const network = "stellar:testnet";
const usdc = USDC_ASSET[network];
const requirements = {
  scheme: "exact",
  network,
  asset: usdc,
  payTo,
  amount: "100000",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
} as PaymentRequirements;
/** The expiration ledger of the payments below. */
const EXPIRES = 50_000;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A signed payment: the claim the provider stores for it, and the transaction that carries it. */
async function signedPayment(options: { expirationLedger?: number } = {}): Promise<{ claim: PaymentClaim; envelope: xdr.TransactionEnvelope }> {
  const payload = await signTestPayment(requirements, payer, { expirationLedger: options.expirationLedger ?? EXPIRES });
  const checked = (await checkPayment(payload, requirements)) as CheckedPayment;
  const envelope = xdr.TransactionEnvelope.fromXDR((payload.payload as { transaction: string }).transaction, "base64");
  return { claim: { fingerprint: checked.fingerprint, payer: checked.payer, nonce: checked.nonce, expirationLedger: checked.expirationLedger }, envelope };
}

const hash = (n: number) => n.toString(16).padStart(64, "0");

/** A successful transaction that carries the payment and moves the USDC. */
const landed = (n: number, envelope: xdr.TransactionEnvelope, ledger = EXPIRES - 5): FakeTransaction => ({
  hash: hash(n),
  ledger,
  envelope,
  events: [transferEvent({ asset: usdc, from: payer.publicKey(), to: payTo })],
});

let jobs = 0;
function uncertainJob(claim: PaymentClaim, overrides: Partial<StoredJob> = {}): StoredJob {
  const now = new Date().toISOString();
  return {
    jobId: `0192d3a4-7c1e-7b2a-9f00-${(++jobs).toString().padStart(12, "0")}`,
    service: "report",
    charge: "upfront",
    bindingHash: "b",
    tokenHash: "t",
    status: "payment_uncertain",
    claim,
    input: { topic: "tides" },
    settlement: { reason: "the settlement did not answer in 90 s" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function withJob(job: StoredJob): Promise<JobStore> {
  const store = memoryStore();
  await store.claim(job);
  return store;
}

describe("reconcile", () => {
  it("queues an upfront job that the transaction the facilitator named paid, with its receipt", async () => {
    const { claim, envelope } = await signedPayment();
    const job = uncertainJob(claim, { settlement: { reason: "settle_exact_stellar_transaction_failed", transaction: hash(1) } });
    const store = await withJob(job);
    const { chain, calls } = fakeChain({ latestLedger: EXPIRES - 1, transactions: [landed(1, envelope)] });

    const [result] = await reconcile(store, { chain, network, asset: usdc });
    expect(result).toMatchObject({ jobId: job.jobId, outcome: "settled", status: "queued", transaction: hash(1) });
    expect(await store.get(job.jobId)).toMatchObject({
      status: "queued",
      input: { topic: "tides" },
      payment: { network, asset: usdc, amount: "100000", payTo, payer: payer.publicKey(), transaction: hash(1) },
    });
    // Settled is decided as soon as the payment is found, even before it would have expired.
    expect(calls["getEvents"]).toBeUndefined();
  });

  it("finds an on-success job's payment by its transfer events, not by another job's equal transfer", async () => {
    const { claim, envelope } = await signedPayment();
    const other = await signedPayment();
    const job = uncertainJob(claim, { charge: "on-success", output: { report: "kept" } });
    const store = await withJob(job);
    // The same payer, payee and amount, one ledger earlier: another job's payment.
    const { chain } = fakeChain({ latestLedger: EXPIRES + 10, transactions: [landed(7, other.envelope, EXPIRES - 9), landed(8, envelope, EXPIRES - 8)] });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "settled", status: "succeeded", transaction: hash(8) }]);
    const stored = await store.get(job.jobId);
    expect(stored).toMatchObject({ status: "succeeded", output: { report: "kept" }, payment: { transaction: hash(8) } });
    expect(chargedFor(stored!.status as "succeeded", stored!.charge)).toBe(true);
  });

  it("fails a job whose payment never landed before it expired, uncharged, even if the payer paid other jobs", async () => {
    const { claim } = await signedPayment();
    const other = await signedPayment();
    const job = uncertainJob(claim);
    const store = await withJob(job);
    const { chain } = fakeChain({ latestLedger: EXPIRES + 1, transactions: [landed(2, other.envelope)] });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "not_settled", status: "failed" }]);
    const stored = await store.get(job.jobId);
    expect(stored).toMatchObject({ status: "failed", error: { code: "payment_failed" } });
    expect(stored).not.toHaveProperty("payment");
    expect(chargedFor("failed", "upfront", stored!.error!.code)).toBe(false);
  });

  it("leaves a job undecided while its payment can still land", async () => {
    const { claim } = await signedPayment();
    const job = uncertainJob(claim);
    const store = await withJob(job);
    const { chain } = fakeChain({ latestLedger: EXPIRES });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([
      { outcome: "undecided", status: "payment_uncertain", reason: expect.stringMatching(/can still land until ledger 50000/) },
    ]);
    expect(await store.get(job.jobId)).toMatchObject({ status: "payment_uncertain" });
  });

  it("leaves a job undecided when ledgers it could have landed in are older than the RPC's history", async () => {
    const { claim } = await signedPayment();
    const store = await withJob(uncertainJob(claim));
    const { chain } = fakeChain({ latestLedger: EXPIRES + 100, oldestLedger: EXPIRES - 10 });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "undecided", reason: expect.stringMatching(/older than the RPC's history/) }]);
  });

  it("costs no RPC calls for jobs whose every ledger is gone from the RPC's history", async () => {
    const { claim } = await signedPayment();
    const store = await withJob(uncertainJob(claim, { settlement: { reason: "timeout", transaction: hash(13) } }));
    const { chain, calls } = fakeChain({ latestLedger: EXPIRES + 20_000, oldestLedger: EXPIRES + 1 });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "undecided", reason: expect.stringMatching(/more history/) }]);
    expect(calls).toEqual({ getHealth: 1 });
  });

  it("searches every ledger the payment could have landed in", async () => {
    const { claim, envelope } = await signedPayment();
    const store = await withJob(uncertainJob(claim));
    const { chain } = fakeChain({ latestLedger: EXPIRES + 1, transactions: [landed(3, envelope, EXPIRES - SEARCH_WINDOW_LEDGERS)] });
    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "settled", transaction: hash(3) }]);
  });

  it("pages through a busy payer's transfers", async () => {
    const { claim, envelope } = await signedPayment();
    const other = await signedPayment();
    const store = await withJob(uncertainJob(claim));
    const others = Array.from({ length: 150 }, (_, n) => landed(1000 + n, other.envelope, EXPIRES - 200 + (n % 100)));
    const { chain, calls } = fakeChain({ latestLedger: EXPIRES + 1, transactions: [...others, landed(9, envelope, EXPIRES - 1)] });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "settled", transaction: hash(9) }]);
    expect(calls["getEvents"]).toBe(2);
  });

  it("takes the facilitator's retry when the transaction it named failed", async () => {
    const { claim, envelope } = await signedPayment();
    const job = uncertainJob(claim, { settlement: { reason: "settle_exact_stellar_transaction_failed", transaction: hash(4) } });
    const store = await withJob(job);
    const failed: FakeTransaction = { ...landed(4, envelope, EXPIRES - 20), status: "FAILED", events: [] };
    const { chain } = fakeChain({ latestLedger: EXPIRES + 1, transactions: [failed, landed(5, envelope, EXPIRES - 10)] });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "settled", transaction: hash(5) }]);
  });

  it("recognizes the payment inside a fee-bump transaction", async () => {
    const { claim, envelope } = await signedPayment();
    const store = await withJob(uncertainJob(claim));
    const inner = new Transaction(envelope, Networks.TESTNET);
    const bumped = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), "1000", inner, Networks.TESTNET).toEnvelope();
    const { chain } = fakeChain({ latestLedger: EXPIRES + 1, transactions: [landed(6, bumped)] });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "settled", transaction: hash(6) }]);
  });

  it("leaves a job undecided when a transaction used the payment but shows no matching transfer", async () => {
    const { claim, envelope } = await signedPayment();
    const store = await withJob(uncertainJob(claim));
    const odd: FakeTransaction = { ...landed(10, envelope), events: [transferEvent({ asset: usdc, from: payer.publicKey(), to: payTo, amount: 1n })] };
    const { chain } = fakeChain({ latestLedger: EXPIRES + 1, transactions: [odd] });

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "undecided", reason: expect.stringMatching(/no transfer of 100000/) }]);
  });

  it("leaves jobs undecided while the RPC can't be read", async () => {
    const { claim } = await signedPayment();
    const store = await withJob(uncertainJob(claim));
    const { chain, state } = fakeChain({ latestLedger: EXPIRES + 1 });
    state.down = true;

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "undecided", reason: expect.stringMatching(/the RPC is down/) }]);
  });

  it("changes nothing in a dry run", async () => {
    const { claim } = await signedPayment();
    const job = uncertainJob(claim);
    const store = await withJob(job);
    const { chain } = fakeChain({ latestLedger: EXPIRES + 1 });

    expect(await reconcile(store, { chain, network, asset: usdc, dryRun: true })).toMatchObject([{ outcome: "not_settled", status: "failed" }]);
    expect(await store.get(job.jobId)).toMatchObject({ status: "payment_uncertain" });
  });

  it("keeps a decision made meanwhile by a late settlement answer", async () => {
    const { claim, envelope } = await signedPayment();
    const job = uncertainJob(claim, { charge: "on-success", output: { report: "done" } });
    const store = await withJob(job);
    const { chain } = fakeChain({ latestLedger: EXPIRES + 1, transactions: [landed(11, envelope)] });
    const read = chain.getHealth.bind(chain);
    chain.getHealth = async () => {
      await store.update(job.jobId, "payment_uncertain", { status: "succeeded", payment: { network, asset: usdc, amount: "100000", payTo, payer: payer.publicKey(), transaction: hash(11), settledAt: job.createdAt } });
      return read();
    };

    expect(await reconcile(store, { chain, network, asset: usdc })).toMatchObject([{ outcome: "settled", status: "succeeded" }]);
    expect(await store.get(job.jobId)).toMatchObject({ payment: { settledAt: job.createdAt } });
  });
});

describe("a provider with a Soroban RPC", () => {
  const quick = defineService({
    name: "quick",
    description: "Answers at once.",
    price: "0.01",
    charge: "upfront",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    handler: () => ({ ok: true }),
  });

  it("decides uncertain jobs after its startup sweep, and runs the ones that were paid", async () => {
    const { claim, envelope } = await signedPayment();
    const job = uncertainJob(claim, { jobId, service: "quick", input: {}, tokenHash: createHash("sha256").update(token).digest("hex") });
    const store = await withJob(job);
    const { chain } = fakeChain({ latestLedger: EXPIRES + 1, transactions: [landed(12, envelope)] });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { provider, getJob, view } = testProvider([quick], { store, rpc: chain });
    await provider.ready();
    await vi.waitFor(async () => expect(await view(await getJob(jobId, token))).toMatchObject({ status: "succeeded", charged: true, output: { ok: true }, payment: { transaction: hash(12) } }));
    await provider.close();
  });

  const onSuccess = defineService({
    name: "count",
    description: "Counts.",
    price: "0.01",
    charge: "on-success",
    expectedDurationSeconds: 1,
    inputSchema: { type: "object" },
    outputSchema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
    handler: vi.fn(() => ({ n: 1 })),
  });

  it("times an on-success job by its payment's expiration ledger, and fails it uncharged once too late", async () => {
    const latest = 1000;
    const { chain } = fakeChain({ latestLedger: latest });
    const { createJob, payment, view, facilitator } = testProvider([onSuccess], { rpc: chain });
    // Valid for one more ledger: no time to do the work and settle, however recent the claim.
    const response = await createJob("count", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("count", { expirationLedger: latest + 1 }) });
    expect(await view(response)).toMatchObject({ status: "failed", charged: false, error: { code: "timeout" } });
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("runs an on-success job whose payment has time left", async () => {
    const latest = 1000;
    const { chain } = fakeChain({ latestLedger: latest });
    const { createJob, payment, view } = testProvider([onSuccess], { rpc: chain });
    const response = await createJob("count", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("count", { expirationLedger: latest + 12 }) });
    expect(await view(response)).toMatchObject({ status: "succeeded", charged: true, output: { n: 1 } });
  });

  it("refuses a payment whose signature expires further out than maxTimeoutSeconds allows, before the facilitator sees it", async () => {
    const latest = 1000;
    const { chain } = fakeChain({ latestLedger: latest });
    const { createJob, payment, facilitator } = testProvider([onSuccess], { rpc: chain });
    const response = await createJob("count", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("count", { expirationLedger: latest + 60 + 11 }) });
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_exact_stellar_payload_signature_expiration_too_far");
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("still takes payments, timed by the claim, while the RPC is down", async () => {
    const { chain, state } = fakeChain({ latestLedger: 1000 });
    state.down = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createJob, payment, view } = testProvider([onSuccess], { rpc: chain });
    const response = await createJob("count", {}, { ...ids, "PAYMENT-SIGNATURE": await payment("count") });
    expect(await view(response)).toMatchObject({ status: "succeeded", charged: true });
  });
});

describe("the recovery sweep with a ledger clock", () => {
  const options = (latest: number) => ({
    maxTimeoutSeconds: 60,
    settleTimeoutSeconds: 90,
    retentionSeconds: 86400,
    clock: { latest: async () => latest, closesAt: async () => 0 } satisfies LedgerClock,
  });

  it("fails a recent on-success job as soon as its payment's expiration ledger has passed [S2]", async () => {
    const store = memoryStore();
    const expired = uncertainJob({ fingerprint: "f1", payer: "G", nonce: "1", expirationLedger: 100 }, { charge: "on-success", status: "queued" });
    const live = uncertainJob({ fingerprint: "f2", payer: "G", nonce: "2", expirationLedger: 200 }, { charge: "on-success", status: "queued" });
    await store.claim(expired);
    await store.claim(live);
    await sweep(store, options(101));

    expect(await store.get(expired.jobId)).toMatchObject({ status: "failed", error: { code: "timeout" } });
    expect(await store.get(live.jobId)).toMatchObject({ status: "queued" });
  });
});

describe("ledgerClock", () => {
  it("estimates when a ledger closes from the latest close time and the measured ledger duration", async () => {
    const { chain, calls } = fakeChain({ latestLedger: 5000 });
    const clock = ledgerClock(chain);
    const now = Date.now();
    expect(await clock.latest()).toBe(5000);
    expect(Math.abs((await clock.closesAt(5012)) - (now + 12 * LEDGER_SECONDS * 1000))).toBeLessThan(1500);
    // One reading serves both calls.
    expect(calls["getLatestLedger"]).toBe(1);
  });

  it("uses five seconds a ledger when it can't measure", async () => {
    const { chain } = fakeChain({ latestLedger: 5000 });
    chain.getLedgers = async () => {
      throw new Error("not supported");
    };
    const clock = ledgerClock(chain);
    expect((await clock.closesAt(5002)) - (await clock.closesAt(5000))).toBe(10_000);
  });

  it("rejects while the chain can't be read, and logs it once", async () => {
    const { chain, state } = fakeChain({ latestLedger: 5000 });
    state.down = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = ledgerClock(chain);
    await expect(clock.latest()).rejects.toThrow(/down/);
    await expect(clock.closesAt(5001)).rejects.toThrow(/down/);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("rpcChain", () => {
  it("uses the public RPC on testnet, has no default on pubnet, and wants https", () => {
    expect(rpcChain("stellar:testnet")).toBeDefined();
    expect(rpcChain("stellar:pubnet")).toBeUndefined();
    expect(rpcChain("stellar:pubnet", "https://rpc.example.com")).toBeDefined();
    expect(() => rpcChain("stellar:testnet", "http://rpc.example.com")).toThrow(/https/);
    expect(() => rpcChain("stellar:testnet", "http://localhost:8000")).toThrow(/https/);
    expect(rpcChain("stellar:testnet", "http://localhost:8000", { dev: true })).toBeDefined();
  });
});
