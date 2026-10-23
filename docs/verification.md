# Verification, receipts, badges and Validation Registry (draft)

> Status: outline. To be built in Week 3 (SOW Deliverable 2).

## Conformance levels
<!-- Level 1 Described (C1, C6), Level 2 Payable (+ C3, C4), Level 3 Recoverable (+ C5), Load-safe (C7), and Registered (C2 +
     Validation Registry record), as in provider-standard.md §8. -->

## Checks
<!-- C1 manifest, C2 identity, C3 challenge, C4 paid call, C5 recovery, C6 hygiene, C7 load (spec §5.8: a burst is
     answered with 402, 429 or 503 plus Retry-After, never another error). Each failure cites the rule ids
     from provider-standard.md. `verifier check` runs the no-payment checks against any URL; with `--dev` it also accepts a local
     http:// server (spec [M6]). -->

## Verification receipt

The verifier issues one receipt per run (`VerificationReceipt` in
[packages/protocol](../packages/protocol/src/receipts.ts)). It is published as RFC 8785 canonical JSON, and
`sha256(JCS(receipt))` is the `response_hash` posted on chain.

| Field | Meaning |
| --- | --- |
| `standard` | `stellar-agent-services/provider@1` |
| `agentId` | The provider's Stellar 8004 agent id. Required to publish to the Validation Registry. |
| `network` | `stellar:testnet` or `stellar:pubnet` |
| `validator` | The verifier's `G…` address, which signs `validation_response` |
| `startedAt`, `checkedAt` | RFC 3339 |
| `level` | The conformance level reached, 0–3 (0: not even Described) |
| `score`, `scoreDirection` | 0, 33, 67 or 100 for levels 0–3; `higher-is-better`. `score` is also the on-chain `response`. |
| `manifest` | `{ url, sha256 }`, where `sha256` is the JCS hash of the parsed manifest |
| `results[]` | One per check, C1–C7: `check`, `status` (`passed`, `failed`, `skipped`), `failedRules` (rule ids such as `P4`), `warnings?`, `evidence?` |
| `payment` | The C4 payment receipt, after the verifier confirmed it on chain |

`standard`, `agentId`, `network`, `validator`, `checkedAt`, `score`, `scoreDirection` and `results` form the
envelope shared with Stellar ERC-8126 records ([erc-compatibility.md](erc-compatibility.md), T2). Evidence never
contains secrets, job tokens or payment payloads.

## Badges
<!-- One per level reached; derived only from receipts; network shown on each badge. -->

## Stellar 8004 Validation Registry
<!-- validation_request by the provider owner, validation_response by the verifier, how to read records. -->
