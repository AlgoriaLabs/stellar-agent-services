# Job Recovery: implementation reference for AI coding agents

Use this file to change, extend, review or debug Job Recovery in this repository: the provider's reconciliation
of `payment_uncertain` jobs, the ledger clock, and the payment client's recovery paths.

- **Normative source:** [provider-standard.md §5](../provider-standard.md#5-jobs). If this file and the spec
  disagree, the spec wins. Cite rules by id (`[J13]`). v1 is frozen: additions must be optional fields or SHOULD
  rules.
- **Explanatory doc:** [job-recovery.md](../job-recovery.md). **Human summary:** [README.md](README.md).
- **State:** implemented and tested offline (491 tests passing). Checked read-only against the public testnet
  RPC. Not yet done: the recorded testnet demo (one interrupted job recovered with exactly one on-chain transfer).

## 0. Invariants: never break these

1. **Never charge twice.** A `payment_uncertain` job is never settled again [J13]. Recovery never re-sends
   `PAYMENT-SIGNATURE`; check-status and get-result never charge [J11].
2. **Fail closed on money.** `not_settled` needs proof of absence (§4.3). Any doubt is `undecided`, and the job
   stays `payment_uncertain`. Never report a paid job as unpaid.
3. **Identify a payment by `(payer, nonce)`, never by amount and recipient.** One payer may pay one provider the
   same price for many jobs. Soroban accepts an `(address, nonce)` pair once, so that pair identifies exactly one
   payment.
4. **Every reconciliation write is compare-and-set from `payment_uncertain`.** A late facilitator answer,
   another process or a second run must not overturn a decision.
5. **The provider holds no secret key.** Chain access is read-only Soroban RPC.
6. **Tests never touch the network.** Test providers pass `rpc: false` or a fake `ChainReader`
   (`packages/provider-kit/test/support/chain.ts`).

## 1. File map

| File | Role |
| --- | --- |
| `packages/protocol/src/networks.ts` | `SOROBAN_RPC_URL`: testnet `https://soroban-testnet.stellar.org`, pubnet `undefined` (no public SDF RPC) |
| `packages/provider-kit/src/payments/chain.ts` | `ChainReader` type, `rpcChain()`, `LedgerClock`, `ledgerClock()` |
| `packages/provider-kit/src/payments/onchain.ts` | `findPayment()`, `PaymentLookup`, `PaymentSearch`, `SEARCH_WINDOW_LEDGERS`, `EXPIRATION_TOLERANCE_LEDGERS` |
| `packages/provider-kit/src/jobs/reconcile.ts` | `reconcile()`: lists `payment_uncertain` jobs, calls `findPayment`, applies decisions |
| `packages/provider-kit/src/jobs/recovery.ts` | `sweep()`: now also fails on-success jobs by expiration ledger (`SweepOptions.clock`) |
| `packages/provider-kit/src/jobs/runner.ts` | `paymentDeadline()`: on-success deadline from the expiration ledger; `PaidRun.clock` |
| `packages/provider-kit/src/http/router.ts` | Step 7: refuses a signature that expires too far out; `RouterContext.clock` |
| `packages/provider-kit/src/provider.ts` | `ProviderConfig.rpc`; builds chain and clock; background `reconcileJobs()` after each sweep |
| `packages/provider-kit/src/payments/payload-checks.ts` | `addressCredentials()` is now exported (shared with `onchain.ts`) |
| `packages/provider-kit/src/gateway/config.ts`, `schemas/gateway-config.schema.json` | `rpcUrl` (allows `env:NAME`) maps to `ProviderConfig.rpc` |
| `packages/provider-kit/src/cli/reconcile.ts`, `cli/main.ts`, `cli/shared.ts` | `provider-kit reconcile` command; new flags `--store`, `--rpc` |
| `packages/payment-client/src/client.ts` | 409 handling: `isInProgress()`, `whileSettling()`, changes in `payOnce`, `follow`, `getResult`, `recover` |
| `packages/payment-client/src/onchain.ts` | Uses `SOROBAN_RPC_URL` from protocol (its local copy was removed) |
| `examples/paid-service/src/server.ts`, `.env.example` | Optional `SOROBAN_RPC_URL` passed as `rpc` |

## 2. Spec mapping

| Rule | Where it is enforced |
| --- | --- |
| [J5] same id + binding + token returns the existing job, no settle | `router.ts` `existingJob()` (existing code) |
| [J7] `409 request_in_progress` while claimed or settled | Provider: `router.ts`, for internal status `pending`. Client: `isInProgress()` means "ask again later". |
| [J11] check-status and get-result never charge | `router.ts` `handleGetJob()`; client `recover()` only calls get-result |
| [J12] final states never change | Store `update()` refuses final `from`; reconcile is compare-and-set from `payment_uncertain` |
| [J13] uncertain decided on chain, never re-charged | `jobs/reconcile.ts` + `payments/onchain.ts` |
| [J14] output withheld while uncertain | Existing router logic; reconcile keeps the stored output for on-success |
| [J16] receipt confirmed on chain | Client `confirm()` (existing); reconcile also requires a matching `transfer` event |
| [S2] payment expires about `maxTimeoutSeconds` after signing | `runner.ts` `paymentDeadline()`, `recovery.ts` sweep, router step-7 check |
| [P9] one signed payment buys at most one job | Fingerprint `sha256(JCS({network, payer, nonce}))` (existing) |
| [Q8], [Q9] retries and polling pace | Client follows `Retry-After` for 409, 429 and 503 |

## 3. Data the provider stores (existing, relied on)

`StoredJob.claim: PaymentClaim` = `{ fingerprint, payer, nonce, expirationLedger }`, written at claim time from
`checkPayment()`. `nonce` is the payer auth entry's `credentials.nonce().toString()` (decimal int64).
`expirationLedger` is `signatureExpirationLedger`, the last ledger at which the signature is valid.

`StoredJob.settlement?: { reason, transaction? }` is set when the job became `payment_uncertain`. `transaction`
is the hash the facilitator named, if any.

Internal status `pending`: an upfront job claimed, with settlement in flight. It has no job view; requests get 409.

## 4. Reconciliation algorithm

### 4.1 `reconcile(store, options): Promise<Reconciled[]>` (`jobs/reconcile.ts`)

```
options: PaymentSearch & { dryRun?: boolean; limit?: number }   // limit default 500 (CLI uses 1000)
PaymentSearch: { chain: ChainReader; network: StellarNetwork; asset: string }   // asset = manifest USDC SAC

1. jobs = store.list({ statuses: ["payment_uncertain"], createdBefore: now + 1 s, limit })   // oldest first
2. if none: return []                                       // no RPC call at all
3. health = chain.getHealth()                               // once per run
   on error: every job → undecided("the chain could not be read: …"), no writes
4. for each job:
     if job.claim.expirationLedger < health.oldestLedger:
         undecided("older than the RPC's history")         // no RPC call, so a backlog costs nothing
     else lookup = findPayment(job.claim, job.settlement?.transaction, options, health)
     apply(lookup)                                          // §4.4
```

`Reconciled = { jobId, service, outcome: "settled" | "not_settled" | "undecided", status, transaction?, reason? }`.
`status` is the status afterwards (in a dry run, the status it would get).

### 4.2 `findPayment(claim, known, search, health?)` (`payments/onchain.ts`)

```
check(hash): getTransaction(hash) → paymentIn(...)          // each hash checked once (Set)

1. if known: r = check(known); if r: return r               // settled or undecided; a FAILED tx falls through
2. range = health ?? getHealth()
   end   = claim.expirationLedger
   from  = max(1, end - SEARCH_WINDOW_LEDGERS)               // 320
   start = max(from, range.oldestLedger)
   latest = range.latestLedger
3. if start <= min(end, latest):
     filters = [{ type: "contract", contractIds: [asset],
                  topics: [[sym("transfer"), addr(payer), "*", "*"],     // SAC: 4 topics
                           [sym("transfer"), addr(payer), "*"]] }]       // other SEP-41 tokens: 3 topics
     request = { filters, startLedger: start, endLedger: min(end, latest) + 1, limit: 100 }   // endLedger is exclusive
     loop pages (max 10, else undecided "more transfers than reconciliation searches"):
       response = getEvents(request); latest = min(latest, response.latestLedger)
       for event: if event.ledger > end: stop
                  r = check(event.txHash); if r: return r
       if stopped, or events < 100: break
       request = { filters, cursor: response.cursor, limit: 100 }   // cursor mode can't take endLedger
4. if latest <= end:  undecided("the payment can still land until ledger {end} closes")
5. if start > from:   undecided("ledgers {from}–{start-1} are older than the RPC's history")
6. return not_settled("no transaction used the payment before it expired at ledger {end}")
Any exception: undecided("the chain could not be read: …")
```

`latest` is the **minimum** of every reported latest ledger: several RPC nodes behind one URL may lag
differently, and coverage is only as far as the least advanced node.

**Do not filter on `event.inSuccessfulContractCall`.** Current RPCs leave this deprecated field unset
(`undefined`). An earlier version of this code skipped every real event because of it; the live testnet check
caught it. The transaction's own `SUCCESS` status decides.

### 4.3 `paymentIn(tx, hash, claim, search)`: is this transaction the payment?

```
tx.status !== SUCCESS                                → undefined (not the payment; keep looking)
signedTransfer(tx.envelopeXdr, claim, asset):
  operations: fee-bump → innerTx().v1().tx().operations(); v1 → v1().tx(); else v0().tx()
  for each invokeHostFunction op, for each auth entry:
    credentials = addressCredentials(entry.credentials())     // address or addressV2
    skip unless address == claim.payer && nonce == claim.nonce
    rootInvocation must be contractFn on `asset`, function "transfer", args [from, to, amount],
      with from == payer, to a string and amount a bigint            → { to, amount }
    anything else with this (payer, nonce): undefined (the nonce was spent elsewhere, not this payment)
no matching entry                                    → undefined
transfersFrom(tx.events.contractEventsXdr.flat(), asset, payer) has no event with the same to and amount
                                                     → undecided("used the payment, but … no transfer …")
otherwise → settled, receipt = { network, asset, amount, payTo: to, payer, transaction: hash,
                                 settledAt: ISO(tx.createdAt * 1000) }
```

The transfer event data is an `i128`, or a map with `amount` for a muxed payee (CAP-67). Both are handled.

### 4.4 Applying a decision

| Lookup | `charge` | Patch, compare-and-set from `payment_uncertain` |
| --- | --- | --- |
| `settled` | `upfront` | `{ status: "queued", payment: receipt }`. The store enqueues it; the provider wakes the lane and a worker leases it. `input` is still stored (it's dropped only at a final status). |
| `settled` | `on-success` | `{ status: "succeeded", payment: receipt }`. The output was stored before settling. If `output` is missing (a broken store), report `undecided`: never report a paid job as unpaid. |
| `not_settled` | any | `{ status: "failed", error: jobError("payment_failed", …) }`. `chargedFor()` gives `false`. |
| `undecided` | any | No write. |

When the compare-and-set misses (the job changed meanwhile), the reported status is re-read from the store, and
the earlier decision stands.

### 4.5 Why the 320-ledger window is sound

- The x402 facilitator refuses `signatureExpirationLedger > currentLedger + ceil(maxTimeout / estLedgerSecs) + 2`
  at verify.
- The provider adds its own check at router step 7, only when the clock answers:
  `expirationLedger > latest + maxTimeoutSeconds + EXPIRATION_TOLERANCE_LEDGERS (10)` → 402 with
  `invalid_exact_stellar_payload_signature_expiration_too_far`, before the facilitator sees the payment. This
  counts a ledger as at least 1 s.
- `maxTimeoutSeconds` is at most 300 (§4.1), so `E ≤ claimLedger + 310`, so `E − 320 ≤ claimLedger − 10`.
- A payment lands after verification. Before verification, a used nonce would fail the facilitator's
  simulation, and the job would never be claimed.
- If the clock is down at claim time, the window relies on the facilitator's check alone.

## 5. Ledger clock (`payments/chain.ts`)

```ts
interface LedgerClock { latest(): Promise<number>; closesAt(ledger: number): Promise<number /* epoch ms */> }
ledgerClock(chain: Pick<ChainReader, "getLatestLedger" | "getLedgers">): LedgerClock
```

- **A reading:** `getLatestLedger()`, then `getLedgers({ startLedger: latest - 100, pagination: { limit: 1 } })`.
  `ledgerMs = (latestLedgerCloseTime - sample.ledgerCloseTime) * 1000 / (latestLedger - sample.sequence)`, kept
  only within [1000, 60000]. Default 5000. If `getLedgers` fails, the latest ledger and the default duration
  serve. If there is no usable close time, `Date.now()` stands in.
- `closesAt(L) = closedAt + (L - sequence) * ledgerMs`. `latest()` is the reading's real sequence, never
  extrapolated.
- **Cache 5 s, timeout 3 s per reading.** A failed reading rejects until the next one is due, and warns once per
  failure streak. A slow RPC never holds a request or job for more than 3 s.
- **Users:**
  - `runner.ts` `paymentDeadline(job, run) = min(createdAt + max(1, maxTimeout − 10) s, closesAt(E) − 10 s)`.
    If the clock fails, the claim-time deadline alone applies.
  - `recovery.ts` `sweep()`: an on-success job, `queued` or `running`, with no `settlingSince`, fails `timeout`
    uncharged when `createdAt < now − (maxTimeout + 60) s` **or** `clock.latest() > claim.expirationLedger`.
    With the clock, the list bound is `now + 1 s`, so jobs created this millisecond are included.
  - `router.ts` step-7 expiration check (§4.5).
- Measured live on testnet: about 4.8 s per ledger. SDF testnet RPC history is 120,960 ledgers (about 7 days).

## 6. Configuration

| Where | Field | Behavior |
| --- | --- | --- |
| `createProvider` | `rpc?: string \| ChainReader \| false` | `string`/`undefined` → `rpcChain(network, url, { dev })`; `undefined` on pubnet → no chain, plus a startup warning. A `ChainReader` is used as is. `false` → no chain reads at all (tests). |
| gateway config | `rpcUrl` | String; `env:NAME` allowed. Becomes `rpc`. |
| example env | `SOROBAN_RPC_URL` | Optional; becomes `rpc`. |
| `rpcChain()` | URL rules | `https:` only; `http://localhost`, `127.0.0.1` or `[::1]` only with `dev: true`. `rpc.Server` timeout 15 s. |

Background job in `provider.ts`: `reconcileJobs()` runs after the startup sweep and after every sweep interval
(30 s), never overlapping (a `reconciling` promise guards it), and never blocking `ready()`. It logs `settled` and
`not_settled` decisions with `console.error`; undecided jobs are not logged again. `close()` awaits it before
closing the store.

## 7. CLI

```
provider-kit reconcile (--config <file> | --store <file> --network <testnet|pubnet>) [--rpc <url>] [--dry-run] [--dev]
```

- `--config` loads the gateway config and opens its store. `rpcUrl` comes from the config unless `--rpc` is
  given.
- `--store` must point to an existing file; a typo is an error, not an empty store. `--network` accepts
  `testnet`, `mainnet`, `pubnet`, `stellar:testnet` or `stellar:pubnet`.
- With no RPC (pubnet without `--rpc`), it stops with a usage error.
- **Exit codes:** 0 when every job is decided or there are none; 1 when any job is undecided, or on errors; 2 on
  a usage error.
- It looks at the oldest 1000 jobs and says so when it hits that limit.
- It reads the chain, writes only the job store (compare-and-set) and signs nothing. It is safe beside a running
  provider sharing the SQLite file.

## 8. Payment client changes (`packages/payment-client/src/client.ts`)

- `isInProgress(response)` is `status === 409`. The spec uses 409 only for `request_in_progress`.
- **`payOnce`:** after the busy branch, a 409 on the paid create-job runs
  `whileSettling(baseUrl, jobId, token, response)`. A job view → `finish()`. Still 409 after `followSeconds` →
  journal `uncertain`, then throw `PaymentUncertainError("the provider is still settling the payment")`.
  Before this change, a 409 was journaled `uncertain` at once.
- **`whileSettling`:** cancels the body, waits `pollMs ?? Retry-After ?? 2000`, and calls get-result until it
  answers something other than 409, 429 or 503. Returns `undefined` when the next wait would pass the
  `followSeconds` deadline (default 120).
- **`follow`:** 409, 429 and 503 while polling mean "ask again later" [Q9], [J7]. Their bodies are cancelled.
- **`getResult`:** no longer throws on 409.
- **`recover`:** a 409 runs `whileSettling`. If it is still settling, it throws `PaymentUncertainError`. It never
  signs.
- The journal sequence on the happy 409 path is `intent, approved, sending, settled, result`.

## 9. Tests

| File | Covers |
| --- | --- |
| `packages/provider-kit/test/reconcile.test.ts` (24) | Settled via the named tx (no event search); settled via events while ignoring another job's equal transfer; `not_settled` with `charged: false`; undecided while the payment can still land; window older than history; backlog costs only one `getHealth`; window edge (`E − 320`); paging (150 other transfers, 2 `getEvents` calls); facilitator retry after a FAILED tx; fee-bump envelope; payment used without a matching transfer → undecided; RPC down; dry run; compare-and-set race; provider auto-reconcile at startup running the paid job; on-success timed by ledger (expires in 1 ledger → `timeout`, not settled); time left → succeeds; far expiration → 402 before verify; RPC down → claim-time fallback; sweep with clock; `ledgerClock` estimate, cache, default duration, warn-once; `rpcChain` URL rules |
| `packages/provider-kit/test/support/chain.ts` | Fake `ChainReader`: ledgers 5 s apart (the latest closed now), transactions, transfer events, cursors, `state.down`, `calls` counter. Like real RPCs, its events carry **no** `inSuccessfulContractCall`. |
| `packages/provider-kit/test/gateway.test.ts` (+1) | `rpcUrl` with `env:` and the https rule |
| `packages/payment-client/test/flow.test.ts` (+2) | 409 during settlement is followed, one signature, one settle; settlement outlasting the wait → `PaymentUncertainError`, then `recover()` works after release |
| Harnesses | `rpc: false` in `provider-kit/test/support/harness.ts`, `capacity.test.ts`, `payment-client/test/support/harness.ts` and the gateway Python test |

**Live read-only checks** (scratch scripts, not in the repo), against `https://soroban-testnet.stellar.org`:

- the RPC accepts the event filter format;
- an expired, never-paid claim → `not_settled`; an unexpired one → `undecided`;
- a real fee-bumped x402-style transfer is found from `(payer, nonce, expirationLedger)` alone, without its hash;
- the same payer with another nonce → `not_settled`.

**Commands:** `npm run typecheck`, `npm test`. CI also runs the `apps/wallet` check and build.

## 10. Known limits and open points

- **One RPC is trusted.** Decisions trust the configured RPC's answers (there is no multi-source quorum). Use an
  RPC you operate or trust on mainnet.
- **History:** a job whose ledgers are older than the RPC's history stays `undecided`. Use
  `provider-kit reconcile --rpc <rpc with more history>`.
- **Duplicate reads:** every provider process sharing a store reconciles, so RPC reads are duplicated. Writes
  are compare-and-set, so this is safe.
- **No CLI unit test:** `provider-kit reconcile` is a thin wrapper, smoke-tested by hand (empty store, missing
  store, usage errors, pubnet without RPC).
- **Tests aren't typechecked:** `tsc -b` covers `src` only, and several existing tests have type errors (for
  example `payment-client/test/support/chain.ts`). The new test files typecheck cleanly.
- **Stale doc:** [docs/standard/README-AI.md](../standard/README-AI.md) §0 rule 6 and §1 still say the
  `provider-kit` CLI and gateway mode are not built. They are.
- **Still to do:** the recorded testnet demo. Steps are in [job-recovery.md](../job-recovery.md#response-loss-drill).

## 11. When you change this code

- New chain reads go through `ChainReader` (and the fake in `test/support/chain.ts`), never a raw `fetch`.
- Keep `findPayment` pure: no store access. Keep all writes in `reconcile.ts`, compare-and-set only.
- Any new "can't tell" branch returns `undecided`, never `not_settled`.
- If `SEARCH_WINDOW_LEDGERS` or the step-7 check changes, re-derive §4.5 and update the comments in
  `onchain.ts` and `router.ts`.
- Tests: add a case to `reconcile.test.ts` using `signedPayment()` (a real offline-signed payment through
  `checkPayment`) and `landed()` (a fake transaction). Keep `rpc: false` in every other provider test.
