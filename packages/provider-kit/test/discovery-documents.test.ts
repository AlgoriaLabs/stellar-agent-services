import { checkOpenApiDocument, llmsTxt, openApiDocument, usdPrice, type JsonObject } from "@stellar-agent-services/protocol";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { defineService } from "../src/index.js";
import { testProvider } from "./support/harness.js";

// The discovery documents (§2.5): /openapi.json and /llms.txt, served next to the manifest and made from
// it, for agents and catalogs that don't know the standard.

const services = () => [
  defineService({
    name: "echo",
    title: "Echo",
    description: "Echoes its input.",
    price: "0.25",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    outputSchema: { type: "object", properties: { text: { type: "string" } } },
    examples: [{ input: { text: "hi" }, output: { text: "hi" } }],
    handler: (input) => input,
  }),
  defineService({
    name: "slow",
    description: "Takes a while.",
    price: "1.5",
    charge: "upfront",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handler: () => ({}),
  }),
];

const get = (provider: { fetch(request: Request): Promise<Response> }, path: string, init?: RequestInit) =>
  provider.fetch(new Request(`http://localhost:8787${path}`, init));

describe("discovery documents", () => {
  it("serves /openapi.json on the origin, like the manifest [D4]", async () => {
    const { provider } = testProvider(services());
    const response = await get(provider, "/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const document = (await response.json()) as JsonObject;
    expect(document).toEqual(openApiDocument(provider.manifest, { manifestUrl: provider.manifestUrl }));
    expect(Object.keys(document["paths"] as JsonObject)).toEqual([
      "/agent/services/echo/jobs",
      "/agent/services/slow/jobs",
      "/agent/jobs/{jobId}",
      "/agent/jobs/{jobId}/result",
    ]);
  });

  it("serves /llms.txt as plain text", async () => {
    const { provider } = testProvider(services());
    const response = await get(provider, "/llms.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("max-age=300");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const text = await response.text();
    expect(text).toBe(llmsTxt(provider.manifest, { manifestUrl: provider.manifestUrl }));
    expect(text).toContain(provider.manifestUrl);
    expect(text).toContain("Price: 1.50 USDC for each job, charged before the work runs");
  });

  it("gives the price the manifest and the 402 challenge give [D3]", async () => {
    const { provider, createJob } = testProvider(services());
    const document = await (await get(provider, "/openapi.json")).json();
    expect(checkOpenApiDocument(provider.manifest, document, { documentUrl: "http://localhost:8787/openapi.json" })).toEqual([]);
    for (const [name, input] of [["echo", { text: "hi" }], ["slow", {}]] as const) {
      const challenge = decodePaymentRequiredHeader((await createJob(name, input)).headers.get("PAYMENT-REQUIRED")!);
      const price = document.paths[`/agent/services/${name}/jobs`].post["x-payment-info"].price;
      expect(price).toEqual({ mode: "fixed", currency: "USD", amount: usdPrice(challenge.accepts[0]!.amount) });
    }
  });

  it("answers only GET, and nothing under baseUrl", async () => {
    const { provider } = testProvider(services());
    expect((await get(provider, "/openapi.json", { method: "POST" })).status).toBe(404);
    expect((await get(provider, "/agent/openapi.json")).status).toBe(404);
    expect((await get(provider, "/agent/llms.txt")).status).toBe(404);
  });

  it("serves neither with discoveryDocuments: false [D1]", async () => {
    const { provider } = testProvider(services(), { discoveryDocuments: false });
    for (const path of ["/openapi.json", "/llms.txt"]) {
      const response = await get(provider, path);
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    }
    expect((await get(provider, "/.well-known/stellar-agent-services.json")).status).toBe(200);
  });
});
