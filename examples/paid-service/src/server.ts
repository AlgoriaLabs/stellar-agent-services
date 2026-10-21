// Sample provider, built ONLY with the public provider-kit API, so it doubles as the template that
// pilot providers copy. Config comes from .env: public values only, never a secret key.

import { serve } from "@hono/node-server";
import { createProvider } from "@stellar-agent-services/provider-kit";
import { Hono } from "hono";
import { delayedReport } from "./services/delayed-report.js";
import { textStats } from "./services/text-stats.js";

const port = Number(process.env["PORT"] ?? "8787");
const origin = process.env["PUBLIC_ORIGIN"] ?? `http://localhost:${port}`;
const payTo = process.env["PAY_TO"];
if (payTo === undefined) throw new Error("set PAY_TO to the public G... address that receives payments");

const provider = createProvider({
  baseUrl: origin,
  dev: origin.startsWith("http://localhost"),
  network: "stellar:testnet",
  payTo,
  facilitator: process.env["FACILITATOR_URL"] ?? "https://x402.org/facilitator",
  provider: { name: "Stellar Agent Services example", description: "Sample provider for Provider Standard v1." },
  services: [textStats, delayedReport],
  // Test-only Job Recovery drill: the job is paid and stored, then the create-job response is lost.
  loseCreateJobResponse: process.env["DRILL_LOSE_RESPONSE"] === "1",
});

const app = new Hono();
app.all("*", (context) => provider.fetch(context.req.raw));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Provider listening on ${origin}`);
  console.log(`Manifest: ${provider.manifestUrl}`);
  console.log(`payTo:    ${payTo}`);
});
