// An offline world to verify providers in: the real Provider Kit as the provider, a fake facilitator
// that settles payments onto a fake Soroban chain (the transaction carries the payer's real signed auth
// entry and a SAC transfer event), a fake 8004 registry holding the provider's real registration file,
// and a test payer that signs real payments offline. The verifier runs against it exactly as against a
// real provider: nothing here is a verifier internal.

import {
  createProvider,
  defineService,
  registrationDataUri,
  registrationFile,
  type Facilitator,
  type Provider,
  type ProviderConfig,
  type Service,
} from "@stellar-agent-services/provider-kit";
import { signTestPayment } from "@stellar-agent-services/provider-kit/testing";
import { Address, Keypair, nativeToScVal, Networks, rpc, scValToNative, StrKey, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { TESTNET_CONFIG } from "@trionlabs/stellar8004";
import { afterEach } from "vitest";
import type { ChainReader, Payer, Registry, TrustlineState, ValidationRecord, VerifyOptions } from "../../src/index.js";
import { verifyProvider } from "../../src/index.js";

export const payTo = Keypair.random().publicKey();
export const payerKeys = Keypair.random();
export const payer = payerKeys.publicKey();
export const validator = Keypair.random().publicKey();
export const ORIGIN = "https://provider.test";
export const MANIFEST_URL = `${ORIGIN}/.well-known/stellar-agent-services.json`;
export const AGENT_ID = 7;

export const textStats = defineService({
  name: "text-stats",
  title: "Text statistics",
  description: "Counts the words in a text.",
  price: "0.01",
  charge: "on-success",
  expectedDurationSeconds: 1,
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 1000 } }, additionalProperties: false },
  outputSchema: { type: "object", required: ["words"], properties: { words: { type: "integer" } } },
  examples: [{ input: { text: "Hello world." }, output: { words: 2 } }],
  handler: ({ text }: { text: string }) => ({ words: text.split(/\s+/).filter(Boolean).length }),
});

export const report = defineService({
  name: "report",
  description: "Writes a short report on a topic.",
  price: "0.02",
  charge: "upfront",
  expectedDurationSeconds: 1,
  inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string", minLength: 1, maxLength: 200 } }, additionalProperties: false },
  outputSchema: { type: "object", required: ["report"], properties: { report: { type: "string" } } },
  handler: async ({ topic }: { topic: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { report: `A report on ${topic}.` };
  },
});

/** Sleeps for at most a few milliseconds: Retry-After and polling waits pass quickly. */
export const fastSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5)));

// ── The chain ───────────────────────────────────────────────────────────────

export interface FakeTransaction {
  hash: string;
  ledger: number;
  status: "SUCCESS" | "FAILED";
  envelope: xdr.TransactionEnvelope;
  events: xdr.ContractEvent[];
}

/** A SAC transfer event, as the USDC contract emits it. */
export function transferEvent(options: { asset: string; from: string; to: string; amount: bigint }): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(options.asset) as unknown as xdr.Hash,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [
          nativeToScVal("transfer", { type: "symbol" }),
          nativeToScVal(options.from, { type: "address" }),
          nativeToScVal(options.to, { type: "address" }),
          nativeToScVal("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
        ],
        data: nativeToScVal(options.amount, { type: "i128" }),
      }),
    ),
  });
}

/**
 * A Soroban RPC over in-memory transactions. Every getLatestLedger call closes a ledger, so time passes
 * as the verifier polls. `trustline` is what payTo holds; "down" makes every call fail.
 */
export function fakeChain(options: { trustline?: TrustlineState | "down"; latestLedger?: number } = {}) {
  const state = { latestLedger: options.latestLedger ?? 1000, trustline: options.trustline ?? ("authorized" as TrustlineState | "down"), transactions: [] as FakeTransaction[], down: false };
  const fail = () => {
    if (state.down) throw new Error("the RPC is down");
  };
  const retention = () => ({ latestLedger: state.latestLedger, oldestLedger: 1, latestLedgerCloseTime: 0, oldestLedgerCloseTime: 0 });

  const chain: ChainReader = {
    async getLatestLedger() {
      fail();
      state.latestLedger++;
      return { id: "", sequence: state.latestLedger, protocolVersion: "23" } as rpc.Api.GetLatestLedgerResponse;
    },
    async getTransaction(hash) {
      fail();
      const transaction = state.transactions.find((candidate) => candidate.hash === hash);
      if (transaction === undefined) return { status: rpc.Api.GetTransactionStatus.NOT_FOUND, txHash: hash, ...retention() } as rpc.Api.GetTransactionResponse;
      return {
        status: transaction.status === "FAILED" ? rpc.Api.GetTransactionStatus.FAILED : rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: hash,
        ledger: transaction.ledger,
        createdAt: 0,
        envelopeXdr: transaction.envelope,
        events: { transactionEventsXdr: [], contractEventsXdr: [transaction.events] },
        ...retention(),
      } as unknown as rpc.Api.GetTransactionResponse;
    },
    async getEvents(request) {
      fail();
      const [filter] = request.filters;
      const from = Address.fromScVal(xdr.ScVal.fromXDR(filter!.topics![0]![1]!, "base64")).toString();
      const events = state.transactions
        .filter((transaction) => transaction.status === "SUCCESS")
        .sort((a, b) => a.ledger - b.ledger)
        .flatMap((transaction) =>
          transaction.events
            .filter((event) => filter!.contractIds!.includes(StrKey.encodeContract(event.contractId() as unknown as Buffer)) && scValToNative(event.body().v0().topics()[1]!) === from)
            .map((_, index) => ({ id: `${String(transaction.ledger).padStart(12, "0")}-${transaction.hash}-${index}`, ledger: transaction.ledger, txHash: transaction.hash })),
        )
        .filter((event) => (request.cursor === undefined ? event.ledger >= request.startLedger! : event.id > request.cursor) && (request.endLedger === undefined || event.ledger < request.endLedger));
      const page = events.slice(0, request.limit ?? 100);
      return { ...retention(), cursor: page.at(-1)?.id ?? "", events: page } as unknown as rpc.Api.GetEventsResponse;
    },
    async getLedgerEntries() {
      fail();
      if (state.trustline === "down") throw new Error("the RPC is down");
      const entry = (type: "account" | "trustline", flags = 1) => ({ val: { switch: () => xdr.LedgerEntryType[type](), trustLine: () => ({ flags: () => flags }) } });
      const entries =
        state.trustline === "no_account"
          ? []
          : state.trustline === "missing"
            ? [entry("account")]
            : [entry("account"), entry("trustline", state.trustline === "authorized" ? 1 : 0)];
      return { latestLedger: state.latestLedger, entries } as unknown as rpc.Api.GetLedgerEntriesResponse;
    },
  };

  /** Puts a payment on chain, as a facilitator's settlement would: one transaction, one transfer event. */
  const settle = (transactionXdr: string, options: { status?: "SUCCESS" | "FAILED"; amount?: bigint; to?: string } = {}): string => {
    const envelope = TransactionBuilder.fromXDR(transactionXdr, Networks.TESTNET).toEnvelope();
    const call = envelope.v1().tx().operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const [from, to, amount] = call.args().map((arg) => scValToNative(arg) as unknown) as [string, string, bigint];
    const hash = Buffer.from(Keypair.random().rawPublicKey()).toString("hex");
    state.transactions.push({
      hash,
      ledger: ++state.latestLedger,
      status: options.status ?? "SUCCESS",
      envelope,
      events: [transferEvent({ asset: Address.fromScAddress(call.contractAddress()).toString(), from, to: options.to ?? to, amount: options.amount ?? amount })],
    });
    return hash;
  };

  return { chain, state, settle };
}

export type FakeChain = ReturnType<typeof fakeChain>;

/** A facilitator that verifies every payment and settles it onto the fake chain. */
export function settlingFacilitator(chain: FakeChain): Facilitator & { settled: string[] } {
  const settled: string[] = [];
  return {
    settled,
    async verify() {
      return { isValid: true, payer };
    },
    async settle(payload, requirements) {
      const transaction = chain.settle((payload.payload as { transaction: string }).transaction);
      settled.push(transaction);
      return { success: true, transaction, network: requirements.network, payer };
    },
  };
}

/** The test payer: real payments, signed offline, valid for 12 ledgers. */
export function offlinePayer(chain: FakeChain): Payer {
  return {
    address: payer,
    async sign(requirements) {
      const payload = await signTestPayment(requirements, payerKeys, { expirationLedger: chain.state.latestLedger + 12 });
      return { transaction: (payload.payload as { transaction: string }).transaction };
    },
  };
}

// ── The registry ────────────────────────────────────────────────────────────

export function fakeRegistry(agents: Record<number, { uri: string; wallet?: string }> = {}) {
  const validations = new Map<string, ValidationRecord>();
  const state = { down: false };
  const fail = () => {
    if (state.down) throw new Error("the registry can't be read");
  };
  const registry: Registry = {
    network: "stellar:testnet",
    contracts: { identity: TESTNET_CONFIG.contracts.identity, validation: TESTNET_CONFIG.contracts.validation },
    async agentUri(agentId) {
      fail();
      return agents[agentId]?.uri;
    },
    async agentWallet(agentId) {
      fail();
      return agents[agentId]?.wallet;
    },
    async validation(requestHash) {
      fail();
      return validations.get(requestHash);
    },
  };
  return { registry, agents, validations, state };
}

// ── Putting it together ─────────────────────────────────────────────────────

export type Tamper = (request: Request, response: Response) => Response | Promise<Response>;

const providers: Provider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

export interface SetupOptions {
  provider?: Partial<ProviderConfig>;
  services?: Service[];
  /** Rewrites the provider's answers, to make it break a rule. */
  tamper?: Tamper;
  trustline?: TrustlineState | "down";
}

/** A provider served at ORIGIN, registered as agent AGENT_ID, and a verify() that checks it offline. */
export function setup(options: SetupOptions = {}) {
  const chain = fakeChain(options.trustline === undefined ? {} : { trustline: options.trustline });
  const facilitator = settlingFacilitator(chain);
  const provider = createProvider({
    baseUrl: ORIGIN,
    network: "stellar:testnet",
    payTo,
    provider: { name: "Verifier test provider", agentId: AGENT_ID },
    services: options.services ?? [textStats, report],
    facilitator,
    // The provider never reads the chain here; the verifier does.
    rpc: false,
    ...options.provider,
  });
  providers.push(provider);

  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const original = new Request(input, init);
    // Buffered, not cloned: a teed body's cancel waits for every branch, so the provider refusing an
    // oversized body would wait for a copy nobody reads.
    const body = original.method === "GET" || original.method === "HEAD" ? undefined : await original.text();
    const copy = () => new Request(original.url, { method: original.method, headers: original.headers, ...(body === undefined ? {} : { body }) });
    requests.push(copy());
    const response = await provider.fetch(copy());
    return options.tamper === undefined ? response : options.tamper(copy(), response);
  }) as typeof globalThis.fetch;

  const registration = registrationDataUri(registrationFile(provider.manifest, provider.manifestUrl));
  const { registry, agents, validations, state: registryState } = fakeRegistry({ [AGENT_ID]: { uri: registration, wallet: payTo } });
  const testPayer = offlinePayer(chain);
  const verify = (overrides: Partial<VerifyOptions> = {}) =>
    verifyProvider({ manifestUrl: provider.manifestUrl, fetch, rpc: chain.chain, registry, sleep: fastSleep, ...overrides });

  return { provider, chain, facilitator, fetch, requests, registry, agents, validations, registryState, payer: testPayer, verify };
}

/** A JSON response like the original, with its body rewritten. */
export async function rewriteJson(response: Response, change: (body: any) => unknown, headers: Record<string, string | null> = {}): Promise<Response> {
  const body = change(await response.json());
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return new Response(JSON.stringify(body), { status: response.status, headers: merged });
}

/** The URL path of a request, relative to ORIGIN. */
export function pathOf(request: Request): string {
  return new URL(request.url).pathname;
}
