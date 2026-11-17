# Independent provider pilot report

Status: **one independent provider** and **one recorded pilot user flow**. The supplied run identifies the
buyer as the service operator. Separate user participation and Chapter Lead acceptance are pending.

## Accepted scope

- Sprint start/end: not confirmed.
- Chapter Lead agreement on provider/user counts: not recorded.
- Testnet evidence acceptance: not recorded.
- Tested commit/package versions and dates: not recorded.
- Public sample demo and evidence page: [published](https://algorialabs.github.io/stellar-agent-services/).
  The reference sample is separate from the X Strategy Agent pilot evidence below.

## Recorded mainnet provider and buyer flow

Murat’s X Strategy Agent is the first independent provider in the pilot. The project owner confirmed that
Murat controls the provider deployment and payout wallet. The service registered as Stellar mainnet agent
**76** on 2026-11-16 and received **0.10 USDC** for a job. The written run record includes the approval terms,
job ID and digest of the reported 22-page PDF. [Provider and user evidence](../mainnet/x-strategy.md).

## Providers

| Provider | Independent? | Service and integration path | Manifest / agent id | Receipt / validation | Paid call / ledger / explorer |
| --- | --- | --- | --- | --- | --- |
| Sample | No | TypeScript kit: text statistics and delayed report | [Manifest](https://sas-testnet.79-76-99-174.sslip.io/.well-known/stellar-agent-services.json), testnet agent 163 | [Receipt and registry](../validation/README.md) | [Testnet transfer proofs](../d2/oracle-payments.json) |
| P1 · Murat | Yes, confirmed by the project owner | [X Strategy Agent](https://github.com/MuratCaganGogebakan/marketing-agent-service), TypeScript Provider Kit | [Manifest](https://x-strategy.92-5-73-99.sslip.io/.well-known/stellar-agent-services.json), [mainnet agent 76 registration](https://stellar.expert/explorer/public/tx/80d50587c8ac6b8176b52f828d8026980c9db3efed77b71ba46a10d4247a91b0) | Reported unpaid verifier checks passed. Receipt and Validation Registry response not recorded. | [0.10 USDC, ledger 65509203](https://stellar.expert/explorer/public/tx/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042) |
| P2 | Not confirmed | Not recorded | Not recorded | Not recorded | Not recorded |

Add provider rows if the agreed scope requires them. Record clean-setup duration, assistance and blockers for each.

## Users

| User alias | Date | Provider / service | Discovery evidence | Approval / payment / result | Assistance and outcome |
| --- | --- | --- | --- | --- | --- |
| U1 · Service operator | 2026-11-16 UTC | P1 / `x-strategy` | Client fetched the manifest. Search capture unavailable. | [Written approval and job result](../mainnet/x-strategy.md#buyer-flow), [payer setup and funding](../mainnet/x-strategy.md#setup-and-payment-transactions), [confirmed 0.10 USDC payment](https://stellar.expert/explorer/public/tx/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042) | 22-page PDF delivery reported. No feedback or separate buyer identity recorded. |
| U2 | Not run | — | — | — | — |
| U3 | Not run | — | — | — | — |
| U4 | Not run | — | — | — | — |
| U5 | Not run | — | — | — | — |

The ledger verifies separate payout and payer wallets, their common funder and the single USDC transfer.
Wallet activity alone cannot identify who used the payer wallet.

## Recovery

User, provider, job id, interruption, recovery steps, video, result, and proof of exactly one transfer: not collected.

## Findings and fixes

| Observation | Impact | Fix / issue link | Retest and evidence |
| --- | --- | --- | --- |
| No observations yet | — | — | — |

## Incentives and acceptance

Provider/user incentives agreed and distributed: not recorded. Report totals without private payment details.

SOW §6.1 evidence is linked on the [public evidence page](https://algorialabs.github.io/stellar-agent-services/#x-strategy).
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
