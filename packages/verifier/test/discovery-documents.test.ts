import type { CheckResult } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../src/index.js";
import { MANIFEST_URL, pathOf, rewriteJson, setup, type Tamper } from "./support/harness.js";

// C6's probe of the discovery documents (§2.5): /openapi.json and /llms.txt are optional, and when a
// provider serves them, they agree with its manifest.

const hygiene = (report: VerificationReport) => report.results.find((result) => result.check === "C6") as CheckResult;
const TEXT_STATS = "/services/text-stats/jobs";

/** Rewrites /openapi.json, or replaces the answer of one path. */
const openapi = (change: (document: any) => unknown, headers: Record<string, string | null> = {}): Tamper => (request, response) =>
  pathOf(request) === "/openapi.json" ? rewriteJson(response, change, headers) : response;
const answer = (path: string, make: () => Response): Tamper => (request, response) => (pathOf(request) === path ? make() : response);
const notFound = () => new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } });

describe("C6 discovery documents", () => {
  it("passes the documents the kit serves, and records what it found", async () => {
    const result = hygiene(await setup().verify());
    expect(result).toMatchObject({
      status: "passed",
      evidence: { discovery: { openapi: { status: 200, services: ["text-stats", "report"] }, llmsTxt: { status: 200, manifest: true } } },
    });
    expect(result.warnings).toBeUndefined();
  });

  it("passes a provider that serves neither, whatever its 404 looks like [D1]", async () => {
    const off = hygiene(await setup({ provider: { discoveryDocuments: false } }).verify());
    expect(off).toMatchObject({ status: "passed", evidence: { discovery: { openapi: { status: 404 }, llmsTxt: { status: 404 } } } });
    expect(off.warnings).toBeUndefined();

    const tamper: Tamper = (request, response) => (["/openapi.json", "/llms.txt"].includes(pathOf(request)) ? notFound() : response);
    const html = hygiene(await setup({ tamper }).verify());
    expect(html.status).toBe("passed");
    expect(html.findings).toBeUndefined();
  });

  it.each<[string, (document: any) => unknown, string]>([
    ["another price", (d) => ((d.paths[TEXT_STATS].post["x-payment-info"].price.amount = "0.001"), d), "price/amount"],
    ["the price in base units", (d) => ((d.paths[TEXT_STATS].post["x-payment-info"].price.amount = "100000"), d), "price/amount"],
    ["a dynamic price", (d) => ((d.paths[TEXT_STATS].post["x-payment-info"].price.mode = "dynamic"), d), "price/mode"],
    ["another currency", (d) => ((d.paths[TEXT_STATS].post["x-payment-info"].price.currency = "EUR"), d), "price/currency"],
    ["protocols without x402", (d) => ((d.paths[TEXT_STATS].post["x-payment-info"].protocols = [{ mpp: {} }]), d), "protocols"],
  ])("fails an OpenAPI document with %s [D3]", async (_name, change, where) => {
    const result = hygiene(await setup({ tamper: openapi(change) }).verify());
    expect(result).toMatchObject({ status: "failed", failedRules: ["D3"] });
    expect(result.findings).toEqual([
      { rule: "D3", severity: "fail", message: expect.stringContaining(`/openapi.json /paths/~1services~1text-stats~1jobs/post/x-payment-info/${where}`) },
    ]);
  });

  it("keeps the level at 0 when the OpenAPI price is not the manifest's", async () => {
    const tamper = openapi((d) => ((d.paths["/services/report/jobs"].post["x-payment-info"].price.amount = "0.01"), d));
    const report = await setup({ tamper }).verify();
    expect(report.level).toBe(0);
    expect(report.results.find((result) => result.check === "C1")?.status).toBe("passed");
  });

  it("leaves an OpenAPI document about something else alone", async () => {
    const other = { openapi: "3.1.0", info: { title: "Site API", version: "3" }, paths: { "/v1/search": { post: { "x-payment-info": { price: { mode: "dynamic", currency: "EUR", amount: "9" } } } } } };
    const result = hygiene(await setup({ tamper: openapi(() => other, { "Cache-Control": null, "Access-Control-Allow-Origin": null }) }).verify());
    expect(result).toMatchObject({ status: "passed", evidence: { discovery: { openapi: { status: 200 } } } });
    expect(result.evidence?.["discovery"]).not.toHaveProperty(["openapi", "services"]);
    expect(result.findings).toBeUndefined();
  });

  it("leaves alone what is not JSON, a redirect, and an operation without payment information", async () => {
    const text = answer("/openapi.json", () => new Response("openapi: 3.1.0", { status: 200, headers: { "Content-Type": "application/yaml" } }));
    expect(hygiene(await setup({ tamper: text }).verify()).findings).toBeUndefined();

    const redirect = answer("/openapi.json", () => new Response(null, { status: 302, headers: { Location: "https://docs.example.com/openapi.json" } }));
    expect(hygiene(await setup({ tamper: redirect }).verify())).toMatchObject({ status: "passed", evidence: { discovery: { openapi: { status: 302 } } } });

    const plain = openapi((d) => {
      for (const path of [TEXT_STATS, "/services/report/jobs"]) delete d.paths[path].post["x-payment-info"];
      return d;
    });
    expect(hygiene(await setup({ tamper: plain }).verify())).toMatchObject({ status: "passed", evidence: { discovery: { openapi: { services: ["text-stats", "report"] } } } });
  });

  it("warns about documents that are not served like the manifest [D4]", async () => {
    const tamper: Tamper = (request, response) => {
      if (!["/openapi.json", "/llms.txt"].includes(pathOf(request))) return response;
      return new Response(response.body, { status: 200, headers: { "Content-Type": "application/octet-stream", "Cache-Control": "max-age=86400" } });
    };
    const result = hygiene(await setup({ tamper }).verify());
    expect(result).toMatchObject({ status: "passed", warnings: ["D4"] });
    expect(result.findings?.map((finding) => finding.message)).toEqual([
      "/openapi.json should be served as application/json",
      "/openapi.json should carry Cache-Control: max-age of 300 or less, like the manifest",
      "/openapi.json should carry Access-Control-Allow-Origin: *",
      "/llms.txt should be served as text/plain",
      "/llms.txt should carry Cache-Control: max-age of 300 or less, like the manifest",
      "/llms.txt should carry Access-Control-Allow-Origin: *",
    ]);
  });

  it("warns about an llms.txt that never gives the manifest URL [D5]", async () => {
    const tamper = answer("/llms.txt", () => new Response("# Our site\n\n> Docs for people.\n", { status: 200, headers: { "Content-Type": "text/markdown" } }));
    const result = hygiene(await setup({ tamper }).verify());
    expect(result).toMatchObject({ status: "passed", warnings: ["D5"], evidence: { discovery: { llmsTxt: { status: 200, manifest: false } } } });
  });

  it("looks through the documents for secrets, like every other answer (§10)", async () => {
    const secret = Keypair.random().secret();
    const tamper = answer("/llms.txt", () => new Response(`# Tools\n\n${MANIFEST_URL}\n\nsigner: ${secret}\n`, { status: 200, headers: { "Content-Type": "text/plain" } }));
    expect(hygiene(await setup({ tamper }).verify()).failedRules).toContain("§10");
  });

  it("probes nothing when the manifest can't be used", async () => {
    const tamper: Tamper = (request, response) => (request.url === MANIFEST_URL ? rewriteJson(response, (manifest) => ({ ...manifest, baseUrl: "https://elsewhere.test" })) : response);
    const { verify, requests } = setup({ tamper });
    await verify();
    expect(requests.map(pathOf)).not.toContain("/openapi.json");
  });
});
