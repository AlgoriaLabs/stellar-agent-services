---
name: build-paid-service
description: Build a new paid AI service in TypeScript (Node, Workers, Deno or Bun) that agents and apps pay per call in USDC on Stellar, using the Provider Kit of Provider Standard v1 (x402). Use when the user wants to sell, monetize or charge for a new AI endpoint, model, tool or agent capability written in TypeScript or JavaScript. For an API that already exists, or in another language, use wrap-existing-api instead.
---

# Build a paid service with the Provider Kit

You build a provider: a server that publishes a manifest, answers unpaid requests with an x402 `402` challenge,
takes a USDC payment, runs a job and lets the client recover it without paying again. The Provider Kit does all of
that. You write `defineService(...)` per service and one `createProvider(...)`.

Reference (read it before writing code): `docs/standard/README-AI.md` §2 and `docs/provider-setup-guide.md` §3b–§7
in the repository, or at `https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/<path>`.

## 1. Get the kit

The packages are not on npm. Find a built clone (ask the user where they keep it), or clone one beside the
project with the user's agreement:

```bash
git clone https://github.com/AlgoriaLabs/stellar-agent-services.git
cd stellar-agent-services && npm install && npm run build && REPO=$PWD
```

In the user's project: `npm install "$REPO/packages/provider-kit"`. CLIs:
`alias provider-kit="node $REPO/packages/provider-kit/dist/cli/index.js"` and
`alias verifier="node $REPO/packages/verifier/dist/cli/index.js"`. Node 22.13 or later.

For a new project, the fastest start is the scaffolder:
`node $REPO/packages/create-stellar-service/dist/index.js <folder> --kind typescript --description "<one sentence>"
--price <usdc>`. It writes `src/server.ts`, an example service to replace (`src/services/summarize.ts`), `.env`, a
Dockerfile, `fly.toml` and npm scripts (`dev`, `try`, `check`, `status`, `launch`, `deploy`), packs the kit from the
clone into `vendor/` and installs it. No wallet is needed to build and try it.
`$REPO/examples/paid-service` is a fuller template: two services, SQLite jobs and `.env.example`.

## 2. Write each service

```ts
import { createProvider, defineService, listen, sqliteStore } from "@stellar-agent-services/provider-kit";

export const translate = defineService({
  name: "translate",                        // ^[a-z0-9][a-z0-9_-]{0,63}$
  description: "Translates English text to Turkish. Up to 5,000 characters.",  // for an agent deciding to call it
  price: "0.02",                            // USDC
  charge: "on-success",                     // or "upfront" for long or expensive work
  expectedDurationSeconds: 5,               // on-success: at most half of maxTimeoutSeconds (default 60)
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 5000 } }, additionalProperties: false },
  outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  examples: [{ input: { text: "Hello" }, output: { text: "Merhaba" } }],
  handler: async ({ text }, { signal, jobId }) => ({ text: await translateText(text, { signal }) }),
});
```

- **Description:** what it does, when to use it, its limits. No price, URLs or instructions to the agent.
- **Charge:** `on-success` charges only if the handler succeeds, for work under half a minute. `upfront` charges
  first, for long work. An `upfront` job whose worker died runs again, so make side effects idempotent with `jobId`.
- **Schemas:** JSON Schema 2020-12, root `"type": "object"`, no remote `$ref`. Bound every string and array.
- **Handler:** gets only the validated input and `{ signal, jobId }`, never payment data. Stop when `signal`
  aborts. Throw to fail the job. Error messages never reach the client.
- **Capacity:** set `capacity.concurrency` to what the GPU, pool or upstream quota takes. When the queue is full,
  the kit answers `503` before payment.

## 3. Create the provider

```ts
const origin = process.env.PUBLIC_ORIGIN ?? "http://localhost:8787";   // https in production
const provider = createProvider({
  baseUrl: origin,
  dev: origin.startsWith("http://localhost"),                       // accepts http:// only on localhost
  network: "stellar:testnet",
  payTo: process.env.PAY_TO!,               // public G... address with a USDC trustline. Never a secret key.
  facilitator: "https://x402.org/facilitator",
  provider: { name: "Example provider" },
  services: [translate],
  store: sqliteStore(process.env.JOB_DB_PATH ?? "./jobs.sqlite"),  // never the default memory store in production
});
await provider.ready();
await listen(provider, { port: 8787 });     // or mount provider.fetch on Hono, Workers, Deno, Bun
```

`createProvider()` throws at startup, listing every problem, if the manifest would fail the standard. Fix the
config. Don't work around the check.

## 4. Check it

Run it with `npm run dev` (`provider-kit dev -- node dist/server.js`). With `PAY_TO` empty, `dev` makes a throwaway
testnet account to be paid to and saves its public address in `.env`, so no wallet is needed yet.

1. `provider-kit check --manifest http://localhost:8787/.well-known/stellar-agent-services.json --dev`. Before
   launch it notes that the provider isn't registered yet; that doesn't fail it.
2. `verifier check http://localhost:8787/.well-known/stellar-agent-services.json --dev`. C1, C3, C6 and C7 must pass.
3. Ask the user before paying: it spends test money only, but it is a payment. Once they agree, run
   `provider-kit try translate '{"text":"Hello"}' --manifest http://localhost:8787/.well-known/stellar-agent-services.json --yes --json`.
   It pays from a throwaway testnet account it funds itself, so the user needs no payer wallet, and reports the result
   and the transfer on chain. Without `--yes` it asks in the terminal, which you can't answer.

`provider-kit status --json` shows where the provider stands and the next command, at any point.

## 5. Go live

`npm run launch` (`provider-kit launch --start 'node dist/server.js'`, with `--url <https origin>` when there is no
`fly.toml`) does `docs/provider-setup-guide.md` §7: it builds the manifest the public address will serve, then opens
one approval page where the user's own wallet signs the USDC trustline, the 8004 registration and a validation
request. It saves `PAY_TO` and `AGENT_ID`, and with `--deploy` deploys to Fly.io and waits for the public manifest.
Ask the user first, run it with `--no-open`, give them the link, and say what they will approve. Then
`provider-kit status --json`. In CI, `register` and `request-validation` take `--source <key>` instead.

## Never

- Put a Stellar secret key in code, config or environment. The provider knows only `payTo`.
- Ask the user for a secret key or seed phrase. Their wallet signs, on the page `provider-kit` opens.
- Add manifest fields, headers or error codes. Extra data goes in `extensions` with reverse-DNS keys `[X1]`.
- Hand-write job, payment or recovery logic next to the kit.
- Mark an uncertain payment `failed`, or charge again `[J13]`.
