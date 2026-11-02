// listen(): a request answered before its body was read (413 payload_too_large, 404) leaves its kept-alive connection
// able to carry the client's next request [Q1]. It used to stay half-read, and the next request hung or was reset, as
// the verifier's C7 burst found after C6's oversized probe. Offline: 127.0.0.1 and a fake facilitator.

import { Agent, request } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProvider, defineService, listen, type Listening } from "../src/index.js";

const LIMIT = 1024;
let server: Listening;

beforeAll(async () => {
  const echo = defineService({
    name: "echo",
    description: "Echoes its input back, for testing the Node server.",
    price: "0.01",
    maxInputBytes: LIMIT,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handler: (input) => input,
  });
  const provider = createProvider({
    baseUrl: "http://localhost:8787",
    dev: true,
    network: "stellar:testnet",
    payTo: Keypair.random().publicKey(),
    provider: { name: "Node server test" },
    services: [echo],
    facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: false, errorReason: "test" }) },
    rpc: false,
  });
  await provider.ready();
  server = await listen(provider, { host: "127.0.0.1", port: 0 });
});

afterAll(() => server?.close());

/** One request through `agent`, its body sent whole or, with `chunked`, in pieces without a Content-Length. */
function send(agent: Agent, path: string, body: string, options: { chunked?: boolean } = {}) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(`${server.url}${path}`, {
      method: "POST",
      agent,
      headers: { "Content-Type": "application/json", ...(options.chunked ? {} : { "Content-Length": Buffer.byteLength(body) }) },
    });
    outgoing.on("response", (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode!));
    });
    outgoing.on("error", reject);
    if (options.chunked) for (let at = 0; at < body.length; at += 16_384) outgoing.write(body.slice(at, at + 16_384));
    else outgoing.write(body);
    outgoing.end();
  });
}

describe("listen()", () => {
  // One connection at a time, kept alive: each request waits for the one before it to free its socket.
  const agent = () => new Agent({ keepAlive: true, maxSockets: 1 });
  // Larger than what a stream reads ahead (16 KiB), as the verifier's probe is [§5.4].
  const tooLarge = JSON.stringify({ text: "x".repeat(1024 * 1024) });

  it("answers the next request on a connection whose last body was too large to read", async () => {
    const client = agent();
    expect(await send(client, "/services/echo/jobs", tooLarge)).toBe(413);
    expect(await send(client, "/services/echo/jobs", "{}")).toBe(402);
    // A body sent without a Content-Length is read up to the limit, then dropped.
    expect(await send(client, "/services/echo/jobs", tooLarge, { chunked: true })).toBe(413);
    expect(await send(client, "/services/echo/jobs", "{}")).toBe(402);
    client.destroy();
  });

  it("answers the next request after a body sent to a path that doesn't read it", async () => {
    const client = agent();
    expect(await send(client, "/services/none/jobs", tooLarge)).toBe(404);
    expect(await send(client, "/services/echo/jobs", "{}")).toBe(402);
    client.destroy();
  });
});
