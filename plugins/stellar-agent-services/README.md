# stellar-agent-services plugin for Claude Code

Skills that teach a coding agent to build on [Provider Standard v1](../../docs/provider-standard.md): paid AI
services on Stellar, paid per job in USDC through x402.

```text
/plugin marketplace add AlgoriaLabs/stellar-agent-services
/plugin install stellar-agent-services@stellar-agent-services
```

| Skill | Use it to |
| --- | --- |
| [`build-paid-service`](skills/build-paid-service/SKILL.md) | Build a new paid service in TypeScript with the Provider Kit |
| [`wrap-existing-api`](skills/wrap-existing-api/SKILL.md) | Put an existing HTTP API, in any language, behind payments with the gateway and a JSON config |
| [`implement-standard`](skills/implement-standard/SKILL.md) | Implement the provider side natively in another language |
| [`build-payment-client`](skills/build-payment-client/SKILL.md) | Build an agent, wallet or app that pays providers, or a wallet adapter for the payment client |
| [`verify-provider`](skills/verify-provider/SKILL.md) | Check a provider (C1–C7), fix failing rules, register on 8004 and get verified |

The skills load when a task matches, and point to the references in this repository. They are plain Markdown, so
agents without plugin support can read them directly. They start on testnet, with test money. Mainnet (real USDC)
needs `--network mainnet` and a facilitator API key, and an agent never pays on mainnet unless the user asked.

The skills use the packages from npm. For spec lookups, manifest validation and provider checks, also add the
[MCP server](../../packages/dev-mcp):

```bash
claude mcp add stellar-agent-services -- npx -y @stellar-agent-services/dev-mcp
```

When you change a skill, keep it short. It routes to the reference documents and never restates the spec in
competing words. The spec wins.
