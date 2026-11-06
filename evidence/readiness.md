# Repository readiness: 2026-11-06

Engineering checks, captured live verification and public release observations. This is not a completed live
pilot or Validation Registry proof. The checkout is based on `ddade601a1f640f7b3f353a4d1b43a0aee8aa757`, with uncommitted
closeout changes. Node 24.12.0 was used for local checks.

## Local checks

| Check | Observed result |
| --- | --- |
| Locked dependency install (`npm ci`) | Passed |
| TypeScript build (`tsc -b --force`, then `npm run build`) | Passed; initial stale incremental metadata was rebuilt |
| Complete offline tests (`npm test`) | Passed: 58 files, 1,068 tests, including 34 verification-policy cases and two bounded reconciliation-polling cases |
| Wallet Svelte check and production build | Passed, zero check warnings/errors |
| Owner approval page Svelte check and production build | Passed, zero check warnings/errors |
| Documentation bundle (`npm run llms`, `npm run llms:check`) | Passed |
| Package contents (`npm run packages:check`) | Passed for all six packages |
| Clean TypeScript testnet scaffold | Passed: install, one Stellar SDK 16.4.1, build, start, C1/C3/C6/C7 |
| Clean gateway/Python testnet scaffolds | Both passed: install, one Stellar SDK 16.4.1, start, C1/C3/C6/C7 |
| Read-only testnet infrastructure (`npm run live:check -- --network testnet`) | Passed: USDC contract, RPC, Horizon, 8004 registries and facilitator |

The first sandboxed test run could not bind localhost sockets. The repeat with local socket permission passed;
its providers, facilitator and chain are stand-ins. Scaffold checks also use stand-ins and make no payment.
The infrastructure check is read-only; RPC/Horizon reported ledger 5587098 during the check.

## Public distribution

Read anonymously from the GitHub and npm APIs on 2026-11-06:

- [v0.1.0 release](https://github.com/AlgoriaLabs/stellar-agent-services/releases/tag/v0.1.0), published 2026-11-02.
- [Release workflow](https://github.com/AlgoriaLabs/stellar-agent-services/actions/runs/41477529611): success.
- npm `latest` is 0.1.0 for [protocol](https://www.npmjs.com/package/@stellar-agent-services/protocol),
  [provider-kit](https://www.npmjs.com/package/@stellar-agent-services/provider-kit),
  [payment-client](https://www.npmjs.com/package/@stellar-agent-services/payment-client),
  [verifier](https://www.npmjs.com/package/@stellar-agent-services/verifier),
  [dev-mcp](https://www.npmjs.com/package/@stellar-agent-services/dev-mcp), and
  [create-stellar-service](https://www.npmjs.com/package/create-stellar-service).

These published packages do not contain the new verification-source enforcement in this working tree.

## Public CI observations

- [Ordinary CI on the base commit](https://github.com/AlgoriaLabs/stellar-agent-services/actions/runs/41483551035): success.
- [Latest observed daily live run](https://github.com/AlgoriaLabs/stellar-agent-services/actions/runs/42046787540):
  failure in [the paid testnet job](https://github.com/AlgoriaLabs/stellar-agent-services/actions/runs/42046787540/job/127311796974).
  Both read-only network jobs and the mainnet facilitator start check passed. A previous daily live run passed.
- The inherited `GH_TOKEN` was invalid. Using the existing macOS-keyring GitHub login allowed the logs to be
  read without exposing or replacing credentials. The paid job returned `payment_uncertain`, not a paid success.
- [Attempt 2](https://github.com/AlgoriaLabs/stellar-agent-services/actions/runs/42046787540/attempts/2),
  rerun on 2026-11-06 on a fresh Ubuntu runner, again installed, built and passed the unpaid scaffold checks but
  ended at `payment_uncertain`. This does not complete the clean-machine paid setup acceptance check.

The facilitator's underlying failure in the scheduled call is unresolved. Later manual sample payment and
recovery flows passed on testnet. The verifier's bounded reconciliation polling fix does not change the CLI's
scheduled `provider-kit try` path; no successful scheduled rerun is claimed.

## Captured testnet payment and recovery

On 2026-11-06 the local sample and wallet completed two real testnet calls with disposable accounts:

- [D1 approval/payment recording and screenshots](d1/README.md): 0.01 USDC, confirmed at ledger 5587345.
- [D2 recovery recording and screenshots](d2/README.md): 0.02 USDC, confirmed at ledger 5587377. A complete
  scan of payer USDC transfers in ledgers 5587344–5587416 found exactly one matching recovery transfer.

Both sets contain decoded independent RPC proofs and public explorer links. The recordings use sampled browser
screenshots with inter-segment pauses trimmed and final stills held for readability; no payment state is simulated.
The [public evidence page](https://algorialabs.github.io/stellar-agent-services/) serves the captured artifacts
from the separate `codex/d2-evidence` branch. [Publication verification](publication.json) records anonymous
downloads and exact SHA-256 checks, independent of authenticated repository access.

## Live D2 verification and deployment preparation

[Live receipts](receipts/README.md) retain every run's failures and skips, not just successful checks. They
describe a temporary HTTPS sample, not a registered provider. A dedicated testnet validator was created through
Stellar CLI secure storage in macOS Keychain; no secret was displayed or written to a file. The supplied payout
wallet already holds its testnet USDC trustline.

The first run proved payment and recovery, but its concurrent load calls encountered facilitator errors.
The sample now admits one on-success `text-stats` job at a time [Q2], [Q3]. A subsequent run returned uncertainty
and was later reconciled to its original confirmed transfer. That exposed the verifier stopping its follow
early; bounded polling now also reads `payment_uncertain` jobs [J11], [J13], with two offline regression cases.

The final run passed C1, C3, C4, C5, C6 and C7, reaching level 3 (Recoverable), with four earned badges. C2 was
skipped because the temporary sample was not registered. The paid C7 check accepted one job, refused one before
payment, confirmed the accepted job's transfer and proved the refused payment never settled after expiry.
[Independent RPC proof](d2/verification-payments.json) confirms the final run's two 0.01 USDC transfers and the
earlier uncertain job's original transfer. No second payment was submitted for any of those jobs.

The [permanent sample deployment bundle](../deploy/d2/README.md) is prepared. Fly login and configuration
validation passed, but no app or volume was provisioned. The operator must enable deployment in their account.
The Docker daemon was unavailable, so the sample container image build remains unverified.

## Remaining acceptance work

Owner registration/validation transactions, a permanent public provider deployment, a complete paid clean-machine
setup check and the independent pilot remain. Follow [the closeout guide](../docs/sow-closeout.md) for those steps.
Its acceptance decisions and pilot counts still need owner/Chapter Lead agreement.
