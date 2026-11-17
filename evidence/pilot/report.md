# Independent provider pilot report

The pilot records **two independent providers** with confirmed mainnet payments and **three completed buyer
runs**. X Strategy Agent’s developer ran U1, U2 was an independent buyer, and a third pilot user (U3) used
Claude’s assistance and personally approved payments to both providers. Feedback is recorded from both
providers and the first two buyer runs. [Participant feedback](feedback.md) ·
[D3 screenshots and payment evidence](https://algorialabs.github.io/stellar-agent-services/#pilot-screenshots).

## Accepted scope

- **D3 scope:** Two independent providers, at least one paid call per provider, two completed user flows,
  and public evidence of the pilot findings and fixes. [Current SOW](https://docs.google.com/document/d/1kIJ5nkwIVaXqHqcNHwuI5JN0Ap6g86wzncMQya6Kv88/edit).
- **Pilot dates and network:** The recorded buyer runs took place on 16–17 November 2026 on Stellar mainnet.
  The SOW leaves the sprint start date blank.
- **Participants:** X Strategy Agent (76) and Meeting Action Extractor (77) each received a confirmed USDC payment.
  U2 and U3 completed buyer flows. U1 is the service operator's additional buyer run.
- **Recovery:** The D2 testnet reference sample provides the Job Recovery demonstration and single-payment proof.
  [D2 recovery video and transaction](https://algorialabs.github.io/stellar-agent-services/#recovery).
- **Public evidence:** Provider links, payment references, screenshots and pilot findings are published.
  [D3 evidence page](https://algorialabs.github.io/stellar-agent-services/#pilot).

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
| U1 · Service operator | 2026-11-16 UTC | P1 / `x-strategy` | Client fetched the manifest. | [Written approval and job result](../mainnet/x-strategy.md#buyer-flow), [payer setup and funding](../mainnet/x-strategy.md#setup-and-payment-transactions), [confirmed 0.10 USDC payment](https://stellar.expert/explorer/public/tx/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042) | 22-page PDF delivery reported. [Buyer feedback](feedback.md#buyer-experience-u1). |
| U2 · Independent buyer | 2026-11-17 UTC | P2 / `meeting-actions` | Live provider manifest linked. | [Written quote, approval and job result](../mainnet/meeting-actions.md#independent-pilot-user-u2), [payer trustline and USDC purchase](https://stellar.expert/explorer/public/tx/c08f9621532f9e10fe59ad5a8b74608280cf99ae3a87dacfa51a4cb5dcf429b4), [confirmed 0.01 USDC payment](https://stellar.expert/explorer/public/tx/a3bddc48cf8ef9b18dae8a77b1f84559488ed12d47454dd2c52290609f3e58f9) | Reported successful delivery of three action items, three decisions and a summary. [Buyer feedback](feedback.md#buyer-experience-u2). |
| U3 · Third pilot user | 2026-11-17 UTC | P2 / `meeting-actions`, P1 / `x-strategy` | [Search and manifest captures for both services](claude-buyer-run/README.md#steps-and-screenshots) | [Approval, results and both mainnet payments](claude-buyer-run/README.md#summary) | Claude assisted. The participant approved both payments. Both jobs succeeded. Horizon confirmed both transfers. |

For U1 the payout and payer wallets had a common funder, and the run identifies the buyer as the service operator.
The project owner identified U2 as an independent participant and funded U2’s buyer wallet for the pilot.
The project owner confirmed that a different pilot user ran U3 and approved both payments. The
[U3 ledger record](claude-buyer-run/data/04-ledger.json)
shows one 0.01 USDC debit and one 0.10 USDC debit through the end of the run.

## Recovery

The Job Recovery demo comes from D2. The Stellar testnet recording shows the wallet recovering the same job’s
stored result after a lost response. The ledger proof shows one matching 0.02 test USDC transfer in the recorded
scan window. [D2 recording, job ID and payment proof](../d2/README.md#captured-recovery-evidence).

## Findings and fixes

Both providers praised offline payment tests and local-wallet launch. U1 and U2 reported that the payment
client worked on the first attempt and the job charged once. Participant notes also identify where they
needed workarounds. [Full role-by-role feedback](feedback.md).

| Finding | Workaround or outcome during the pilot | Participant suggestion |
| --- | --- | --- |
| npm 0.1.1 lacked local-wallet launch and the documented OpenAPI and llms.txt endpoints (P1, P2). | Both providers packed Kit tarballs from a checkout. The [0.1.2 release](https://github.com/AlgoriaLabs/stellar-agent-services/releases/tag/v0.1.2) shipped all six npm packages. A fresh install confirmed the flag and HTTP 200 responses from both routes. | Publish a release that matches the docs. |
| Mainnet buyer wallet setup took more effort than the payment itself (U1, U2). | Both used custom payer scripts to set up wallets and buy USDC. Both paid jobs succeeded. | Add a mainnet buyer flow with wallet setup, funding, reserve guidance and closure. |
| Deploying to Oracle required separate VM scripts (P1, P2). | Both deployed with custom scripts. P2 reported an initial permissions and archive issue. | Add a VM deployment template with systemd, Caddy and rollback. |
| Mainnet verifier discovery and registry rent impeded validation (P1, P2). | P2 launched with `--no-validation`. Both agents registered in the Identity Registry. | Publish a default validator. P2 also proposed a way to use a confirmed payment as C4 evidence. |
| Look-alike accounts sent dust after funding (U1, U2). | Both buyers reported the activity during wallet setup. | Surface suspicious transfers and require explicit entry of the return address. |
| Provider development and buyer tooling had case-specific friction. | P2 used a scratch copy for `dev`; P1 used a wrapper for PDF routes and received a 429 after C7. U2 reported one transient Horizon failure before submission. | Improve dev configuration isolation, route documentation, discovery, and file-based buyer input. See the [full feedback](feedback.md) for the remaining proposals. |

U3 reached both providers with Stellar Agent Search, though both ranked last for the successful queries. The
payment client could not confirm the X Strategy transfer because its RPC lookup failed. An independent
Horizon check confirmed a single settlement. [U3 observations](claude-buyer-run/README.md#findings).

## Incentives and acceptance

The project owner provided login credentials for his Oracle Cloud VM to both independent providers so
they could deploy their own services directly and at no hosting cost. He also funded both providers’
Stellar wallets as a pilot incentive. Both developers used the shared VM for their separately built
services. Written confirmation from each provider is pending on who administers the server, deploys
the service and controls its payout wallet.

The [public D3 evidence page](https://algorialabs.github.io/stellar-agent-services/#pilot) links both provider
projects, their payment references, the U3 screenshots, and this report for SOW §6.1.
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
