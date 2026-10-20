import { describe, expect, it } from "vitest";
import { bindingHash, canonicalJson, createJobUrl, jobResultUrl, jobStatusUrl } from "../src/index.js";
import { loadVectors } from "./support/vectors.js";

interface BindingHashVectors {
  cases: { name: string; service: string; input: unknown; canonical: string; bindingHash: string }[];
}

const vectors = loadVectors<BindingHashVectors>("binding-hash.json");

describe("bindingHash: test-vectors/binding-hash.json", () => {
  it.each(vectors.cases)("$name", async ({ service, input, canonical, bindingHash: expected }) => {
    expect(canonicalJson({ service, input })).toBe(canonical);
    expect(await bindingHash(service, input)).toBe(expected);
  });
});

describe("job URLs", () => {
  const baseUrl = "https://api.example.com/agent";
  const jobId = "0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d";

  it("are fixed paths under baseUrl", () => {
    expect(createJobUrl(baseUrl, "text-stats")).toBe("https://api.example.com/agent/services/text-stats/jobs");
    expect(jobStatusUrl(baseUrl, jobId)).toBe(`https://api.example.com/agent/jobs/${jobId}`);
    expect(jobResultUrl(baseUrl, jobId)).toBe(`https://api.example.com/agent/jobs/${jobId}/result`);
  });

  it("refuse names and ids that would change the path", () => {
    expect(() => createJobUrl(baseUrl, "../admin")).toThrow(TypeError);
    expect(() => jobStatusUrl(baseUrl, "../../admin")).toThrow(TypeError);
    expect(() => jobResultUrl(baseUrl, jobId.toUpperCase())).toThrow(TypeError);
  });
});
