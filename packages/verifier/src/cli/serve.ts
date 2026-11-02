// Serves a Fetch-API handler on Node's HTTP server: how `verifier watch` serves receipts, badges, request
// status and /healthz. Everything it serves is read with GET or HEAD, so request bodies are never read, and
// any other method is refused here.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Served {
  /** Where it listens, such as http://0.0.0.0:8080. */
  url: string;
  close(): Promise<void>;
}

export type Handler = (request: Request) => Promise<Response>;

export async function serveHttp(handler: Handler, port: number, host = "0.0.0.0"): Promise<Served> {
  const server = createServer((incoming, outgoing) => {
    void respond(handler, incoming, outgoing);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${shown}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function respond(handler: Handler, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  try {
    const method = incoming.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      outgoing.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "application/json" }).end('{"error":"only GET and HEAD"}');
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
    // The handler routes on the path alone, so the origin is a placeholder.
    const response = await handler(new Request(new URL(incoming.url ?? "/", "http://localhost"), { method, headers }));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(method === "HEAD" || response.body === null ? undefined : new Uint8Array(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end();
  }
}
