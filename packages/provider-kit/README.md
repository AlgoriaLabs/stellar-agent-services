# @stellar-agent-services/provider-kit

Turn a function, or an existing HTTP API in any language, into a paid Stellar service that follows Provider
Standard v1. The kit covers:

- the service description (manifest)
- pricing
- the x402 USDC payment
- job recovery

Two ways to use it:

```text
library:  defineService(...)  ->  createProvider(...)  ->  { fetch(request) }  ->  Hono / Node / Workers / Deno / Bun
gateway:  provider-kit serve --config <file>  ->  forwards paid jobs to your existing API (also as a Docker image)
```

- The provider runtime holds **no Stellar secret keys**; it only knows its `payTo` public address.
- Owner operations (8004 registration, validation requests) run from the CLI and sign through the Stellar
  CLI keychain.

Status: scaffold only. See [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md) §5.3 and the
[setup guide](../../docs/provider-setup-guide.md).
