// JSON Schema 2020-12 validation (Ajv), for three kinds of schema:
// - the manifest JSON Schema [M9] and the verification receipt schema, both from the protocol package;
// - the providers' own inputSchema and outputSchema. Each compiles in its own Ajv instance, after a check
//   against the 2020-12 meta-schema, so one schema can never refer to another, and a schema that doesn't
//   compile is reported rather than thrown. Remote references never resolve [S5]: nothing is fetched.

import type { JsonObject, JsonValue } from "@stellar-agent-services/protocol";
import manifestSchema from "@stellar-agent-services/protocol/manifest.schema.json" with { type: "json" };
import receiptSchema from "@stellar-agent-services/protocol/verification-receipt.schema.json" with { type: "json" };
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isObject, pointerSegment } from "./json.js";

const documents = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
export const validateManifestSchema: ValidateFunction = documents.compile(manifestSchema as JsonObject);
export const validateReceiptSchema: ValidateFunction = documents.compile(receiptSchema as JsonObject);

export interface SchemaError {
  /** JSON Pointer to the value; for a missing member, to where it belongs. */
  pointer: string;
  message: string;
}

export function schemaErrors(errors: ErrorObject[] | null | undefined): SchemaError[] {
  const seen = new Set<string>();
  const result: SchemaError[] = [];
  for (const error of errors ?? []) {
    // Ajv reports the branches of if/then and anyOf too; the leaf errors say what is wrong.
    if (error.keyword === "if" || error.keyword === "anyOf") continue;
    const pointer =
      error.keyword === "required" ? `${error.instancePath}/${pointerSegment(String(error.params["missingProperty"]))}` : error.instancePath;
    const message = error.keyword === "required" ? "is required" : (error.message ?? "does not match the schema");
    const key = `${pointer} ${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ pointer, message });
  }
  return result;
}

const compiled = new WeakMap<object, ValidateFunction | Error>();

/** A service schema's validator, or why it is not a usable JSON Schema 2020-12 (§3.3). Cached per schema object. */
export function compileServiceSchema(schema: JsonObject): ValidateFunction | Error {
  const cached = compiled.get(schema);
  if (cached !== undefined) return cached;
  let result: ValidateFunction | Error;
  try {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    if (!ajv.validateSchema(schema)) {
      const first = schemaErrors(ajv.errors)[0];
      result = new Error(`it is not a valid JSON Schema 2020-12: ${first?.pointer || "/"} ${first?.message ?? ""}`.trim());
    } else {
      result = ajv.compile(schema);
    }
  } catch (error) {
    // An unresolvable $ref, or a schema too deep to compile.
    result = new Error(`it does not compile: ${(error as Error).message}`);
  }
  compiled.set(schema, result);
  return result;
}

/** Whether `value` matches a service schema: undefined when the schema doesn't compile. */
export function matchesSchema(schema: JsonObject, value: unknown): boolean | undefined {
  const validate = compileServiceSchema(schema);
  return validate instanceof Error ? undefined : (validate(value) as boolean);
}

/** Why `value` fails a service schema, for messages: the first error. */
export function firstSchemaError(schema: JsonObject, value: unknown): string {
  const validate = compileServiceSchema(schema);
  if (validate instanceof Error) return validate.message;
  if (validate(value)) return "it matches";
  const first = schemaErrors(validate.errors)[0];
  return `${first?.pointer || "/"} ${first?.message ?? "does not match"}`;
}

// Keywords whose values are subschemas, so a walk visits schemas and never a property named "if".
const SUBSCHEMA = ["items", "additionalItems", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties"];
const SUBSCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

function walk(schema: unknown, pointer: string, visit: (schema: Record<string, unknown>, pointer: string) => void): void {
  if (!isObject(schema)) return;
  visit(schema, pointer);
  for (const keyword of SUBSCHEMA) {
    const value = schema[keyword];
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${pointer}/${keyword}/${i}`, visit));
    else walk(value, `${pointer}/${keyword}`, visit);
  }
  for (const keyword of SUBSCHEMA_LISTS) {
    const value = schema[keyword];
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${pointer}/${keyword}/${i}`, visit));
  }
  for (const keyword of SUBSCHEMA_MAPS) {
    const value = schema[keyword];
    if (isObject(value)) for (const [name, item] of Object.entries(value)) walk(item, `${pointer}/${keyword}/${pointerSegment(name)}`, visit);
  }
}

/**
 * Where a schema uses what [S7] asks providers to avoid, because many agent frameworks don't support it:
 * if/then/else and patternProperties anywhere, oneOf and allOf at the root.
 */
export function discouragedKeywords(schema: JsonObject): string[] {
  const found: string[] = [];
  walk(schema, "", (node, pointer) => {
    for (const keyword of ["if", "then", "else", "patternProperties"]) if (keyword in node) found.push(`${pointer}/${keyword}`);
    if (pointer === "") for (const keyword of ["oneOf", "allOf"]) if (keyword in node) found.push(`/${keyword}`);
  });
  return found;
}

/**
 * An input for a service without an example: built from its inputSchema (const, examples, default,
 * enum, required members, length and range bounds), and returned only if it validates against that
 * schema. Undefined when no such input can be built, such as for a string with a `pattern`.
 */
export function sampleInput(schema: JsonObject): JsonObject | undefined {
  const value = sample(schema, schema, 0);
  return isObject(value) && matchesSchema(schema, value) === true ? (value as JsonObject) : undefined;
}

/** An input that is sure to fail the schema, so the provider must answer 400 invalid_input [P8]. */
export function invalidInput(schema: JsonObject): JsonValue {
  // An object that misses a required member is the clearest case. Otherwise any array fails, since the
  // root type is "object" [S4].
  return matchesSchema(schema, {}) === false ? {} : [];
}

function sample(schema: unknown, root: JsonObject, depth: number): JsonValue | undefined {
  if (depth > 12 || !isObject(schema)) return undefined;
  if ("const" in schema) return schema["const"] as JsonValue;
  if (Array.isArray(schema["examples"]) && schema["examples"].length > 0) return schema["examples"][0] as JsonValue;
  if ("default" in schema) return schema["default"] as JsonValue;
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) return schema["enum"][0] as JsonValue;
  const ref = schema["$ref"];
  if (typeof ref === "string") return ref.startsWith("#") ? sample(resolve(root, ref.slice(1)), root, depth + 1) : undefined;
  for (const keyword of ["anyOf", "oneOf"]) {
    const options = schema[keyword];
    if (!Array.isArray(options)) continue;
    for (const option of options) {
      const value = sample(option, root, depth + 1);
      if (value !== undefined) return value;
    }
  }

  const declared = schema["type"];
  const type = Array.isArray(declared) ? (declared.find((t) => t !== "null") ?? "null") : (declared ?? (isObject(schema["properties"]) ? "object" : undefined));
  const number = (key: string): number | undefined => (typeof schema[key] === "number" ? (schema[key] as number) : undefined);
  switch (type) {
    case "object": {
      const properties = isObject(schema["properties"]) ? schema["properties"] : {};
      const required = Array.isArray(schema["required"]) ? schema["required"].filter((name): name is string => typeof name === "string") : [];
      const value: JsonObject = {};
      for (const name of required) {
        const member = sample(properties[name] ?? {}, root, depth + 1);
        if (member === undefined) return undefined;
        value[name] = member;
      }
      return value;
    }
    case "string": {
      if (typeof schema["pattern"] === "string") return undefined;
      const formats: Record<string, string> = {
        uri: "https://example.com/",
        url: "https://example.com/",
        iri: "https://example.com/",
        email: "verifier@example.com",
        "date-time": "2026-01-01T00:00:00Z",
        date: "2026-01-01",
        uuid: "00000000-0000-4000-8000-000000000000",
      };
      const format = typeof schema["format"] === "string" ? formats[schema["format"]] : undefined;
      if (format !== undefined) return format;
      const min = number("minLength") ?? 0;
      const max = number("maxLength") ?? Number.POSITIVE_INFINITY;
      return "verifier".repeat(Math.ceil(Math.max(min, 1) / 8)).slice(0, Math.min(Math.max(min, 8), max));
    }
    case "integer":
    case "number": {
      const exclusive = number("exclusiveMinimum");
      const min = number("minimum") ?? (exclusive === undefined ? 1 : Math.floor(exclusive) + 1);
      const max = number("maximum");
      return max === undefined ? Math.ceil(min) : Math.min(Math.ceil(min), max);
    }
    case "boolean":
      return false;
    case "null":
      return null;
    case "array": {
      const count = number("minItems") ?? 0;
      const items: JsonValue[] = [];
      for (let i = 0; i < count; i++) {
        const item = sample(schema["items"] ?? {}, root, depth + 1);
        if (item === undefined) return undefined;
        items.push(item);
      }
      return items;
    }
    default:
      return undefined;
  }
}

/** The value a local JSON Pointer names inside the schema, such as "/$defs/name". */
function resolve(root: JsonObject, pointer: string): unknown {
  let value: unknown = root;
  for (const segment of pointer.split("/").slice(1)) {
    if (!isObject(value)) return undefined;
    value = value[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return value;
}
