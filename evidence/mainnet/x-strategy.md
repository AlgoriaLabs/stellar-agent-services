# X Strategy Agent mainnet evidence

On **16 November 2026 (UTC)**, X Strategy Agent registered as Stellar 8004 agent **76** on Stellar mainnet
(`stellar:pubnet`). Its operator then used the project's payment client to buy one run of `x-strategy` for
**0.10 USDC** over x402. The service analyzes a GitHub or GitLab repository and delivers an X marketing
strategy as a PDF.

## Provider proof

- The provider project uses the TypeScript Provider Kit with an `on-success` charge, which settles after
  the report has been generated. [Provider project on GitHub](https://github.com/MuratCaganGogebakan/marketing-agent-service).
- [Public Provider Standard v1 manifest](https://x-strategy.92-5-73-99.sslip.io/.well-known/stellar-agent-services.json).
- [8004 Identity Registry registration](https://stellar.expert/explorer/public/tx/80d50587c8ac6b8176b52f828d8026980c9db3efed77b71ba46a10d4247a91b0)
  at ledger **65509002**. The agent owner's wallet is the service's payout address
  `GAIBNH5ZZVY53NJQAU77RWT5YXQQMRPST66YZHXDBG3ZEST5UJZ6RAKE`.
- The operator reported passing unpaid verifier checks C1, C2, C3, C6 and C7 on 2026-11-16. A read-only
  Provider Kit check on 2026-11-17 confirmed the payout account's USDC trustline and matched the manifest URL
  and `payTo` to the registration [I1]–[I3].

## Buyer flow

The operator's run record reports that the client fetched the manifest, checked the x402 challenge against it
and approved **0.10 USDC** on mainnet at **12:26:45 UTC**. The per-payment and daily limits were both 0.10 USDC.
The client used `@stellar-agent-services/payment-client` and signed once. It posted to
`/services/x-strategy/jobs` with
[`basevenue_wolf` at commit `1dc3602`](https://github.com/batuhanozcan1605/basevenue_wolf/tree/1dc3602e86d65340b6efaebf42e708f9979debed)
as the repository to analyze.

| Time (UTC) | Recorded event |
| --- | --- |
| 12:26:49 | Job `5bf31423-e483-4571-b4c0-bc9154454c81` created |
| 12:27:37 | One 0.10 USDC payment closed on chain at ledger 65509203 |
| 12:27:41 | Client recorded settlement |
| 12:27:43 | Client received the result with `status: succeeded` and `charged: true` |

Horizon records one 0.10 USDC debit from `GD5HJMIY655IR7D3CROTBM2KPJI4H5NS4Y4EHEHFOESMC7BTBXXNPNMP` and
one matching credit to the service wallet. The payer's Horizon effects had one USDC debit when checked
on 2026-11-17. Horizon lists OpenZeppelin's facilitator as the transaction source and a separate
fee account, `GA5SXMFJTUPTZRIEKM6XZLCYOZRMUEE6KGAHL3GXDBG64DYOUIWYIF3M`, for the 0.0012203 XLM fee.
[Payment explorer record](https://stellar.expert/explorer/public/tx/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042) ·
[Horizon transaction](https://horizon.stellar.org/transactions/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042) ·
[Horizon effects](https://horizon.stellar.org/transactions/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042/effects).

The operator reported receiving a **22-page PDF** titled “basevenue_wolf: X marketing strategy” about **58 seconds
after approval**. The recorded size is 107,120 bytes and the reported SHA-256 is
`152d678fd1a15102b68541e6b8ab12f12c88db0579a0745eb0dd6f5e0d2b4166`. The evidence supplied for this run was a
written record with ledger links and a digest. The PDF and approval recording were unavailable for review.

## Setup and payment transactions

| Time (UTC) | Operation | Ledger and explorer |
| --- | --- | --- |
| 12:10:37 | Create payout account with 2.0 XLM | [65508999](https://stellar.expert/explorer/public/tx/879d74476ea1a03f385ac81fd7549df5626ad58b2466e19f9dd86b7615312cc2) |
| 12:10:47 | Add payout account's USDC trustline | [65509001](https://stellar.expert/explorer/public/tx/c15334a4519bb3b86ad30fe30de35b691fa21968978a4d1ec086705ce9e12776) |
| 12:10:52 | Register agent 76 | [65509002](https://stellar.expert/explorer/public/tx/80d50587c8ac6b8176b52f828d8026980c9db3efed77b71ba46a10d4247a91b0) |
| 12:26:07 | Create payer account with 2.5 XLM | [65509185](https://stellar.expert/explorer/public/tx/0b52d18d7efefaa98f7b437adf711d0bb35af336c68d9d79d3163f54df7d2bf3) |
| 12:26:32 | Add payer's USDC trustline and exchange 0.7299656 XLM for 0.10 USDC | [65509190](https://stellar.expert/explorer/public/tx/ee763a32dba5be44b23cddc50f1c7e76cc7a0563f40b0d9430a0c90faba9ad9e) |
| 12:27:37 | Settle the paid job | [65509203](https://stellar.expert/explorer/public/tx/430fa75be0debb374cbbf787553bfc3e320c6d9a59b8d1ad4b0eb02b117b3042) |

## SOW coverage

This documents one provider project and deployment and one operator-run buyer flow on mainnet. The run record
attributes funding for both wallets and the paid call to the service operator. The provider repository establishes
the implementation's source. Independent control of the deployment and payout wallet, and an independent buyer,
remain to be documented for D3. This run covered identity registration and normal delivery. Paid verifier checks
C4/C5, a Validation Registry response, verification badges and a recovery run are absent for agent 76.
