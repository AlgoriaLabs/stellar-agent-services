import type { CheckResult } from "@stellar-agent-services/protocol";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../src/index.js";
import { MANIFEST_URL, pathOf, setup, type Tamper } from "./support/harness.js";

// C1: each test serves a manifest that breaks one rule, and expects the rule's id.

const check = (report: VerificationReport, id: string) => report.results.find((result) => result.check === id) as CheckResult;

/** Rewrites the manifest the provider serves: its JSON, its raw text, or its headers. */
function manifest(options: {
  change?: (manifest: any) => void;
  text?: (text: string) => string;
  bytes?: (text: string) => Uint8Array;
  headers?: Record<string, string | null>;
  status?: number;
}): Tamper {
  return async (request, response) => {
    if (pathOf(request) !== "/.well-known/stellar-agent-services.json") return response;
    let text = await response.text();
    if (options.change !== undefined) {
      const parsed = JSON.parse(text);
      options.change(parsed);
      text = JSON.stringify(parsed);
    }
    if (options.text !== undefined) text = options.text(text);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    return new Response(options.bytes === undefined ? text : options.bytes(text), { status: options.status ?? response.status, headers });
  };
}

describe("C1 manifest", () => {
  it("refuses a redirect, and probes nothing more [M3]", async () => {
    const { verify, requests } = setup({ tamper: manifest({ status: 302, headers: { Location: "https://elsewhere.test/manifest.json" } }) });
    const report = await verify();
    expect(check(report, "C1")).toMatchObject({ status: "failed", failedRules: ["M3"] });
    expect(report.results.filter((result) => result.check !== "C1").every((result) => result.status === "skipped")).toBe(true);
    expect(report.level).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([MANIFEST_URL]);
  });

  it.each<[string, Parameters<typeof manifest>[0], string]>([
    ["a status other than 200", { status: 404 }, "M1"],
    ["a Content-Type other than application/json", { headers: { "Content-Type": "text/plain" } }, "M1"],
    ["a body that is not JSON", { text: () => "{ not json" }, "M3"],
    ["a body that is not UTF-8", { bytes: (text) => new Uint8Array([...new TextEncoder().encode(text.slice(0, -1)), ...new TextEncoder().encode(',"x":"'), 0xff, 0x22, 0x7d]) }, "M3"],
    ["a body over 256 KiB", { change: (m) => (m.extensions = { "com.example.padding": "x".repeat(256 * 1024) }) }, "M3"],
    ["a duplicate key, which clients could read two ways", { text: (text) => text.replace('"payTo":', '"payTo":"GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF","payTo":') }, "M3"],
    ["a manifest of another major version", { change: (m) => (m.standard = "stellar-agent-services/provider@2") }, "M8"],
    ["a field the JSON Schema forbids", { change: (m) => (m.payment.accepts[0].amount = "100000") }, "M9"],
    ["a baseUrl on another origin", { change: (m) => (m.baseUrl = "https://other.test") }, "M5"],
    ["a payTo with a bad checksum", { change: (m) => (m.payment.accepts[0].payTo = `${m.payment.accepts[0].payTo.slice(0, -1)}A`) }, "P11"],
    ["two services with one name", { change: (m) => m.services.push(m.services[0]) }, "M7"],
    ["an example that does not match its schema", { change: (m) => (m.services[0].examples[0].output = { words: "two" }) }, "S9"],
    ["a schema that does not compile", { change: (m) => (m.services[0].outputSchema = { type: "object", properties: { words: { $ref: "#/$defs/missing" } } }) }, "§3.3"],
  ])("fails %s", async (_name, tamper, rule) => {
    const { verify } = setup({ tamper: manifest(tamper) });
    const result = check(await verify(), "C1");
    expect(result.status).toBe("failed");
    expect(result.failedRules).toContain(rule);
    expect(result.findings?.find((finding) => finding.rule === rule)?.message).toBeTruthy();
  });

  it("stops probing a manifest that fails the JSON Schema or names another origin", async () => {
    for (const change of [(m: any) => (m.payment.accepts[0].amount = "1"), (m: any) => (m.baseUrl = "https://other.test")]) {
      const { verify, requests } = setup({ tamper: manifest({ change }) });
      const report = await verify();
      expect(check(report, "C3")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/C1/) });
      expect(requests.every((request) => request.url === MANIFEST_URL)).toBe(true);
    }
  });

  it("keeps probing a manifest with a broken example, using an input built from the schema", async () => {
    const { verify } = setup({ tamper: manifest({ change: (m) => (m.services[0].examples[0].input = { text: 42 }) }) });
    const report = await verify();
    expect(check(report, "C1")).toMatchObject({ status: "failed", failedRules: ["S9"] });
    expect(check(report, "C3")).toMatchObject({ status: "passed" });
    expect(check(report, "C3").evidence?.["services"]).toContainEqual(expect.objectContaining({ service: "text-stats", input: "sample" }));
  });

  it("warns about the SHOULD rules without failing", async () => {
    const { verify } = setup({
      tamper: manifest({
        headers: { "Cache-Control": null },
        change: (m) => {
          m.extensions = { notReverseDns: true };
          m.services[0].expectedDurationSeconds = 50;
          m.services[1].inputSchema.if = { required: ["topic"] };
          m.services[1].inputSchema.then = { properties: { topic: { minLength: 1 } } };
        },
      }),
    });
    const result = check(await verify(), "C1");
    expect(result).toMatchObject({ status: "passed", failedRules: [], warnings: ["M4", "S2", "S7", "X1"] });
  });

  it("fails a manifest that can't be fetched [M1]", async () => {
    const { verify } = setup({ tamper: () => Promise.reject(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") })) });
    const result = check(await verify(), "C1");
    expect(result).toMatchObject({ status: "failed", failedRules: ["M1"] });
    expect(result.findings?.[0]?.message).toMatch(/could not be reached/);
  });

  it("records the manifest's hash, size and services", async () => {
    const { verify } = setup();
    const result = check(await verify(), "C1");
    expect(result.evidence).toMatchObject({ url: MANIFEST_URL, status: 200, network: "stellar:testnet", services: ["text-stats", "report"], agentId: 7 });
    expect(result.evidence?.["sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
