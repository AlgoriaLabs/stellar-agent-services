import { describe, expect, it } from "vitest";
import { applyPatch, loadVectors, type PatchOperation } from "../../protocol/test/support/vectors.js";
import { checkManifestDocument } from "../src/index.js";

// checkManifestDocument() is C1 without a server: every manifest test vector must get the same answer
// from it as from the protocol package.

interface ManifestVectors {
  bases: Record<string, { manifestUrl: string; manifest: unknown }>;
  cases: Array<{
    name: string;
    base: string;
    patch: PatchOperation[];
    manifestUrl?: string;
    valid: boolean;
    checkedBy?: "schema" | "code";
    violations: Array<{ rule: string; pointer: string }>;
  }>;
}

const vectors = loadVectors<ManifestVectors>("manifests.json");
const full = vectors.bases["full"]!;

describe("checkManifestDocument", () => {
  it.each(vectors.cases.map((vector) => [vector.name, vector] as const))("%s", async (_name, vector) => {
    const base = vectors.bases[vector.base]!;
    const result = await checkManifestDocument(applyPatch(base.manifest, vector.patch), { manifestUrl: vector.manifestUrl ?? base.manifestUrl });
    if (vector.valid) {
      expect(result).toMatchObject({ check: "C1", status: "passed", failedRules: [] });
    } else if (vector.checkedBy === "schema") {
      // C1 names the rule the schema enforces as M9, except a manifest of another major version [M8].
      expect(result.failedRules).toEqual([vector.violations.some((violation) => violation.rule === "M8") ? "M8" : "M9"]);
    } else {
      expect(new Set(result.failedRules)).toEqual(new Set(vector.violations.map((violation) => violation.rule)));
    }
  });

  it("finds the manifest URL from baseUrl by default", async () => {
    const result = await checkManifestDocument(full.manifest);
    expect(result.status).toBe("passed");
    expect(result.evidence?.["url"]).toBe(full.manifestUrl);
  });

  it("reads duplicate keys from the text [M3]", async () => {
    const text = JSON.stringify(full.manifest).replace('"baseUrl":', '"baseUrl":"https://api.example.com/other","baseUrl":');
    expect((await checkManifestDocument(text)).failedRules).toContain("M3");
  });

  it("accepts a loopback provider in development mode only [M6]", async () => {
    const local = applyPatch(full.manifest, [{ op: "replace", path: "/baseUrl", value: "http://localhost:8787" }]);
    expect((await checkManifestDocument(local)).status).toBe("failed");
    expect((await checkManifestDocument(local, { dev: true })).status).toBe("passed");
  });

  it("fails a document that is not JSON [M3]", async () => {
    expect((await checkManifestDocument("{ not json")).failedRules).toEqual(["M3"]);
  });
});
