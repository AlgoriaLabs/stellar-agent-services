# Independent pilot checklist

Two independent providers are recorded, each with a confirmed mainnet payment. The pilot has an operator-run
buyer flow, an independent buyer flow, and [a third pilot user's run](claude-buyer-run/README.md) with paid
calls to both providers. The current SOW calls for two independent providers and two pilot users.

The [pilot report](report.md) links X Strategy Agent and Meeting Action Extractor, with their registrations,
payer setup and confirmed USDC payments. The [public evidence page](https://algorialabs.github.io/stellar-agent-services/#pilot-screenshots)
shows the third user's discovery, approval and payment evidence.

For each independent provider:

- [ ] Record an alias/name, service purpose, language, integration path and public manifest URL.
- [ ] Confirm that the provider controls its service, deployment and payout wallet independently of the sample.
- [ ] Follow the published guide from a clean environment; note assistance, setup duration and blockers.
- [ ] Record its agent id, verifier receipt/badges and confirmed Validation Registry response.
- [ ] Complete at least one paid call and record its network, transaction hash, ledger and explorer URL.

For each distinct user:

- [ ] Record an alias and date; do not publish private contact information.
- [ ] Link the provider, service, confirmed payment and observed result.
- [ ] Record assistance, confusing steps, errors and whether the user completed the flow.

The [D2 Job Recovery demo](../d2/README.md#captured-recovery-evidence) shows recovery of an interrupted
sample job and the single confirmed transfer on Stellar testnet.

Fill [report.md](report.md) from observations and link the payment evidence. SOW §6.1 lists pilot screenshots
and leaves the choice of screens open. Discovery, approval, payment and result screens are examples.
Resolve blocking issues and link the fixes and retest outcomes.

[Invitation drafts](invitation-drafts.md) are prepared for the owner. The registered sample and its
[verification evidence](../validation/README.md) are ready for demonstration, but do not count as an
independent provider or user.
