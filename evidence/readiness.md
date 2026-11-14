# Repository readiness: 2026-11-06

Engineering checks and public evidence, updated for the stable Oracle sample and confirmed testnet registry
response. This is not a completed independent pilot. The checkout is based on
`35f1280de78958e6d34eca4ac472071915584029`, with uncommitted Oracle deployment and client polling changes.
Node 24.12.0 was used locally; Oracle runs Node 24.22.2.

## Local checks

| Check | Observed result |
| --- | --- |
| Locked dependency install (`npm ci`) | Passed |
| TypeScript build (`tsc -b --force`, then `npm run build`) | Passed; initial stale incremental metadata was rebuilt |
| Complete offline tests (`npm test`) | Passed: 58 files, 1,071 tests, including the three new client/CLI bounded polling cases |
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

The released CLI returned before provider reconciliation completed. The same issue was reproduced on Oracle
with npm 0.1.0. The checkout now enables bounded same-job uncertainty polling in `provider-kit try`, and a
separate Linux client workspace completed its call in 35.6 seconds with an independently confirmed payment.
[The before/after record](d2/oracle-clean-client.json) preserves both original payments. No successful scheduled
rerun is claimed, and the fix has not been released to npm.

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

## Registered Oracle verification

The sample runs at [its stable HTTPS manifest](https://sas-testnet.79-76-99-174.sslip.io/.well-known/stellar-agent-services.json)
as testnet agent 163. All C1–C7 checks passed, reaching level 3 and score 100. The confirmed registry response
anchors the canonical receipt and earns all five badges. [Registry proof](validation/README.md) links every
registration/request/response transaction and the exact public receipt bytes. The validator is project-operated.

[Independent payment proofs](d2/oracle-payments.json) cover two 0.01 test USDC transfers. C7 refused the extra
load payment and checked that it never settled after expiry; C5 recovered the original C4 job.
Historical temporary-provider receipts retain their original failures and skips.

[Deployment checks](d2/oracle-deployment.json) confirm both HTTPS origins are healthy, and the mainnet Logo Maker
manifest remains byte-canonically unchanged. The existing Oracle A1 allocation is reused; no extra VM, volume
or network resource was provisioned. The service has its own Linux user, SQLite directory and loopback port,
with 384 MiB/25% CPU limits and boot startup. Signing keys remain off the server. A read-only `provider-kit status` using the deployed public environment
reports all six stages complete: local, payTo, paid, registered, live and verified. See the
[runbook](../deploy/d2/oracle/README.md).

## Mainnet: 2026-11-14

The npm verifier 0.1.1 paid three live AlgoriaLabs providers on mainnet with real USDC. Agents 73, 72 and 70
reached level 3 with score 100; three transfers settled (0.10, 0.10 and 0.005 USDC), and no paid job was charged
twice. All six registered AlgoriaLabs services (agents 69–74) passed the unpaid checks. Provider findings and
failed runs are kept as captured. See [mainnet/](mainnet/README.md).

Since this page was first written: 0.1.1 was released on 2026-11-06 with the bounded polling fix, and the daily
live workflow's paid testnet job has passed on most days since (one failure, on 2026-11-09).

## Remaining acceptance work

Recruit independent providers and distinct users, execute the pilot and fill its report. Agree conflicting
SOW counts, sprint dates and testnet evidence acceptance with the Chapter Lead. Review and release the source
fixes; rerun the scheduled paid CI job after they are available there. Mainnet payments are now captured
(above); mainnet Validation Registry records still need the agent owner's signature.
