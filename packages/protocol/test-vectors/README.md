# Provider Standard v1 test vectors

Known-answer tests for [Provider Standard v1](../../../docs/provider-standard.md). An implementation in any
language can check itself against these files. `packages/protocol` runs all of them in its own tests.

| File | What it pins | Spec |
| --- | --- | --- |
| `canonical-json.json` | RFC 8785 canonical JSON and its SHA-256, including the RFC's own examples | §5.3, verification receipts |
| `binding-hash.json` | The job binding hash | §5.3 |
| `headers.json` | `Idempotency-Key` and `Job-Token` formats | §5.2 |
| `manifests.json` | Manifest validation: the JSON Schema and the rules it can't express | §2.4 |
| `challenges.json` | Checking an x402 challenge against the approved manifest | §4.2 |
| `job-states.json` | Allowed job state transitions and the `charged` value of each state | §5.6 |
| `problems.json` | Error codes, their HTTP status and Retry-After, and job failure codes | §6 |
| `validation-requests.json` | Validation request documents: their canonical bytes, `request_hash` and `data:` URI, and the JSON Schema | [verification.md](../../../docs/verification.md#stellar-8004-validation-registry) |

## Conventions

- **Patches.** `manifests.json` and `challenges.json` describe each case as a small change to a base document,
  using the `add`, `replace` and `remove` operations of JSON Patch (RFC 6902). A last path segment of `-`
  appends to an array.
- **Violations.** Each `{ "rule", "pointer" }` is a rule id from the spec and a JSON Pointer (RFC 6901) to the
  offending value, or to where a missing field belongs. Compare them as a set. Messages are not part of the
  vectors.
- **`checkedBy`.** In `manifests.json`, `"schema"` cases fail the
  [manifest JSON Schema](../schemas/manifest.schema.json). `"code"` cases pass it and fail only the rules JSON
  Schema can't express. If you validate in code only, every invalid case must still fail.
- **Numbers** are IEEE 754 doubles, as I-JSON requires. Integers beyond ±(2^53 − 1) aren't interoperable, so the
  vectors avoid them. Services should send such values as strings.
- **Duplicate keys** make a document invalid I-JSON, but many parsers can't detect them, so no vector covers
  them.

## How they were made

The expected values were generated once and checked before they were written:
- canonical JSON against the independent [`canonicalize`](https://github.com/erdtman/canonicalize) package by an
  RFC 8785 author;
- the RFC 8785 examples (§3.2.2, §3.2.3, Appendix B) against the text of the RFC;
- hashes against a second SHA-256 implementation;
- every manifest and challenge case against Ajv with the JSON Schema, and against `packages/protocol`;
- validation requests with Python's `json`, `hashlib` and `base64` modules, apart from `packages/protocol`, and the
  hashes again with `shasum`;
- job states and error codes by hand from the tables in §5.6 and §6.

When you change a vector, run `npm test` and review the diff by hand.
