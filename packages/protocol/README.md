# @stellar-agent-services/protocol

Provider Standard v1 as code. It holds the manifest, job, receipt and header definitions that every other
package shares. Specification: [docs/provider-standard.md](../../docs/provider-standard.md).

| Path | Contents |
| --- | --- |
| [`schemas/manifest.schema.json`](schemas/manifest.schema.json) | The manifest JSON Schema (2020-12) |
| [`schemas/verification-receipt.schema.json`](schemas/verification-receipt.schema.json), [`schemas/validation-request.schema.json`](schemas/validation-request.schema.json) | The two Validation Registry documents: the verifier's receipt and the owner's request |
| [`test-vectors/`](test-vectors) | Known-answer tests that implementations in any language can use |
| `src/` | Types (manifest, `JobView`, `Problem`, `PaymentReceipt`, `VerificationReceipt`, `ValidationRequest`), constants and the reference checks: `canonicalJson`, `bindingHash`, `checkManifestRules`, `checkChallenge`, `stellarAddressKind`, `canTransition`, `chargedFor`, `conformanceLevel`, `validationRequestHash`, `validationRequestDataUri` |

- No runtime dependencies and no signing code, so the read-only discovery server can import it safely.
- It ships the schema rather than a validator. To validate a manifest, run any JSON Schema 2020-12 validator,
  then `checkManifestRules()` (spec §2.4).
