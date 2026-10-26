import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL } from "../src/index.js";
import { duplicateKey } from "../src/json.js";
import { compileServiceSchema, discouragedKeywords, invalidInput, matchesSchema, sampleInput } from "../src/schemas.js";

describe("duplicateKey", () => {
  it.each<[string, string, string | undefined]>([
    ["no duplicates", '{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}', undefined],
    ["a top-level duplicate", '{"a":1,"b":2,"a":3}', "/a"],
    ["a nested duplicate", '{"payment":{"accepts":[{"payTo":"G1","payTo":"G2"}]}}', "/payment/accepts/0/payTo"],
    ["the same key spelled with an escape", '{"payTo":1,"pay\\u0054o":2}', "/payTo"],
    ["a duplicate after strings holding braces and quotes", '{"a":"}{\\"","b":{"c":1},"b":2}', "/b"],
    ["a key that needs pointer escaping", '{"x":{"a/b~c":1,"a/b~c":2}}', "/x/a~1b~0c"],
    ["a second array element", '{"list":[{"k":1},{"k":2,"k":3}]}', "/list/1/k"],
  ])("finds %s", (_name, text, pointer) => {
    JSON.parse(text);
    expect(duplicateKey(text)).toBe(pointer);
  });
});

describe("service schemas", () => {
  it("compile only as valid, self-contained JSON Schema 2020-12", () => {
    expect(compileServiceSchema({ type: "object" })).toBeTypeOf("function");
    expect(compileServiceSchema({ type: "object", properties: { x: { type: "nonsense" } } })).toBeInstanceOf(Error);
    expect(compileServiceSchema({ type: "object", properties: { x: { $ref: "#/$defs/missing" } } })).toBeInstanceOf(Error);
    expect(compileServiceSchema({ type: "object", properties: { x: { $ref: "https://example.com/schema.json" } } })).toBeInstanceOf(Error);
    expect(matchesSchema({ type: "object", properties: { x: { type: "nonsense" } } }, {})).toBeUndefined();
  });

  it("compile apart, so two services may use the same $id", () => {
    const a = { $id: "https://example.com/input", type: "object", required: ["a"] };
    const b = { $id: "https://example.com/input", type: "object", required: ["b"] };
    expect(matchesSchema(a, { a: 1 })).toBe(true);
    expect(matchesSchema(b, { a: 1 })).toBe(false);
  });

  it("are walked as schemas when looking for what [S7] discourages", () => {
    expect(
      discouragedKeywords({
        type: "object",
        oneOf: [{ required: ["a"] }],
        properties: { if: { type: "string" }, nested: { type: "object", if: { required: ["x"] }, then: {}, patternProperties: { "^x": {} } } },
        $defs: { thing: { allOf: [{}] } },
      }),
    ).toEqual(["/oneOf", "/properties/nested/if", "/properties/nested/then", "/properties/nested/patternProperties"]);
    expect(discouragedKeywords({ type: "object", properties: { if: { type: "string" } } })).toEqual([]);
  });
});

describe("sampleInput", () => {
  it.each<[string, Record<string, unknown>]>([
    ["required strings, bounded", { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 12, maxLength: 20 } } }],
    ["short strings", { type: "object", required: ["code"], properties: { code: { type: "string", maxLength: 3 } } }],
    ["formats", { type: "object", required: ["url", "email", "at"], properties: { url: { type: "string", format: "uri" }, email: { type: "string", format: "email" }, at: { type: "string", format: "date-time" } } }],
    ["numbers in a range", { type: "object", required: ["n", "x"], properties: { n: { type: "integer", minimum: 5, maximum: 9 }, x: { type: "number", exclusiveMinimum: 0 } } }],
    ["enums, consts and defaults", { type: "object", required: ["e", "c", "d"], properties: { e: { enum: ["b", "a"] }, c: { const: 3 }, d: { type: "string", default: "hi" } } }],
    ["local references", { type: "object", required: ["item"], properties: { item: { $ref: "#/$defs/item" } }, $defs: { item: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } }],
    ["arrays with a minimum", { type: "object", required: ["tags"], properties: { tags: { type: "array", minItems: 2, items: { type: "string" } } } }],
    ["anyOf", { type: "object", required: ["v"], properties: { v: { anyOf: [{ type: "boolean" }, { type: "string" }] } } }],
    ["nothing required", { type: "object", properties: { optional: { type: "string" } } }],
  ])("builds a valid input for %s", (_name, schema) => {
    const input = sampleInput(schema as never);
    expect(input).toBeDefined();
    expect(matchesSchema(schema as never, input)).toBe(true);
  });

  it("gives up rather than guess", () => {
    expect(sampleInput({ type: "object", required: ["code"], properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } } })).toBeUndefined();
    expect(sampleInput({ type: "object", required: ["n"], properties: { n: { type: "integer", minimum: 5, maximum: 1 } } })).toBeUndefined();
  });

  it("builds an input sure to fail, for the invalid-input probe [P8]", () => {
    expect(invalidInput({ type: "object", required: ["text"] })).toEqual({});
    expect(invalidInput({ type: "object" })).toEqual([]);
  });
});

describe("the tool", () => {
  it("reports the package's own version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(TOOL).toEqual({ name: pkg.name, version: pkg.version });
  });
});
