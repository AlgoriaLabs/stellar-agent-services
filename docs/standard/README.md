# Provider Standard v1, in short

A shared way for AI services on Stellar to say what they do, get paid in USDC, and deliver results to people and
agents. It works with any programming language.

This page is the short version. The full rules are in [provider-standard.md](../provider-standard.md). If you are
an AI coding agent, read [README-AI.md](README-AI.md) instead.

## Why it exists

AI agents are starting to hire other AI services. Before an agent uses a service, it needs to know what the
service does, what it costs and how to get the result. The person paying needs to know their money is safe.

The standard gives every service the same answers:

- **Service developers** integrate once. Their service can then be found in Stellar Agent Search and paid by any
  agent or wallet that speaks x402.
- **People and agents** see the exact price before paying, and get the promises below.

## How a call works

```
1. Find     Stellar Agent Search finds the service. Its Stellar 8004 registration points to its manifest.
2. Ask      Create a job. The service answers "402: pay this much".
3. Pay      Sign one USDC payment and send the same request again.
4. Get      The result comes back now (200), or later (202: "still working, check back").
5. Recover  Lost the connection? Ask for the same job again. You never pay twice.
```

## What a service publishes

One JSON file, the **manifest**, usually at `/.well-known/stellar-agent-services.json`:

```jsonc
{
  "standard": "stellar-agent-services/provider@1",
  "provider": { "name": "Example Text Tools" },
  "baseUrl": "https://api.example.com/agent",
  "payment": { /* USDC on Stellar, and the address that gets paid */ },
  "services": [
    {
      "name": "text-stats",
      "description": "Counts words, sentences and characters in English text.",
      "price": { "amount": "100000" },          // 0.01 USDC (USDC has 7 decimals)
      "charge": "on-success",                    // pay only if it works
      "expectedDurationSeconds": 2,
      "inputSchema":  { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
      "outputSchema": { "type": "object", "properties": { "words": { "type": "integer" } }, "required": ["words"] },
      "capacity": { "concurrency": 4, "maxQueueWaitSeconds": 60 }
    }
  ]
}
```

Each service is also a ready-made MCP tool, with the same name, description and schemas.

## The promises

| Promise | How |
| --- | --- |
| You see the price first | The price, recipient and network come from the manifest. The wallet checks the payment request against it. |
| You never pay twice | One payment buys one job. Asking again, retrying or recovering never charges again. |
| You never pay for bad input | The service checks the input before it asks for money. |
| You never pay for work that can't start | A busy service says "try again in N seconds" before it asks for money. |
| Failed work can be free | With `on-success`, you pay only when the service returns a valid result. |
| Results don't get lost | Every job has a fixed address. If the connection drops, fetch the job again. |
| No secret keys on servers | The service only knows the address it gets paid to. |

## Two ways to charge

| `charge` | When the user pays | Good for |
| --- | --- | --- |
| `on-success` | After the work, only if it succeeded | Quick work, well under a minute |
| `upfront` | Before the work starts | Long work: video, reports, research |

## When many agents call at once

A service runs a set number of jobs at a time and queues the rest. A queued job shows its place in line and when it
should start. When the queue is full, the service answers `503` with "try again in N seconds" before any payment.
Agents wait and send the same request again. Nothing breaks, and nobody is charged twice.

## How to support it

| Path | For | What you write |
| --- | --- | --- |
| TypeScript library | New services on Node, Workers, Deno or Bun | `defineService(...)` and a handler function |
| Gateway *(coming soon)* | An existing API in any language | A config file |
| Native | Any language | Your own implementation, checked against the JSON Schema and test vectors |

The quickest start is the [example service](../../examples/paid-service), built with the
[Provider Kit](../../packages/provider-kit).

## Get verified

A verifier tests a service and records the result on Stellar, in the 8004 Validation Registry. The badges are
**Standard v1**, **Payment verified** and **Recovery verified**, plus **8004 validated** and **Load-safe**. The
verifier is still being built.

## Learn more

- [Full standard](../provider-standard.md)
- [AI-readable version](README-AI.md)
- [Provider Kit](../../packages/provider-kit/README.md)
- [Payment client and wallet](../../packages/payment-client/README.md)
- [Example service](../../examples/paid-service/README.md)
