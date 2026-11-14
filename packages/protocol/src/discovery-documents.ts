// Discovery documents: /openapi.json and /llms.txt, made from the manifest (docs/provider-standard.md
// §2.5 and Appendix C).
//
// They are for agents and catalogs that don't know this standard: x402 directories, and tools that read
// OpenAPI. The manifest stays the only source of truth [D2]: a client of the standard never takes a
// price or a payee from these documents.
//
//   openApiDocument()       OpenAPI 3.1: each service's create-job as a paid operation (`x-payment-info`),
//                           plus check-status and get-result
//   llmsTxt()               a plain-text guide for models: the services, their prices, how to pay and recover
//   checkOpenApiDocument()  the prices an OpenAPI document gives, against the manifest [D3]
//
// `x-payment-info` follows what OpenAPI-first catalogs read (a fixed price in decimal USD, and the
// protocols), and `x-service-info.docs` the IETF draft "Service Discovery for HTTP Payment
// Authentication". test-vectors/discovery-documents.json pins usdPrice() and checkOpenApiDocument().

import type { JsonObject, JsonValue } from "./canonical-json.js";
import { JOB_FAILURES, PROBLEM_CONTENT_TYPE, PROBLEMS } from "./errors.js";
import { IDEMPOTENCY_KEY, IDEMPOTENCY_KEY_PATTERN, JOB_TOKEN, JOB_TOKEN_PATTERN } from "./headers.js";
import { createJobUrl, JOB_STATUSES } from "./jobs.js";
import type { ProviderManifest, RuleViolation, ServiceDescriptor } from "./manifest.js";
import type { StellarNetwork } from "./networks.js";
import { DEFAULT_RETENTION_SECONDS, PROVIDER_STANDARD } from "./standard.js";

/** Where the documents live, on the manifest's origin [D1]. */
export const OPENAPI_PATH = "/openapi.json";
export const LLMS_TXT_PATH = "/llms.txt";

/** The media type llms.txt is served with [D4]. */
export const LLMS_TXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/** USDC has 7 decimals on Stellar (§3.1). */
const USDC_DECIMALS = 7;

const NETWORK_NAMES: Readonly<Record<StellarNetwork, string>> = {
  "stellar:testnet": "Stellar testnet",
  "stellar:pubnet": "Stellar mainnet",
};

/** The longest example input llms.txt quotes. */
const MAX_EXAMPLE_CHARACTERS = 500;

export interface DiscoveryDocumentOptions {
  /** The URL the manifest is served from. The documents link to it, and live on its origin. */
  manifestUrl: string;
}

/** The URLs of both documents for a manifest: fixed paths on its origin [D1]. */
export function discoveryDocumentUrls(manifestUrl: string): { openapi: string; llmsTxt: string } {
  const origin = new URL(manifestUrl).origin;
  return { openapi: `${origin}${OPENAPI_PATH}`, llmsTxt: `${origin}${LLMS_TXT_PATH}` };
}

/**
 * A price in USDC base units as a decimal number, the form `x-payment-info.price.amount` takes:
 * "100000" is "0.01". At least two decimals, and no more than the amount needs.
 */
export function usdPrice(amount: string): string {
  if (!/^[0-9]{1,38}$/.test(amount)) throw new TypeError(`not an amount in base units: ${amount}`);
  const digits = amount.padStart(USDC_DECIMALS + 1, "0");
  const whole = digits.slice(0, -USDC_DECIMALS).replace(/^0+(?=[0-9])/, "");
  const fraction = digits.slice(-USDC_DECIMALS).replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/** The OpenAPI 3.1 document for a manifest (Appendix C). */
export function openApiDocument(manifest: ProviderManifest, options: DiscoveryDocumentOptions): JsonObject {
  const base = new URL(manifest.baseUrl);
  const jobsPath = `${base.pathname.replace(/\/$/, "")}/jobs/{jobId}`;
  const urls = discoveryDocumentUrls(options.manifestUrl);

  const info: JsonObject = { title: manifest.provider.name, version: "1" };
  if (manifest.provider.description !== undefined) info["description"] = manifest.provider.description;
  if (manifest.provider.termsUrl !== undefined) info["termsOfService"] = manifest.provider.termsUrl;
  info["x-guidance"] = guidance(manifest, options.manifestUrl);

  const docs: JsonObject = {};
  if (manifest.provider.homepage !== undefined) docs["homepage"] = manifest.provider.homepage;
  docs["llms"] = urls.llmsTxt;

  const paths: JsonObject = {};
  for (const service of manifest.services) {
    paths[new URL(createJobUrl(manifest.baseUrl, service.name)).pathname] = { post: createJobOperation(manifest, service) };
  }
  paths[jobsPath] = { get: getJobOperation("checkStatus", "Check a job's status", "The job as it stands, without its output.") };
  paths[`${jobsPath}/result`] = {
    get: getJobOperation("getResult", "Get a job's result", "The job with its output, once it has succeeded. It answers 202 until the job has finished."),
  };

  return {
    openapi: "3.1.0",
    info,
    externalDocs: {
      description: "The Provider Standard v1 manifest: the source of truth for the services, their prices and the payee.",
      url: options.manifestUrl,
    },
    "x-service-info": { docs },
    servers: [{ url: base.origin }],
    paths,
    components: structuredClone(COMPONENTS),
  };
}

/** The plain-text guide for a manifest, in the llms.txt layout: a title, a summary, the guide, then links. */
export function llmsTxt(manifest: ProviderManifest, options: DiscoveryDocumentOptions): string {
  const { provider, baseUrl } = manifest;
  const urls = discoveryDocumentUrls(options.manifestUrl);
  const lines = [`# ${oneLine(provider.name)}`, ""];
  if (provider.description !== undefined) lines.push(`> ${oneLine(provider.description)}`, "");
  lines.push(`Paid services for AI agents, following Provider Standard v1 (\`${PROVIDER_STANDARD}\`). ${paymentTerms(manifest)}`, "");

  lines.push("**Services**", "");
  for (const service of manifest.services) {
    const title = service.title === undefined ? "" : `: ${oneLine(service.title)}`;
    lines.push(`- \`${service.name}\`${title}`);
    lines.push(`  - Price: ${usdPrice(service.price.amount)} USDC for each job, ${chargeTerms(service)}`);
    lines.push(`  - Call: \`POST ${createJobUrl(baseUrl, service.name)}\`, with the input as JSON`);
    if (service.expectedDurationSeconds !== undefined) lines.push(`  - Typical time: ${service.expectedDurationSeconds} s`);
    const example = service.examples?.[0] === undefined ? undefined : JSON.stringify(service.examples[0].input);
    if (example !== undefined && example.length <= MAX_EXAMPLE_CHARACTERS) lines.push(`  - Example input: \`${example}\``);
    lines.push(`  - ${oneLine(service.description)}`);
  }
  lines.push("");

  lines.push("**How to call a service**", "");
  lines.push(
    "1. POST the input as JSON. The answer is `402 Payment Required`, with an x402 challenge in the `PAYMENT-REQUIRED` header. An input that fails the service's schema is refused with `400` first, so nobody pays for it.",
    "2. Sign the payment, and send the same request again with the `PAYMENT-SIGNATURE` header.",
    '3. `200`: the job finished. `status` is `"succeeded"`, with the result in `output`, or `"failed"`, with `error`.',
    `4. \`202\`: the job is still running. Ask \`GET ${baseUrl}/jobs/{jobId}/result\` with the \`${JOB_TOKEN}\` header, no sooner than \`Retry-After\` says, until it answers \`200\`. Asking is free.`,
    `5. Never pay twice for one job. Send your own \`${IDEMPOTENCY_KEY}\` (a lowercase UUID: it becomes the job id) and \`${JOB_TOKEN}\` (32 random bytes as base64url) on both requests, and keep them. If a response is lost, step 4 still returns the job. Without them, the provider sends \`jobId\` and \`jobToken\` once, in the paid response.`,
    "",
  );
  lines.push(
    `Results stay available for ${duration(manifest.jobs?.retentionSeconds ?? DEFAULT_RETENTION_SECONDS)} after a job finishes. The prices on this page are for information: the manifest and the 402 challenge decide.`,
    "",
  );

  lines.push("## Documents", "");
  lines.push(`- [Manifest](${options.manifestUrl}): the Provider Standard v1 manifest, the source of truth for the services, their prices and the payee`);
  lines.push(`- [OpenAPI](${urls.openapi}): the same services as an OpenAPI 3.1 document, with their input and output schemas`);
  if (provider.homepage !== undefined) lines.push(`- [Homepage](${provider.homepage})`);
  if (provider.termsUrl !== undefined) lines.push(`- [Terms](${provider.termsUrl})`);
  return `${lines.join("\n")}\n`;
}

export interface CreateJobOperation {
  service: ServiceDescriptor;
  /** JSON Pointer to the operation in the document. */
  pointer: string;
  operation: Record<string, unknown>;
}

/**
 * The create-job operations an OpenAPI document describes: each `post` whose URL, with the document's
 * `servers`, is a service's create-job URL. `documentUrl` is where the document was fetched from, for
 * relative server URLs. An empty answer means the document is about something else.
 */
export function findCreateJobOperations(manifest: ProviderManifest, document: unknown, options: { documentUrl: string }): CreateJobOperation[] {
  if (!isObject(document) || !isObject(document["paths"])) return [];
  const services = new Map(manifest.services.map((service) => [createJobUrl(manifest.baseUrl, service.name), service]));
  const found: CreateJobOperation[] = [];
  for (const [path, item] of Object.entries(document["paths"])) {
    if (!isObject(item) || !isObject(item["post"])) continue;
    const servers = [item["post"]["servers"], item["servers"], document["servers"]].find((list) => Array.isArray(list)) ?? [{ url: "/" }];
    for (const server of servers as unknown[]) {
      const url = isObject(server) && typeof server["url"] === "string" ? resolve(`${server["url"].replace(/\/$/, "")}${path}`, options.documentUrl) : undefined;
      const service = url === undefined ? undefined : services.get(url);
      if (service === undefined) continue;
      found.push({ service, pointer: `/paths/${path.replaceAll("~", "~0").replaceAll("/", "~1")}/post`, operation: item["post"] });
      break;
    }
  }
  return found;
}

/**
 * Checks the payment information an OpenAPI document gives for the manifest's services [D3]: a price
 * is fixed, in USD, and equal to the service's `price.amount`; listed protocols include x402. An
 * operation without `x-payment-info`, and a document about something else, break nothing.
 */
export function checkOpenApiDocument(manifest: ProviderManifest, document: unknown, options: { documentUrl: string }): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const report = (pointer: string, message: string) => {
    violations.push({ rule: "D3", pointer, message });
  };
  for (const { service, pointer, operation } of findCreateJobOperations(manifest, document, options)) {
    const payment = operation["x-payment-info"];
    if (payment === undefined) continue;
    const at = `${pointer}/x-payment-info`;
    if (!isObject(payment)) {
      report(at, "x-payment-info must be an object");
      continue;
    }

    const price = payment["price"];
    if (price !== undefined && !isObject(price)) report(`${at}/price`, "price must be an object");
    if (isObject(price)) {
      if (price["mode"] !== "fixed") report(`${at}/price/mode`, `"${service.name}" has a fixed price`);
      if (price["currency"] !== "USD") report(`${at}/price/currency`, "the price is in USDC, written as USD");
      if (baseUnits(price["amount"]) !== BigInt(service.price.amount)) {
        report(`${at}/price/amount`, `the price of "${service.name}" in the manifest is ${usdPrice(service.price.amount)}`);
      }
    }

    const protocols = payment["protocols"];
    if (protocols !== undefined && !(Array.isArray(protocols) && protocols.some((protocol) => isObject(protocol) && Object.hasOwn(protocol, "x402")))) {
      report(`${at}/protocols`, "the protocols must include x402");
    }
  }
  return violations;
}

/** A decimal USD amount in USDC base units, or undefined when it is not one. */
function baseUnits(amount: unknown): bigint | undefined {
  const match = typeof amount === "string" ? /^([0-9]{1,31})(?:\.([0-9]{1,38}))?$/.exec(amount) : null;
  if (match === null) return undefined;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction.length > USDC_DECIMALS ? undefined : BigInt(`${match[1]}${fraction.padEnd(USDC_DECIMALS, "0")}`);
}

function createJobOperation(manifest: ProviderManifest, service: ServiceDescriptor): JsonObject {
  const url = createJobUrl(manifest.baseUrl, service.name);
  const request: JsonObject = { schema: embedded(service.inputSchema, `${url}/input-schema`) };
  if (service.examples !== undefined && service.examples.length > 0) {
    request["examples"] = Object.fromEntries(service.examples.map((example, index) => [`example-${index + 1}`, { value: example.input }]));
  }

  const operation: JsonObject = { operationId: service.name, summary: service.title ?? service.name, description: service.description };
  if (service.tags !== undefined && service.tags.length > 0) operation["tags"] = service.tags;
  return {
    ...operation,
    "x-payment-info": {
      price: { mode: "fixed", currency: "USD", amount: usdPrice(service.price.amount) },
      protocols: [{ x402: {} }],
    },
    parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }, { $ref: "#/components/parameters/JobToken" }],
    requestBody: { required: true, content: { "application/json": request } },
    responses: {
      "200": {
        description: `The job finished. \`status\` is "succeeded", with the result in \`output\`, or "failed", with \`error\`. The user is ${chargeTerms(service)}.`,
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/Job" },
                { type: "object", properties: { output: embedded(service.outputSchema, `${url}/output-schema`) } },
              ],
            },
          },
        },
      },
      "202": {
        description: "Paid, and still running or queued. Ask get-result with the job token until it answers 200.",
        headers: {
          Location: { description: "The job's check-status URL.", schema: { type: "string" } },
          "Retry-After": { $ref: "#/components/headers/RetryAfter" },
        },
        content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } },
      },
      "400": { $ref: "#/components/responses/Problem" },
      "402": {
        description: "Payment Required: an x402 v2 challenge. Pay it, and send the same request again with PAYMENT-SIGNATURE.",
        headers: { "PAYMENT-REQUIRED": { description: "The x402 v2 PaymentRequired object, as base64 JSON.", schema: { type: "string" } } },
      },
      default: { $ref: "#/components/responses/Problem" },
    },
  };
}

function getJobOperation(operationId: string, summary: string, description: string): JsonObject {
  return {
    operationId,
    summary,
    description: `${description} Free: it never takes a payment.`,
    security: [{ jobToken: [] }],
    parameters: [{ $ref: "#/components/parameters/JobId" }],
    responses: {
      "200": { description: "The job finished.", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } },
      "202": {
        description: "The job has not finished. Ask again, no sooner than Retry-After says.",
        headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
        content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } },
      },
      default: { $ref: "#/components/responses/Problem" },
    },
  };
}

/**
 * A service schema inside the document: without `$schema`, which only a document root may carry, and
 * with an `$id` when it uses references, so that they resolve inside the schema and not against the
 * OpenAPI document.
 */
function embedded(schema: JsonObject, id: string): JsonObject {
  const { $schema: _dialect, ...rest } = schema;
  return rest["$id"] === undefined && usesReferences(rest) ? { $id: id, ...rest } : rest;
}

function usesReferences(value: JsonValue): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(usesReferences);
  return Object.entries(value).some(([key, member]) => ((key === "$ref" || key === "$dynamicRef") && typeof member === "string") || usesReferences(member));
}

/** `info.x-guidance`: how to pay, wait and recover. Written here, so it never carries provider text. */
function guidance(manifest: ProviderManifest, manifestUrl: string): string {
  const jobs = `${new URL(manifest.baseUrl).pathname.replace(/\/$/, "")}/jobs/{jobId}/result`;
  return [
    `Every paid operation here creates one job, following Provider Standard v1 (${PROVIDER_STANDARD}).`,
    paymentTerms(manifest),
    "To run a job, POST the input as JSON to the service's path.",
    "The answer is 402, with an x402 challenge in the PAYMENT-REQUIRED header; an input that fails the schema is refused with 400 first, so nobody pays for it.",
    "Sign the payment, and send the same request again with PAYMENT-SIGNATURE.",
    '200 means the job finished: status is "succeeded", with the result in output, or "failed", with error.',
    `202 means it is still running: GET ${jobs} with the ${JOB_TOKEN} header, no sooner than Retry-After says, until it answers 200.`,
    `Never pay twice for one job. Send your own ${IDEMPOTENCY_KEY} (a lowercase UUID: it becomes the job id) and ${JOB_TOKEN} (32 random bytes as base64url) on both requests, and a lost response can be collected from get-result, free of charge.`,
    "Without them, the provider sends jobId and jobToken once, in the paid response.",
    `The prices in this document are for information: the manifest at ${manifestUrl} and the 402 challenge decide.`,
  ].join(" ");
}

function paymentTerms(manifest: ProviderManifest): string {
  const { network } = manifest.payment.accepts[0];
  return `Each job is paid once, in USDC on ${NETWORK_NAMES[network]} (\`${network}\`), through x402 v2 with the \`exact\` scheme. Network fees are sponsored, so the payer needs only USDC.`;
}

/** When the user is charged (§3.2), after "the user is" or a price. */
function chargeTerms(service: ServiceDescriptor): string {
  return service.charge === "on-success" ? "charged only if the work succeeds" : "charged before the work runs, with no refund if it fails";
}

function duration(seconds: number): string {
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (seconds % 86400 === 0) return plural(seconds / 86400, "day");
  return seconds % 3600 === 0 ? plural(seconds / 3600, "hour") : plural(seconds, "second");
}

/** Provider text on one line, so it can't break out of a heading or a list item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resolve(url: string, base: string): string | undefined {
  try {
    return new URL(url, base).href;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What every document shares: the job view (§5.5), the receipt (§5.7), problems (§6) and the job headers (§5.2). */
const COMPONENTS: JsonObject = {
  securitySchemes: {
    jobToken: {
      type: "apiKey",
      in: "header",
      name: JOB_TOKEN,
      description: "The job's bearer secret: the Job-Token the client sent with create-job, or the jobToken the provider returned once.",
    },
  },
  parameters: {
    IdempotencyKey: {
      name: IDEMPOTENCY_KEY,
      in: "header",
      required: false,
      description: `A lowercase UUID the client makes up. It becomes the job id, so the same request can be sent again safely. Send it together with ${JOB_TOKEN}, or send neither.`,
      schema: { type: "string", pattern: IDEMPOTENCY_KEY_PATTERN.source },
    },
    JobToken: {
      name: JOB_TOKEN,
      in: "header",
      required: false,
      description: `32 random bytes as base64url, without padding, which the client makes up and keeps. It opens the job's status and result. Send it together with ${IDEMPOTENCY_KEY}, or send neither.`,
      schema: { type: "string", pattern: JOB_TOKEN_PATTERN.source },
    },
    JobId: {
      name: "jobId",
      in: "path",
      required: true,
      description: `The job id: the ${IDEMPOTENCY_KEY} of create-job, or the jobId it returned.`,
      schema: { type: "string", pattern: IDEMPOTENCY_KEY_PATTERN.source },
    },
  },
  headers: {
    RetryAfter: { description: "Whole seconds to wait before asking again.", schema: { type: "integer", minimum: 0 } },
  },
  responses: {
    Problem: {
      description:
        "An error, as an RFC 9457 problem: act on its `code`. 400 is an input that fails the schema, refused before any payment. 429 and 503 carry Retry-After: the provider is busy, and nothing was charged.",
      content: { [PROBLEM_CONTENT_TYPE]: { schema: { $ref: "#/components/schemas/Problem" } } },
    },
  },
  schemas: {
    Job: {
      type: "object",
      description: "A job: the one response body of create-job, check-status and get-result.",
      properties: {
        jobId: { type: "string" },
        service: { type: "string" },
        status: { enum: [...JOB_STATUSES] },
        charge: { enum: ["on-success", "upfront"], description: "When the user is charged: only if the work succeeds, or before it runs." },
        charged: { enum: [true, false, "unknown"], description: 'Whether the user paid. "unknown" while the job is payment_uncertain.' },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time", description: "Until when the job can be read." },
        output: { type: "object", description: "The result, in create-job and get-result answers, once the job has succeeded." },
        error: { $ref: "#/components/schemas/Problem" },
        payment: { $ref: "#/components/schemas/PaymentReceipt" },
        queue: {
          type: "object",
          description: "Where a queued job stands.",
          properties: { position: { type: "integer", minimum: 1 }, estimatedStartAt: { type: "string", format: "date-time" } },
        },
        jobToken: { type: "string", description: `Only in the create-job answer, and only when the client sent no ${JOB_TOKEN}. Keep it: it is shown once.` },
      },
      required: ["jobId", "service", "status", "charge", "charged", "createdAt", "updatedAt", "expiresAt"],
    },
    PaymentReceipt: {
      type: "object",
      description: "What was paid. A claim: confirm the transaction on chain before treating the job as paid.",
      properties: {
        network: { type: "string" },
        asset: { type: "string" },
        amount: { type: "string", description: "In the asset's base units." },
        payTo: { type: "string" },
        payer: { type: "string" },
        transaction: { type: "string", description: "The Stellar transaction hash." },
        settledAt: { type: "string", format: "date-time" },
      },
      required: ["network", "asset", "amount", "payTo", "payer", "transaction", "settledAt"],
    },
    Problem: {
      type: "object",
      description: "An RFC 9457 problem. `status` is absent on a failed job's `error`.",
      properties: {
        type: { type: "string" },
        title: { type: "string" },
        status: { type: "integer" },
        detail: { type: "string" },
        code: { enum: [...Object.keys(PROBLEMS), ...Object.keys(JOB_FAILURES)] },
        errors: {
          type: "array",
          description: "For invalid_input: where the input fails the schema.",
          items: { type: "object", properties: { pointer: { type: "string" }, message: { type: "string" } }, required: ["pointer", "message"] },
        },
      },
      required: ["type", "title", "code"],
    },
  },
};
