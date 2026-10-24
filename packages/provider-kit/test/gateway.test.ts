import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JobView } from "@stellar-agent-services/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProvider, listen, loadGatewayConfig, upstreamHandler, type Listening } from "../src/index.js";
import { client, ids, jobId, payTo } from "./support/harness.js";

// Gateway mode: an existing HTTP API, here a Python one, behind the kit with only a config file.

const directory = mkdtempSync(join(tmpdir(), "provider-kit-gateway-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

type Handler = (request: IncomingMessage, body: string) => { status: number; body?: unknown; headers?: Record<string, string> };

/** A local HTTP server that answers with `handler`. */
async function server(handler: Handler): Promise<{ url: string; close: () => Promise<void>; requests: { headers: IncomingMessage["headers"]; body: string }[] }> {
  const requests: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const http: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ headers: request.headers, body });
      const answer = handler(request, body);
      response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
      response.end(answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}

/** A facilitator that accepts every payment, over HTTP like the real one. */
function facilitatorServer() {
  let transactions = 0;
  return server((request) => {
    if (request.url?.endsWith("/supported")) {
      return { status: 200, body: { kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }] } };
    }
    if (request.url?.endsWith("/verify")) return { status: 200, body: { isValid: true } };
    return { status: 200, body: { success: true, transaction: (++transactions).toString(16).padStart(64, "0"), network: "stellar:testnet" } };
  });
}

describe("upstreamHandler", () => {
  const context = () => ({ signal: AbortSignal.timeout(10_000), jobId });

  it("POSTs the input with the job id and configured headers, and nothing about the payment", async () => {
    const upstream = await server(() => ({ status: 200, body: { ok: true } }));
    const handler = upstreamHandler({ url: `${upstream.url}/run`, headers: { Authorization: "Bearer upstream-key" } });
    expect(await handler({ text: "hi" }, context())).toEqual({ ok: true });
    const [sent] = upstream.requests;
    expect(JSON.parse(sent!.body)).toEqual({ text: "hi" });
    expect(sent!.headers).toMatchObject({ authorization: "Bearer upstream-key", "idempotency-key": jobId, "content-type": "application/json" });
    expect(Object.keys(sent!.headers).filter((name) => /payment|job-token/i.test(name))).toEqual([]);
    await upstream.close();
  });

  it("retries a busy upstream after its Retry-After", async () => {
    let calls = 0;
    const upstream = await server(() => (++calls < 3 ? { status: 503, headers: { "Retry-After": "0" } } : { status: 200, body: { ok: calls } }));
    expect(await upstreamHandler({ url: upstream.url })({}, context())).toEqual({ ok: 3 });
    await upstream.close();
  });

  it("fails on an error status, a non-object answer or a redirect", async () => {
    for (const answer of [{ status: 500 }, { status: 200, body: "[1,2]" }, { status: 200, body: "not json" }, { status: 302, headers: { Location: "https://elsewhere.example" } }]) {
      const upstream = await server(() => answer);
      await expect(upstreamHandler({ url: upstream.url })({}, context())).rejects.toThrow();
      await upstream.close();
    }
  });

  it("stops retrying when the job runs out of time", async () => {
    const upstream = await server(() => ({ status: 503, headers: { "Retry-After": "30" } }));
    const signal = AbortSignal.timeout(200);
    await expect(upstreamHandler({ url: upstream.url })({}, { signal, jobId })).rejects.toThrow();
    await upstream.close();
  });
});

describe("loadGatewayConfig", () => {
  const write = (name: string, config: unknown) => {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(config));
    return path;
  };
  const minimal = {
    baseUrl: "env:ORIGIN",
    network: "stellar:testnet",
    payTo: "env:PAY_TO",
    facilitator: "https://x402.org/facilitator",
    provider: { name: "Gateway test" },
    store: "memory",
    services: [
      {
        name: "echo",
        description: "Echoes.",
        price: "0.01",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        upstream: { url: "http://127.0.0.1:1/echo", headers: { "X-Api-Key": "env:UPSTREAM_KEY" } },
      },
    ],
  };
  const env = { ORIGIN: "https://api.example.com/agent", PAY_TO: payTo, UPSTREAM_KEY: "k" };

  it("reads env: values and builds a provider config that passes every startup check", async () => {
    const { config, listen: where } = await loadGatewayConfig(write("ok.json", minimal), { env: { ...env, PORT: "9000" } });
    expect(config).toMatchObject({ baseUrl: "https://api.example.com/agent", payTo, network: "stellar:testnet" });
    expect(where).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(createProvider(config).manifestUrl).toBe("https://api.example.com/.well-known/stellar-agent-services.json");
  });

  it("reads the Soroban RPC URL, and refuses a plain http:// one outside dev", async () => {
    const withRpc = { ...minimal, rpcUrl: "env:RPC_URL" };
    const { config } = await loadGatewayConfig(write("rpc.json", withRpc), { env: { ...env, RPC_URL: "https://rpc.example.com" } });
    expect(config.rpc).toBe("https://rpc.example.com");
    const plain = await loadGatewayConfig(write("rpc-http.json", withRpc), { env: { ...env, RPC_URL: "http://rpc.example.com" } });
    expect(() => createProvider(plain.config)).toThrow(/Soroban RPC URL must be https/);
  });

  it("refuses a config with a missing env value, a schema problem or a bad service, saying where", async () => {
    await expect(loadGatewayConfig(write("env.json", minimal), { env: { ...env, UPSTREAM_KEY: "" } })).rejects.toThrow(/UPSTREAM_KEY/);
    await expect(loadGatewayConfig(write("schema.json", { ...minimal, payto: "typo" }), { env })).rejects.toThrow(/must NOT have additional properties/);
    const badExample = { ...minimal, services: [{ ...minimal.services[0], examples: [{ input: {}, output: { x: 1 } }], outputSchema: { type: "object", required: ["y"] } }] };
    await expect(loadGatewayConfig(write("example.json", badExample), { env })).rejects.toThrow(/services\[0\].*S9/);
    await expect(loadGatewayConfig(join(directory, "missing.json"), { env })).rejects.toThrow(/can't be read/);
  });
});

const python = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!python)("the Python example behind the gateway", () => {
  let app: ChildProcess;
  let gateway: Listening;
  let facilitator: Awaited<ReturnType<typeof facilitatorServer>>;

  beforeAll(async () => {
    app = spawn("python3", [join(import.meta.dirname, "../../../examples/python-upstream/app.py"), "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const upstreamUrl = await new Promise<string>((resolve, reject) => {
      createInterface({ input: app.stdout! }).once("line", (line) => resolve(line.replace("listening on ", "")));
      app.once("exit", (code) => reject(new Error(`app.py exited with ${code}`)));
    });
    facilitator = await facilitatorServer();

    // The example's own config, pointed at the local Python app and facilitator.
    const example = join(import.meta.dirname, "../../../examples/python-upstream");
    cpSync(join(example, "schemas"), join(directory, "schemas"), { recursive: true });
    const config = JSON.parse(readFileSync(join(example, "provider.config.json"), "utf8"));
    config.facilitator = `${facilitator.url}/facilitator`;
    config.dev = true;
    config.store = "./python.sqlite";
    config.services[0].upstream.url = `${upstreamUrl}/summarize`;
    const path = join(directory, "python.config.json");
    writeFileSync(path, JSON.stringify(config));

    const loaded = await loadGatewayConfig(path, { env: { PUBLIC_ORIGIN: "http://localhost:8787", PAY_TO: payTo } });
    // The test runs offline: no chain reads.
    const provider = createProvider({ ...loaded.config, rpc: false });
    await provider.ready();
    gateway = await listen(provider, { host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await gateway?.close();
    await facilitator?.close();
    app?.kill();
  });

  it("serves the manifest, asks for payment, and returns the paid Python result", async () => {
    const http = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, init);
    const manifest = await (await http("/.well-known/stellar-agent-services.json")).json();
    expect(manifest.services[0]).toMatchObject({ name: "summarize", price: { amount: "100000" }, charge: "on-success" });
    expect((await http("/healthz")).status).toBe(200);

    // A client against the live gateway: its fetch goes over HTTP.
    const { payment } = client({ manifest, manifestUrl: "", fetch: (request: Request) => fetch(request), ready: async () => {}, close: async () => {} });
    const input = { text: "Stellar settles in seconds. Fees are tiny. Agents can pay.", sentences: 2 };
    const post = (headers: Record<string, string>) =>
      http("/services/summarize/jobs", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input) });

    expect((await post(ids)).status).toBe(402);
    expect((await post({ "Idempotency-Key": jobId })).status).toBe(400);
    const paid = await post({ ...ids, "PAYMENT-SIGNATURE": await payment("summarize") });
    expect(paid.status).toBe(200);
    expect((await paid.json()) as JobView).toMatchObject({
      status: "succeeded",
      charged: true,
      output: { summary: "Stellar settles in seconds. Fees are tiny.", sentences: 3, words: 10 },
    });
    expect(facilitator.requests.filter((request) => request.body.includes("paymentPayload"))).toHaveLength(2);
  });

  it("refuses input the schema rejects before the Python app sees it", async () => {
    const response = await fetch(`${gateway.url}/services/summarize/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", sentences: 99 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_input", errors: [{ pointer: "/sentences" }] });
  });

  it("keeps the paid job for check-status, with its receipt", async () => {
    const response = await fetch(`${gateway.url}/jobs/${jobId}`, { headers: { "Job-Token": ids["Job-Token"] } });
    expect(response.status).toBe(200);
    expect((await response.json()) as JobView).toMatchObject({ status: "succeeded", payment: { payTo, amount: "100000" } });
  });
});
