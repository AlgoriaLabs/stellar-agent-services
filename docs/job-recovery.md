# Job Recovery (draft)

> Status: outline. To be built in Week 3 (SOW Deliverable 2). The normative rules are in
> [provider-standard.md §5](provider-standard.md#5-jobs). This document explains them and how the demo is run.

Goal: if a connection drops after payment, the user can collect the same job's result without paying again.

## Operations
<!-- create-job, check-status, get-result. One flow for every service: 200 when finished, 202 + Location +
     Retry-After otherwise. -->

## Job identity and binding
<!-- Client-generated job id (Idempotency-Key) and Job-Token, saved before paying. Binding hash =
     sha256(JCS({ service, input })). Same binding and token → same job; different → 422; still in progress → 409;
     wrong token → 404. Clients that send neither get a provider-generated id and token. -->

## States
<!-- queued, running, succeeded, failed, payment_uncertain; allowed transitions; `charged`. -->

## When the user is charged
<!-- charge "on-success" (verify → work → settle) vs "upfront" (verify → settle → work); the payment
     authorization's time limit. -->

## Why nobody pays twice
<!-- Client journal, provider binding, payment fingerprint, uncertain-never-recharged, recovery never resends payment. -->

## Reconciliation
<!-- How payment_uncertain is resolved from on-chain data. -->

## Response-loss drill
<!-- Test-only mode used for the recovery demo. -->
