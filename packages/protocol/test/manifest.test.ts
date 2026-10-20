import { readFileSync } from "node:fs";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  checkManifestRules,
  MANIFEST_SCHEMA_ID,
  PROVIDER_STANDARD,
  SERVICE_NAME_PATTERN,
  STELLAR_NETWORKS,
  USDC_ASSET,
  type JsonObject,
  type JsonValue,
  type ProviderManifest,
} from "../src/index.js";
import { applyPatch, loadVectors, ruleIds, type PatchOperation } from "./support/vectors.js";

interface ManifestVectors {
  bases: Record<string, { manifestUrl: string; manifest: ProviderManifest }>;
  cases: {
    name: string;
    base: string;
    manifestUrl?: string;
    patch: PatchOperation[];
    valid: boolean;
    checkedBy?: "schema" | "code";
    violations: { rule: string; pointer: string }[];
  }[];
}

const vectors = loadVectors<ManifestVectors>("manifests.json");
const schema = JSON.parse(readFileSync(new URL("../schemas/manifest.schema.json", import.meta.url), "utf8"));

// Every Ajv strict check except strictRequired, which flags the schema's "required when" (if/then) rules.
const validateManifest = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, validateFormats: false }).compile(schema);
// Service schemas come from providers, so unknown keywords are ignored, as JSON Schema intends.
const validateExample = (serviceSchema: JsonObject, value: JsonValue) =>
  new Ajv2020({ strict: false, validateFormats: false }).validate(serviceSchema, value) as boolean;

const errorPath = (error: ErrorObject) =>
  error.keyword === "required" ? `${error.instancePath}/${String(error.params["missingProperty"])}` : error.instancePath;
const related = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

describe("manifest validation: test-vectors/manifests.json", () => {
  it.each(vectors.cases)("$name", ({ base: baseName, manifestUrl, patch, checkedBy, violations }) => {
    const base = vectors.bases[baseName];
    if (base === undefined) throw new Error(`unknown base ${baseName}`);
    const manifest = applyPatch(base.manifest, patch);
    const schemaValid = validateManifest(manifest);
    const errors = validateManifest.errors ?? [];

    if (checkedBy === "schema") {
      expect(schemaValid).toBe(false);
      // The schema must fail where the case says, not somewhere else.
      const pointer = violations[0]?.pointer ?? "";
      expect(errors.map(errorPath).filter((path) => !related(path, pointer))).toEqual([]);
      return;
    }

    expect(errors).toEqual([]);
    const actual = checkManifestRules(manifest, { manifestUrl: manifestUrl ?? base.manifestUrl, validateExample });
    expect(ruleIds(actual)).toEqual(ruleIds(violations));
  });
});

describe("manifest JSON Schema", () => {
  it("is the example in docs/provider-standard.md §2.2", () => {
    const doc = readFileSync(new URL("../../../docs/provider-standard.md", import.meta.url), "utf8");
    const example = /```json\n([\s\S]*?)\n```/.exec(doc.slice(doc.indexOf("### 2.2 Example")))?.[1];
    expect(JSON.parse(example ?? "null")).toEqual(vectors.bases["full"]?.manifest);
  });

  it("uses the same constants as the code", () => {
    const defs = schema.$defs;
    expect(schema.$id).toBe(MANIFEST_SCHEMA_ID);
    expect(schema.properties.standard.const).toBe(PROVIDER_STANDARD);
    expect(defs.service.properties.name.pattern).toBe(SERVICE_NAME_PATTERN.source);
    expect(defs.paymentOption.properties.network.enum).toEqual(STELLAR_NETWORKS);
    const assetByNetwork = Object.fromEntries(
      defs.paymentOption.allOf.map((rule: any) => [rule.if.properties.network.const, rule.then.properties.asset.const]),
    );
    expect(assetByNetwork).toEqual(USDC_ASSET);
  });
});

describe("checkManifestRules", () => {
  it("skips the example check when no validator is given", () => {
    const base = vectors.bases["full"]!;
    const manifest = applyPatch(base.manifest, [{ op: "replace", path: "/services/0/examples/0/input/text", value: 42 }]);
    expect(checkManifestRules(manifest, { manifestUrl: base.manifestUrl })).toEqual([]);
    expect(ruleIds(checkManifestRules(manifest, { manifestUrl: base.manifestUrl, validateExample }))).toEqual([
      { rule: "S9", pointer: "/services/0/examples/0/input" },
    ]);
  });

  it("reports a manifest URL that is not a URL as M1", () => {
    const base = vectors.bases["full"]!;
    expect(ruleIds(checkManifestRules(base.manifest, { manifestUrl: "not a url" }))).toEqual([{ rule: "M1", pointer: "" }]);
  });
});
