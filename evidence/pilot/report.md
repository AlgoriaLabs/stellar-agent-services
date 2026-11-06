# Independent provider pilot report

Status: template, not a completed pilot report. Do not count placeholder rows as participants or integrations.

## Accepted scope

- Sprint start/end: not confirmed.
- Chapter Lead agreement on provider/user counts: not recorded.
- Testnet evidence acceptance: not recorded.
- Tested commit/package versions and dates: not recorded.
- Public sample demo and evidence page: [published](https://algorialabs.github.io/stellar-agent-services/).
  This is sample engineering evidence; no independent participant flow is claimed.

## Providers

| Provider | Independent? | Service and integration path | Manifest / agent id | Receipt / validation | Paid call / ledger / explorer |
| --- | --- | --- | --- | --- | --- |
| Sample | No | TypeScript kit: text statistics and delayed report | [Manifest](https://sas-testnet.79-76-99-174.sslip.io/.well-known/stellar-agent-services.json), testnet agent 163 | [Receipt and registry](../validation/README.md) | [Testnet transfer proofs](../d2/oracle-payments.json) |
| P1 | Not confirmed | Not recorded | Not recorded | Not recorded | Not recorded |
| P2 | Not confirmed | Not recorded | Not recorded | Not recorded | Not recorded |

Add provider rows if the agreed scope requires them. Record clean-setup duration, assistance and blockers for each.

## Users

| User alias | Date | Provider / service | Discovery evidence | Approval / payment / result | Assistance and outcome |
| --- | --- | --- | --- | --- | --- |
| U1 | Not run | — | — | — | — |
| U2 | Not run | — | — | — | — |
| U3 | Not run | — | — | — | — |
| U4 | Not run | — | — | — | — |
| U5 | Not run | — | — | — | — |

## Recovery

User, provider, job id, interruption, recovery steps, video, result, and proof of exactly one transfer: not collected.

## Findings and fixes

| Observation | Impact | Fix / issue link | Retest and evidence |
| --- | --- | --- | --- |
| No observations yet | — | — | — |

## Incentives and acceptance

Provider/user incentives agreed and distributed: not recorded. Report totals without private payment details.

SOW §6.1 evidence links, unresolved limitations, Chapter Lead review and acceptance date: not recorded.

## Engineering preparation outside the independent pilot

The sample is deployed on the existing Oracle A1 VM. Its registered-provider run passed C1–C7 at level 3,
score 100. The validator is operated for this project and does not establish provider independence.

A separate Linux client workspace reproduced npm 0.1.0 returning `payment_uncertain`. The original job later
reconciled to its original transfer. With the unreleased bounded polling fix, a new client call succeeded and
confirmed its own payment without a second signature. Both outcomes and independent transfer proofs are in
[the clean-client record](../d2/oracle-clean-client.json). This is not a participant flow or a successful rerun
of the scheduled CI job. Pilot observations and participant counts above remain unfilled.

[Invitation drafts](invitation-drafts.md) are ready for the owner to send. No invitations have been sent.
