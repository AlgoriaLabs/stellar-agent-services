// Turns a service's inputSchema into form fields, so any provider is usable with no frontend work
// (docs/payment-client.md, "Web app"). A flat object of strings, numbers, booleans and enums gets a form;
// anything else gets a JSON editor. The provider checks the input itself before it asks for payment.
//
// The schema comes from the provider, so it is only read as data: never compiled or evaluated.

import type { JsonObject, JsonValue } from "@stellar-agent-services/protocol";
import { humanize } from "./format.js";

interface FieldBase {
  name: string;
  label: string;
  description: string | undefined;
  required: boolean;
}

export type Field =
  | (FieldBase & { kind: "text"; multiline: boolean; minLength: number | undefined; maxLength: number | undefined })
  | (FieldBase & { kind: "number"; integer: boolean; minimum: number | undefined; maximum: number | undefined })
  | (FieldBase & { kind: "boolean" })
  | (FieldBase & { kind: "choice"; options: (string | number)[] });

export type FormValues = Record<string, string | boolean>;

/** Longer strings than this get a text area. */
const SINGLE_LINE_MAX = 200;

/** The fields for a flat object schema, or undefined when the input needs the JSON editor. */
export function formFields(schema: JsonObject): Field[] | undefined {
  const properties = schema["properties"];
  if (schema["type"] !== "object" || !isObject(properties)) return undefined;
  const required = Array.isArray(schema["required"]) ? schema["required"].filter((name) => typeof name === "string") : [];
  const fields: Field[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const field = isObject(property) ? toField(name, property, required.includes(name)) : undefined;
    if (field === undefined) return undefined;
    fields.push(field);
  }
  return fields;
}

function toField(name: string, property: JsonObject, required: boolean): Field | undefined {
  const base: FieldBase = {
    name,
    label: typeof property["title"] === "string" ? property["title"] : humanize(name),
    description: typeof property["description"] === "string" ? property["description"] : undefined,
    required,
  };
  const options = property["enum"];
  if (Array.isArray(options)) {
    const choices = options.filter((option) => typeof option === "string" || typeof option === "number");
    return choices.length > 0 && choices.length === options.length ? { ...base, kind: "choice", options: choices } : undefined;
  }
  switch (property["type"]) {
    case "string": {
      const maxLength = number(property["maxLength"]);
      const multiline = property["format"] === undefined && (maxLength === undefined || maxLength > SINGLE_LINE_MAX);
      return { ...base, kind: "text", multiline, minLength: number(property["minLength"]), maxLength };
    }
    case "number":
    case "integer":
      return { ...base, kind: "number", integer: property["type"] === "integer", minimum: number(property["minimum"]), maximum: number(property["maximum"]) };
    case "boolean":
      return { ...base, kind: "boolean" };
    default:
      return undefined;
  }
}

/** Starting values: the service's first example, so the form shows what a request looks like. */
export function initialValues(fields: Field[], example: JsonObject | undefined): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const value = example?.[field.name];
    if (field.kind === "boolean") values[field.name] = value === true;
    else values[field.name] = typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  return values;
}

/** The service input, or a message for each field that is not valid. */
export function readForm(fields: Field[], values: FormValues): { input: JsonObject } | { errors: Record<string, string> } {
  const input: JsonObject = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.kind === "boolean") {
      input[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    if (text.trim() === "") {
      if (field.required) errors[field.name] = "Required";
      continue;
    }
    const read = readValue(field, text);
    if ("error" in read) errors[field.name] = read.error;
    else input[field.name] = read.value;
  }
  return Object.keys(errors).length > 0 ? { errors } : { input };
}

function readValue(field: Exclude<Field, { kind: "boolean" }>, text: string): { value: JsonValue } | { error: string } {
  switch (field.kind) {
    case "text":
      if (field.minLength !== undefined && text.length < field.minLength) return { error: `At least ${field.minLength} characters` };
      if (field.maxLength !== undefined && text.length > field.maxLength) return { error: `At most ${field.maxLength} characters` };
      return { value: text };
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value)) return { error: "Enter a number" };
      if (field.integer && !Number.isInteger(value)) return { error: "Enter a whole number" };
      if (field.minimum !== undefined && value < field.minimum) return { error: `At least ${field.minimum}` };
      if (field.maximum !== undefined && value > field.maximum) return { error: `At most ${field.maximum}` };
      return { value };
    }
    case "choice": {
      const value = field.options.find((option) => String(option) === text);
      return value === undefined ? { error: "Choose one of the options" } : { value };
    }
  }
}

/** The JSON editor's text, as the service input. */
export function readJson(text: string): { input: JsonObject } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "This is not valid JSON" };
  }
  return isObject(value) ? { input: value } : { error: "The input must be a JSON object, such as {\"text\": \"hello\"}" };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}
