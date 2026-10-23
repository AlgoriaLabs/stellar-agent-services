// Shared test setup: a provider with fake facilitator calls and real, offline-signed payments, so the
// provider's own payment checks run exactly as in production.

import type { JobView } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { vi } from "vitest";
import { createProvider, type Facilitator, type Provider, type ProviderConfig, type Service } from "../../src/index.js";
import { signTestPayment, type TestPaymentOptions } from "../../src/testing.js";

export const payTo = Keypair.random().publicKey();
export const payer = Keypair.random();
export const jobId = "0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d";
export const token = "q7Zt3m0bX0s8b6f5JmS2kQ9xg3Y1rZcV4nL8pW2eA0c";
export const ids = { "Idempotency-Key": jobId, "Job-Token": token };

export function fakeFacilitator() {
  let transactions = 0;
  return {
    verify: vi.fn<Facilitator["verify"]>(async () => ({ isValid: true })),
    settle: vi.fn<Facilitator["settle"]>(async (_payload, requirements) => ({
      success: true,
      transaction: (++transactions).toString(16).padStart(64, "0"),
      network: requirements.network,
    })),
  };
}

export type FakeFacilitator = ReturnType<typeof fakeFacilitator>;

export function testProvider(services: Service[], options: Partial<ProviderConfig> & { facilitator?: Facilitator } = {}) {
  const facilitator = (options.facilitator ?? fakeFacilitator()) as FakeFacilitator;
  const provider = createProvider({
    baseUrl: "http://localhost:8787/agent",
    dev: true,
    network: "stellar:testnet",
    payTo,
    provider: { name: "Test" },
    services,
    ...options,
    facilitator,
  });
  return { provider, facilitator, ...client(provider) };
}

/** What a client does with a provider, over its fetch handler. */
export function client(provider: Provider) {
  const base = provider.manifest.baseUrl;

  const requirements = (service: string): PaymentRequirements => {
    const descriptor = provider.manifest.services.find((candidate) => candidate.name === service)!;
    return { ...provider.manifest.payment.accepts[0], amount: descriptor.price.amount } as unknown as PaymentRequirements;
  };
  /** A PAYMENT-SIGNATURE header for one new payment, signed by `payer`. */
  const payment = async (service: string, options: TestPaymentOptions = {}) =>
    encodePaymentSignatureHeader(await signTestPayment(requirements(service), payer, options));

  const createJob = (service: string, input: unknown, headers: Record<string, string> = {}) =>
    provider.fetch(
      new Request(`${base}/services/${service}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(input),
      }),
    );
  const getJob = (id: string, jobToken?: string, result = true) =>
    provider.fetch(new Request(`${base}/jobs/${id}${result ? "/result" : ""}`, { headers: jobToken === undefined ? {} : { "Job-Token": jobToken } }));
  const view = async (response: Response) => (await response.json()) as JobView;

  return { requirements, payment, createJob, getJob, view };
}

/** Lets pending promise chains settle, including ones that cross a store. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
