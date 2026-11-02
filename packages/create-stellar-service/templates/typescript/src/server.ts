// {{name}}: a paid service on Stellar, built with the Provider Kit (Provider Standard v1).
//
// Settings come from .env, public values only: this service never needs a Stellar secret key. Paid jobs are kept
// in SQLite (JOB_DB_PATH), so they survive a restart, and a client that lost its response can still collect the
// result. Add services in src/services/ and list them below. `npm run launch` starts this file with PUBLIC_ORIGIN set
// to the public address, to read the manifest it will serve there.

import { createProvider, listen, sqliteStore, type ProviderConfig } from "@stellar-agent-services/provider-kit";
import { summarize } from "./services/summarize.js";

const port = Number(process.env["PORT"] ?? "8787");
const origin = process.env["PUBLIC_ORIGIN"] ?? `http://localhost:${port}`;
const payTo = process.env["PAY_TO"];
if (!payTo) throw new Error("PAY_TO is empty: npm run dev makes a throwaway testnet account to be paid to, and npm run launch sets up your own wallet.");
const agentId = process.env["AGENT_ID"];
const rpcUrl = process.env["SOROBAN_RPC_URL"];

const provider = createProvider({
  baseUrl: origin,
  dev: origin.startsWith("http://localhost"),
  network: (process.env["STELLAR_NETWORK"] ?? "stellar:testnet") as ProviderConfig["network"],
  payTo,
  facilitator: process.env["FACILITATOR_URL"] ?? "https://x402.org/facilitator",
  // Search matches only this name and description: use the words buyers type.
  provider: {
    name: {{nameJson}},
    description: {{descriptionJson}},
    dataUse: { storesInputs: false, trainsOnInputs: false },
    ...(agentId ? { agentId: Number(agentId) } : {}),
  },
  services: [summarize],
  store: sqliteStore(process.env["JOB_DB_PATH"] ?? "./jobs.sqlite"),
  // Decides payment_uncertain jobs from the chain. Testnet defaults to the public RPC; mainnet needs one.
  ...(rpcUrl ? { rpc: rpcUrl } : {}),
});

// Fails fast if the facilitator can't settle this network, and resumes jobs a restart left behind.
await provider.ready();
const server = await listen(provider, { port });
console.log(`Listening on ${origin}`);
console.log(`Manifest: ${provider.manifestUrl}`);
console.log(`payTo:    ${payTo}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
