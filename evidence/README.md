# Evidence

Public evidence for the Instaward SOW (section 6.1), filled in during the sprint. Every transaction is listed
with its network, hash, ledger and explorer link, and testnet evidence is labeled as testnet.

**Public evidence:** [videos, screenshots, receipts and payment proofs](https://algorialabs.github.io/stellar-agent-services/).

**Status (2026-11-06): D1 and D2 technical evidence is published.** The Oracle sample is registered as
testnet agent 163, passes all C1–C7 checks and has a confirmed Validation Registry response anchoring its
receipt. Five badges are earned. Recordings and payment proofs remain available. Independent pilot work and
Chapter Lead acceptance remain outstanding.

**Mainnet (2026-11-14):** the verifier paid three live AlgoriaLabs providers with real USDC. Agents 73, 72 and 70
reached level 3 with score 100, each paid job was recovered without a second charge, and every transfer is
confirmed on chain. Agent 73's receipt is anchored in the mainnet Validation Registry and earns all five badges.
These are project-operated services, not pilot providers. See [mainnet/](mainnet/README.md). [Readiness](readiness.md) records the checks and release limits;
[the closeout guide](../docs/sow-closeout.md) gives the pilot handoff.

| Deliverable | Evidence | Location |
| --- | --- | --- |
| D1 | Provider Standard v1 | [docs/provider-standard.md](../docs/provider-standard.md) |
| D1 | Approval → payment video, screenshots, tx link | [Captured evidence](d1/README.md) — published |
| D2 | Setup guide | [docs/provider-setup-guide.md](../docs/provider-setup-guide.md) |
| D2 | Verification receipts and badges | [Live run results](receipts/README.md) — registered Oracle run, five earned badges |
| D2 | Validation Registry records | [Confirmed registration, request and response](validation/README.md) |
| D2 | Job Recovery demo | [Captured recovery and single-transfer proof](d2/README.md) — published |
| D1, D2 | Mainnet payments, recovery, receipts and a Validation Registry record | [Mainnet run](mainnet/README.md): three paid providers at level 3, real USDC; agent 73 anchored on chain |
| D3 | Provider integrations, paid-call references, screenshots | [Pilot checklist](pilot/README.md) — not run |
| D3 | Pilot report | [Report template](pilot/report.md) — not filled |

For each transaction include: network, transaction hash, ledger, explorer link, provider id, service and purpose.
Publish participant aliases, not private contact details. Exclude keys, signed payment payloads, job tokens and
raw journals from screenshots and attachments. Link a completed artifact only after checking its public access.

[checksums.sha256](checksums.sha256) records the captured media and JSON files. From the repository root, run
`shasum -a 256 -c evidence/checksums.sha256` to check their file integrity. The linked public ledger transactions
independently establish the payments.

[publication.json](publication.json) records the evidence branch commit and anonymous checksum verification of
the publicly served files. Run `npm run build`, then build the site with `node scripts/evidence-site.mjs <empty-output-directory>`.
