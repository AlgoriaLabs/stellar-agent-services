# Provider setup guide (draft)

> Status: outline. To be written and tested on a clean machine in Week 2 (SOW Deliverable 2).

1. Prerequisites: a testnet `payTo` account with a USDC trustline, and the Stellar CLI for registration.
2. Choose a path:
   - **Gateway (any language):** you already have an HTTP API. Write a config file with each service's price,
     schemas and upstream URL, then run `provider-kit serve --config <file>` (npx or Docker).
   - **TypeScript library:** install the Provider Kit, define a service with `defineService`, and mount
     `createProvider(...).fetch` on your server.
   - **Native:** implement [provider-standard.md](provider-standard.md) directly.
3. Set each service's capacity: how many jobs one instance runs at once (`concurrency`) and how long a new job
   may wait (`maxQueueWaitSeconds`). Under load the kit queues jobs and answers `503` with `Retry-After` before
   payment, so a busy service never fails or charges for work it can't do. See
   [Capacity and load](../packages/provider-kit/README.md#capacity-and-load) and spec §5.8. A native
   implementation follows rules Q1–Q9.
4. Run locally and check it with `verifier check --dev http://localhost:…`. Check C7 sends a burst of requests.
5. Make a paid testnet request.
6. Deploy to a public HTTPS origin.
7. Register on Stellar 8004, with the agent wallet set to your `payTo`.
8. Request validation and get your verification receipt and badges.
