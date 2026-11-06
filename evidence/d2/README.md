# D2 recovery recording checklist

Status: recovery captured and [published](https://algorialabs.github.io/stellar-agent-services/#recovery) on
2026-11-06. The sample used Stellar testnet and a durable SQLite job store. See [the live verifier runs](../receipts/README.md)
for receipts and earned badges. The stable Oracle sample is now registered as testnet agent 163, with [confirmed registry evidence](../validation/README.md).

## Registered sample evidence

- [Oracle deployment and unchanged mainnet manifest check](oracle-deployment.json).
- [All C1–C7 checks](oracle-live-verification.json) and [confirmed registry response](../validation/README.md).
- [Independent verifier payment proofs](oracle-payments.json).
- [Linux client before/after check](oracle-clean-client.json): npm 0.1.0 returned uncertainty; the original
  job later reconciled. The unreleased bounded polling fix completes a distinct new call with one payment.

## Captured recovery evidence

- [Job Recovery video](job-recovery.mp4), about 62 seconds.
- [Initial payment approval](01-recovery-payment-approval.jpg).
- [Lost response and the same job's recovery instruction](02-response-lost-recover-same-job.jpg).
- [Recovered result with no second payment](03-recovered-no-second-payment.jpg).
- [Recovered job and transaction reference](04-recovered-job-and-transaction.jpg).
- [Decoded RPC proof and complete event scan](payment-proof.json).
- [Validated provider manifest](provider-manifest.json); its canonical hash is recorded in the proof.
- [Final live verification report](live-verification.json), [canonical receipts and four earned badges](../receipts/README.md),
  and [independent verification-payment proofs](verification-payments.json).
- [Public testnet transaction](https://stellar.expert/explorer/testnet/tx/559d0126e86a062eb9a5891eedb2e6bb1a99a262e3330d9935fc7feb61f93f4b),
  confirmed in ledger **5587377**: **200000 base units = 0.02 USDC**.

The job id before and after recovery was `37fdf22f-4c4d-4b21-ab5c-3030cdd1e19a`. After approving the original
payment, the deliberately lost response produced the uncertain outcome. The wallet's **Recover job** action
collected that job's stored report and confirmed its original transaction, with no second approval or payment.

An independent read-only scan covered every USDC transfer event from the disposable payer in ledgers
**5587344–5587416**, inclusive. It found exactly one matching 0.02 USDC transfer to the approved payee. The only
other payer transfer in that window was the separate 0.01 USDC D1 call. This is the bounded on-chain evidence
for the no-second-payment claim [J11], [J13], [J16].

The sample ran locally at `http://localhost:8788`, using the same throwaway payout account as D1. The video is
a genuine browser screen recording sampled at approximately two frames per second, with inter-segment pauses
removed and closing screenshots held for readability. It contains no narration or simulated payment states.
[Recording metadata](recording.json) records the segments and timings. Anonymous downloads of the public
artifacts matched their recorded SHA-256 checksums; see [publication verification](../publication.json).

## Recording checklist

Follow [the wallet recovery walkthrough](../../apps/wallet/README.md), using `delayed-report` with
`DRILL_LOSE_RESPONSE=1 REPORT_DELAY_SECONDS=10`. The drill loses the create-job response after storing the paid job.

- [x] Record the provider URL, version, service, price, network and job id (keep its job token private).
- [x] Show explicit approval and the lost-response/uncertain outcome.
- [x] Recover the existing job through the wallet.
- [x] Show the stored result and confirmed transfer, with no new job or payment approval.
- [x] Prove exactly one matching transfer for this job, using its original transaction and on-chain events.
- [x] Save the video, screenshots, transaction hash, ledger and explorer link.
- [x] Link the registered Oracle verification receipt and confirmed registry response from the evidence index.
- [x] Preserve the earlier unanchored receipts and their skipped C2; the fresh Oracle run passes C1–C7.
- [x] Publish the evidence files at stable public URLs and check anonymous access and exact checksums.

Recovery calls check-status and get-result and never pays [J11], [J13]. A provider's receipt is a claim until
the approved transfer is confirmed on chain [J16]. Restore the normal provider settings after recording.
