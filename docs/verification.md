# Verification, receipts, badges and Validation Registry

How a provider is checked against [Provider Standard v1](provider-standard.md), and how the result becomes
evidence anyone can check: a verification receipt, badges, and a record in the Stellar 8004 Validation Registry.
The verifier is [`packages/verifier`](../packages/verifier).

## Contents

1. [Commands](#commands)
2. [Conformance levels](#conformance-levels)
3. [How the verifier works](#how-the-verifier-works)
4. [Checks](#checks)
5. [The test payer](#the-test-payer)
6. [Verification receipt](#verification-receipt)
7. [Badges](#badges)
8. [Stellar 8004 Validation Registry](#stellar-8004-validation-registry)
9. [Security considerations](#security-considerations)

## Commands

The packages are not on npm yet. After `npm install && npm run build` at the root of this repository:

```bash
alias verifier="node $PWD/packages/verifier/dist/cli/index.js"
```

| Command | What it does | Keys |
| --- | --- | --- |
| `verifier check <manifest-url>` | Runs every check that needs no payment: C1, C2, C3, C6 and C7's burst. `--dev` also accepts a provider on `http://localhost`. | none |
| `verifier verify <manifest-url> --pay` | Runs every check, paying for C4, C5 and C7's paid part. With `--validator <G…> --out <dir>`, it writes the receipt. | test payer |
| `verifier badge <receipt.json>` | Writes the SVG badges the receipt earns. With `--request-hash`, also "8004 validated", once the record is on chain. | none |
| `verifier publish <receipt.json>` | Answers a validation request with the receipt (`validation_response`). | validator, through the Stellar CLI keychain |

A provider tests itself before going live:

```bash
verifier check http://localhost:8787/.well-known/stellar-agent-services.json --dev
```

A verifier answers a validation request:

```bash
export VERIFIER_PAYER_SECRET=S...        # the dedicated testnet test payer (see below)
verifier verify https://api.example.com/.well-known/stellar-agent-services.json --pay \
  --validator $(stellar keys address verifier) --out evidence/receipts
# Publish evidence/receipts/<sha256>.json at an HTTPS URL, exactly as written, then:
verifier publish evidence/receipts/<sha256>.json --request-hash <hex> \
  --response-uri https://example.com/receipts/<sha256>.json --source verifier
verifier badge evidence/receipts/<sha256>.json --request-hash <hex>
```

| Flag | Meaning |
| --- | --- |
| `--service <name>`, `--input <json>` | The service to pay for and load, and its input. Default: the cheapest service with an example, and that example. |
| `--max-price <usdc>`, `--max-spend <usdc>` | The most the test payer pays for one job (default 0.10) and in one run (default 1.00). |
| `--allow-pubnet` | Pay a provider on pubnet, which is real money. |
| `--rpc <url>` | The Soroban RPC. Default: the public testnet RPC, or on pubnet the one the 8004 SDK uses. |
| `--json` | The report, or the receipt, as JSON on standard output; progress goes to standard error. |

**Exit codes:** `0` every check that ran passed, `1` a check or the command failed, `2` a usage error.

## Conformance levels

| Level | Name | Checks | Score | Badge |
| --- | --- | --- | --- | --- |
| 0 | – | Level 1 not reached | 0 | none |
| 1 | Described | C1 manifest, C6 hygiene | 33 | Standard v1 |
| 2 | Payable | Level 1 + C3 challenge, C4 paid call | 67 | Payment verified |
| 3 | Recoverable | Level 2 + C5 recovery | 100 | Recovery verified |
| – | Registered | C2 identity, plus a Validation Registry record of the receipt | – | 8004 validated |
| – | Load-safe | C7 load | – | Load-safe |

A level counts only checks that **passed**. A skipped check earns nothing, so `verifier check`, which pays for
nothing, reaches level 1 at most.

## How the verifier works

- **From the standard, not from the kit.** The checks follow [provider-standard.md](provider-standard.md) and cite
  its rule ids. They don't reuse the Provider Kit, so a fault the kit shares with its providers can't pass unnoticed.
  The verifier's tests run them against the kit, as a provider that must pass, and against kit providers made to
  break one rule each.
- **MUST fails, SHOULD warns.** Each finding names a rule: an id such as `P4`, or a section such as `§5.5` for a
  requirement the standard states without an id. A broken MUST rule fails the check. An unmet SHOULD rule is a
  warning and never fails it. C7 is the exception: Load-safe certifies the SHOULD rules of §5.8, so they fail it.
- **Failed, or skipped.** A check fails only on what the provider did. When the verifier can't finish a check for
  its own reasons, such as an RPC outage or a provider that stayed busy, the check is skipped with a reason, and
  earns nothing.
- **A careful client.** The verifier sends what a conforming client sends: a fresh job id and token for each job
  [J1], the same request again after a `429` or `503` [Q8], polls no faster than `Retry-After` [Q9].
- **It pays only where a client would.** No payment unless C1 passed and the challenge matches the manifest [P7],
  within the verifier's own limits.
- **The chain decides.** A receipt is a claim [J16]. The verifier matches payments on chain by the auth-entry nonce
  it signed, so another job's payment can never pass as this one's. "Not charged" is proven too: once a payment's
  signature has expired, the chain must show no transfer for it.

Order of a run: C1, C2, C3, C4, C5, C6's probes, C7, then C6 over every exchange. The load test runs late so a
provider's rate limit can't turn away the other checks' requests.

## Checks

### C1 Manifest (§2)

The three steps of §2.4, and more.

| What | Rule |
| --- | --- |
| HTTPS (or loopback `http://` with `--dev`), `200`, `Content-Type: application/json` | M1 |
| No redirect, at most 256 KiB, I-JSON: UTF-8, no lone surrogates, no duplicate keys | M3 |
| `Cache-Control: max-age` of 300 s or less | M4 (warning) |
| The manifest URL has no user info | M6 |
| `standard` of another major version is rejected | M8 |
| The manifest JSON Schema, which also encodes M5, M6, M8, P1, S4 and S5; each error names its JSON Pointer | M9 |
| `checkManifestRules()`: same origin, unique names, schema sizes, examples, `payTo` checksum | M5, M7, S6, S9, P11 |
| Every `inputSchema` and `outputSchema` is a JSON Schema 2020-12 that compiles | §3.3 |
| `on-success` work expected to take at most half of `maxTimeoutSeconds` | S2 (warning) |
| No `if`/`then`/`else` or `patternProperties`, no `oneOf` or `allOf` at the root | S7 (warning) |
| Reverse-DNS extension keys | X1 (warning) |

Duplicate keys matter: `JSON.parse` keeps the last of two `payTo` members, while another parser may keep the
first, so two clients could show different payees.

C1 also decides what the run may do. The provider is **probed** only when the manifest passed the JSON Schema and
its `baseUrl` is on its own origin. It is **paid** only when C1 passed.

### C2 Identity (§7)

Reads only: the 8004 identity registry and the registration file.

| What | Rule |
| --- | --- |
| The agent exists | I2 |
| The registration file, from a `data:` or `https:` agent URI, lists `{ "name": "stellar-agent-services", "endpoint": <manifest URL>, "version": "1" }` | I1 |
| It also lists `{ "name": "web", "endpoint": <baseUrl> }` and sets `x402: true` | I1 (warning) |
| The agent's wallet, `get_agent_wallet(agentId)`, is the manifest's `payTo` | I3 |

Skipped without `provider.agentId`, in development mode, and when the registry or an `ipfs://` registration
can't be read. An `http://` agent URI fails: HTTPS is what proves the file's origin.

### C3 Challenge (§4)

With no payment, for every service the verifier has an input for: its first example that matches `inputSchema`,
the `--input` given for it, or an input built from the schema that validates against it.

| What | Rule |
| --- | --- |
| An input that fails `inputSchema` gets `400 invalid_input`, never a `402` | P8 |
| A valid input gets `402` with the x402 v2 `PAYMENT-REQUIRED` header | P3 |
| The challenge's one `accepts` entry equals the manifest's payment option plus the price | P4 |
| `resource.url` is the public create-job URL | P5 |
| The challenge carries the Bazaar extension | P6 (warning) |
| A `G…` `payTo` exists and holds an authorized USDC trustline | P2 |

### C4 Paid call (§4, §5)

The test payer pays for one job of the target service (`--service`, or the cheapest one with an example).

1. Unpaid create-job with a fresh job id and token: a `402` whose challenge matches the manifest. Otherwise
   nothing is signed [P7].
2. The payment is signed once and sent with the identical request. A busy answer is waited out with the same
   payment while it is valid [Q8], a `409` is followed with get-result [J7], and a lost response is recovered with
   get-result, never paid again.
3. Every job view is checked: the job id is the `Idempotency-Key` (§5.2), `charge` is the manifest's (§3.2),
   `charged` fits the state (§5.6), `200` once finished and otherwise `202` with `Retry-After`, plus `Location` on
   create-job [J8], output only when it may be shown [J14], and a receipt whose terms are the payment's (§5.7).
4. The job must succeed (§5.6), charged, with output that matches `outputSchema` [S1].
5. The receipt's transaction must have succeeded, carry the payment the verifier signed, and move exactly the
   price from the payer to `payTo` [J16]. The response that settled SHOULD carry `PAYMENT-RESPONSE` [P10].

### C5 Recovery (§5.3–§5.5, [job-recovery.md](job-recovery.md))

It recovers C4's job, as a client that lost the create-job response would.

| Request | Expected | Rule |
| --- | --- | --- |
| create-job again: same id, token and input, no payment | `200` and the same job, no `402` | J5 |
| The same, with the same `PAYMENT-SIGNATURE` | the same job; the receipt still names the same transaction | J5, J16 |
| Same id, another input | `422 idempotency_key_reused` | J6 |
| Same id and input, another token | `422 idempotency_key_reused` | J6 |
| check-status and get-result with the token | `200` and the job, get-result with its output | J8, J15 |
| No token, a wrong token, an unknown job, on both | `404 job_not_found`, the same answer each time | J10 |

### C6 Hygiene

Two probes, then every exchange of the run.

| What | Rule |
| --- | --- |
| A body of `maxInputBytes` + 1 bytes is refused with `413 payload_too_large` | §5.4 |
| The job endpoints never redirect | §5.5 |
| Every error but `402` is `application/problem+json`, with a known `code` that goes with the HTTP status | E1 |
| `409` carries `Retry-After`; so do `429` and `503` | J7, §6 |
| No response contains a job token or a signed payment the verifier sent | E2 |
| No response contains a Stellar secret key | §10 |
| CORS on the manifest and the job endpoints, and a preflight that allows them | J17 (warning) |

### C7 Load (§5.8)

| What | Rule |
| --- | --- |
| 20 unpaid create-job requests at once: each answered within 30 s with `402`, or `429`/`503` with `Retry-After` | Q1 |
| With the test payer, once C4 passed: `capacity.concurrency` + 1 jobs paid at once (5 without `capacity`, at most 10) | |
| Each one accepted (`200`, or `202` with `queue` while queued) or refused with `429`/`503` and `Retry-After` | Q3, Q5 |
| Every accepted job finishes, and proves its own payment | Q4, J16 |
| A refused payment never lands: once its signature expired, the chain shows no transfer for it | Q3 |
| check-status and get-result keep answering at capacity | Q7 (warning) |

## The test payer

The paid checks are paid by a **dedicated** testnet account: create one for the verifier, fund it with XLM and
USDC, and keep nothing else in it. Its secret key is read from `VERIFIER_PAYER_SECRET` and stays in memory.

```bash
stellar keys generate verifier-payer --network testnet --fund
stellar tx new change-trust --source-account verifier-payer --network testnet \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
# Testnet USDC: https://faucet.circle.com, or the testnet DEX (`stellar-pay wallet fund` does this for its own key).
export VERIFIER_PAYER_SECRET=$(stellar keys secret verifier-payer)   # `stellar keys show` in older versions
```

A full run against a service that costs 0.01 USDC signs for 0.06 USDC: one C4 job and five C7 jobs.

The verifier's own limits apply before anything is signed:
- one job costs at most `--max-price` (default 0.10 USDC), and a run signs for at most `--max-spend` (default 1.00
  USDC). A payment counts once signed, whether or not it settles;
- pubnet providers are paid only with `--allow-pubnet`;
- each signed payment is decoded before it is sent, and must move exactly the approved asset and amount, from the
  payer, to `payTo`.

## Verification receipt

The verifier issues one receipt per run (`VerificationReceipt` in
[packages/protocol](../packages/protocol/src/receipts.ts), JSON Schema
[verification-receipt.schema.json](../packages/protocol/schemas/verification-receipt.schema.json)). It is published as
RFC 8785 canonical JSON.

| Field | Meaning |
| --- | --- |
| `standard` | `stellar-agent-services/provider@1` |
| `agentId` | The provider's Stellar 8004 agent id. Required to publish to the Validation Registry. |
| `network` | `stellar:testnet` or `stellar:pubnet` |
| `validator` | The verifier's `G…` address, which signs `validation_response` |
| `startedAt`, `checkedAt` | RFC 3339 |
| `level` | The conformance level reached, 0–3 (0: not even Described) |
| `score`, `scoreDirection` | 0, 33, 67 or 100 for levels 0–3; `higher-is-better`. `score` is also the on-chain `response`. |
| `manifest` | `{ url, sha256 }`, where `sha256` is the JCS hash of the parsed manifest. No `sha256` when the manifest could not be read as JSON. |
| `results[]` | One per check, in order C1–C7: `check`, `status` (`passed`, `failed`, `skipped`), `failedRules`, `warnings?`, `reason?` (why it was skipped), `findings?` (each rule, `fail` or `warn`, and what was observed), `evidence?` |
| `payment` | The C4 payment receipt, after the verifier confirmed it on chain |
| `tool` | The software that issued it: `{ name, version }` |

`standard`, `agentId`, `network`, `validator`, `checkedAt`, `score`, `scoreDirection` and `results` form the
envelope shared with Stellar ERC-8126 records ([erc-compatibility.md](erc-compatibility.md), T2).

**Rules beyond the JSON Schema:** `level` is the highest level whose checks all passed, and `score` is that level's.
`verifier badge` and `verifier publish` refuse a receipt that breaks either.

**One file, one hash.** The receipt is written to `<dir>/<sha256>.json`, holding exactly its canonical bytes with
no trailing newline. The name, the SHA-256 of the file and the on-chain `response_hash` are the same value, so
anyone can fetch the `response_uri`, hash it, and compare it with the chain. Upload the file as it is: reformatting
it changes the hash.

**What a receipt never holds:** secrets, job tokens, payment payloads, or text a provider chose. Messages quote a
provider's value only when it is a short plain token, such as an id or a status.

Receipts are issued only for providers served over HTTPS, never in development mode.

## Badges

SVG images derived **only** from a receipt, never from what a provider says about itself.

| Badge | Earned by |
| --- | --- |
| Standard v1 | Level 1 |
| Payment verified | Level 2 |
| Recovery verified | Level 3 |
| Load-safe | C7 passed |
| 8004 validated | C2 passed, and the Validation Registry anchors this receipt |

- **Each badge names the network**, "testnet" or "mainnet", so testnet evidence never passes for mainnet.
- **"8004 validated" needs the chain.** `verifier badge --request-hash <hex>` reads the request's record. The record
  must hold a response by the receipt's validator, for its agent, with its hash, its score and the tag
  `provider-standard-v1`.
- **The badge links back to its evidence.** Its description carries the receipt's SHA-256. Where a badge is shown,
  link it to the receipt.
- **Safe to embed anywhere.** The SVG is self-contained (no fonts, scripts or links), accessible (`role="img"` with a
  title), and the same receipt always gives the same bytes.

Files are written next to the receipt as `<sha256>.<badge>.svg`, for example `<sha256>.payment-verified.svg`.

## Stellar 8004 Validation Registry

The registry ([contract](https://github.com/trionlabs/stellar-8004/tree/main/contracts/validation-registry), testnet
`CC5USZRO26MOIAVNYTTJDS63C2OBBLREOAOET4CPF2EZWO3YFKLMO3SL`) keeps one record per request. Only the validator a
request names may answer it, and may update its answer later.

### 1. The provider's owner asks

```
validation_request(caller = owner, validator_address = <verifier G…>, agent_id, request_uri, request_hash)
```

The request document names what is to be verified:

```json
{
  "standard": "stellar-agent-services/provider@1",
  "type": "validation-request",
  "agentId": 42,
  "network": "stellar:testnet",
  "manifest": "https://api.example.com/.well-known/stellar-agent-services.json",
  "validator": "GBZSBASBFMV5RGKPRIPCB5QQVAJ35IXKMTF2A2766MOA4ZHQ7MLSIPXU",
  "requestedAt": "2026-10-26T10:00:00Z"
}
```

`request_hash` is `sha256(JCS(document))`, the `contentHash` mode of `generateRequestNonce`, and `request_uri` is an
HTTPS URL serving the document, or a `data:application/json;base64,` URI holding it. `requestedAt` makes each request
unique: the registry refuses a hash it already has. `provider-kit request-validation` will do this; until then, the
owner can call it with the Stellar CLI:

```bash
stellar contract invoke --id CC5USZRO26MOIAVNYTTJDS63C2OBBLREOAOET4CPF2EZWO3YFKLMO3SL --source-account owner \
  --network testnet -- validation_request --caller $(stellar keys address owner) \
  --validator_address <verifier G…> --agent_id 42 --request_uri <uri> --request_hash <hex>
```

### 2. The verifier answers

```
validation_response(caller = validator, request_hash, response = score, response_uri = receipt URL,
                    response_hash = sha256(receipt), tag = "provider-standard-v1")
```

`verifier publish` checks everything before the Stellar CLI signs, and refuses when anything is off:
- the receipt is valid, and recent: checked within `--max-age` hours, default 24;
- the request exists, names this validator and the receipt's agent, on the receipt's network;
- `response_uri` is HTTPS and serves exactly the receipt's bytes;
- the `--source` key is the receipt's validator.

The validator key stays in the Stellar CLI keychain; the verifier never reads it. After sending, `publish` reads the
record back to confirm it.

### 3. Anyone reads it

`get_validation_status(request_hash)` returns the validator, agent, score, `response_hash` and tag;
`get_agent_validations_paginated(agent_id)` lists an agent's requests. Fetch the `response_uri`, check its SHA-256
against `response_hash`, and read the receipt. `get_summary(agent_id, validators, "provider-standard-v1")` averages
this standard's records without mixing in other kinds ([erc-compatibility.md](erc-compatibility.md), T2).

## Security considerations

- **Keys.** The test payer holds testnet USDC only, within the verifier's limits. The validator key signs through
  the Stellar CLI keychain and never enters the verifier. Neither is shared with providers, discovery or the payment
  client.
- **The provider is untrusted.** Every request has a deadline and a size limit on its answer, and no redirect is
  followed. Once the manifest names its origin, the verifier sends requests to that origin only, so a manifest can't
  point the load test at someone else's server.
- **Provider schemas are untrusted.** Each compiles in its own Ajv instance, after a check against the JSON Schema
  2020-12 meta-schema; nothing remote is fetched [S5]. A provider can still slow its own run down with a costly
  regular expression in a `pattern`. A verifier run as a shared service should run each verification in its own
  process with a time limit.
- **Address checks.** The verifier does not resolve host names to refuse private addresses. A verifier run as a
  shared service should run where it can reach only the public internet.
- **No secrets in evidence.** Job tokens and signed payments are kept in memory to check that no response echoes
  them [E2], and never written to a receipt or a report.
