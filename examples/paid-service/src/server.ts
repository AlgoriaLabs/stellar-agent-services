// Sample provider, built ONLY with the public provider-kit API, so it doubles as the template that
// pilot providers copy. Config comes from .env: public values only, never a secret key.
//
// Jobs are kept in SQLite (JOB_DB_PATH), so a paid job survives a restart: a queued report runs when
// the server is back, and a client that lost its response can still collect the result.

import { serve } from "@hono/node-server";
import { createProvider, sqliteStore, type ProviderConfig } from "@stellar-agent-services/provider-kit";
import { Hono } from "hono";
import { delayedReport } from "./services/delayed-report.js";
import { textStats } from "./services/text-stats.js";

const port = Number(process.env["PORT"] ?? "8787");
const origin = process.env["PUBLIC_ORIGIN"] ?? `http://localhost:${port}`;
const payTo = process.env["PAY_TO"];
if (payTo === undefined) throw new Error("set PAY_TO to the public G... address that receives payments");
const agentId = process.env["AGENT_ID"];
const rpcUrl = process.env["SOROBAN_RPC_URL"];

const provider = createProvider({
  baseUrl: origin,
  dev: origin.startsWith("http://localhost"),
  network: (process.env["STELLAR_NETWORK"] ?? "stellar:testnet") as ProviderConfig["network"],
  payTo,
  facilitator: process.env["FACILITATOR_URL"] ?? "https://x402.org/facilitator",
  provider: {
    name: "Stellar Agent Services example",
    description: "Sample provider for Provider Standard v1.",
    dataUse: { storesInputs: false, trainsOnInputs: false },
    ...(agentId === undefined || agentId === "" ? {} : { agentId: Number(agentId) }),
  },
  services: [textStats, delayedReport],
  store: sqliteStore(process.env["JOB_DB_PATH"] ?? "./jobs.sqlite"),
  // Reads the chain to decide payment_uncertain jobs. Testnet defaults to the public RPC; mainnet needs one.
  ...(rpcUrl === undefined || rpcUrl === "" ? {} : { rpc: rpcUrl }),
  // Test-only Job Recovery drill: the job is paid and stored, then the create-job response is lost.
  loseCreateJobResponse: process.env["DRILL_LOSE_RESPONSE"] === "1",
});

// Fails fast if the facilitator can't settle this network, and resumes jobs a restart left behind.
await provider.ready();

const app = new Hono();
app.all("*", (context) => provider.fetch(context.req.raw));

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Provider listening on ${origin}`);
  console.log(`Manifest: ${provider.manifestUrl}`);
  console.log(`payTo:    ${payTo}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => void provider.close().then(() => process.exit(0)));
  });
}
