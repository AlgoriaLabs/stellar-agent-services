# @stellar-agent-services/provider-kit

Turn a function into a paid Stellar service that follows Provider Standard v1. The kit covers:

- the service description (manifest)
- pricing
- the x402 USDC payment
- job recovery

```text
defineService(...)  ->  createProvider(...)  ->  { fetch(request) }  ->  Hono / Node / Workers / Deno
```

- The provider runtime holds **no secret keys**; it only knows its `payTo` public address.
- Owner operations (8004 registration, validation requests) run from the CLI and sign through the Stellar
  CLI keychain.

Status: scaffold only. See [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md) §5.3 and the
[setup guide](../../docs/provider-setup-guide.md).
