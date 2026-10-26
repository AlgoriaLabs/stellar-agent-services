# @stellar-agent-services/verifier

Checks a provider against [Provider Standard v1](../../docs/provider-standard.md) and turns the result into evidence
anyone can check:

1. **Checks C1–C7:** manifest, identity, payment challenge, paid call, recovery, hygiene and load. Each finding
   cites a rule of the standard.
2. **Verification receipt:** RFC 8785 canonical JSON, stored under its own SHA-256.
3. **Badges:** SVGs drawn only from a receipt.
4. **Validation Registry:** `validation_response` anchors the receipt's hash in the Stellar 8004 Validation
   Registry.

The full description, with every check and rule, is [docs/verification.md](../../docs/verification.md).

## Use

```bash
# After npm install && npm run build at the repository root:
alias verifier="node $PWD/packages/verifier/dist/cli/index.js"

# A provider testing itself, with no payment and no key:
verifier check http://localhost:8787/.well-known/stellar-agent-services.json --dev

# A verifier: every check, paid by a dedicated testnet account, and a receipt.
VERIFIER_PAYER_SECRET=S... verifier verify https://api.example.com/.well-known/stellar-agent-services.json \
  --pay --validator G... --out evidence/receipts
verifier publish evidence/receipts/<sha256>.json --request-hash <hex> --response-uri <https url> --source verifier
verifier badge evidence/receipts/<sha256>.json --request-hash <hex>
```

```
Provider Standard v1 check: http://localhost:8787/.well-known/stellar-agent-services.json
  ✓ C1 Manifest
  - C2 Identity: skipped, development mode: a loopback provider can't be registered
  ✓ C3 Challenge
  - C4 Paid call: skipped, no test payer: run verifier verify --pay
  - C5 Recovery: skipped, no test payer: run verifier verify --pay
  ✓ C6 Hygiene
  ✓ C7 Load

Level 1 (Described): score 33 of 100.
Load (C7) passed: Load-safe.
Every check that ran passed.
```

Exit codes: `0` every check that ran passed, `1` a check or the command failed, `2` a usage error. `--json` prints
the report, or the receipt, on standard output.

As a library:

```ts
import { issueReceipt, localKeyPayer, verifyProvider, writeReceipt } from "@stellar-agent-services/verifier";

const report = await verifyProvider({ manifestUrl, payer: localKeyPayer(process.env.VERIFIER_PAYER_SECRET!) });
const receipt = issueReceipt(report, { validator: "G..." });
const { path, sha256 } = await writeReceipt(receipt, "evidence/receipts");
```

## Keys

| Key | Used for | Where it lives |
| --- | --- | --- |
| Test payer | C4, C5 and C7's paid part | `VERIFIER_PAYER_SECRET`: a dedicated testnet account holding a little USDC |
| Validator | `validation_response` | The Stellar CLI keychain. `verifier publish --source <key>` signs through it; the verifier never sees it. |

The test payer pays only a provider whose manifest passed C1 and whose challenge matches it, at most 0.10 USDC for
a job and 1.00 USDC in a run unless told otherwise, and never on pubnet without `--allow-pubnet`.

## Layout

| Path | What it does |
| --- | --- |
| `src/verify.ts` | `verifyProvider()`: runs the checks, in order, and returns the report |
| `src/checks/` | One module per check, C1–C7 |
| `src/jobs.ts` | The job endpoints, called as a careful client calls them, and the job view checks (§5.5–§5.7) |
| `src/http.ts` | The HTTP client for an untrusted provider: no redirects, deadlines, size limits, one origin |
| `src/payments.ts` | The test payer and its limits |
| `src/chain.ts` | Soroban RPC reads: the trustline, and the proofs that a payment did or did not settle |
| `src/registry.ts` | Stellar 8004 reads: identity and validation records |
| `src/receipt.ts`, `src/badges.ts`, `src/publish.ts` | Receipts, badges, and the Validation Registry response |
| `src/cli/` | The `verifier` command |

## Tests

The tests run every check against the real Provider Kit in-process, with a facilitator that settles onto a fake
Soroban chain and a test payer that signs real payments offline. A conforming provider must pass every check; for
each rule, a provider made to break it must fail with that rule's id.
