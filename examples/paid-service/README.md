# Example paid service

A sample provider built only with `@stellar-agent-services/provider-kit`. Pilot providers can copy it as
their template.

| Service | Charge | Price | Purpose |
| --- | --- | --- | --- |
| `text-stats` | on-success | 0.01 USDC | The basic paid call: finishes at once, failed work is never charged |
| `delayed-report` | upfront | 0.02 USDC | The Job Recovery demo: answers `202`, then check-status and get-result. Also the capacity demo: 2 at a time, up to 8 queued, then `503` before payment. |

Jobs are kept in SQLite (`JOB_DB_PATH`, default `./jobs.sqlite`), so a paid job survives a restart: stop the
server while a report is queued, start it again, and the report runs.

Set `HOST=127.0.0.1` when a reverse proxy on the same server supplies HTTPS. The default is `0.0.0.0`, which also
works inside a container. [The Oracle testnet deployment](../../deploy/d2/oracle/README.md) uses loopback and
a separate persistent job store beside an existing mainnet service.

`text-stats` admits one on-success job at a time and refuses excess work before payment [Q2], [Q3]. This is
deliberately conservative for the shared testnet facilitator. A live verification run at the former default of
four concurrent jobs encountered settlement errors; its receipt is retained in
[the verification evidence](../../evidence/receipts/README.md).

Run it with `npx provider-kit dev -- npm start` in this directory, after `npm install && npm run build` at the
repository root: with `PAY_TO` empty, `dev` makes a throwaway testnet account to be paid to, so you need no wallet yet
(or run `PAY_TO=G... npm start` with an account of yours). `.env.example` lists the settings; they are public values
only. Then `npx provider-kit try text-stats`, from
another terminal, pays for one job on testnet from a throwaway account and shows the result (`try delayed-report`
shows a job that answers 202 and is polled). See
[packages/payment-client](../../packages/payment-client/README.md) for a full testnet walkthrough, and the
[setup guide](../../docs/provider-setup-guide.md) for building your own provider from this template.

Providers with an existing API in another language don't need this template. They can use the kit's gateway
mode instead: see [examples/python-upstream](../python-upstream).
