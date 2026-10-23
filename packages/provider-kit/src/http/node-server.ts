// Serves a provider on Node's built-in HTTP server, for `provider-kit serve` and for library users who
// don't want a framework. Any Fetch-API server (Hono, Workers, Deno, Bun) can mount provider.fetch
// directly instead.
//
// GET /healthz answers 200 for load balancers and container health checks. close() stops taking
// connections, waits for requests in flight, then closes the provider; jobs still running resume on
// the next start.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { Provider } from "../provider.js";

export interface ListenOptions {
  host?: string;
  /** 0 picks a free port. */
  port: number;
}

export interface Listening {
  server: Server;
  /** Where the server listens, such as http://127.0.0.1:8787. */
  url: string;
  close(): Promise<void>;
}

/** How long close() waits for requests in flight. A held create-job lasts at most 30 s [J9]. */
const DRAIN_MS = 35_000;

export async function listen(provider: Provider, options: ListenOptions): Promise<Listening> {
  const server = createServer((request, response) => {
    void handle(provider, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;

  let closing: Promise<void> | undefined;
  return {
    server,
    url: `http://${host}:${address.port}`,
    close() {
      closing ??= (async () => {
        const drained = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        const timer = setTimeout(() => server.closeAllConnections(), DRAIN_MS);
        await drained;
        clearTimeout(timer);
        await provider.close();
      })();
      return closing;
    },
  };
}

async function handle(provider: Provider, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  try {
    if (incoming.method === "GET" && incoming.url === "/healthz") {
      outgoing.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    const response = await provider.fetch(toRequest(incoming));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    if (response.body === null) {
      outgoing.end();
      return;
    }
    for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  } catch (error) {
    console.error("[provider-kit] request failed:", error);
    if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end();
  }
}

/** The router reads only the path, so the host part of the URL is a placeholder. */
function toRequest(incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const each of value) headers.append(name, each);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" as const };
  return new Request(new URL(incoming.url ?? "/", "http://localhost"), { method, headers, ...body });
}
