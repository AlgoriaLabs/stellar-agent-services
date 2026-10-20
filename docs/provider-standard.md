# Provider Standard v1 (draft)

> Status: outline. To be finalized and published in Week 1 (SOW Deliverable 1).

This standard defines how a paid AI service on Stellar describes its purpose, input, output, price, network,
job status and result, so that any client can discover it, pay for it once and collect the result.

## 1. Manifest
<!-- Location (/.well-known/stellar-agent-services.json), fields, size limits, HTTPS and same-origin rules. -->

## 2. Services
<!-- id, title, purpose, mode (sync/async), price, input/output JSON Schema, example, expected duration. -->

## 3. Payment
<!-- x402 v2 exact scheme on Stellar, USDC SAC, payTo, fee sponsorship; the challenge must equal the manifest. -->

## 4. Jobs
<!-- create-job, check-status, get-result; headers; states; see job-recovery.md. -->

## 5. Receipts
<!-- Payment receipt returned with the result. -->

## 6. Stellar 8004 registration
<!-- How registration metadata points at the manifest; how validation records relate (see verification.md). -->

## 7. Conformance
<!-- What the verifier checks (C1–C6) and what a provider must pass. -->
