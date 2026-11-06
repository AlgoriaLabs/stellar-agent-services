# Live verification receipts and badges

Captured on 2026-11-06 with the actual HTTPS sample, x402 facilitator and Stellar testnet RPC. Every receipt is
canonical JSON named by its exact SHA-256. The [public evidence page](https://algorialabs.github.io/stellar-agent-services/#verification)
serves the latest receipt and earned badges, and retains the earlier receipts.

## Registered Oracle run

[Canonical receipt](b364429e0b6e084fe85100d7e2a6ef05d92c0a1b94f351f6952aadb5ad84ddba.json), checked at **2026-11-06 15:42:43 UTC**:
**C1–C7 all passed**, level **3 (Recoverable)**, score **100**. The sample is testnet agent **163** at the
[stable Oracle manifest](https://sas-testnet.79-76-99-174.sslip.io/.well-known/stellar-agent-services.json).

The [confirmed registry response](../validation/README.md) anchors this exact receipt. Five badges are earned:
Standard v1, Payment verified, Recovery verified, Load-safe and 8004 validated.

![8004 validated](b364429e0b6e084fe85100d7e2a6ef05d92c0a1b94f351f6952aadb5ad84ddba.8004-validated.svg)

[Run report and captured manifest](../d2/oracle-live-verification.json) ·
[Independent RPC transfer proofs](../d2/oracle-payments.json) ·
[Before/after Linux client check](../d2/oracle-clean-client.json).

The run reserved up to 0.03 test USDC for C4 and two C7 payments. Two transfers of 0.01 settled; the excess
load job was refused and its signature did not settle after expiry. C5 recovered the original C4 job.
The validator is operated for this project, with its signing key in macOS Keychain. This is not an independent audit.
The run used the checkout, not a newly published npm version.

## Historical temporary-endpoint run

[Canonical receipt](695dcdc2ff60d2d277636323872d96425cbab390f2a88d5859b4b9872fe093e4.json),
checked at **2026-11-06 11:08:23 UTC**, reached **level 3, Recoverable** (conformance score 100).
This score measures the conformance level; identity and load have separate results.

| Check | Result |
| --- | --- |
| C1 Manifest | Passed |
| C2 Identity | Skipped: the temporary sample is not registered |
| C3 Challenge | Passed |
| C4 Paid call | Passed; original payment confirmed at ledger 5587906 |
| C5 Recovery | Passed; existing job, original payment |
| C6 Hygiene | Passed |
| C7 Load | Passed; 20 unpaid requests, one accepted paid load job, one refused before payment |

The C7 accepted job finished. The refused payment was checked after its signature expired and did not settle
[Q3]. The run signed for at most **0.03 test USDC**: C4 and two C7 payments. Two 0.01 USDC transfers settled;
the refused third payment did not. Signed spending and settled spending are distinct.

- [Run report and captured manifest](../d2/live-verification.json).
- [Independent RPC confirmation](../d2/verification-payments.json) of both final-run payments and the earlier
  uncertain job's original payment after reconciliation.
- [C4 payment on Stellar](https://stellar.expert/explorer/testnet/tx/d1821d406c2b10eb7cd7d5b60d79d88b5d302008e2b349e664debd8919e01e9a).
- Manifest canonical SHA-256: `02aadbe84e39fefc286e5e9cc294085c0f848cc6f6b629b05e0aeeb83903c963`.
- Validator: `GB5PKQ7G64QCV6D2X3CZSQZYIMWHL2URBBAVO3Z5T4WA6IL3J7BEVH22`.
- Payout: `GDZTNESUUP2YODFWW5TIOVV2PN43JTJFIEZ7ML4JC2VCHOXWNSTV44SC`.

![Standard v1](695dcdc2ff60d2d277636323872d96425cbab390f2a88d5859b4b9872fe093e4.standard-v1.svg)
![Payment verified](695dcdc2ff60d2d277636323872d96425cbab390f2a88d5859b4b9872fe093e4.payment-verified.svg)
![Recovery verified](695dcdc2ff60d2d277636323872d96425cbab390f2a88d5859b4b9872fe093e4.recovery-verified.svg)
![Load-safe](695dcdc2ff60d2d277636323872d96425cbab390f2a88d5859b4b9872fe093e4.load-safe.svg)

## Earlier runs and fixes

| Run | Paid/recovery | Load | Receipt |
| --- | --- | --- | --- |
| Original sample, default concurrency 4 | C4/C5 passed | C7 failed [Q4] after concurrent settlement errors | [Unedited receipt](7af1af2b7c28ae68976a516879ca8f260b4ad9c7f6d1b92b3211df65f31bb609.json) |
| Sample concurrency 1, before polling fix | C4 uncertain; C5 skipped | Unpaid burst passed; paid load skipped | [Unedited receipt](7e18a75da464b7ac1001aef6cae76facd22fb9d244d3726535161761840692a4.json) |
| Concurrency 1 and bounded uncertainty polling | C4/C5 passed | Full C7 passed | [Final receipt](695dcdc2ff60d2d277636323872d96425cbab390f2a88d5859b4b9872fe093e4.json) |

[The first report](../d2/live-verification-before.json) records the actual load failure. The sample now declares
one on-success job at a time and refuses excess work before payment [Q2], [Q3].
[The intermediate report](../d2/live-verification-intermediate.json) records the uncertainty; the provider later
reconciled its original job to a settled transfer. The verifier now polls that same uncertain job within its
existing follow deadline [J13]. Two offline regression tests prove successful reconciliation and bounded
unresolved polling, with one signing operation and no second payment [J11]. No old receipt was edited or combined
with another run to earn a badge.

## Limits of the historical receipts

The sample used a temporary Cloudflare quick tunnel, not a permanent deployment. It was not registered, so C2
was skipped in all three runs. The validator is operated for this project; this is not independent validation.
Its signing key is in macOS Keychain through Stellar CLI secure storage. Dedicated disposable verifier payers
were held in memory and never shared with the provider.

These three historical receipts are **unanchored**. No `8004 validated` badge is earned. The fresh registered Oracle receipt above is the one anchored on chain. These historical files remain
unchanged and do not gain registry badges retroactively.

The historical final run used the local sample admission and verifier polling fixes, based on the 0.1.0 checkout. Those
source changes have not been released to npm; the receipt's tool version remains 0.1.0.
