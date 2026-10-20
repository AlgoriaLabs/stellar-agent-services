# Job Recovery (draft)

> Status: outline. To be built in Week 3 (SOW Deliverable 2).

Goal: if a connection drops after payment, the user can collect the same job's result without paying again.

## Operations
<!-- create-job, check-status, get-result: requests, responses, status codes. -->

## Job identity and binding
<!-- Client-generated job id (Idempotency-Key) and job token; binding to service + canonical input; 409/404 rules. -->

## States
<!-- queued, running, succeeded, failed, payment_uncertain; allowed transitions. -->

## Settlement modes
<!-- after-work (sync default) vs before-work (async default). -->

## Why nobody pays twice
<!-- Client journal, provider binding, payment fingerprint, uncertain-never-recharged, recovery never resends payment. -->

## Reconciliation
<!-- How payment_uncertain is resolved from on-chain data. -->

## Response-loss drill
<!-- Test-only mode used for the recovery demo. -->
