// Gateway services from an OpenAPI document, for `provider-kit init --openapi` (docs/provider-setup-guide.md §3a).
//
// The gateway POSTs a job's input to one fixed URL as a JSON object, and takes a JSON object back
// (gateway/upstream.ts). So an operation becomes a service when it is a POST that takes a JSON object or no body,
// has no path parameters and no required query, header or cookie parameters, and answers 2xx with a JSON object.
// Every other operation is skipped, with the reason.
//
// Schemas become what the standard asks for [S4]–[S6]: JSON Schema 2020-12, with the body's own schema at the
// root and the components it uses under $defs. OpenAPI's own keywords are rewritten (nullable, example, boolean
// exclusiveMinimum and exclusiveMaximum), readOnly properties leave inputs and writeOnly ones leave outputs. Each
// service is then checked as `provider-kit serve` checks it, and skipped with the problem when it fails.
//
// The rest are first guesses for the developer to review: the price, the charge policy, names from paths, titles
// and descriptions from the document, and the API's own credentials as "env:" headers, kept out of the file.
// OpenAPI 3.0, 3.1 and 3.2, as JSON or YAML.

import { readFile } from "node:fs/promises";
import type { JsonObject, JsonValue } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { defineService } from "../define-service.js";
import { readBounded } from "../http/bounded.js";
import { createProvider } from "../provider.js";
import type { GatewayService } from "./config.js";

/** What a generated service starts with, as `provider-kit init` writes it. The developer sets the real values. */
export const FIRST_GUESS = {
  price: "0.01",
  charge: "upfront",
  expectedDurationSeconds: 5,
  capacity: { concurrency: 2, maxQueueWaitSeconds: 60 },
} as const satisfies Partial<GatewayService>;

/** The description a service gets when the document has none, as in `provider-kit init`'s starter config. */
export const DESCRIPTION_TO_WRITE = "What it does, when to use it, and its limits (input size, languages, what it won't do).";

/** The most a document read from a URL may be. */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** A provider has at most this many services (the manifest schema's services maxItems). */
const MAX_SERVICES = 25;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"];
/** Header parameters OpenAPI describes elsewhere, and ignores as parameters. */
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"]);
/** OpenAPI's own schema keywords, which JSON Schema 2020-12 doesn't have, and identifiers that would move $ref's base. */
const OPENAPI_ONLY = new Set(["nullable", "example", "xml", "externalDocs", "discriminator", "$schema", "$id"]);
/** Keywords whose value is a schema or an array of schemas. */
const SUBSCHEMAS = new Set([
  "items",
  "prefixItems",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
  "allOf",
  "anyOf",
  "oneOf",
]);
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]);

export interface SkippedOperation {
  method: string;
  path: string;
  reason: string;
}

/** An upstream header whose value comes from the environment: the API's own credentials. */
export interface UpstreamCredential {
  header: string;
  /** The environment variable it reads. */
  name: string;
  /** What the variable holds. */
  holds: string;
}

export interface OpenApiGateway {
  /** The document, for messages: its title and version, and the OpenAPI version. */
  api: { title: string; version?: string; openapi: string };
  provider: { name: string; description?: string };
  services: GatewayService[];
  skipped: SkippedOperation[];
  credentials: UpstreamCredential[];
  /** Services whose description is not the document's own, but its summary or a placeholder: to write by hand. */
  undescribed: string[];
  /** What the developer has to finish by hand. */
  warnings: string[];
}

/** The document can't be read or used at all. */
export class OpenApiError extends Error {
  override name = "OpenApiError";
}

/** Why one operation can't be a service. */
class Skip extends Error {}

type Direction = "input" | "output";

/** Reads an OpenAPI 3 document, JSON or YAML, from a file or an http(s) URL. `url` is where it came from, after redirects. */
export async function readOpenApi(source: string, fetcher: typeof fetch = fetch): Promise<{ document: JsonObject; url?: string }> {
  if (!/^https?:\/\//i.test(source)) {
    let text: string;
    try {
      text = await readFile(source, "utf8");
    } catch (error) {
      throw new OpenApiError(`${source} can't be read: ${(error as Error).message}`);
    }
    return { document: parseDocument(text, source) };
  }
  let response: Response;
  try {
    response = await fetcher(source, { headers: { Accept: "application/json, application/yaml;q=0.9, */*;q=0.5" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new OpenApiError(`${source} can't be read: ${(error as Error).message}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new OpenApiError(`${source} answered ${response.status}`);
  }
  const bytes = await readBounded(response.body, MAX_DOCUMENT_BYTES);
  if (bytes === undefined) throw new OpenApiError(`${source} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
  return { document: parseDocument(new TextDecoder().decode(bytes), source), url: response.url === "" ? source : response.url };
}

function parseDocument(text: string, source: string): JsonObject {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    try {
      document = parseYaml(text);
    } catch (error) {
      throw new OpenApiError(`${source} is neither JSON nor YAML: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  if (!isObject(document)) throw new OpenApiError(`${source} isn't an OpenAPI document`);
  const version = document["openapi"];
  if (typeof version !== "string") {
    if (typeof document["swagger"] === "string") {
      throw new OpenApiError(`${source} is Swagger ${document["swagger"]} (OpenAPI 2). Convert it to OpenAPI 3 first, such as in the Swagger Editor: Edit, then Convert to OpenAPI 3.`);
    }
    throw new OpenApiError(`${source} isn't an OpenAPI document: it names no "openapi" version`);
  }
  if (!/^3\.[0-2](\.|$)/.test(version)) throw new OpenApiError(`${source} is OpenAPI ${version}; 3.0, 3.1 and 3.2 are supported`);
  return document;
}

/**
 * The gateway services an OpenAPI document describes. `url` is where the document came from, to resolve a relative
 * server URL against; `upstream` is the API's base URL, which wins over the document's servers.
 */
export async function gatewayFromOpenApi(document: JsonObject, options: { url?: string; upstream?: string } = {}): Promise<OpenApiGateway> {
  const info = isObject(document["info"]) ? document["info"] : {};
  const title = line(info["title"], 120) ?? "API";
  const version = line(info["version"], 60);
  const description = prose(info["description"], 500) ?? prose(info["summary"], 500);
  const gateway: OpenApiGateway = {
    api: { title, ...(version === undefined ? {} : { version }), openapi: String(document["openapi"]) },
    provider: { name: title, ...(description === undefined ? {} : { description }) },
    services: [],
    skipped: [],
    credentials: [],
    undescribed: [],
    warnings: [],
  };
  const names = new Set<string>();
  const paths = isObject(document["paths"]) ? document["paths"] : {};

  for (const [path, value] of Object.entries(paths)) {
    if (!path.startsWith("/")) continue;
    let item: JsonObject;
    try {
      item = resolved(document, value);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      gateway.skipped.push({ method: "*", path, reason: error.message });
      continue;
    }
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const skip = (reason: string) => gateway.skipped.push({ method: method.toUpperCase(), path, reason });
      if (method !== "post") {
        skip("the gateway calls the API with POST");
        continue;
      }
      if (operation["deprecated"] === true) {
        skip("it is deprecated");
        continue;
      }
      // Servers may be set per operation and per path, over the document's.
      const servers = operation["servers"] ?? item["servers"] ?? document["servers"];
      let generated: Generated;
      try {
        generated = generate(document, path, item, operation, () => upstreamBase(servers, options));
      } catch (error) {
        if (!(error instanceof Skip)) throw error;
        skip(error.message);
        continue;
      }
      const { service } = generated;
      service.name = unique(service.name, names);
      const problem = await problemWith(service);
      if (problem !== undefined) {
        skip(problem);
        continue;
      }
      if (gateway.services.length >= MAX_SERVICES) {
        skip(`a provider has at most ${MAX_SERVICES} services; this one can replace another`);
        continue;
      }
      names.add(service.name);
      gateway.services.push(service);
      if (!generated.described) gateway.undescribed.push(service.name);
      for (const credential of generated.credentials) {
        if (!gateway.credentials.some((known) => known.name === credential.name)) gateway.credentials.push(credential);
      }
      if (generated.warning !== undefined) gateway.warnings.push(`${service.name}: ${generated.warning}`);
    }
  }
  return gateway;
}

interface Generated {
  service: GatewayService;
  /** Whether the description is the document's own. */
  described: boolean;
  credentials: UpstreamCredential[];
  warning?: string;
}

/** One POST operation as a gateway service. Throws Skip when the gateway can't call it. */
function generate(document: JsonObject, path: string, item: JsonObject, operation: JsonObject, upstream: () => string): Generated {
  if (/\{[^}]*\}/.test(path)) throw new Skip(`it has a path parameter (${/\{[^}]*\}/.exec(path)![0]}); the gateway calls one fixed URL`);
  for (const value of [...list(item["parameters"]), ...list(operation["parameters"])]) {
    const parameter = resolved(document, value);
    const where = String(parameter["in"]);
    const name = String(parameter["name"]);
    if (where === "path") throw new Skip(`it has a path parameter (${name}); the gateway calls one fixed URL`);
    if (parameter["required"] === true && !(where === "header" && IGNORED_HEADERS.has(name.toLowerCase()))) {
      throw new Skip(`it needs the ${where} parameter "${name}"; the gateway sends only a JSON body`);
    }
  }

  let inputSchema: JsonObject = { type: "object", properties: {}, additionalProperties: false };
  let inputExample: JsonValue | undefined = {};
  if (operation["requestBody"] !== undefined) {
    const body = resolved(document, operation["requestBody"]);
    const media = jsonMedia(body["content"], "input");
    if (media === undefined) throw new Skip(`it takes ${firstMediaType(body["content"]) ?? "a body of no stated type"}, not JSON`);
    inputSchema = objectRoot(toJsonSchema(document, media["schema"] ?? {}, "input"), "input");
    inputExample = exampleOf(document, media);
  }

  let outputSchema: JsonObject = { type: "object" };
  let outputExample: JsonValue | undefined;
  const success = successResponse(operation["responses"]);
  if (success !== undefined) {
    const response = resolved(document, success.response);
    if (!isObject(response["content"]) || Object.keys(response["content"]).length === 0) {
      throw new Skip(`it answers ${success.code} with no content; a service answers with a JSON object`);
    }
    const media = jsonMedia(response["content"], "output");
    if (media === undefined) throw new Skip(`it answers with ${firstMediaType(response["content"])}, not JSON`);
    outputSchema = objectRoot(toJsonSchema(document, media["schema"] ?? {}, "output"), "output");
    outputExample = exampleOf(document, media);
  }

  const auth = credentialsFor(document, operation);
  const summary = line(operation["summary"], 120);
  const ownDescription = prose(operation["description"], 1000);
  const tags = tagsFor(operation["tags"]);
  // An example pair only when both halves match their schemas [S9].
  const example = isObject(inputExample) && isObject(outputExample) && matches(inputSchema, inputExample) && matches(outputSchema, outputExample);
  const service: GatewayService = {
    name: nameFor(path, operation["operationId"]),
    ...(summary === undefined ? {} : { title: summary }),
    description: ownDescription ?? prose(operation["summary"], 1000) ?? DESCRIPTION_TO_WRITE,
    price: FIRST_GUESS.price,
    charge: FIRST_GUESS.charge,
    expectedDurationSeconds: FIRST_GUESS.expectedDurationSeconds,
    ...(tags.length === 0 ? {} : { tags }),
    inputSchema,
    outputSchema,
    ...(example ? { examples: [{ input: inputExample as JsonObject, output: outputExample as JsonObject }] } : {}),
    capacity: { ...FIRST_GUESS.capacity },
    upstream: { url: `${upstream().replace(/\/+$/, "")}${path}`, ...(Object.keys(auth.headers).length === 0 ? {} : { headers: auth.headers }) },
  };
  return { service, described: ownDescription !== undefined, credentials: auth.credentials, ...(auth.warning === undefined ? {} : { warning: auth.warning }) };
}

/**
 * A schema from the document as JSON Schema 2020-12: the schema itself at the root, never a reference to it [S4],
 * and every component it uses, however deep, under $defs, so it refers to nothing outside itself [S5].
 */
function toJsonSchema(document: JsonObject, schema: JsonValue, direction: Direction): JsonObject {
  const components = isObject(document["components"]) && isObject(document["components"]["schemas"]) ? document["components"]["schemas"] : {};
  const defs = new Map<string, { key: string; schema?: JsonValue }>();
  const queue: string[] = [];

  const reference = (pointer: string): string => {
    if (!pointer.startsWith("#")) throw new Skip(`its schema refers to another document (${pointer}); bundle the document into one file first`);
    const tokens = pointer.startsWith("#/") ? pointer.slice(2).split("/").map(unescapeToken) : [];
    const name = tokens[2];
    if (tokens[0] !== "components" || tokens[1] !== "schemas" || name === undefined) throw new Skip(`its schema refers to ${pointer}, outside components/schemas`);
    if (!(name in components)) throw new Skip(`its schema refers to ${pointer}, which the document doesn't have`);
    let def = defs.get(name);
    if (def === undefined) {
      def = { key: defKey(name, defs) };
      defs.set(name, def);
      queue.push(name);
    }
    return ["#", "$defs", def.key, ...tokens.slice(3)].map((token, index) => (index < 2 ? token : escapeToken(token))).join("/");
  };

  const convert = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(convert);
    if (!isObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("x-") || OPENAPI_ONLY.has(key)) continue;
      if (key === "$ref" && typeof child === "string") out[key] = reference(child);
      else if (SCHEMA_MAPS.has(key) && isObject(child)) out[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, convert(schema)]));
      else if (SUBSCHEMAS.has(key)) out[key] = convert(child);
      // Everything else, such as enum, const, default and examples, is data: copied as it is.
      else out[key] = child;
    }
    return rewrite(value, out, direction);
  };

  const root = convert(inlined(document, schema));
  // The schemas `true` and `{}` accept anything; `false` accepts nothing.
  if (root === true) return {};
  if (!isObject(root)) throw new Skip(direction === "input" ? "its body schema accepts nothing" : "its answer schema accepts nothing");
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) defs.get(name)!.schema = convert(components[name]!);
  if (defs.size > 0) {
    root["$defs"] = { ...(isObject(root["$defs"]) ? root["$defs"] : {}), ...Object.fromEntries([...defs.values()].map((def) => [def.key, def.schema!])) };
  }
  return root;
}

/** OpenAPI's ways of saying things, said the JSON Schema 2020-12 way. `original` is the schema as the document wrote it. */
function rewrite(original: JsonObject, out: JsonObject, direction: Direction): JsonValue {
  // OpenAPI 3.0 writes one example as `example`; JSON Schema keeps a list in `examples`.
  if (original["example"] !== undefined && out["examples"] === undefined) out["examples"] = [original["example"]];
  if (out["examples"] !== undefined && !Array.isArray(out["examples"])) delete out["examples"];
  // OpenAPI 3.0's boolean exclusiveMinimum and exclusiveMaximum qualify minimum and maximum.
  for (const [exclusive, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    if (typeof out[exclusive] !== "boolean") continue;
    if (out[exclusive] === true && typeof out[bound] === "number") {
      out[exclusive] = out[bound];
      delete out[bound];
    } else {
      delete out[exclusive];
    }
  }
  // A client never sends readOnly properties, and never gets writeOnly ones back.
  const properties = out["properties"];
  if (isObject(properties)) {
    const hidden = direction === "input" ? "readOnly" : "writeOnly";
    const dropped = Object.keys(properties).filter((name) => {
      const property = properties[name];
      return isObject(property) && property[hidden] === true;
    });
    for (const name of dropped) delete properties[name];
    const required = out["required"];
    if (dropped.length > 0 && Array.isArray(required)) out["required"] = required.filter((name) => typeof name !== "string" || !dropped.includes(name));
  }
  // OpenAPI 3.0's nullable: null is allowed as well.
  if (original["nullable"] === true) {
    const type = out["type"];
    if (typeof type === "string") {
      out["type"] = [type, "null"];
      const values = out["enum"];
      if (Array.isArray(values) && !values.includes(null)) out["enum"] = [...values, null];
    } else if (type === undefined) {
      return { anyOf: [out, { type: "null" }] };
    }
  }
  return out;
}

/** The schema with "type": "object" first at its root [S4]: the gateway sends and takes JSON objects only. */
function objectRoot(schema: JsonObject, direction: Direction): JsonObject {
  const { type, ...rest } = schema;
  if (type === "object" || type === undefined || (Array.isArray(type) && type.includes("object"))) return { type: "object", ...rest };
  const kinds = (Array.isArray(type) ? type : [type]).map((kind) => KINDS[String(kind)] ?? String(kind)).join(" or ");
  throw new Skip(direction === "input" ? `its body is ${kinds}, not a JSON object` : `it answers with ${kinds}, not a JSON object`);
}

const KINDS: Record<string, string> = {
  array: "an array",
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "true or false",
  null: "null",
};

/** A reference at the root replaced with what it refers to, keeping the keywords beside it. */
function inlined(document: JsonObject, schema: JsonValue): JsonValue {
  const seen = new Set<string>();
  let current = schema;
  while (isObject(current) && typeof current["$ref"] === "string") {
    const pointer = current["$ref"];
    if (seen.has(pointer)) throw new Skip(`its schema refers to itself and nothing else (${pointer})`);
    seen.add(pointer);
    const { $ref: _, ...beside } = current;
    const target = pointed(document, pointer, "its schema");
    current = isObject(target) ? { ...target, ...beside } : target;
  }
  return current;
}

/** What a $ref points to, outside schemas: parameters, request bodies, responses, examples, path items. */
function resolved(document: JsonObject, value: JsonValue | undefined): JsonObject {
  const seen = new Set<string>();
  let current = value;
  while (isObject(current) && typeof current["$ref"] === "string") {
    const pointer = current["$ref"];
    if (seen.has(pointer)) throw new Skip(`it refers to itself (${pointer})`);
    seen.add(pointer);
    current = pointed(document, pointer);
  }
  return isObject(current) ? current : {};
}

/** What a local $ref points to. `what` names the referrer in the reason when it can't be followed. */
function pointed(document: JsonObject, pointer: string, what = "it"): JsonValue {
  if (!pointer.startsWith("#")) throw new Skip(`${what} refers to another document (${pointer}); bundle the document into one file first`);
  if (!pointer.startsWith("#/")) throw new Skip(`${what} refers to ${pointer}, which isn't a JSON pointer into the document`);
  let current: JsonValue = document;
  for (const token of pointer.slice(2).split("/").map(unescapeToken)) {
    const next: JsonValue | undefined = isObject(current) ? current[token] : Array.isArray(current) ? current[Number(token)] : undefined;
    if (next === undefined) throw new Skip(`${what} refers to ${pointer}, which the document doesn't have`);
    current = next;
  }
  return current;
}

/** The JSON media type of a body or an answer: application/json and +json types; for answers, also any type. */
function jsonMedia(content: JsonValue | undefined, direction: Direction): JsonObject | undefined {
  if (!isObject(content)) return undefined;
  const entries = Object.entries(content).filter((entry): entry is [string, JsonObject] => isObject(entry[1]));
  const json = entries.find(([type]) => /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(type.trim()));
  return (json ?? (direction === "output" ? entries.find(([type]) => type.trim() === "*/*") : undefined))?.[1];
}

function firstMediaType(content: JsonValue | undefined): string | undefined {
  return isObject(content) ? Object.keys(content)[0] : undefined;
}

/** The answer a service returns: 200, else the first other 2xx. */
function successResponse(responses: JsonValue | undefined): { code: string; response: JsonValue } | undefined {
  if (!isObject(responses)) return undefined;
  const code = Object.keys(responses)
    .filter((candidate) => /^2(\d\d|XX)$/i.test(candidate))
    .sort((a, b) => a.localeCompare(b))[0];
  return code === undefined ? undefined : { code, response: responses[code]! };
}

/** The first example the document gives: the media type's own, else its schema's. */
function exampleOf(document: JsonObject, media: JsonObject): JsonValue | undefined {
  if (media["example"] !== undefined) return media["example"];
  const examples = media["examples"];
  if (isObject(examples)) {
    for (const value of Object.values(examples)) {
      const example = resolved(document, value);
      if (example["value"] !== undefined) return example["value"];
    }
  }
  const schema = inlined(document, media["schema"] ?? {});
  if (!isObject(schema)) return undefined;
  const listed = schema["examples"];
  if (Array.isArray(listed) && listed.length > 0) return listed[0];
  return schema["example"];
}

/** Whether a value matches a schema, for examples [S9]. A schema that doesn't compile matches nothing. */
function matches(schema: JsonObject, value: JsonValue): boolean {
  try {
    return new Ajv2020({ strict: false, validateFormats: false }).validate(schema, value) as boolean;
  } catch {
    return false;
  }
}

/** The API's own credentials as upstream headers read from the environment: an API key header, bearer or basic. */
function credentialsFor(document: JsonObject, operation: JsonObject): { headers: Record<string, string>; credentials: UpstreamCredential[]; warning?: string } {
  const none = { headers: {}, credentials: [] };
  const requirements = Array.isArray(operation["security"]) ? operation["security"] : Array.isArray(document["security"]) ? document["security"] : [];
  if (requirements.length === 0) return none;
  const components = isObject(document["components"]) && isObject(document["components"]["securitySchemes"]) ? document["components"]["securitySchemes"] : {};
  const unusable = new Set<string>();
  // The requirements are alternatives: the first the gateway can send wins. An empty one asks for nothing.
  for (const requirement of requirements) {
    if (!isObject(requirement)) continue;
    const names = Object.keys(requirement);
    if (names.length === 0) return none;
    const credentials = names.map((name) => {
      const credential = headerFor(resolved(document, components[name]));
      if (credential === undefined) unusable.add(name);
      return credential;
    });
    if (credentials.every((credential) => credential !== undefined)) {
      return { headers: Object.fromEntries(credentials.map((credential) => [credential.header, `env:${credential.name}`])), credentials };
    }
  }
  return { ...none, warning: `the API asks for credentials (${[...unusable].join(", ")}) that the gateway can't send as a fixed header. Set upstream.headers by hand.` };
}

function headerFor(scheme: JsonObject): UpstreamCredential | undefined {
  if (scheme["type"] === "apiKey" && scheme["in"] === "header" && typeof scheme["name"] === "string" && scheme["name"] !== "") {
    const header = scheme["name"];
    return { header, name: `UPSTREAM_${header.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`, holds: `the API's key, sent as ${header}` };
  }
  const kind = scheme["type"] === "http" && typeof scheme["scheme"] === "string" ? scheme["scheme"].toLowerCase() : undefined;
  if (kind === "bearer") return { header: "Authorization", name: "UPSTREAM_AUTHORIZATION", holds: `"Bearer " and the API's token` };
  if (kind === "basic") return { header: "Authorization", name: "UPSTREAM_AUTHORIZATION", holds: `"Basic " and the API's user:password in base64` };
  return undefined;
}

/**
 * The address the gateway calls: --upstream, else the first server, with its variables' defaults. A relative
 * server URL is resolved against where the document came from, and is an error for a document read from a file.
 */
function upstreamBase(servers: JsonValue | undefined, options: { url?: string; upstream?: string }): string {
  if (options.upstream !== undefined) {
    if (!/^https?:\/\//i.test(options.upstream)) throw new OpenApiError(`--upstream must be the API's http(s) address, not "${options.upstream}"`);
    return options.upstream;
  }
  const server = list(servers).find((candidate): candidate is JsonObject => isObject(candidate) && typeof candidate["url"] === "string");
  const variables = server !== undefined && isObject(server["variables"]) ? server["variables"] : {};
  const url = String(server?.["url"] ?? "/").replace(/\{([^}]+)\}/g, (match, name: string) => {
    const variable = variables[name];
    return isObject(variable) && typeof variable["default"] === "string" ? variable["default"] : match;
  });
  if (/^https?:\/\//i.test(url)) return url;
  if (options.url === undefined) {
    throw new OpenApiError(`the document's server URL is "${url}", relative to where the API runs, so pass the API's address: --upstream <url>, such as http://127.0.0.1:8000`);
  }
  return new URL(url, options.url).toString();
}

/** A service name from the path, without api and version segments: /v1/text/summarize is text-summarize. */
function nameFor(path: string, operationId: JsonValue | undefined): string {
  const fromPath = slug(
    path
      .split("/")
      .filter((segment) => segment !== "" && !/^(api|v\d+(\.\d+)*)$/i.test(segment))
      .join("-"),
  );
  return fromPath || slug(typeof operationId === "string" ? operationId : "") || "service";
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
}

/** `name`, or `name-2`, `name-3`… when it is taken [M7]. */
function unique(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, 64 - `-${n}`.length)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The operation's tags as manifest tags: lowercase words joined by hyphens, at most 10. */
function tagsFor(tags: JsonValue | undefined): string[] {
  const out = new Set<string>();
  for (const tag of list(tags)) {
    if (typeof tag !== "string") continue;
    const slugged = tag
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "");
    if (slugged !== "") out.add(slugged);
  }
  return [...out].slice(0, 10);
}

/** A $defs key for a component: its name, made safe for a JSON pointer in a URI, and unique. */
function defKey(name: string, defs: Map<string, { key: string }>): string {
  const base = name.replace(/[^A-Za-z0-9_.-]+/g, "_") || "Schema";
  const taken = new Set([...defs.values()].map((def) => def.key));
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

/**
 * Checks a generated service as `provider-kit serve` would: its schemas compile, and a manifest with it passes the
 * standard's checks. The problem, in one line, or undefined.
 */
async function problemWith(service: GatewayService): Promise<string | undefined> {
  try {
    const { upstream: _, inputSchema, outputSchema, ...rest } = service;
    const defined = defineService({ ...rest, inputSchema: inputSchema as JsonObject, outputSchema: outputSchema as JsonObject, handler: () => ({}) });
    // A throwaway provider with just this service, never served or paid.
    checkPayTo ??= Keypair.random().publicKey();
    const provider = createProvider({
      baseUrl: "http://localhost:8787",
      dev: true,
      network: "stellar:testnet",
      payTo: checkPayTo,
      provider: { name: "Check" },
      services: [defined],
      facilitator: "https://x402.org/facilitator",
      rpc: false,
    });
    await provider.close();
    return undefined;
  } catch (error) {
    const message = (error as Error).message;
    // A manifest problem names its rule and where it is: "[S6] /services/0/inputSchema: …". The first one is enough.
    const violation = /\n\s+(\[[A-Z]\d+\]) ([^:\n]*): ([^\n]*)/.exec(message);
    if (violation !== null) {
      const where = violation[2]!.replace(/^\/services\/0\/?/, "");
      return `${violation[1]} ${where === "" ? "" : `${where}: `}${violation[3]}`;
    }
    return message.split("\n")[0]!.replace(/^service "[^"]*": /, "");
  }
}

let checkPayTo: string | undefined;

/** Text from the document on one line, at most `max` characters. */
function line(value: JsonValue | undefined, max: number): string | undefined {
  const text = prose(value, max);
  return text?.replace(/\n+/g, " ");
}

/** Prose from the document: lines inside each paragraph joined, no control characters, at most `max` characters. */
function prose(value: JsonValue | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
  if (text === "") return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON pointer token from a URI fragment: percent-decoded, then ~1 and ~0 unescaped. */
function unescapeToken(token: string): string {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    // Not percent-encoded after all: used as it is.
  }
  return decoded.replaceAll("~1", "/").replaceAll("~0", "~");
}

function escapeToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}
