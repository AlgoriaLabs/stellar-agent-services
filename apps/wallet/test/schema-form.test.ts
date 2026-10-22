import { describe, expect, it } from "vitest";
import { formFields, initialValues, readForm, readJson } from "../src/lib/schema-form.js";

const textStats = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string", minLength: 1, maxLength: 10000, description: "The text to analyse" } },
  additionalProperties: false,
};

describe("form from an input schema", () => {
  it("gives a long string a text area, filled from the service's example", () => {
    const fields = formFields(textStats)!;
    expect(fields).toEqual([
      { kind: "text", name: "text", label: "Text", description: "The text to analyse", required: true, multiline: true, minLength: 1, maxLength: 10000 },
    ]);
    expect(initialValues(fields, { text: "Hello world." })).toEqual({ text: "Hello world." });
  });

  it("gives a short string a single line", () => {
    const fields = formFields({ type: "object", properties: { topic: { type: "string", maxLength: 200 } } })!;
    expect(fields[0]).toMatchObject({ kind: "text", multiline: false, required: false });
  });

  it("reads numbers, booleans and choices into their JSON types", () => {
    const fields = formFields({
      type: "object",
      required: ["count"],
      properties: {
        count: { type: "integer", minimum: 1, maximum: 10 },
        ratio: { type: "number" },
        loud: { type: "boolean", title: "Shout it" },
        tone: { enum: ["calm", "bold"] },
      },
    })!;
    expect(fields.map((field) => field.kind)).toEqual(["number", "number", "boolean", "choice"]);
    expect(fields[2]!.label).toBe("Shout it");
    expect(readForm(fields, { count: "3", ratio: "0.5", loud: true, tone: "bold" })).toEqual({ input: { count: 3, ratio: 0.5, loud: true, tone: "bold" } });
  });

  it("leaves out empty optional fields", () => {
    const fields = formFields({ type: "object", properties: { note: { type: "string", maxLength: 20 } } })!;
    expect(readForm(fields, { note: "  " })).toEqual({ input: {} });
  });

  it("says what is wrong with each field", () => {
    const fields = formFields({
      type: "object",
      required: ["text", "count"],
      properties: { text: { type: "string", maxLength: 3 }, count: { type: "integer", minimum: 1 }, tone: { enum: ["calm"] } },
    })!;
    expect(readForm(fields, { text: "", count: "1.5", tone: "loud" })).toEqual({
      errors: { text: "Required", count: "Enter a whole number", tone: "Choose one of the options" },
    });
    expect(readForm(fields, { text: "long", count: "0" })).toEqual({ errors: { text: "At most 3 characters", count: "At least 1" } });
  });

  it("falls back to the JSON editor for anything but a flat object", () => {
    expect(formFields({ type: "object", properties: { items: { type: "array" } } })).toBeUndefined();
    expect(formFields({ type: "object", properties: { nested: { type: "object" } } })).toBeUndefined();
    expect(formFields({ type: "string" })).toBeUndefined();
  });

  it("reads the JSON editor's text as an object only", () => {
    expect(readJson('{"text": "hi"}')).toEqual({ input: { text: "hi" } });
    expect(readJson("[1, 2]")).toMatchObject({ error: expect.stringMatching(/JSON object/) });
    expect(readJson("{text")).toEqual({ error: "This is not valid JSON" });
  });
});
