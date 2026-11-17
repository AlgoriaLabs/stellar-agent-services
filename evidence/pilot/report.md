# Independent provider pilot report

Status: **two independent providers** with confirmed mainnet payments, and **two recorded user flows**.
U1 was run by the service operator. U2 is the first independent pilot user identified by the project owner.
Discovery and approval captures, user feedback and Chapter Lead acceptance are pending.

## Accepted scope

- Sprint start/end: not confirmed.
- Chapter Lead agreement on provider/user counts: not recorded.
- Testnet evidence acceptance: not recorded.
- Tested commit/package versions and dates: not recorded.
- Public sample demo and evidence page: [published](https://algorialabs.github.io/stellar-agent-services/).
  The reference sample is separate from the two independent provider integrations below.

## Recorded mainnet provider and buyer flow

Murat’s X Strategy Agent is the first independent provider in the pilot. The project owner confirmed that
Murat controls the provider deployment and payout wallet. The service registered as Stellar mainnet agent
**76** on 2026-11-16 and received **0.10 USDC** for a job. The written run record includes the approval terms,
job ID and digest of the reported 22-page PDF. [Provider and user evidence](../mainnet/x-strategy.md).

The second independent provider, Meeting Action Extractor, registered as mainnet agent **77** on 2026-11-17.
An independent buyer paid **0.01 USDC** and reported receiving three action items, three decisions and a
summary. The proof includes the provider repository, live manifest, registration, payer funding and confirmed
transfer. [Provider and user evidence](../mainnet/meeting-actions.md).

## Providers

| Provider | Independent? | Service and integration path | Manifest / agent id | Receipt / validation | Paid call / ledger / explorer |
| --- | --- | --- | --- | --- | --- |
| Sample | No | TypeScript kit: text statistics and delayed report | [Manifest](https://sas-testnet.79-76-99-174.sslip.io/.well-known/stellar-agent-services.json), testnet agent 163 | [Receipt and registry](../validation/README.md) | [Testnet transfer proofs](../d2/oracle-payments.json) |
| P1 · Murat | Yes, confirmed by the project owner | [X Strategy Agent](https://github.com/MuratCaganGogebakan/marketing-agent-service), TypeScript Provider Kit | [Manifest](https://x-strategy.92-5-73-99.sslip.io/.well-known/stellar-agent-services.json), [mainnet agent 76 registration](https://stellar.expert/explorer/public/tx/80d50587c8ac6b8176b52f828d8026980c9db3efed77b71ba46a10d4247a91b0) | Reported unpaid verifier checks passed. Receipt and Validation Registry response not recorded. | [0.10 USDC, ledger 65509203](https://stellar.expert/explorer/public/tx/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042) |
| P2 · atknalkan | Yes, identified by the project owner | [Meeting Action Extractor](https://github.com/atknalkan/meeting-action-extractor), TypeScript Provider Kit | [Manifest](https://meeting-actions.92-5-73-99.sslip.io/.well-known/stellar-agent-services.json), [mainnet agent 77 registration](https://stellar.expert/explorer/public/tx/38e44819d7d7fbb7837acd4c75b22a1790d6e74a14b2a8e80fda85f5fbcf9e58) | Live Provider Kit check passed. Unpaid verifier checks reported. Receipt and Validation Registry response pending. | [0.01 USDC, ledger 65525757](https://stellar.expert/explorer/public/tx/a3bddc48cf8ef9b18dae8a77b1f84559488ed12d47454dd2c52290609f3e58f9) |

Add provider rows if the agreed scope requires them. Record clean-setup duration, assistance and blockers for each.

## Users

| User alias | Date | Provider / service | Discovery evidence | Approval / payment / result | Assistance and outcome |
| --- | --- | --- | --- | --- | --- |
| U1 · Service operator | 2026-11-16 UTC | P1 / `x-strategy` | Client fetched the manifest. Search capture unavailable. | [Written approval and job result](../mainnet/x-strategy.md#buyer-flow), [payer setup and funding](../mainnet/x-strategy.md#setup-and-payment-transactions), [confirmed 0.10 USDC payment](https://stellar.expert/explorer/public/tx/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042) | 22-page PDF delivery reported. No feedback or separate buyer identity recorded. |
| U2 · Independent buyer | 2026-11-17 UTC | P2 / `meeting-actions` | Live provider manifest linked. Search capture unavailable. | [Written quote, approval and job result](../mainnet/meeting-actions.md#independent-pilot-user-u2), [payer trustline and USDC purchase](https://stellar.expert/explorer/public/tx/c08f9621532f9e10fe59ad5a8b74608280cf99ae3a87dacfa51a4cb5dcf429b4), [confirmed 0.01 USDC payment](https://stellar.expert/explorer/public/tx/a3bddc48cf8ef9b18dae8a77b1f84559488ed12d47454dd2c52290609f3e58f9) | Reported successful delivery of three action items, three decisions and a summary. Feedback pending. |
| U3 | Not run | — | — | — | — |
| U4 | Not run | — | — | — | — |
| U5 | Not run | — | — | — | — |

For U1 the payout and payer wallets had a common funder, and the run identifies the buyer as the service operator.
For U2 the project owner identified the buyer as an independent participant. The ledger verifies each payer's
wallet and USDC transfer.

## Recovery

User, provider, job id, interruption, recovery steps, video, result, and proof of exactly one transfer: not collected.

## Findings and fixes

| Observation | Impact | Fix / issue link | Retest and evidence |
| --- | --- | --- | --- |
| No observations yet | — | — | — |

## Incentives and acceptance

Provider/user incentives agreed and distributed: not recorded. Report totals without private payment details.

SOW §6.1 evidence is linked on the public evidence page for
[X Strategy Agent](https://algorialabs.github.io/stellar-agent-services/#x-strategy) and
[Meeting Action Extractor](https://algorialabs.github.io/stellar-agent-services/#meeting-actions).
Chapter Lead review and acceptance are pending.

## Engineering preparation outside the independent pilot

The sample is deployed on the existing Oracle A1 VM. Its registered-provider run passed C1–C7 at level 3,
score 100. The validator is operated for this project and does not establish provider independence.

A separate Linux client workspace reproduced npm 0.1.0 returning `payment_uncertain`. The original job later
reconciled to its original transfer. With the unreleased bounded polling fix, a new client call succeeded and
confirmed its own payment without a second signature. Both outcomes and independent transfer proofs are in
[the clean-client record](../d2/oracle-clean-client.json). This engineering run predates the participant
evidence above.

[Invitation drafts](invitation-drafts.md) are available for the remaining recruitment.
