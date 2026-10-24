# Job Recovery

The normative rules are in [provider-standard.md §5](provider-standard.md#5-jobs). This document explains how they
fit together, how the Provider Kit and the payment client implement them, and how the recovery demo is run.
Short version: [recovery/README.md](recovery/README.md). For AI coding agents:
[recovery/README-AI.md](recovery/README-AI.md).

**Goal:** if a connection drops after payment, the user collects the same job's result without paying again.
Nobody is charged twice for one job. A payment whose outcome is unknown is decided from the chain, never by
charging again.

## Operations

| Operation | Request | Auth |
| --- | --- | --- |
| create-job | `POST {baseUrl}/services/{name}/jobs` | x402 payment |
| check-status | `GET {baseUrl}/jobs/{jobId}` | `Job-Token` |
| get-result | `GET {baseUrl}/jobs/{jobId}/result` | `Job-Token` |

All three answer with the same job view (§5.5): `200` once the job is `succeeded` or `failed`, otherwise `202`
with `Retry-After`, plus `Location` on create-job. The paths are fixed under `baseUrl`, so a client that kept
`baseUrl`, the job id and the token can always reach the job, even if it lost every response. check-status and
get-result never take a payment and never charge [J11].

## Job identity and binding

1. Before the first request, the client generates the job id (a lowercase UUID, sent as `Idempotency-Key`) and a
   `Job-Token` (32 random bytes), and saves both. The payment client writes them to its journal and secret store
   before it calls create-job.
2. The provider binds the job id, permanently [J4], to:
   - the binding hash, `sha256(JCS({ service, input }))`;
   - `sha256(Job-Token)`. The token itself is never stored [J3].
3. Repeated requests get these answers:

| Request | Answer |
| --- | --- |
| create-job with the same id, binding and token | The existing job. No new `402`, and a payment the request carries is not settled [J5]. |
| create-job with the same id and other input or another token | `422 idempotency_key_reused` [J6] |
| create-job, check-status or get-result while the payment is still being claimed or settled | `409 request_in_progress` with `Retry-After` [J7] |
| check-status or get-result with a wrong token, or for an unknown or expired job | `404 job_not_found`, which never says whether the job exists [J10] |

A client that sends neither header (any plain x402 client) gets a provider-generated id and token in the
create-job response [J2]. It can pay, but if that response is lost, so is the job.

## States

```
(new)              → queued | running | payment_uncertain | failed
queued             → running
running            → succeeded | failed | payment_uncertain    (payment_uncertain: on-success only)
payment_uncertain  → queued | succeeded | failed               (decided from on-chain data)
```

| `status` | `charged` |
| --- | --- |
| `queued`, `running` | `true` for `upfront`, `false` for `on-success` |
| `succeeded` | `true` |
| `failed` | `true` for `upfront` unless `error.code` is `payment_failed`; `false` for `on-success` |
| `payment_uncertain` | `"unknown"`. The output is withheld [J14]. |

`succeeded` and `failed` are final [J12]. Finished jobs stay retrievable for `jobs.retentionSeconds` [J15]. The
kit also has an internal `pending` state: an `upfront` job whose settlement has not answered yet. Requests for it
get `409`.

## When the user is charged

| `charge` | Order | If the work fails |
| --- | --- | --- |
| `on-success` | verify → work → settle | Not charged |
| `upfront` (default) | verify → settle → work | Charged. v1 has no refunds. |

A signed Stellar payment is valid up to an **expiration ledger**, about `maxTimeoutSeconds` (30–300) after
signing [S2]. `on-success` therefore suits work well inside that window, and the kit refuses an `on-success`
service whose `expectedDurationSeconds` is more than half of `maxTimeoutSeconds`.

The kit times each `on-success` job by its payment's expiration ledger, using the ledger clock (see
[Reconciliation](#reconciliation)). It stops 10 s before that ledger closes, to leave time to settle. A job that
can't finish in time fails with `timeout` and is not charged, even when the client sent its payment long after
signing [Q8]. Long or expensive work uses `upfront`: it is paid before it starts, and its place in the queue
survives restarts [Q4].

## Why nobody pays twice

There are five independent guards, and each one alone stops a second charge.

1. **The client fixes the identity before paying.** The job id, token and binding are journaled before the first
   request, and `sending` is journaled and flushed before the paid request goes out. From then on the client
   never signs for that job again: `pay()` refuses, and `recover()` only reads.
2. **The provider binds the job.** One job id has one binding and one token, forever [J4]. A repeated create-job
   returns the same job and never settles the payment it carries [J5].
3. **The provider binds the payment.** The payment fingerprint is `sha256(JCS({ network, payer, nonce }))`, taken
   from the payer's signed Soroban auth entry. Soroban accepts an (address, nonce) pair once, and the store
   refuses a second job for one fingerprint. A signed payment buys at most one job, however it is re-wrapped
   [P9].
4. **Uncertain means don't pay.** When settlement times out, errors or answers something unexpected, the job
   becomes `payment_uncertain` and is never settled again [J13]. Only a facilitator answer saying the
   transaction was never submitted counts as failed.
5. **Recovery never re-sends `PAYMENT-SIGNATURE`.** It calls check-status and get-result only.

The client checks the receipt as well. Before it shows "paid", it confirms on chain that the transaction moved
the approved amount from the payer to `payTo`, and it accepts one transaction as proof for one job only [J16].

## Reconciliation

A `payment_uncertain` job is decided from on-chain data [J13]. In the kit, `jobs/reconcile.ts` applies the
decision and `payments/onchain.ts` does the lookup.

**What identifies the payment.** The amount and recipient can't: the same payer may pay the same provider the
same price for several jobs. Instead the kit looks for the successful transaction that carries the payer's signed
auth entry **with the job's nonce**, which the provider stored when it claimed the job. Soroban accepts that pair
once, so that transaction is the job's payment, and no other transaction can be.

**Where it looks.**

1. The transaction hash the facilitator named, if there is one.
2. Otherwise, or if that transaction failed (a facilitator may retry), the USDC `transfer` events from the payer
   in every ledger the payment could have landed in: the 320 ledgers up to its expiration ledger. Those cover
   every possible ledger, because the provider and the facilitator both refuse a signature that expires more than
   `maxTimeoutSeconds` (at most 300) of ledgers after verification, and a ledger takes at least a second.

**What it decides.**

| Found | Decision | The job becomes |
| --- | --- | --- |
| A successful transaction that carries the payment, with its `transfer` event | settled | `upfront`: `queued` with the receipt, and a worker runs it. `on-success`: `succeeded` with the receipt; the output was stored before settling. |
| Nothing, after the expiration ledger closed and every ledger of the window was searched | not settled | `failed` with `payment_failed`, `charged: false` |
| Anything less | undecided | Stays `payment_uncertain` |

"Undecided" covers a payment that can still land (its expiration ledger hasn't closed), a window older than the
RPC's history, an RPC error, and a transaction that used the payment but shows no matching transfer. The job
waits. Nothing is decided from a guess.

**Who runs it.**

- The provider itself, after every recovery sweep (every 30 s), when it has a Soroban RPC: `rpc` in
  `createProvider()`, or `rpcUrl` in a gateway config. Testnet defaults to the public RPC. Mainnet has no public
  RPC, so set your own.
- The operator, with `provider-kit reconcile`:

```bash
provider-kit reconcile --config provider.config.json --dry-run   # what would change
provider-kit reconcile --config provider.config.json             # decide
provider-kit reconcile --store ./jobs.sqlite --network testnet   # a library provider's store
```

The command reads the chain and writes only the job store. It is safe to run next to a running provider, and it
exits 1 while any job is still undecided. `--rpc <url>` uses another RPC, such as one that keeps more history.

Every update is compare-and-set from `payment_uncertain`. A late facilitator answer, another process or a second
run can't overturn a decision, and they all read the same chain.

**The ledger clock.** The same RPC gives the kit a clock on ledgers (`payments/chain.ts`): the latest ledger, its
close time, and the average ledger duration over the last 100 ledgers. The clock is used to:

- time `on-success` jobs (see [When the user is charged](#when-the-user-is-charged));
- let the recovery sweep fail an `on-success` job, uncharged, as soon as its payment's expiration ledger has
  passed;
- let create-job refuse a payment that expires too far out.

When the RPC is slow or down, all three fall back to the claim time plus `maxTimeoutSeconds`, and payments keep
working.

## Clients

The payment client (`packages/payment-client`) recovers like this:

- `pay()` journals `sending` before it sends the paid request. If that request fails in transit, the journal
  marks the job `uncertain`, and `PaymentUncertainError` says to recover the job, never to pay again.
- A `409 request_in_progress` means the provider holds the payment and is still settling it. The client polls
  get-result at the provider's `Retry-After` until it has a job view, for up to `followSeconds`. If settlement
  takes longer, it hands the job back for `recover()`.
- `recover(jobId)` (`stellar-pay recover <job-id>`) reads the job id and token from the journal and calls
  get-result. It never signs.
- A `payment_uncertain` job comes back at once. Only the provider's reconciliation decides it, so polling doesn't
  help; recover the job again later.

## Response-loss drill

The SOW recovery demo needs a response lost after a real payment. The kit has a test-only switch for this:
`loseCreateJobResponse: true`, or `DRILL_LOSE_RESPONSE=1` in the example provider. With it, the provider verifies
the payment, claims the job, settles and stores the result, then drops the create-job response. It is off by
default. Never enable it in production.

To run the demo on testnet:

```bash
# 1. The example provider, with the drill on (after npm install && npm run build at the root)
cd examples/paid-service
DRILL_LOSE_RESPONSE=1 PAY_TO=G... npm start

# 2. Pay for a job. The response is lost after the payment.
MANIFEST=http://localhost:8787/.well-known/stellar-agent-services.json
npx stellar-pay pay $MANIFEST text-stats '{"text":"lost and found"}' --dev
#    ⚠ ... The payment may have gone through: recover job <job-id>, do not pay again.

# 3. Collect the result without paying
npx stellar-pay recover <job-id> --dev
```

The evidence is the recovered result, plus the payer's account on stellar.expert showing exactly one USDC
transfer for the job.
