// An offline provider + client pair: the real provider-kit and payment-client code, with a fake
// facilitator and a fake signed payload instead of the network.

import { createProvider, defineService, type Facilitator, type ProviderConfig } from "@stellar-agent-services/provider-kit";
import { Keypair } from "@stellar/stellar-sdk";
import { vi } from "vitest";
import {
  defaultPolicy,
  Journal,
  memoryJournalStorage,
  memorySecretStore,
  PaymentClient,
  type PaymentClientOptions,
  type SpendingPolicy,
} from "../../src/index.js";

export const payTo = Keypair.random().publicKey();
export const payer = Keypair.random().publicKey();
export const manifestUrl = "http://localhost:8787/.well-known/stellar-agent-services.json";

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
  const policy: SpendingPolicy = { ...defaultPolicy(payer, "stellar:testnet"), ...options.policy };
  let signed = 0;
  const client = new PaymentClient({
    signer: { address: payer, signAuthEntry: async () => ({ signedAuthEntry: "", signerAddress: payer }) },
    policy,
    journal,
    secrets: memorySecretStore(),
    fetch,
    allowLocalhost: true,
    pollMs: 20,
    followSeconds: 5,
    confirmPayment: async () => true,
    createPayload: async () => ({ x402Version: 2, payload: { transaction: `signed-${++signed}` } }),
    ...options.client,
  });
  return { provider, facilitator, client, journal, policy, fetch };
}
