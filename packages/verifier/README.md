# @stellar-agent-services/verifier

Checks a provider against Provider Standard v1 and produces evidence that can be checked independently:

1. **Checks C1–C6:** manifest, identity, payment challenge, paid call, recovery, hygiene.
2. **Verification receipt:** canonical JSON, hashed.
3. **Badges:** rendered only from the receipt.
4. **Validation Registry:** a `validation_response` anchoring the receipt hash on Stellar 8004.

`verifier check <manifest-url>` runs the checks that need no payment. With `--dev` it also accepts a local
`http://` server, so a provider in any language can test itself before going live.

Status: scaffold only. See [docs/verification.md](../../docs/verification.md).
