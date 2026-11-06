# Confirmed testnet registry evidence

The stable Oracle sample is registered as **agent 163**. Its fresh C1–C7 verification passed every check,
reached level 3 (Recoverable), and scored 100. The confirmed Validation Registry response anchors the exact
canonical receipt. This is project-operated verification, not an independent audit or pilot.

| Field | Confirmed value |
| --- | --- |
| Network | `stellar:testnet` |
| Manifest | [Live Oracle sample](https://sas-testnet.79-76-99-174.sslip.io/.well-known/stellar-agent-services.json) |
| Provider / payout | Agent 163 / `GBQXS5ZRH5AXDFEMKUNHPJ3VBEOYNKZEYF3TFIVFBULBLIBPSW5ACUZ3` |
| Identity registration | [3ea07a7c…](https://stellar.expert/explorer/testnet/tx/3ea07a7cd69cc1e8877476d3b81daaef32fe3761c594922268b1f84aa16c65d6), ledger 5591067 |
| Validation request | [4da4ed91…](https://stellar.expert/explorer/testnet/tx/4da4ed91a2e927cf1f2b681f892d63d25326b7ada9259b342ee5ba8494aa055a), ledger 5591100 |
| Validation response | [adf32dca…](https://stellar.expert/explorer/testnet/tx/adf32dca14608cc0f2cd28c59cd4365871f2314b56270eeed38d1f09c134599f), ledger 5591328 |
| Validator | `GB5PKQ7G64QCV6D2X3CZSQZYIMWHL2URBBAVO3Z5T4WA6IL3J7BEVH22` |
| Response score / direction / tag | 100 / higher-is-better / `provider-standard-v1` |
| Receipt | [Canonical JSON](../receipts/b364429e0b6e084fe85100d7e2a6ef05d92c0a1b94f351f6952aadb5ad84ddba.json) |

- Request hash: `57a4b03ab6d4680546df11a415fd8b1efb2a6552361735cc8a3c568dd49a1262`.
- Canonical receipt SHA-256 and on-chain `response_hash`: `b364429e0b6e084fe85100d7e2a6ef05d92c0a1b94f351f6952aadb5ad84ddba`.
- [Decoded public registry events, complete bounded scan and independently confirmed transactions](oracle-testnet-records.json).
- [Identity registration document](oracle-testnet-registration.json) and [canonical request document](oracle-testnet-request.json).
- [Verification report](../d2/oracle-live-verification.json), [independent transfer proofs](../d2/oracle-payments.json),
  [earned badges](../receipts/README.md), and [deployment runbook](../../deploy/d2/oracle/README.md).
- Immutable public `response_uri`:
  [receipt at evidence commit ef43efd](https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/ef43efd1e489bb94ffdd45afb5b78595601c900f/receipts/b364429e0b6e084fe85100d7e2a6ef05d92c0a1b94f351f6952aadb5ad84ddba.json).

Identity binding [I1]–[I3] passed against the registry and live manifest. Publication checked the request's
agent, validator, network and binding, then fetched the public receipt and verified its exact bytes before
signing. A read-only registry lookup matched its hash, score and tag before issuing the fifth badge.

The dedicated owner and validator use separate Stellar CLI aliases in macOS secure storage. Only public
settings are deployed; neither signing key is on Oracle. The verifier payer was disposable and memory-only.
All transactions here use test tokens. No mainnet transaction or paid cloud provisioning was performed.
