import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  PROVIDER_STANDARD,
  STELLAR_NETWORKS,
  stellarAddressKind,
  VALIDATION_REQUEST_SCHEMA_ID,
  VALIDATION_REQUEST_TYPE,
  validationRequestDataUri,
  validationRequestHash,
  type ValidationRequest,
} from "../src/index.js";
import { applyPatch, loadVectors, type PatchOperation } from "./support/vectors.js";

interface ValidationRequestVectors {
  cases: { name: string; document: ValidationRequest; canonical: string; requestHash: string; requestUri: string }[];
  invalid: { name: string; patch: PatchOperation[] }[];
}

const vectors = loadVectors<ValidationRequestVectors>("validation-requests.json");
const DATA_URI_PREFIX = "data:application/json;base64,";

describe("validation requests: test-vectors/validation-requests.json", () => {
  it.each(vectors.cases)("$name", async ({ document, canonical, requestHash, requestUri }) => {
    expect(canonicalJson(document)).toBe(canonical);
    expect(await validationRequestHash(document)).toBe(requestHash);
    expect(validationRequestDataUri(document)).toBe(requestUri);
  });

  it("puts exactly the hashed bytes in the data: URI", () => {
    for (const { canonical, requestUri } of vectors.cases) {
      expect(requestUri.startsWith(DATA_URI_PREFIX)).toBe(true);
      expect(Buffer.from(requestUri.slice(DATA_URI_PREFIX.length), "base64").toString("utf8")).toBe(canonical);
    }
  });
});

describe("validation request JSON Schema", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/validation-request.schema.json", import.meta.url), "utf8"));
  // Every Ajv strict check except strictRequired, as for the manifest and receipt schemas.
  const validate = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, validateFormats: false }).compile(schema);

  it("uses the same constants as the code", () => {
    expect(schema.$id).toBe(VALIDATION_REQUEST_SCHEMA_ID);
    expect(schema.properties.standard.const).toBe(PROVIDER_STANDARD);
    expect(schema.properties.type.const).toBe(VALIDATION_REQUEST_TYPE);
    expect(schema.properties.network.enum).toEqual(STELLAR_NETWORKS);
  });

  it.each(vectors.cases)("accepts $name", ({ document }) => {
    expect(validate(document)).toBe(true);
    expect(stellarAddressKind(document.validator)).toBe("account");
  });

  it.each(vectors.invalid)("rejects $name", ({ patch }) => {
    expect(validate(applyPatch(vectors.cases[0]!.document, patch))).toBe(false);
  });
});
