import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, JsonObject, JsonValue } from "@stellar-agent-services/protocol";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "../src/cli/init.js";
import { gatewayFromOpenApi, OpenApiError, readOpenApi, type OpenApiGateway } from "../src/gateway/openapi.js";
import { createProvider, loadGatewayConfig, type GatewayService } from "../src/index.js";
import { client, fakeFacilitator, ids, payTo } from "./support/harness.js";

// provider-kit init --openapi: an existing API's OpenAPI document becomes a gateway config, a service per POST
// endpoint the gateway can call, with the reason for every operation it skips. The fixtures are a real FastAPI
// document (fixtures/openapi/fastapi_app.py) and a drf-spectacular style OpenAPI 3.0 document in YAML.

const FIXTURES = join(import.meta.dirname, "fixtures/openapi");
const FASTAPI = join(FIXTURES, "fastapi-openapi.json");
const CAPTIONS = join(FIXTURES, "image-captions.yaml");

const directory = mkdtempSync(join(tmpdir(), "provider-kit-openapi-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;
const nextPath = (name = "provider.config.json") => join(directory, `${++files}-${name}`);

let output: string[] = [];
beforeEach(() => {
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void output.push(args.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

async function generate(source: string, options: { upstream?: string; url?: string } = { upstream: "http://127.0.0.1:8000" }): Promise<OpenApiGateway> {
  const { document } = await readOpenApi(source);
  return gatewayFromOpenApi(document, options);
}

const named = (gateway: OpenApiGateway, name: string): GatewayService => gateway.services.find((service) => service.name === name)!;

/** A document with one server, and `paths`. */
const doc = (paths: JsonObject, extra: JsonObject = {}): JsonObject => ({
  openapi: "3.1.0",
  info: { title: "Edge API", version: "1" },
  servers: [{ url: "http://127.0.0.1:9000" }],
  paths,
  ...extra,
});

/** A POST operation taking `body` (none when undefined) and answering 200 with `answer`. */
const post = (body: JsonValue | undefined, answer: JsonValue = { type: "object" }, more: JsonObject = {}): JsonObject => ({
  post: {
    ...(body === undefined ? {} : { requestBody: { content: { "application/json": { schema: body } } } }),
    responses: { "200": { description: "OK", content: { "application/json": { schema: answer } } } },
    ...more,
  },
});

describe("a FastAPI document", () => {
  it("becomes a service per POST endpoint the gateway can call, and every other operation is skipped with the reason", async () => {
    const gateway = await generate(FASTAPI);
    expect(gateway.api).toEqual({ title: "Text Tools API", version: "1.4.0", openapi: "3.1.0" });
    expect(gateway.provider).toEqual({ name: "Text Tools API", description: "Summaries, translations and labels for English text." });
    expect(gateway.services.map((service) => [service.name, service.upstream.url])).toEqual([
      ["summarize", "http://127.0.0.1:8000/summarize"],
      ["translate", "http://127.0.0.1:8000/v1/translate"],
      ["classify-tree", "http://127.0.0.1:8000/classify/tree"],
      ["random-fact", "http://127.0.0.1:8000/random-fact"],
    ]);
    expect(gateway.skipped).toEqual([
      { method: "GET", path: "/health", reason: "the gateway calls the API with POST" },
      { method: "POST", path: "/documents/{document_id}/summarize", reason: "it has a path parameter ({document_id}); the gateway calls one fixed URL" },
      { method: "POST", path: "/search", reason: 'it needs the query parameter "q"; the gateway sends only a JSON body' },
      { method: "POST", path: "/upload", reason: "it takes multipart/form-data, not JSON" },
      { method: "POST", path: "/languages", reason: "it answers with an array, not a JSON object" },
      { method: "POST", path: "/render", reason: "it answers with image/png, not JSON" },
      { method: "POST", path: "/v0/summarize", reason: "it is deprecated" },
    ]);
  });

  it("writes JSON Schema 2020-12: the body at the root, the components it uses under $defs, recursion included", async () => {
    const gateway = await generate(FASTAPI);
    const summarize = named(gateway, "summarize");
    expect(summarize.inputSchema).toMatchObject({
      type: "object",
      required: ["text"],
      properties: { language: { anyOf: [{ $ref: "#/$defs/Language" }, { type: "null" }] }, sentences: { minimum: 1, maximum: 10, default: 2 } },
      $defs: { Language: { type: "string", enum: ["en", "tr", "de"] } },
    });
    // The root is the schema itself, and its first keyword is "type" [S4].
    expect(Object.keys(summarize.inputSchema as JsonObject)[0]).toBe("type");
    expect(JSON.stringify(gateway.services)).not.toContain("#/components/");

    const tree = named(gateway, "classify-tree").inputSchema as JsonObject;
    expect(tree).toMatchObject({ type: "object", properties: { children: { items: { $ref: "#/$defs/Node" } } }, $defs: { Node: { required: ["label"] } } });
    const noBody = named(gateway, "random-fact");
    expect(noBody.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("pairs the document's examples, and takes titles and descriptions from it", async () => {
    const gateway = await generate(FASTAPI);
    expect(named(gateway, "summarize")).toMatchObject({
      title: "Summarize",
      description: "Returns the first sentences of an English text, with sentence and word counts. Use it to shorten text before passing it on. It does not paraphrase.",
      tags: ["text"],
      examples: [{ input: { text: "Stellar settles in seconds. Fees are tiny.", sentences: 1 }, output: { summary: "Stellar settles in seconds.", sentences: 2, words: 7 } }],
    });
    // No body: the example input is the empty object.
    expect(named(gateway, "random-fact").examples).toEqual([{ input: {}, output: { summary: "Stellar settles in seconds.", sentences: 2, words: 7 } }]);
    // A summary is not a description: the developer writes one.
    expect(named(gateway, "classify-tree")).toMatchObject({ title: "Label a tree", description: "Label a tree" });
    expect(gateway.undescribed).toEqual(["classify-tree"]);
    // First guesses, the same as the starter config's.
    expect(named(gateway, "translate")).toMatchObject({ price: "0.01", charge: "upfront", expectedDurationSeconds: 5, capacity: { concurrency: 2, maxQueueWaitSeconds: 60 } });
  });

  it("sends the API's own key from the environment, never from the file", async () => {
    const gateway = await generate(FASTAPI);
    expect(named(gateway, "translate").upstream.headers).toEqual({ "X-API-Key": "env:UPSTREAM_X_API_KEY" });
    expect(named(gateway, "summarize").upstream.headers).toBeUndefined();
    expect(gateway.credentials).toEqual([{ header: "X-API-Key", name: "UPSTREAM_X_API_KEY", holds: "the API's key, sent as X-API-Key" }]);
  });
});

describe("an OpenAPI 3.0 document in YAML", () => {
  it("is rewritten the JSON Schema 2020-12 way", async () => {
    const gateway = await generate(CAPTIONS, {});
    const captions = named(gateway, "captions");
    // readOnly properties never come in; nullable becomes a type list (and null joins an enum); a boolean
    // exclusiveMaximum moves the maximum; `example` becomes `examples`; OpenAPI's own keywords are dropped.
    expect(captions.inputSchema).toEqual({
      type: "object",
      required: ["image_url"],
      properties: {
        image_url: { type: "string", format: "uri", examples: ["https://example.com/cat.png"] },
        max_words: { type: ["integer", "null"], minimum: 1, exclusiveMaximum: 50 },
        style: { type: ["string", "null"], enum: ["plain", "poetic", null] },
      },
    });
    // writeOnly properties never go out.
    expect(captions.outputSchema).toEqual({
      type: "object",
      required: ["id", "caption", "confidence"],
      properties: { id: { type: "integer", readOnly: true }, caption: { type: "string" }, confidence: { type: "number", exclusiveMinimum: 0, maximum: 1 } },
    });
  });

  it("calls the server the document names, with its variables, and the 201 answer with a charset", async () => {
    const gateway = await generate(CAPTIONS, {});
    expect(named(gateway, "captions")).toMatchObject({
      title: "Caption an image",
      description: "Writes a one-sentence caption for the image at a URL. Use it for alt text. English only.",
      tags: ["captions", "vision-ai"],
      upstream: { url: "https://eu.captions.example.com/api/v2/captions/", headers: { Authorization: "env:UPSTREAM_AUTHORIZATION" } },
      examples: [{ input: { image_url: "https://example.com/cat.png", max_words: 12 }, output: { id: 7, caption: "A cat asleep on a keyboard.", confidence: 0.92 } }],
    });
    expect(gateway.provider.description).toBe("Captions and alt text for images.\n\nServed by Django REST Framework.");
    expect(gateway.skipped.map((operation) => operation.reason)).toEqual(["the gateway calls the API with POST", "it takes application/x-www-form-urlencoded, not JSON"]);
  });
});

describe("operations the gateway can't call", () => {
  it("are skipped with the reason, and the rest still become services", async () => {
    const gateway = await gatewayFromOpenApi(
      doc(
        {
          "/ok": post({ type: "object", properties: { a: { type: "string" } } }),
          "/list": post({ type: "array", items: { type: "string" } }),
          "/maybe": post({ type: ["string", "null"] }),
          "/nothing": { post: { responses: { "204": { description: "No content" } } } },
          "/external": post({ $ref: "shared.yaml#/Thing" }),
          "/missing": post({ $ref: "#/components/schemas/Gone" }),
          "/tenant": post(undefined, { type: "object" }, { parameters: [{ name: "X-Tenant", in: "header", required: true }] }),
          "/auth-header": post(undefined, { type: "object" }, { parameters: [{ name: "Authorization", in: "header", required: true }] }),
        },
        { components: { schemas: {} } },
      ),
    );
    expect(gateway.services.map((service) => service.name)).toEqual(["ok", "auth-header"]);
    expect(Object.fromEntries(gateway.skipped.map((operation) => [operation.path, operation.reason]))).toEqual({
      "/list": "its body is an array, not a JSON object",
      "/maybe": "its body is a string or null, not a JSON object",
      "/nothing": "it answers 204 with no content; a service answers with a JSON object",
      "/external": "its schema refers to another document (shared.yaml#/Thing); bundle the document into one file first",
      "/missing": "its schema refers to #/components/schemas/Gone, which the document doesn't have",
      "/tenant": 'it needs the header parameter "X-Tenant"; the gateway sends only a JSON body',
    });
  });

  it("include ones the kit would refuse to serve: a schema that doesn't compile, or one over 32 KiB [S6]", async () => {
    const huge = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`field${index}`, { type: "string", description: "x".repeat(80) }]));
    const gateway = await gatewayFromOpenApi(
      doc({
        "/python-regex": post({ type: "object", properties: { word: { type: "string", pattern: "^(?P<word>\\w+)$" } } }),
        "/huge": post({ type: "object", properties: huge }),
      }),
    );
    expect(gateway.services).toEqual([]);
    expect(gateway.skipped[0]!.reason).toMatch(/^a schema does not compile: .*Invalid regular expression/);
    expect(gateway.skipped[1]!.reason).toMatch(/^\[S6\] inputSchema: .*32768/);
  });
});

describe("generated services", () => {
  it("are named after their paths, without api and version segments, and uniquely", async () => {
    const gateway = await gatewayFromOpenApi(
      doc({
        "/api/v1/summarize": post({ type: "object" }),
        "/v2/summarize": post({ type: "object" }),
        "/text/Translate_Now": post({ type: "object" }),
        "/": post({ type: "object" }, { type: "object" }, { operationId: "Root Call" }),
      }),
    );
    expect(gateway.services.map((service) => service.name)).toEqual(["summarize", "summarize-2", "text-translate_now", "root-call"]);
  });

  it("are at most 25", async () => {
    const paths = Object.fromEntries(Array.from({ length: 26 }, (_, index) => [`/s${index + 1}`, post({ type: "object" })]));
    const gateway = await gatewayFromOpenApi(doc(paths));
    expect(gateway.services).toHaveLength(25);
    expect(gateway.skipped).toEqual([{ method: "POST", path: "/s26", reason: "a provider has at most 25 services; this one can replace another" }]);
  });

  it("take any JSON object from an answer of any type or no schema, as Spring's */* answers", async () => {
    const gateway = await gatewayFromOpenApi(
      doc({
        "/spring": { post: { responses: { "200": { description: "OK", content: { "*/*": { schema: { $ref: "#/components/schemas/Out" } } } } } } },
        "/no-schema": { post: { responses: { "200": { description: "OK", content: { "application/json": {} } } } } },
        "/no-answer": { post: { responses: {} } },
      }, { components: { schemas: { Out: { type: "object", properties: { ok: { type: "boolean" } } } } } }),
    );
    expect(gateway.services.map((service) => [service.name, service.outputSchema])).toEqual([
      ["spring", { type: "object", properties: { ok: { type: "boolean" } } }],
      ["no-schema", { type: "object" }],
      ["no-answer", { type: "object" }],
    ]);
  });

  it("keep a reference's neighbours, accept an object-or-null root, and make component names safe for a pointer", async () => {
    const gateway = await gatewayFromOpenApi(
      doc(
        {
          "/merge": post({ $ref: "#/components/schemas/My Model", description: "Overrides the component's own." }, { type: ["object", "null"], properties: { n: { type: "integer" } } }),
        },
        { components: { schemas: { "My Model": { type: "object", description: "The component's.", properties: { other: { $ref: "#/components/schemas/Other~Thing" } } }, "Other~Thing": { type: "string" } } } },
      ),
    );
    const merge = named(gateway, "merge");
    expect(merge.inputSchema).toEqual({
      type: "object",
      description: "Overrides the component's own.",
      properties: { other: { $ref: "#/$defs/Other_Thing" } },
      $defs: { Other_Thing: { type: "string" } },
    });
    expect(merge.outputSchema).toEqual({ type: "object", properties: { n: { type: "integer" } } });
  });

  it("leave out an example that doesn't match its schema [S9]", async () => {
    const operation = post({ type: "object", required: ["text"], properties: { text: { type: "string" } }, examples: [{ txt: "typo" }] }, { type: "object", examples: [{ ok: true }] });
    const gateway = await gatewayFromOpenApi(doc({ "/typo": operation }));
    expect(named(gateway, "typo").examples).toBeUndefined();
  });
});

describe("the API's own credentials", () => {
  const schemes = {
    key: { type: "apiKey", in: "header", name: "X-Api-Key" },
    basic: { type: "http", scheme: "basic" },
    cookie: { type: "apiKey", in: "cookie", name: "session" },
    oauth: { type: "oauth2", flows: {} },
  };
  const withSecurity = (security: JsonValue | undefined, documentSecurity?: JsonValue) =>
    gatewayFromOpenApi(
      doc({ "/x": post({ type: "object" }, { type: "object" }, security === undefined ? {} : { security }) }, {
        components: { securitySchemes: schemes },
        ...(documentSecurity === undefined ? {} : { security: documentSecurity }),
      }),
    );

  it("are read from the environment by header: an API key, basic or bearer", async () => {
    expect((await withSecurity([{ key: [] }])).services[0]!.upstream.headers).toEqual({ "X-Api-Key": "env:UPSTREAM_X_API_KEY" });
    const basic = await withSecurity([{ basic: [] }]);
    expect(basic.services[0]!.upstream.headers).toEqual({ Authorization: "env:UPSTREAM_AUTHORIZATION" });
    expect(basic.credentials[0]!.holds).toBe(`"Basic " and the API's user:password in base64`);
  });

  it("come from the first alternative the gateway can send, and an operation's own list wins", async () => {
    expect((await withSecurity([{ cookie: [] }, { key: [] }])).services[0]!.upstream.headers).toEqual({ "X-Api-Key": "env:UPSTREAM_X_API_KEY" });
    expect((await withSecurity(undefined, [{ key: [] }])).services[0]!.upstream.headers).toEqual({ "X-Api-Key": "env:UPSTREAM_X_API_KEY" });
    expect((await withSecurity([], [{ key: [] }])).services[0]!.upstream.headers).toBeUndefined();
    expect((await withSecurity([{}, { key: [] }])).services[0]!.upstream.headers).toBeUndefined();
  });

  it("that can't be a fixed header leave the service in, with a warning", async () => {
    const gateway = await withSecurity([{ cookie: [] }, { oauth: [] }]);
    expect(gateway.services).toHaveLength(1);
    expect(gateway.warnings).toEqual(["x: the API asks for credentials (cookie, oauth) that the gateway can't send as a fixed header. Set upstream.headers by hand."]);
  });
});

describe("the address the gateway calls", () => {
  const operations = { "/a": post({ type: "object" }), "/b": { ...post({ type: "object" }), servers: [{ url: "https://b.example.com/v9" }] } };

  it("is --upstream, else the document's server, else relative to where the document was read", async () => {
    const urls = (gateway: OpenApiGateway) => gateway.services.map((service) => service.upstream.url);
    expect(urls(await gatewayFromOpenApi(doc(operations), { upstream: "http://10.0.0.5:7000/" }))).toEqual(["http://10.0.0.5:7000/a", "http://10.0.0.5:7000/b"]);
    expect(urls(await gatewayFromOpenApi(doc(operations)))).toEqual(["http://127.0.0.1:9000/a", "https://b.example.com/v9/b"]);
    const relative = doc({ "/a": post({ type: "object" }) }, { servers: [{ url: "/api" }] });
    expect(urls(await gatewayFromOpenApi(relative, { url: "http://127.0.0.1:8000/openapi.json" }))).toEqual(["http://127.0.0.1:8000/api/a"]);
  });

  it("must be given when the document's server is relative and it came from a file", async () => {
    const relative = doc({ "/a": post({ type: "object" }) }, { servers: [] });
    await expect(gatewayFromOpenApi(relative)).rejects.toThrow(/server URL is "\/", relative to where the API runs, so pass the API's address: --upstream <url>/);
    await expect(gatewayFromOpenApi(relative, { upstream: "ftp://x" })).rejects.toThrow(OpenApiError);
    // A document with nothing to call needs no address.
    expect((await gatewayFromOpenApi(doc({ "/a": { get: { responses: {} } } }, { servers: [] }))).services).toEqual([]);
  });
});

describe("readOpenApi", () => {
  const file = (name: string, text: string) => {
    const path = nextPath(name);
    writeFileSync(path, text);
    return path;
  };

  it("reads JSON and YAML, and refuses what isn't OpenAPI 3", async () => {
    expect((await readOpenApi(file("a.yaml", "openapi: 3.2.0\ninfo: {title: A, version: '1'}\npaths: {}\n"))).document).toMatchObject({ openapi: "3.2.0" });
    await expect(readOpenApi(file("swagger.json", '{"swagger":"2.0","paths":{}}'))).rejects.toThrow(/Swagger 2\.0 \(OpenAPI 2\)\. Convert it to OpenAPI 3 first/);
    await expect(readOpenApi(file("other.json", '{"name":"not openapi"}'))).rejects.toThrow(/names no "openapi" version/);
    await expect(readOpenApi(file("four.json", '{"openapi":"4.0.0"}'))).rejects.toThrow(/OpenAPI 4\.0\.0; 3\.0, 3\.1 and 3\.2 are supported/);
    await expect(readOpenApi(file("broken.yaml", "openapi: [3.1\n  - :"))).rejects.toThrow(/is neither JSON nor YAML/);
    await expect(readOpenApi(join(directory, "missing.json"))).rejects.toThrow(/can't be read/);
  });

  it("reads a URL, and says where it ended up", async () => {
    const text = readFileSync(FASTAPI, "utf8");
    const fetcher = vi.fn<typeof fetch>(async (input) => (String(input).endsWith("/openapi.json") ? new Response(text) : new Response("nope", { status: 404 })));
    expect(await readOpenApi("http://127.0.0.1:8000/openapi.json", fetcher)).toMatchObject({ url: "http://127.0.0.1:8000/openapi.json", document: { openapi: "3.1.0" } });
    await expect(readOpenApi("http://127.0.0.1:8000/docs.json", fetcher)).rejects.toThrow("http://127.0.0.1:8000/docs.json answered 404");
  });
});

describe("provider-kit init --openapi", () => {
  it("writes a config that loads as serve loads it, and says what to do next", async () => {
    const out = nextPath();
    expect(await init({ openapi: FASTAPI, upstream: "http://127.0.0.1:8000", out })).toBe(0);
    const printed = output.join("\n");
    expect(printed).toContain("Read Text Tools API 1.4.0 (OpenAPI 3.1.0)");
    expect(printed).toContain(`Wrote ${out} with 4 services:`);
    expect(printed).toContain("translate      POST http://127.0.0.1:8000/v1/translate  with X-API-Key");
    expect(printed).toContain("Skipped 7 operations:");
    expect(printed).toContain("✓ The config passes Provider Standard v1");
    expect(printed).toContain("Write one for classify-tree");
    expect(printed).toContain("export UPSTREAM_X_API_KEY=...   the API's key, sent as X-API-Key");
    expect(printed).toContain(`provider-kit try summarize --config ${out}`);

    const config = JSON.parse(readFileSync(out, "utf8"));
    expect(config).toMatchObject({ baseUrl: "http://localhost:8787", dev: true, network: "stellar:testnet", payTo: "env:PAY_TO", provider: { name: "Text Tools API" } });
    const { config: loaded } = await loadGatewayConfig(out, { env: { PAY_TO: payTo, UPSTREAM_X_API_KEY: "key" }, openStore: false });
    expect(loaded.services.map((service) => service.name)).toEqual(["summarize", "translate", "classify-tree", "random-fact"]);
  });

  it("serves: a paid call reaches the API at the endpoint's path, with its key, and returns its answer", async () => {
    const out = nextPath();
    const api = await upstream((request, body) => {
      if (request.url === "/summarize") return { summary: "Stellar settles in seconds.", sentences: 2, words: 7, echo: JSON.parse(body) };
      if (request.url === "/v1/translate") return { text: request.headers["x-api-key"] === "key" ? "Merhaba" : "no key" };
      return undefined;
    });
    try {
      await init({ openapi: FASTAPI, upstream: api.url, out });
      const { config } = await loadGatewayConfig(out, { env: { PAY_TO: payTo, UPSTREAM_X_API_KEY: "key" }, openStore: false });
      const provider = createProvider({ ...config, facilitator: fakeFacilitator(), rpc: false });
      const { createJob, payment, view } = client(provider);
      const example = { text: "Stellar settles in seconds. Fees are tiny.", sentences: 1 };

      expect((await createJob("summarize", { sentences: 1 })).status).toBe(400);
      const summary = await view(await createJob("summarize", example, { ...ids, "PAYMENT-SIGNATURE": await payment("summarize") }));
      expect(summary).toMatchObject({ status: "succeeded", charged: true, output: { summary: "Stellar settles in seconds.", echo: example } } satisfies Partial<JobView>);

      const translated = await view(
        await createJob("translate", { text: "Hello", target: "tr" }, { "Idempotency-Key": crypto.randomUUID(), "Job-Token": ids["Job-Token"], "PAYMENT-SIGNATURE": await payment("translate") }),
      );
      expect(translated).toMatchObject({ status: "succeeded", output: { text: "Merhaba" } });
      expect(api.paths).toEqual(["/summarize", "/v1/translate"]);
      await provider.close();
    } finally {
      await api.close();
    }
  });

  it("reads the document from the running API, and calls the API where it found it", async () => {
    const out = nextPath();
    const text = readFileSync(FASTAPI, "utf8");
    const api = await upstream((request) => (request.url === "/openapi.json" ? JSON.parse(text) : undefined));
    try {
      expect(await init({ openapi: `${api.url}/openapi.json`, out })).toBe(0);
      const config = JSON.parse(readFileSync(out, "utf8"));
      expect(config.services[0].upstream.url).toBe(`${api.url}/summarize`);
    } finally {
      await api.close();
    }
  });

  it("never overwrites a file, and checks before reading the document", async () => {
    const out = nextPath();
    writeFileSync(out, "{}");
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(init({ openapi: "http://127.0.0.1:1/openapi.json", out })).rejects.toThrow(`${out} already exists; nothing was written`);
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFileSync(out, "utf8")).toBe("{}");
  });

  it("writes nothing when no operation can be a service", async () => {
    const source = nextPath("only-get.json");
    writeFileSync(source, JSON.stringify(doc({ "/health": { get: { responses: {} } } })));
    const out = nextPath();
    await expect(init({ openapi: source, out })).rejects.toThrow(/none of its operations can be a service/);
    expect(existsSync(out)).toBe(false);
    expect(output.join("\n")).toContain("GET  /health  the gateway calls the API with POST");
  });
});

describe("provider-kit init without --openapi", () => {
  it("still writes the one-service starter config", async () => {
    const out = nextPath();
    expect(await init({ out, upstream: "http://127.0.0.1:5000/run" })).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      $schema: "./node_modules/@stellar-agent-services/provider-kit/schemas/gateway-config.schema.json",
      baseUrl: "http://localhost:8787",
      dev: true,
      network: "stellar:testnet",
      payTo: "env:PAY_TO",
      facilitator: "https://x402.org/facilitator",
      provider: { name: "My provider", description: "What you offer, in a sentence or two.", dataUse: { storesInputs: false, trainsOnInputs: false } },
      store: "./jobs.sqlite",
      services: [
        {
          name: "my-service",
          title: "My service",
          description: "What it does, when to use it, and its limits (input size, languages, what it won't do).",
          price: "0.01",
          charge: "upfront",
          expectedDurationSeconds: 5,
          inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 10000 } }, additionalProperties: false },
          outputSchema: { type: "object" },
          capacity: { concurrency: 2, maxQueueWaitSeconds: 60 },
          upstream: { url: "http://127.0.0.1:5000/run" },
        },
      ],
    });
  });
});

/** A local stand-in for the API: `answer` returns the JSON for a path, or undefined for 404. */
async function upstream(answer: (request: IncomingMessage, body: string) => JsonValue | undefined) {
  const paths: string[] = [];
  const http: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url !== "/openapi.json") paths.push(request.url ?? "");
      const json = answer(request, body);
      response.writeHead(json === undefined ? 404 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(json ?? { detail: "Not Found" }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    paths,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
