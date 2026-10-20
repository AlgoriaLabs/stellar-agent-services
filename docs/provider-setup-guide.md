# Provider setup guide (draft)

> Status: outline. To be written and tested on a clean machine in Week 2 (SOW Deliverable 2).

1. Prerequisites: a testnet `payTo` account with a USDC trustline, and the Stellar CLI for registration.
2. Choose a path:
   - **Gateway (any language):** you already have an HTTP API. Write a config file with each service's price,
     schemas and upstream URL, then run `provider-kit serve --config <file>` (npx or Docker).
   - **TypeScript library:** install the Provider Kit, define a service with `defineService`, and mount
     `createProvider(...).fetch` on your server.
   - **Native:** implement [provider-standard.md](provider-standard.md) directly.
3. Run locally and check it with `verifier check --dev http://localhost:…`.
4. Make a paid testnet request.
5. Deploy to a public HTTPS origin.
6. Register on Stellar 8004, with the agent wallet set to your `payTo`.
7. Request validation and get your verification receipt and badges.
