# Evidence

Public evidence for the Instaward SOW (section 6.1), filled in during the sprint. Every transaction is listed
with its network, hash, ledger and explorer link, and testnet evidence is labeled as testnet.

**Public evidence:** [videos, screenshots, receipts and payment proofs](https://algorialabs.github.io/stellar-agent-services/).

**D1 evidence is published. D2 is complete.** Oracle testnet agent 163 passed all seven verifier checks and
earned five badges. The confirmed Validation Registry response anchors its receipt. The Job Recovery recording
and single-payment proof are published. [D2 verification and recovery evidence](https://algorialabs.github.io/stellar-agent-services/#recovery).

**Mainnet (2026-11-14):** the verifier paid three live AlgoriaLabs providers with real USDC. Agents 73, 72 and 70
reached level 3 with score 100, each paid job was recovered without a second charge, and every transfer is
confirmed on chain. Agent 73's receipt is anchored in the mainnet Validation Registry and earns all five badges.
These are project-operated services. See [mainnet/](mainnet/README.md). [Readiness](readiness.md) records the checks and release limits;
[the closeout guide](../docs/sow-closeout.md) gives the pilot handoff.

**Mainnet (2026-11-16):** [X Strategy Agent](mainnet/x-strategy.md) is the first independent D3 provider
(agent 76). Its operator-run pilot user flow includes a confirmed 0.10 USDC payment and reported delivery
of a 22-page PDF.

**Mainnet (2026-11-17):** [Meeting Action Extractor](mainnet/meeting-actions.md), agent 77, is the second
independent D3 provider. An independent pilot user paid 0.01 USDC and reported receiving action items,
decisions and a summary.

| Deliverable | Evidence | Location |
| --- | --- | --- |
| D1 | Provider Standard v1 | [docs/provider-standard.md](../docs/provider-standard.md) |
| D1 | Approval → payment video, screenshots, tx link | [Captured evidence](d1/README.md) — published |
| D2 | Setup guide | [docs/provider-setup-guide.md](../docs/provider-setup-guide.md) |
| D2 | Verification receipts and badges | [Live run results](receipts/README.md) — registered Oracle run, five earned badges |
| D2 | Validation Registry records | [Confirmed registration, request and response](validation/README.md) |
| D2 | Job Recovery demo | [Captured recovery and single-transfer proof](d2/README.md) — published |
| D1, D2 | Mainnet payments, recovery, receipts and a Validation Registry record | [Mainnet run](mainnet/README.md): three paid providers at level 3, real USDC; agent 73 anchored on chain |
| D3 | Two independent providers, an operator-run user flow and an independent user flow | [Agent 76 registration, payment and delivery](mainnet/x-strategy.md) · [Agent 77 registration, payment and delivery](mainnet/meeting-actions.md) |
| D3 | Remaining user evidence, findings and Chapter Lead acceptance | [Pilot checklist](pilot/README.md) and [pilot report](pilot/report.md) |

For each transaction include: network, transaction hash, ledger, explorer link, provider id, service and purpose.
Publish participant aliases, not private contact details. Exclude keys, signed payment payloads, job tokens and
raw journals from screenshots and attachments. Link a completed artifact only after checking its public access.

[checksums.sha256](checksums.sha256) records the captured media and JSON files. From the repository root, run
`shasum -a 256 -c evidence/checksums.sha256` to check their file integrity. The linked public ledger transactions
independently establish the payments.

[publication.json](publication.json) records the evidence branch commit and anonymous checksum verification of
the publicly served files. Run `npm run build`, then build the site with `node scripts/evidence-site.mjs <empty-output-directory>`.
