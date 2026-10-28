# Example paid service

A sample provider built only with `@stellar-agent-services/provider-kit`. Pilot providers can copy it as
their template.

| Service | Charge | Price | Purpose |
| --- | --- | --- | --- |
| `text-stats` | on-success | 0.01 USDC | The basic paid call: finishes at once, failed work is never charged |
| `delayed-report` | upfront | 0.02 USDC | The Job Recovery demo: answers `202`, then check-status and get-result. Also the capacity demo: 2 at a time, up to 8 queued, then `503` before payment. |

Jobs are kept in SQLite (`JOB_DB_PATH`, default `./jobs.sqlite`), so a paid job survives a restart: stop the
server while a report is queued, start it again, and the report runs.

Run it with `PAY_TO=G... npm start` in this directory, after `npm install && npm run build` at the repository
root. `.env.example` lists the settings; they are public values only. Then `npx provider-kit try text-stats`, from
another terminal, pays for one job on testnet from a throwaway account and shows the result (`try delayed-report`
shows a job that answers 202 and is polled). See
[packages/payment-client](../../packages/payment-client/README.md) for a full testnet walkthrough, and the
[setup guide](../../docs/provider-setup-guide.md) for building your own provider from this template.

Providers with an existing API in another language don't need this template. They can use the kit's gateway
mode instead: see [examples/python-upstream](../python-upstream).
