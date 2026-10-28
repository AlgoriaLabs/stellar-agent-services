// provider-kit init: writes a starter gateway config with one service that forwards to --upstream.
// It never overwrites a file.

import { writeFile } from "node:fs/promises";
import type { CliFlags } from "./shared.js";

export async function init(flags: CliFlags): Promise<number> {
  const out = flags.out ?? "provider.config.json";
  const config = {
    $schema: "./node_modules/@stellar-agent-services/provider-kit/schemas/gateway-config.schema.json",
    baseUrl: "http://localhost:8787",
    dev: true,
    network: "stellar:testnet",
    payTo: "env:PAY_TO",
    facilitator: "https://x402.org/facilitator",
    provider: {
      name: "My provider",
      description: "What you offer, in a sentence or two.",
      dataUse: { storesInputs: false, trainsOnInputs: false },
    },
    store: "./jobs.sqlite",
    services: [
      {
        name: "my-service",
        title: "My service",
        description: "What it does, when to use it, and its limits (input size, languages, what it won't do).",
        price: "0.01",
        charge: "upfront",
        expectedDurationSeconds: 5,
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", minLength: 1, maxLength: 10000 } },
          additionalProperties: false,
        },
        outputSchema: { type: "object" },
        capacity: { concurrency: 2, maxQueueWaitSeconds: 60 },
        upstream: { url: flags.upstream ?? "http://127.0.0.1:5000/run" },
      },
    ],
  };
  try {
    await writeFile(out, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${out} already exists; nothing was written`);
    throw error;
  }
  console.log(`Wrote ${out}. Next:
  1. Edit the service: name, description, price, schemas and upstream URL.
  2. PAY_TO=G... provider-kit check --config ${out}
  3. PAY_TO=G... provider-kit serve --config ${out}
  4. provider-kit try my-service '{"text":"Hello"}' --config ${out}   (one paid testnet call, from another terminal)
  For production, set baseUrl to your public HTTPS URL and remove "dev".`);
  return 0;
}
