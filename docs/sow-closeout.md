# SOW closeout and pilot handoff

Reviewed on 2026-11-06 against the [source SOW](https://docs.google.com/document/d/1kIJ5nkwIVaXqHqcNHwuI5JN0Ap6g86wzncMQya6Kv88/edit)
and this checkout. The [implementation plan](../IMPLEMENTATION_PLAN.md) records the build; this page records the
remaining acceptance work. Prepared templates are not evidence of completed pilot work.

## Readiness

| Area | Available | Still needed for SOW acceptance |
| --- | --- | --- |
| D1 | Standard, client, spending controls, publicly hosted approval/limit-block video, screenshots and payment proof | Chapter Lead review |
| D2 | Kit, guide, stable Oracle sample, all C1–C7 passed, anchored receipt/five badges, recovery and payment proofs | Chapter Lead review |
| D3 | Scaffolder and onboarding guide | Independent integrations, user flows, findings/fixes and completed pilot report |
| Distribution | Six npm packages at 0.1.1 (released 2026-11-06, with the reconciliation fix) | A later release for `--local-wallet` |
| Mainnet | Three paid providers at level 3 with real USDC, receipts, on-chain transfers, and agent 73's Validation Registry record | Nothing for the SOW |
| Discovery | Newer implementation notes report testnet registry scanning and manifest service matching | Confirm the released discovery path in the pilot and show the complete find-to-result flow |

Public release and CI references, and local check results, belong in [readiness evidence](../evidence/readiness.md).
The latest observed daily live workflow failed its paid testnet call; do not treat ordinary CI as a live payment
proof. A trusted registry/risk-source adapter remains application integration work; configured verification limits
now block new payments unless a trusted source can satisfy them [V1].

## Acceptance decisions for the owner

The source SOW conflicts: D3 says three independent providers and five users, while the objective and evidence
section say two providers and two users; its exclusions cap providers at two. The working target is the sample
plus two independent providers, and five distinct pilot users. This interpretation still needs Chapter Lead
agreement. Five flows by one person do not establish five users.

Also confirm that testnet evidence is accepted. Record the agreement and sprint start date in the pilot report;
the SOW's submission date does not establish the sprint deadline.

## Completed reference deployment and evidence

The [sample runs on the existing Oracle A1 VM](../deploy/d2/oracle/README.md), with separate process, user,
loopback port, SQLite data and HTTPS origin. No new cloud resources were allocated. Its public testnet owner
is separate from the existing mainnet Logo Maker wallet. The mainnet manifest hash remained unchanged.

The sample is registered as testnet agent 163. [Registry evidence](../evidence/validation/README.md) includes
confirmed registration, request and response transactions, the request document, receipt hash and on-chain
score/tag. All C1–C7 checks passed. The project-operated validator is separate from the provider and disposable
payer; it is not an independent auditor. Signing keys stay in local Stellar CLI secure storage.

Review these completed reference artifacts:

1. [D1 approval, spending block, payment and result recording](../evidence/d1/README.md).
2. [Registered sample receipt and five badges](../evidence/receipts/README.md), with failures/skips from historical runs preserved.
3. [D2 same-job recovery recording and bounded single-transfer proof](../evidence/d2/README.md) [J11], [J13], [J16].
4. [Linux client before/after evidence](../evidence/d2/oracle-clean-client.json): npm 0.1.0 returned uncertainty;
   its original job later reconciled. The unreleased polling fix completed a distinct testnet call and
   confirmed its transfer. This does not claim a scheduled CI rerun or an independent clean-host integration.
5. [Public evidence page](https://algorialabs.github.io/stellar-agent-services/) and [publication checks](../evidence/publication.json).

The [Oracle runbook](../deploy/d2/oracle/README.md) records maintenance and rollback. For another provider,
follow the [setup guide](provider-setup-guide.md), use its own public payout, and have its owner sign registry
steps in their wallet. Never deploy an owner signing key. The registry records and the reference sample are
testnet.

## Mainnet proof (2026-11-14)

[Mainnet evidence](../evidence/mainnet/README.md): the verifier paid three live AlgoriaLabs providers, built with
the kit and registered in the mainnet 8004 registry, with real USDC. Agents 73 (logo), 72 (pitch deck) and 70
(text to speech) reached level 3 with score 100. Each paid job was recovered without a second charge, and the
three transfers (0.10, 0.10 and 0.005 USDC) are confirmed on chain. Agent 74's paid jobs failed and were not
charged. Agent 73's receipt is anchored in the mainnet Validation Registry (request and response confirmed) and
earns all five badges. These services are project-operated, so they do not count as independent pilot providers.

## Run the independent pilot

Use [the pilot checklist](../evidence/pilot/README.md) and [report template](../evidence/pilot/report.md). Recruit
providers who control their own code, payout wallet and deployment. Have them follow the guide from a clean
environment; record assistance and blockers. Each provider needs a real paid testnet service call and its own
linked evidence. Capture discovery, approval, payment and result for each user; at least one demonstrates recovery.

Resolve blocking issues, retain before/after observations and rerun only affected flows. Submit the evidence index
with completed videos, receipts, transaction references, registry records and report, then request Chapter Lead
acceptance against SOW §6.2.
