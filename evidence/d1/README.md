# D1 recording checklist

Status: captured and [published](https://algorialabs.github.io/stellar-agent-services/#approval) on 2026-11-06.
All payments use Stellar testnet USDC.

## Captured evidence

- [Approval and payment video](approval-payment.mp4), about 48 seconds.
- [Blocked request](01-spending-limit-blocked.jpg) and [failed spending check](02-limit-safety-check.jpg).
- [Exact approval terms](03-approval-terms.jpg) and [passing safety checks](04-approval-safety-checks.jpg).
- [Confirmed payment](05-payment-confirmed.jpg) and [result/transaction reference](06-result-and-transaction.jpg).
- [Decoded RPC proof](payment-proof.json): successful transaction in ledger **5587345**, with one transfer of
  **100000 base units = 0.01 USDC** from the approved payer to the approved payee [J16].
- [Validated provider manifest](provider-manifest.json); its canonical hash is recorded in the proof.
- [Public testnet transaction](https://stellar.expert/explorer/testnet/tx/29cbeae9ac78018e313e2dc34ee32b52fe3ebba48fe3e99a4ebd8a1e9cd769de).

The recording uses genuine browser screenshots sampled at approximately two frames per second, with pauses
between recorded segments removed. Closing screenshots are held for readability. It has no narration or
simulated payment state. [Recording metadata](recording.json) records the segments and timings.

The sample ran locally at `http://localhost:8787`, using the 0.1.0 checkout plus the uncommitted closeout changes.
The payer and payout accounts were disposable testnet accounts. This proves the sample's payment flow; it does
not represent an independent provider or user pilot. Anonymous downloads of the public artifacts matched their
recorded SHA-256 checksums; see [publication verification](../publication.json).

## Recording checklist

- [x] Record date, commit/package version, provider URL and service price.
- [x] Show the service input and provider-supplied description.
- [x] Set a 0.01 USDC limit; show that the 0.02 USDC delayed report is blocked before signing.
- [x] Review the 0.01 USDC text-statistics service, including exact terms and passing checks, before approval.
- [x] Show explicit approval, successful result and payment confirmed on chain [J16].
- [x] Save screenshots/video and the transaction hash, ledger and explorer link.
- [x] Link the spec, video and payment reference from the evidence index.
- [x] Publish the evidence files at stable public URLs and confirm anonymous access and exact checksums.

Use [the wallet walkthrough](../../apps/wallet/README.md). A command-line `try --yes` payment alone does not show
the approval screen or the rejected spending limit promised by D1.
