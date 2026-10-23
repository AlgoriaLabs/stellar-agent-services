import { describe, expect, it } from "vitest";
import { createProvider, defineService, type ProviderConfig, type ServiceConfig } from "../src/index.js";
import { fakeFacilitator, payTo } from "./support/harness.js";

// A provider that would fail the standard's checks never starts, so it never takes a payment.

const service = (overrides: Partial<ServiceConfig> = {}) =>
  defineService({
    name: "echo",
    description: "Echoes.",
    price: "0.01",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handler: () => ({}),
    ...overrides,
  });

const config = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  baseUrl: "https://api.example.com/agent",
  network: "stellar:testnet",
  payTo,
  provider: { name: "Startup test" },
  services: [service()],
  facilitator: fakeFacilitator(),
  ...overrides,
});

describe("startup checks", () => {
  it("builds a manifest that passes the JSON Schema and rules, served from the baseUrl origin", () => {
    const provider = createProvider(config());
    expect(provider.manifestUrl).toBe("https://api.example.com/.well-known/stellar-agent-services.json");
    expect(provider.manifest.payment.accepts[0]).toMatchObject({ scheme: "exact", network: "stellar:testnet", payTo, extra: { areFeesSponsored: true } });
  });

  it("refuses a service that breaks a rule, naming the service", () => {
    expect(() => service({ name: "Not A Name" })).toThrow(/service "Not A Name".*§3\.1/);
    expect(() => service({ charge: "on-success" })).toThrow(/S2/);
    expect(() => service({ examples: [{ input: {}, output: { n: 1 } }], outputSchema: { type: "object", required: ["m"] } })).toThrow(/S9/);
    expect(() => service({ maxInputBytes: 11 * 1024 * 1024 })).toThrow(/maxInputBytes/);
    expect(() => service({ inputSchema: { type: "object", properties: { x: { type: "nonsense" } } } })).toThrow(/does not compile/);
  });

  it("refuses a manifest a client or verifier would reject", () => {
    expect(() => createProvider(config({ services: [service(), service()] }))).toThrow(/M7/);
    expect(() => createProvider(config({ services: [service({ inputSchema: { type: "array" } })] }))).toThrow(/M9/);
    // A schema that points outside itself [S5] doesn't even compile: nothing is ever fetched.
    expect(() => createProvider(config({ services: [service({ inputSchema: { type: "object", $ref: "https://evil.example/schema.json" } })] }))).toThrow(/does not compile/);
    expect(() => createProvider(config({ provider: { name: "Bad\u0007name" } }))).toThrow(/M9/);
    expect(() => createProvider(config({ maxTimeoutSeconds: 10 }))).toThrow(/M9/);
    expect(() => createProvider(config({ retentionSeconds: 60 }))).toThrow(/M9/);
    expect(() => createProvider(config({ services: [service({ charge: "on-success", expectedDurationSeconds: 40 })] }))).toThrow(/S2/);
  });

  it("allows http:// only on loopback with dev", () => {
    expect(() => createProvider(config({ baseUrl: "http://localhost:8787" }))).toThrow(/https/);
    expect(() => createProvider(config({ baseUrl: "http://example.com", dev: true }))).toThrow(/https/);
    expect(createProvider(config({ baseUrl: "http://localhost:8787", dev: true })).manifest.baseUrl).toBe("http://localhost:8787");
    expect(() => createProvider(config({ facilitator: "http://facilitator.example" }))).toThrow(/https/);
  });
});
