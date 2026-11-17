# Meeting Action Extractor pilot evidence

On **17 November 2026 (UTC)**, Meeting Action Extractor registered as Stellar 8004 agent **77** on mainnet
(`stellar:pubnet`). An independent pilot user paid **0.01 USDC** for a transcript to be converted into
structured meeting notes. The project owner identified the provider and buyer as independent for the pilot.
The ledger verifies the transfer between their wallets.

## Provider P2

`atknalkan` built the service with the TypeScript Provider Kit and Provider Standard v1. It returns JSON
with tasks, owners, due dates, priorities and supporting quotes, plus decisions and a summary. The
`meeting-actions` service charges 0.01 USDC per successful job via x402 v2 `exact`.
[Provider source](https://github.com/atknalkan/meeting-action-extractor).

- [Live manifest](https://meeting-actions.92-5-73-99.sslip.io/.well-known/stellar-agent-services.json) ·
  [OpenAPI](https://meeting-actions.92-5-73-99.sslip.io/openapi.json) ·
  [llms.txt](https://meeting-actions.92-5-73-99.sslip.io/llms.txt).
- [8004 registration at ledger 65525603](https://stellar.expert/explorer/public/tx/38e44819d7d7fbb7837acd4c75b22a1790d6e74a14b2a8e80fda85f5fbcf9e58) ·
  [Provider wallet and payTo](https://stellar.expert/explorer/public/account/GDZ2Z5TMBSI3EBBMMYXAXXNVHN4THI6VTIEVBHMBAJ7TPJGTRACQZFW6).
- A read-only Provider Kit check on 2026-11-17 verified the payout wallet's USDC trustline, the mainnet
  registration and its match to the live manifest URL and `payTo` [I1]–[I3].
- The provider reported passing unpaid verifier checks C1, C2, C3, C6 and C7, plus seven offline tests
  including payment and result delivery. No paid verifier results (C4/C5), verification badges, Validation
  Registry response or interrupted-job recovery run were supplied for this case.

The provider reported using Gemini Flash-Lite, a shared Oracle Cloud VM with systemd and Caddy,
and SQLite for persisted jobs. The service uses a public payout address.

## Independent pilot user U2

The project owner confirmed that he funded U2’s buyer wallet for the pilot.

The written run reports that the user reviewed a **0.01 USDC** mainnet quote in
`@stellar-agent-services/payment-client`, applied the same spending limit, signed once and received an
on-chain confirmation. The request went to `POST /services/meeting-actions/jobs`.

- **Job ID:** `cecb7bf4-814b-46b6-8eff-22557d404d81`.
- **Reported result:** `status: succeeded`, `charged: true`. Three action items with owners, three decisions
  and a summary. The output resolved “by Friday” to 2026-11-20 and “on Monday” to 2026-11-23.
- **Verified settlement:** At **11:27:07 UTC**, ledger **65525757**, Horizon recorded one debit of **0.01 USDC**
  from `GBMC37IPXEPO36DXH6TVNSFVNUAR5CGW5J2JWNFCBJVZHOEJWYPSG3IY` and one matching credit to
  `GDZ2Z5TMBSI3EBBMMYXAXXNVHN4THI6VTIEVBHMBAJ7TPJGTRACQZFW6`. The payer's Horizon history showed one
  USDC debit at the time of review. The supplied run attributes settlement to OpenZeppelin's facilitator.
  [Payment transaction](https://stellar.expert/explorer/public/tx/a3bddc48cf8ef9b18dae8a77b1f84559488ed12d47454dd2c52290609f3e58f9) ·
  [Horizon effects](https://horizon.stellar.org/transactions/a3bddc48cf8ef9b18dae8a77b1f84559488ed12d47454dd2c52290609f3e58f9/effects).

The supplied user evidence includes a written run record, transaction references and participant feedback.
[Provider and buyer feedback](../pilot/feedback.md#meeting-action-extractor).

## Transaction timeline

| Network | Time (UTC) | Operation | Ledger and explorer |
| --- | --- | --- | --- |
| Testnet | 11:10:11 | Rehearsal paid 0.01 test USDC from a throwaway payer through the x402.org facilitator | [5778033](https://stellar.expert/explorer/testnet/tx/2eac0b8f8a99cf098f67323196e94e7ee7aac067f0dae12154996744fa8514bb) |
| Mainnet | 11:14:12 | Payout wallet added its USDC trustline | [65525602](https://stellar.expert/explorer/public/tx/1104ff8969ad75e2db2b358673edcdf42e0a2a2f07ccd9788a34ad61ef36d1a1) |
| Mainnet | 11:14:17 | Register agent 77 in the 8004 Identity Registry | [65525603](https://stellar.expert/explorer/public/tx/38e44819d7d7fbb7837acd4c75b22a1790d6e74a14b2a8e80fda85f5fbcf9e58) |
| Mainnet | 11:25:37 | Buyer added its USDC trustline and exchanged 0.07226 XLM for 0.01 USDC | [65525739](https://stellar.expert/explorer/public/tx/c08f9621532f9e10fe59ad5a8b74608280cf99ae3a87dacfa51a4cb5dcf429b4) |
| Mainnet | 11:27:07 | Settle the buyer's 0.01 USDC payment to agent 77's payout wallet | [65525757](https://stellar.expert/explorer/public/tx/a3bddc48cf8ef9b18dae8a77b1f84559488ed12d47454dd2c52290609f3e58f9) |

[D3 pilot report](../pilot/report.md).
