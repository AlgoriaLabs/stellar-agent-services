# Validation Registry evidence

Status: no owner registration, validation request or response has been submitted for the sample. The
[unanchored live receipts](../receipts/README.md) and validator setup are complete; they are not registry evidence.

Prepared testnet identities:

- Owner-supplied payout: `GDZTNESUUP2YODFWW5TIOVV2PN43JTJFIEZ7ML4JC2VCHOXWNSTV44SC`; USDC trustline confirmed.
- Separate validator: `GB5PKQ7G64QCV6D2X3CZSQZYIMWHL2URBBAVO3Z5T4WA6IL3J7BEVH22`, funded through Friendbot.
  Stellar CLI alias `sas-d2-validator-20261106` uses macOS secure storage. No secret is in the provider.
- [Deployment bundle](../../deploy/d2/README.md): prepared and Fly configuration validated. The stable app name
  still needs reserving; the temporary tunnel used for the receipts must not be registered.

The final registered-provider receipt must be generated after registration; do not anchor a temporary
unregistered-provider receipt or claim that its skipped C2 passed.

For each provider retain:

| Field | Value |
| --- | --- |
| Network | stellar:testnet |
| Provider name, manifest URL, agent id and public payTo | Not collected |
| Identity registration transaction, ledger, explorer URL | Not collected |
| Validator public address | Not collected |
| Validation request hash and request document | Not collected |
| Request transaction, ledger, explorer URL | Not collected |
| Response transaction, ledger, explorer URL | Not collected |
| Receipt URL and canonical SHA-256 | Not collected |
| On-chain response hash, score and tag | Not collected |

Check identity binding [I1]–[I3], and that the receipt's canonical SHA-256 equals the on-chain `response_hash`.
The tag is `provider-standard-v1`; the conformance score is higher-is-better. Verify the published response with
a read-only registry lookup. A submitted request without a confirmed response is incomplete.
