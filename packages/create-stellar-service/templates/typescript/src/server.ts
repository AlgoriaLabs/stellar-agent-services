// {{name}}: a paid service on Stellar, built with the Provider Kit (Provider Standard v1).
//
// Settings come from .env: public values, and on mainnet the facilitator's API key. This service never needs a Stellar
// secret key. Paid jobs are kept in SQLite (JOB_DB_PATH), so they survive a restart, and a client that lost its
// response can still collect the result. Add services in src/services/ and list them below. `npm run launch` starts
// this file with PUBLIC_ORIGIN set to the public address, to read the manifest it will serve there.

import { createProvider, httpFacilitator, listen, sqliteStore, type ProviderConfig } from "@stellar-agent-services/provider-kit";
import { summarize } from "./services/summarize.js";

const port = Number(process.env["PORT"] ?? "8787");
const origin = process.env["PUBLIC_ORIGIN"] ?? `http://localhost:${port}`;
const dev = origin.startsWith("http://localhost");
// stellar:testnet takes test money; stellar:pubnet is mainnet, real USDC.
const network = (process.env["STELLAR_NETWORK"] ?? "stellar:testnet") as ProviderConfig["network"];
const payTo = process.env["PAY_TO"];
if (!payTo) throw new Error(`PAY_TO is empty: npm run launch sets up your own wallet${network === "stellar:testnet" ? ", and npm run dev makes a throwaway testnet account meanwhile" : ""}.`);
const agentId = process.env["AGENT_ID"];
const rpcUrl = process.env["SOROBAN_RPC_URL"];

// The facilitator verifies and settles payments: x402.org's on testnet, OpenZeppelin's on mainnet, which wants an API
// key. FACILITATOR_AUTH is sent as the Authorization header: "Bearer <key>".
const facilitatorUrl = process.env["FACILITATOR_URL"] ?? (network === "stellar:pubnet" ? "https://channels.openzeppelin.com/x402" : "https://x402.org/facilitator");
const facilitatorAuth = process.env["FACILITATOR_AUTH"];
if (network === "stellar:pubnet" && !facilitatorAuth && !process.env["FACILITATOR_URL"]) {
  throw new Error('FACILITATOR_AUTH is empty: get an API key at https://channels.openzeppelin.com/gen, and set FACILITATOR_AUTH="Bearer <key>" in .env.');
}

const provider = createProvider({
  baseUrl: origin,
  dev,
  network,
  payTo,
  facilitator: httpFacilitator(facilitatorUrl, { dev, ...(facilitatorAuth ? { headers: { Authorization: facilitatorAuth } } : {}) }),
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
