// An offline provider + client pair: the real provider-kit and payment-client code, with a fake
// facilitator, signer and payment method instead of the network.

import { createProvider, defineService, type Facilitator, type ProviderConfig } from "@stellar-agent-services/provider-kit";
import { signTestPayment } from "@stellar-agent-services/provider-kit/testing";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { vi } from "vitest";
import {
  defaultPolicy,
  Journal,
  memoryJournalStorage,
  memorySecretStore,
  PaymentClient,
  type PaymentClientOptions,
  type PaymentMethod,
  type Signer,
  type SpendingPolicy,
} from "../../src/index.js";

export const payTo = Keypair.random().publicKey();
const payerKeys = Keypair.random();
export const payer = payerKeys.publicKey();
export const manifestUrl = "http://localhost:8787/.well-known/stellar-agent-services.json";

export const signer: Signer = { address: payer, signAuthEntry: async () => ({ signedAuthEntry: "", signerAddress: payer }) };

/**
 * A payment method for `exact` challenges that signs a real payment offline, so the provider's payment
 * checks pass, without any network call, and confirms every payment.
 */
export function testMethod(overrides: Partial<PaymentMethod> = {}) {
  return {
    id: "test-exact",
    matches: (requirements: PaymentRequirements) => requirements.scheme === "exact",
    createPayload: vi.fn<PaymentMethod["createPayload"]>(async (requirements) => ({
      x402Version: 2,
      payload: (await signTestPayment(requirements, payerKeys)).payload,
    })),
    confirm: vi.fn<PaymentMethod["confirm"]>(async () => ({ confirmed: true })),
    ...overrides,
  };
}

export const textStats = defineService({
  name: "text-stats",
  description: "Counts words and characters.",
  price: "0.01",
  charge: "on-success",
  expectedDurationSeconds: 1,
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
  outputSchema: { type: "object", required: ["words"], properties: { words: { type: "integer" } } },
  handler: ({ text }: { text: string }) => ({ words: text.split(/\s+/).filter(Boolean).length }),
});

export const slowReport = defineService({
  name: "slow-report",
  description: "Takes a moment.",
  price: "0.02",
  charge: "upfront",
  inputSchema: { type: "object", properties: { topic: { type: "string" } } },
  outputSchema: { type: "object", required: ["report"], properties: { report: { type: "string" } } },
  handler: async ({ topic }: { topic?: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { report: `report on ${topic ?? "nothing"}` };
  },
});

export function fakeFacilitator(): Facilitator & { verify: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn> } {
  let transactions = 0;
  return {
    verify: vi.fn(async () => ({ isValid: true, payer })),
    settle: vi.fn(async (_payload, requirements) => ({
      success: true,
      transaction: (++transactions).toString(16).padStart(64, "0"),
      network: requirements.network,
      payer,
    })),
  };
}

export async function setup(
  options: {
    provider?: Partial<ProviderConfig>;
    policy?: Partial<SpendingPolicy>;
    client?: Partial<PaymentClientOptions>;
    /** Rewrites provider responses on the way to the client, to simulate a dishonest provider. */
    tamper?: (request: Request, response: Response) => Promise<Response>;
  } = {},
) {
  const facilitator = fakeFacilitator();
  const provider = createProvider({
    baseUrl: "http://localhost:8787",
    dev: true,
    network: "stellar:testnet",
    payTo,
    provider: { name: "Test provider" },
    services: [textStats, slowReport],
    facilitator,
    ...options.provider,
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await provider.fetch(request.clone());
    return options.tamper ? options.tamper(request, response) : response;
  }) as typeof globalThis.fetch;

  const journal = await Journal.open(memoryJournalStorage());
  const secrets = memorySecretStore();
  const policy: SpendingPolicy = { ...defaultPolicy(payer, "stellar:testnet"), ...options.policy };
  const method = testMethod();
  const client = new PaymentClient({
    signer,
    methods: [method],
    policy,
    journal,
    secrets,
    fetch,
    allowLocalhost: true,
    pollMs: 20,
    followSeconds: 5,
    ...options.client,
  });
  return { provider, facilitator, client, method, journal, secrets, policy, fetch };
}
