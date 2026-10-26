# Provider Standard v1: implementation reference for AI coding agents

Use this file to build or review a **provider** (a paid AI service) or a **client** (an agent, wallet or app that
pays one) that follows Provider Standard v1.

- **Source of truth:** [provider-standard.md](../provider-standard.md). If this file and the spec disagree, the
  spec wins. Cite rules by id, such as `[J5]`.
- **Identifier:** `stellar-agent-services/provider@1`. v1 is frozen and only gains optional fields and SHOULD
  rules.
- **Key words:** MUST, MUST NOT, SHOULD and MAY as in RFC 2119.
- **Human summary:** [README.md](README.md).

## 0. Rules for the agent using this file

1. Pick one path in §1 and follow it. Do not mix the kit with a hand-written job flow.
2. Do not invent manifest fields, headers, status codes or error codes. Put anything extra in `extensions`, with
   reverse-DNS keys `[X1]`.
3. Never put a Stellar secret key in provider code, config or environment. A provider knows only its public
   `payTo` address and a facilitator URL.
4. Treat every money path as fail-closed. When you can't tell whether a payment settled, the job is
   `payment_uncertain`, never `failed` and never retried with a new charge `[J13]`.
5. Validate your work with the JSON Schema and test vectors in §13 before you call it done.
6. One tool is planned but not built yet: `provider-kit request-validation`. Don't tell the user to run it.

## 1. Choose a path

| Situation | Path | Start from |
| --- | --- | --- |
| New service in TypeScript (Node, Workers, Deno, Bun) | **Kit**: `@stellar-agent-services/provider-kit` | §2, [examples/paid-service](../../examples/paid-service) |
| Existing HTTP API in any language | **Gateway**: not built yet. Use Native, or wrap the API with the Kit. | §3–§12 |
| Any other language or stack | **Native**: implement §3–§12 | §3–§12, §13 |
| Agent, wallet or app that pays providers | **Client** | §14, [packages/payment-client](../../packages/payment-client) |

The packages are npm workspaces in this repository and are not yet published to npm. Build inside the repo, or
copy `examples/paid-service`.

## 2. Kit path (TypeScript)

```ts
import { createProvider, defineService } from "@stellar-agent-services/provider-kit";

const textStats = defineService({
  name: "text-stats",                       // ^[a-z0-9][a-z0-9_-]{0,63}$
  description: "Counts words in English text. Use it to check length limits. Up to 20,000 characters.",
  price: "0.01",                            // USDC decimal string; becomes "100000" base units
  charge: "on-success",                     // or "upfront" (the default)
  expectedDurationSeconds: 1,               // required for on-success; at most maxTimeoutSeconds / 2
  capacity: { concurrency: 4, maxQueued: 100, maxQueueWaitSeconds: 60 },   // these are the defaults
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 20000 } } },
  outputSchema: { type: "object", required: ["words"], properties: { words: { type: "integer" } } },
  handler: async ({ text }: { text: string }, { signal }) => ({ words: text.split(/\s+/).filter(Boolean).length }),
});

const provider = createProvider({
  baseUrl: "https://api.example.com",       // https only; http://localhost needs dev: true
  network: "stellar:testnet",
  payTo: "G...",                            // public address with a USDC trustline. Never a secret key.
  facilitator: "https://x402.org/facilitator",
  provider: { name: "Example provider" },
  services: [textStats],
  // optional: maxTimeoutSeconds (30–300, default 60), retentionSeconds, holdSeconds (0–30), store,
  //           rateLimit: { requests, windowSeconds, key: (request) => string | undefined }, dev
});

// Mount provider.fetch(request) on any Fetch API server. Hono: app.all("*", (c) => provider.fetch(c.req.raw)).
```

The kit implements §3–§12: the manifest, the challenge, the processing order, jobs, capacity and errors. A handler
receives only the parsed input and an `AbortSignal`, never payment data. Throw to fail the job. Error messages are
not passed on to the client `[E2]`.

Known gaps: the job store is in memory, so jobs are lost on restart. Queues are per process.

## 3. Constants

| Name | Value |
| --- | --- |
| `standard` | `stellar-agent-services/provider@1` |
| Default manifest path | `/.well-known/stellar-agent-services.json` |
| Manifest size | ≤ 256 KiB, I-JSON (RFC 7493) |
| Services per manifest | 1–25 |
| Service name | `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `inputSchema` / `outputSchema` | JSON Schema 2020-12, root `"type": "object"`, each ≤ 32 KiB as canonical JSON |
| `maxInputBytes` | default 1,048,576, maximum 10,485,760 |
| `examples` / `tags` | ≤ 5 / ≤ 10, tag pattern `^[a-z0-9-]{1,32}$` |
| `price.amount` | `^[1-9][0-9]{0,37}$`, USDC base units, 7 decimals (`"100000"` = 0.01 USDC) |
| `maxTimeoutSeconds` | 30–300 |
| `jobs.retentionSeconds` | default 86400, minimum 3600 |
| Networks (CAIP-2) | `stellar:testnet`, `stellar:pubnet` |
| USDC asset, testnet | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| USDC asset, pubnet | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| `Idempotency-Key` (job id) | lowercase UUID: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| `Job-Token` | 32 random bytes, base64url without padding: `^[A-Za-z0-9_-]{43}$` |
| create-job hold | ≤ 30 s, then `202` |
| `Retry-After` | whole seconds; `202` responses use 1–60 |
| Problem `type` | `https://algorialabs.github.io/stellar-agent-services/provider/1#error-<code>` (provisional) |

## 4. Manifest

Required: `standard`, `provider.name`, `baseUrl`, `payment`, `services[]`, and for each service `name`,
`description`, `price.amount`, `inputSchema` and `outputSchema`. `expectedDurationSeconds` is required when
`charge` is `on-success`.

Minimal valid manifest (from `test-vectors/manifests.json`, base `minimal`):

```json
{
  "standard": "stellar-agent-services/provider@1",
  "provider": { "name": "Minimal Provider" },
  "baseUrl": "https://minimal.example.com",
  "payment": {
    "protocol": "x402",
    "x402Version": 2,
    "accepts": [
      {
        "scheme": "exact",
        "network": "stellar:testnet",
        "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        "payTo": "GBZSBASBFMV5RGKPRIPCB5QQVAJ35IXKMTF2A2766MOA4ZHQ7MLSIPXU",
        "maxTimeoutSeconds": 60,
        "extra": { "areFeesSponsored": true }
      }
    ]
  },
  "services": [
    {
      "name": "echo",
      "description": "Returns its input unchanged. Useful for testing a client.",
      "price": { "amount": "1" },
      "inputSchema": { "type": "object" },
      "outputSchema": { "type": "object" }
    }
  ]
}
```

Optional fields:
- `provider`: `description`, `homepage`, `agentId` (u32), `termsUrl`, `dataUse.storesInputs`,
  `dataUse.trainsOnInputs`
- top level: `jobs.retentionSeconds`
- per service: `title`, `charge` (default `upfront`), `expectedDurationSeconds`, `examples`, `maxInputBytes`,
  `tags`, `capacity.concurrency` (≥ 1), `capacity.maxQueueWaitSeconds` (≥ 0)
- top level and per service: `extensions`

Serving and validating it:
- Serve it over HTTPS with status `200` and `Content-Type: application/json` `[M1]`, and SHOULD send
  `Cache-Control: max-age` of 300 or less `[M4]`.
- `baseUrl` is HTTPS, has the manifest's origin, and has no user info, query, fragment, empty path segment or
  trailing slash `[M5]`.
- Every URL is HTTPS, at most 300 characters, without user info. Loopback `http://` is allowed only in a dev mode
  `[M6]`.
- Validate in three steps: fetch rules `[M1] [M3]`, then the JSON Schema
  ([manifest.schema.json](../../packages/protocol/schemas/manifest.schema.json)) `[M9]`, then the rules the
  schema can't express (`checkManifestRules()`): M1, M3, M5, M7, S6, S9, P11.
- Descriptions say what the service does, when to use it, and its limits. They contain no prices, URLs or
  instructions to the agent (§3.4).
- Schemas use the portable subset: `type properties required additionalProperties items enum const minimum maximum
  minLength maxLength minItems maxItems pattern format title description default examples anyOf $defs` with local
  `$ref`. Avoid `if/then/else`, `patternProperties`, and `oneOf`/`allOf` at the root `[S7]`. Pass large media as
  HTTPS URLs (`"format": "uri"`). URLs in an output stay valid for `retentionSeconds` `[S8]`.

## 5. Endpoints and headers

| Operation | Request | Auth | Returns |
| --- | --- | --- | --- |
| manifest | `GET <manifest URL>` | none | manifest |
| create-job | `POST {baseUrl}/services/{name}/jobs`, body = the input object, `Content-Type: application/json` | x402 payment | job view, `402`, or a problem |
| check-status | `GET {baseUrl}/jobs/{jobId}` | `Job-Token` | job view without `output` |
| get-result | `GET {baseUrl}/jobs/{jobId}/result` | `Job-Token` | job view with `output` when succeeded |

| Header | Direction | Meaning |
| --- | --- | --- |
| `Idempotency-Key` | client → provider | The job id. Send both it and `Job-Token`, or neither `[J1]`. |
| `Job-Token` | client → provider | Bearer secret for the job `[J3]` |
| `PAYMENT-REQUIRED` | provider → client | base64 x402 v2 `PaymentRequired`, on `402` `[P3]` |
| `PAYMENT-SIGNATURE` | client → provider | base64 x402 v2 `PaymentPayload` |
| `PAYMENT-RESPONSE` | provider → client | base64 x402 `SettleResponse`, on the response that settled `[P10]` |
| `Location` | provider → client | `{baseUrl}/jobs/{jobId}` on a create-job `202` |
| `Retry-After` | provider → client | Whole seconds, on `202`, `409`, `429` and `503` |

CORS `[J17]` (SHOULD), on the manifest and all three endpoints:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE, Location, Retry-After`
- `OPTIONS` preflight: `Access-Control-Allow-Methods: GET, POST` and
  `Access-Control-Allow-Headers: Content-Type, Idempotency-Key, Job-Token, PAYMENT-SIGNATURE`

## 6. create-job algorithm (provider)

Follow this order exactly `[§5.4]`. The first failing step answers.

```
POST {baseUrl}/services/{name}/jobs
 1. Headers and body
    - only one of Idempotency-Key / Job-Token        → 400 invalid_request
    - malformed Idempotency-Key or Job-Token          → 400 invalid_request
    - Content-Type is not application/json            → 400 invalid_request
    - body larger than maxInputBytes                  → 413 payload_too_large
                                                        (the service's limit; apply the 10 MiB cap before the lookup)
    - body is not valid UTF-8 JSON                    → 400 invalid_request
    - body is not a JSON object                       → 400 invalid_input
 2. Unknown service                                   → 404 service_not_found
 3. The job id exists [J5–J7]
    - other binding hash or other token               → 422 idempotency_key_reused
    - still being claimed, verified or settled        → 409 request_in_progress + Retry-After
    - otherwise                                       → the existing job view (200/202). No new 402.
                                                        Never settle a payment sent with it.
 4. Input fails inputSchema                           → 400 invalid_input, errors[] = [{ pointer, message }]
 5. Capacity [P8][Q1–Q3]
    - caller over its rate limit                      → 429 rate_limited + Retry-After
    - no slot and no room in the queue                → 503 unavailable + Retry-After
 6. No PAYMENT-SIGNATURE                              → 402 + PAYMENT-REQUIRED (§7)
 7. Decode and verify the payment with the facilitator
    - undecodable, or `accepted` doesn't match        → 402 (x402 error e.g. "invalid_payment")
    - facilitator says invalid                        → 402 (x402 error = its reason)
    - facilitator unreachable                         → 503 unavailable ("nothing was charged")
 8. In ONE atomic step, claim the job id (binding hash, sha256(token)) AND the payment fingerprint [J4][P9]
    - payment fingerprint already used                → 402, x402 error "payment_already_used"
    - an identical request won the race               → that job's view; do not settle [J5]
 9. Settle and run in the order set by `charge` (§8)
10. Respond: wait up to 30 s [J9]
    - job finished                                    → 200 (+ PAYMENT-RESPONSE if this response settled)
    - otherwise                                       → 202 + Location + Retry-After
```

Without `Idempotency-Key` and `Job-Token`, the provider generates both and returns them once, as `jobId` and
`jobToken` in the create-job response `[J2]`.

**Binding hash** `[§5.3]`: `bindingHash = lowercase hex(sha256(JCS({"service": name, "input": input})))`, where JCS
is RFC 8785 canonical JSON. For example, service `text-stats` with input `{"text":"Hello world."}` canonicalizes to
`{"input":{"text":"Hello world."},"service":"text-stats"}` and hashes to
`3d3b3dbdf90621535bd77d1f1d2a1ed0334bf875c7dc7c023caa48cad949ce87`.

**Storage:** keep `jobId`, `service`, `charge`, `bindingHash`, `sha256(Job-Token)` (never the token itself), the
status, timestamps, `output`, `error` and the payment receipt. Make the job id and the payment fingerprint unique
in the same transaction. Compare token hashes in constant time `[J3]`.

## 7. Payment (x402 v2, `exact` scheme on Stellar)

- The manifest has exactly one `payment.accepts` entry, with no `amount` `[P1]`. A `G…` `payTo` has a USDC
  trustline `[P2]` and every `payTo` is a valid strkey `[P11]`. Muxed `M…` addresses are not allowed.
- **Challenge:** the `402` carries a `PAYMENT-REQUIRED` header `[P3]` that decodes to:

  ```json
  {
    "x402Version": 2,
    "resource": { "url": "{baseUrl}/services/{name}/jobs", "description": "…", "mimeType": "application/json" },
    "accepts": [{ "scheme": "exact", "network": "…", "asset": "…", "payTo": "…", "amount": "<price.amount>",
                  "maxTimeoutSeconds": 60, "extra": { "areFeesSponsored": true } }]
  }
  ```

  - `accepts` has exactly one entry, equal to the manifest entry plus `amount` = the service's `price.amount` `[P4]`.
  - `resource.url` is the public HTTPS create-job URL `[P5]`.
  - It SHOULD include x402's Bazaar extension `[P6]`.
- **Paid request:** the same request plus `PAYMENT-SIGNATURE`. Reject a payload whose `x402Version` isn't 2, or
  whose `accepted` differs from the challenge in `scheme`, `network`, `asset`, `amount` or `payTo`.
- **Facilitator:** verify and settle through an x402 facilitator that supports the network with scheme `exact` and
  sponsored fees, such as `https://x402.org/facilitator` on testnet. The provider never signs anything.
- **Settlement outcome:**
  - `settled`: success with a transaction hash.
  - `failed`: only when the facilitator said success is false and gave no transaction.
  - `uncertain`: everything else, including timeouts, 5xx and exceptions. The job becomes `payment_uncertain` and
    is decided later from on-chain data, never by charging again `[J13]`.
- **One payment, one job:** a payment fingerprint is unique `[P9]`.

## 8. Charge policies, states and the job view

| `charge` | Order | If the work fails |
| --- | --- | --- |
| `on-success` | verify → queued → running → work → validate output → settle | Not charged. Settle only if the output matches `outputSchema` `[S1]`. |
| `upfront` | verify → settle → queued → running → work | Charged. v1 has no refunds. |

- `[S2]`: the signed payment expires about `maxTimeoutSeconds` after signing.
  - An `on-success` job whose work and settlement don't finish in time fails, uncharged.
  - Keep `expectedDurationSeconds` ≤ `maxTimeoutSeconds / 2`, and use `upfront` for longer work.

**Transitions** (anything else is forbidden):

```
(new)             → queued | running | payment_uncertain | failed
queued            → running
running           → succeeded | failed | payment_uncertain      (→ payment_uncertain: on-success only)
payment_uncertain → queued | succeeded | failed                 (decided from on-chain data)
succeeded, failed → final [J12]
```

**`charged`:**
- `queued` and `running`: `true` for `upfront`, `false` for `on-success`.
- `succeeded`: `true`.
- `failed`: `true` for `upfront`, except when `error.code` is `payment_failed`; `false` for `on-success`.
- `payment_uncertain`: `"unknown"`.

**Job view** (the body of create-job, check-status and get-result):

```json
{
  "jobId": "0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d",
  "service": "text-stats",
  "status": "queued | running | succeeded | failed | payment_uncertain",
  "charge": "on-success | upfront",
  "charged": true,
  "createdAt": "RFC 3339", "updatedAt": "RFC 3339", "expiresAt": "RFC 3339",
  "output":   { "…": "create-job and get-result, only when succeeded; withheld while payment_uncertain [J14]" },
  "error":    { "type": "…#error-timeout", "title": "…", "code": "service_failed | output_invalid | timeout | payment_failed", "detail": "…" },
  "payment":  { "network": "…", "asset": "…", "amount": "…", "payTo": "…", "payer": "G…", "transaction": "<tx hash>", "settledAt": "RFC 3339" },
  "queue":    { "position": 1, "estimatedStartAt": "RFC 3339" },
  "jobToken": "only in the create-job response, only when the provider generated it [J2]"
}
```

- `error` is present only when `failed`, `payment` only when `charged` is `true`, and `queue` only when `queued`
  `[Q5]`.
- `200` when the job is finished, otherwise `202` with `Retry-After` `[J8]`.
- check-status and get-result never take a payment or cause a charge `[J11]`.
- An unknown job, an expired job, and a missing or wrong token all return the same `404 job_not_found` `[J10]`.
- Jobs stay retrievable for `retentionSeconds` after they finish `[J15]`.

## 9. Capacity and queuing `[§5.8]`

- Check capacity at step 5, before the `402` and before verifying a payment. Check it again on the paid request.
  - `503 unavailable`: the service is full.
  - `429 rate_limited`: this caller sent too many requests.
  - Both carry `Retry-After`, and neither charges anything `[Q1] [Q3]`.
- Admit a job only if it should start within `capacity.maxQueueWaitSeconds`. For `on-success`, it must also finish
  work and settlement before the payment expires `[Q2]`.
- An accepted job is not failed because of load.
  - It waits as `queued`, and a paid `upfront` job SHOULD survive a restart.
  - An `on-success` job that can't start before its payment expires goes `running` → `failed` with `timeout`,
    uncharged `[Q4]`.
- Report the queue in the job view: `"queue": { "position": 1, "estimatedStartAt": "…" }`. Position 1 starts next
  `[Q5]`.
- A `202`'s `Retry-After` reflects when the job will likely change, 1–60 s `[Q6]`.
- Never apply capacity limits to check-status or get-result `[Q7]`.
- Reference admission rule, as in the kit:
  - A service has `concurrency` slots, and `ahead = running + admitted-but-unclaimed + waiting`.
  - When `ahead < concurrency`, the job starts now.
  - Otherwise `position = ahead − concurrency + 1` and `wait = ceil(position / concurrency) × average job seconds`.
    Reject when `position > maxQueued` or `wait > maxQueueWaitSeconds`.

## 10. Errors

Every error other than `402` is RFC 9457, sent as `Content-Type: application/problem+json`:

```json
{ "type": "https://algorialabs.github.io/stellar-agent-services/provider/1#error-invalid_input",
  "title": "Input does not match the service's inputSchema", "status": 400, "code": "invalid_input",
  "detail": "optional, written by the provider", "errors": [{ "pointer": "/text", "message": "must be a string" }] }
```

| `code` | HTTP | When | `Retry-After` |
| --- | --- | --- | --- |
| `invalid_request` | 400 | Malformed JSON, wrong content type, bad header, or only one of `Idempotency-Key` / `Job-Token` | |
| `invalid_input` | 400 | Input fails `inputSchema`; `errors[]` has JSON Pointers | |
| `service_not_found` | 404 | No such service | |
| `job_not_found` | 404 | Unknown or expired job, or a wrong or missing token | |
| `request_in_progress` | 409 | The job id is being claimed, verified or settled `[J7]` | yes |
| `payload_too_large` | 413 | Body over `maxInputBytes` | |
| `idempotency_key_reused` | 422 | Same job id, different request `[J6]` | |
| `rate_limited` | 429 | This caller sent too many requests `[Q1]` | yes |
| `unavailable` | 503 | At capacity, or a dependency is down | yes |

- Job failure codes, in the job view's `error.code`: `service_failed`, `output_invalid`, `timeout` and
  `payment_failed`. A failed job's `error` has no `status`.
- `[E1]` Clients act on `code`, never on `title` or `detail`.
- `[E2]` Problems never contain request headers, payment payloads or job tokens. Never copy a handler's exception
  message into `detail`.

## 11. Identity (Stellar 8004)

- `[I1]` The provider's 8004 registration file lists
  `{ "name": "stellar-agent-services", "endpoint": "<manifest URL>", "version": "1" }` in `services`. It SHOULD
  also list `{ "name": "web", "endpoint": "<baseUrl>" }` and set the `x402` flag.
- `[I2]` `provider.agentId` in the manifest is that registration's id.
- `[I3]` The manifest's `payTo` equals `get_agent_wallet(agentId)` on chain.
- Registration and validation requests are owner actions. They run offline and sign through the Stellar CLI
  keychain, never in the provider runtime.

## 12. Security invariants (provider)

- No Stellar secret key in the runtime, config, environment or logs.
- Store `sha256(Job-Token)` only, and compare in constant time.
- A `404` never reveals whether a job exists.
- One payment buys at most one job. A repeated request never settles again.
- An uncertain settlement is never retried with a new charge.
- Schemas never reference remote documents `[S5]`.
- Output is validated before settling (`on-success`) and before storing.
- Problems and logs sent to clients never echo headers, payment payloads or tokens.
- `description`, `title` and `examples` are untrusted text for clients. Write them as plain descriptions, not as
  instructions.

## 13. Testing and conformance

**Test vectors** in [packages/protocol/test-vectors](../../packages/protocol/test-vectors). Each file explains
itself in its `description`.

| File | Pins |
| --- | --- |
| `manifests.json` | Manifest validation: JSON Schema cases and code-rule cases, as RFC 6902 patches to a base |
| `challenges.json` | `checkChallenge`: a `402` versus the approved manifest `[P3–P5]` |
| `canonical-json.json` | RFC 8785 output, including number formatting |
| `binding-hash.json` | Binding hashes `[§5.3]` |
| `headers.json` | `Idempotency-Key` and `Job-Token` patterns, and `Retry-After` parsing |
| `job-states.json` | Allowed transitions and `charged` per status, charge and failure code |
| `problems.json` | Error codes, HTTP statuses and which ones carry `Retry-After` |

**TypeScript helpers** in `@stellar-agent-services/protocol`, which has no runtime dependencies:
`checkManifestRules`, `checkChallenge`, `canonicalJson`, `canonicalSha256`, `bindingHash`, `canTransition`,
`chargedFor`, `jobViewHttpStatus`, `parseRetryAfter`, `problem`, `jobError`, `createJobUrl`, `jobStatusUrl`,
`jobResultUrl`, `stellarAddressKind`, `USDC_ASSET`.

**A real paid call on testnet** against a local provider, using the payment client CLI (see
[packages/payment-client/README.md](../../packages/payment-client/README.md)):

```bash
npx stellar-pay wallet create
npx stellar-pay wallet fund --usdc 2
npx stellar-pay pay http://localhost:8787/.well-known/stellar-agent-services.json text-stats '{"text":"Hello agents."}' --dev
```

**Acceptance checklist for a provider:**
- [ ] The manifest passes the JSON Schema and `checkManifestRules` with no violations.
- [ ] Invalid input returns `400 invalid_input` and never a `402`.
- [ ] An unpaid valid request returns a `402` whose challenge passes `checkChallenge`.
- [ ] A paid request returns `200`/`202`, and the job view's `payment.transaction` is a real transfer to `payTo`.
- [ ] Repeating the paid request (same id, token and input) returns the same job, with exactly one transfer on
  chain.
- [ ] The same id with another input returns `422`. A wrong token returns `404`.
- [ ] A facilitator timeout during settlement gives `payment_uncertain`, not `failed`.
- [ ] A burst of 20 simultaneous requests gets only `402`, `429` or `503` with `Retry-After`. No `500`, no
  timeout.
- [ ] check-status and get-result work while the service is at capacity.
- [ ] CORS headers are present, including on `OPTIONS`.

**Conformance levels** `[§8]`:
- **1 Described:** C1 manifest + C6 hygiene.
- **2 Payable:** + C3 challenge + C4 paid call.
- **3 Recoverable:** + C5 recovery.
- Independent of the levels: **Registered** (C2 identity + a Validation Registry record) and **Load-safe** (C7
  load).
- The checks are defined in [verification.md](../verification.md). Run them with
  `node packages/verifier/dist/cli/index.js check <manifest-url>` (`--dev` for `http://localhost`): every check that
  needs no payment. Exit code 0 means every check that ran passed; each failure names its rule id.

## 14. Client rules (agents, wallets, apps)

- Fetch the manifest with no redirects, at most 256 KiB, as I-JSON `[M3]`.
  - Ignore unknown fields, and reject another major `standard` `[M8]`.
  - Never fetch remote schemas `[S5]`.
- Before the first request, generate and **persist** a UUID job id and a 32-byte token `[J1]`. Recovery depends on
  them.
- Unpaid create-job → `402`. Compare the challenge with the approved manifest, and refuse to sign on any mismatch
  `[P7]`.
  - Show the price, recipient, network and `charge` before approval `[S3]`.
- Sign once. Send the paid request with the same id, token and input.
- `429` / `503` from create-job: wait `Retry-After` plus jitter, then send the identical request again `[Q8]`.
  - On a paid request, send the same `PAYMENT-SIGNATURE`.
  - Stop before the payment expires, and give up after a bounded wait.
  - The user was not charged.
- `202`: poll check-status or get-result no faster than `Retry-After`. A `429` or `503` while polling means "later"
  `[Q9]`. Use an HTTP timeout above 30 s `[J9]`.
- Lost response, crash or timeout after sending payment: recover with get-result. **Never sign or pay again** for
  that job.
- `payment_uncertain`: stop polling and tell the user not to pay again. Only the provider resolves it `[J13]`.
- Show "paid" only after confirming the transaction on chain against what the user approved, not against the
  receipt. One transaction proves one job `[J16]`.
- Label `description`, `title` and `examples` as provider-supplied when you show them to an LLM (§10 of the spec).
- Map each service 1:1 to an MCP tool with `name`, `title`, `description`, `inputSchema` and `outputSchema`. Keep
  price, network and `charge` out of the tool definition (Appendix B).

## 15. Common mistakes

| Mistake | Rule |
| --- | --- |
| Answering `402` before validating input or checking capacity | P8, Q1 |
| `amount` in the manifest's payment option, or more than one `accepts` entry | P1 |
| `baseUrl` with a trailing slash, or on another origin than the manifest | M5 |
| Settling again when a known job id is repeated | J5 |
| Deriving the job id from the input instead of `Idempotency-Key` | J4 |
| Different responses for "unknown job" and "wrong token" | J10 |
| Storing the raw `Job-Token` | J3 |
| Echoing headers, payment payloads, tokens or exception messages in errors | E2 |
| Marking a facilitator timeout as `failed`, or settling again | J13 |
| Long `on-success` work (more than `maxTimeoutSeconds / 2`) | S2 |
| `500`, a dropped connection or a hang under load instead of `503` + `Retry-After` | Q1 |
| Rate-limiting check-status or get-result | Q7 |
| `Retry-After` as a decimal, or missing on `409`, `429` or `503` | §6, Q1 |
| Holding create-job open longer than 30 s | J9 |
| CORS without `Access-Control-Expose-Headers`, so browsers can't read `PAYMENT-REQUIRED` | J17 |
| A non-object schema root, or a remote `$ref` | S4, S5 |
| Price, URLs or agent instructions in `description` | §3.4 |
| Changing a finished job | J12 |
| A muxed `M…` `payTo` | P11, §4.1 |

## 16. Rule index

Manifest:
- **M1** The manifest is served over HTTPS, `200`, `application/json`.
- **M2** Any URL. The default is `/.well-known/stellar-agent-services.json`, and the 8004 registration points to
  the actual URL.
- **M3** Clients don't follow redirects. At most 256 KiB, I-JSON.
- **M4** SHOULD send `Cache-Control: max-age` ≤ 300.
- **M5** `baseUrl` is HTTPS on the manifest's origin, with no user info, query, fragment, empty segment or trailing
  `/`.
- **M6** URLs are HTTPS, ≤ 300 characters, without user info. Loopback `http://` only in dev mode.
- **M7** Service names are unique.
- **M8** Clients ignore unknown fields and reject another major `standard`.
- **M9** The manifest is valid against the JSON Schema.

Services:
- **S1** `on-success` settles only for output that is valid against `outputSchema`.
- **S2** A payment expires about `maxTimeoutSeconds` after signing; overrunning `on-success` work fails uncharged.
  SHOULD keep the expected duration ≤ half of it.
- **S3** Clients show `charge` before approval.
- **S4** Schema roots are `"type": "object"`.
- **S5** No external `$ref` or `$dynamicRef`; `$schema` is 2020-12 only; clients never fetch remote schemas.
- **S6** Each schema is ≤ 32 KiB as canonical JSON.
- **S7** SHOULD use the portable JSON Schema subset.
- **S8** URLs in an output stay valid for `retentionSeconds`.
- **S9** Examples validate against their schemas.

Payment:
- **P1** Exactly one `accepts` entry, without `amount`.
- **P2** A `G…` `payTo` has a USDC trustline.
- **P3** Unpaid create-job returns `402` with `PAYMENT-REQUIRED` (x402 v2).
- **P4** The challenge's single entry equals the manifest's, plus `amount` = the price.
- **P5** `resource.url` is the public HTTPS create-job URL.
- **P6** SHOULD include the Bazaar extension.
- **P7** Clients compare the challenge with the approved manifest and refuse to sign on a mismatch.
- **P8** Validate the input and check capacity before any `402`.
- **P9** One payment buys at most one job; a reused one gets `402` `payment_already_used`.
- **P10** SHOULD send `PAYMENT-RESPONSE` on the response that settled.
- **P11** `payTo` is a valid strkey.

Jobs:
- **J1** Clients SHOULD send `Idempotency-Key` and `Job-Token`, MUST send both or neither, and save them before
  paying.
- **J2** If both are missing, the provider generates them and returns them once.
- **J3** Store `sha256(Job-Token)` only, and compare in constant time.
- **J4** A job id is bound to one binding hash and one token hash forever.
- **J5** Same id, binding and token returns the existing job: no new `402`, and an attached payment is never
  settled.
- **J6** Same id with another binding or token returns `422 idempotency_key_reused`.
- **J7** A job id still being claimed or settled returns `409 request_in_progress` with `Retry-After`.
- **J8** Finished returns `200`; otherwise `202` with `Retry-After`, plus `Location` on create-job.
- **J9** Hold create-job ≤ 30 s, then `202`. Clients use a timeout above 30 s.
- **J10** Unknown, expired and wrong-token jobs all return `404 job_not_found`.
- **J11** check-status and get-result never take a payment or charge.
- **J12** `succeeded` and `failed` are final; a retry uses a new job id.
- **J13** An uncertain settlement is never re-charged; it is decided on chain, and `failed` with `charged: false`
  if it wasn't settled.
- **J14** Output is withheld while `payment_uncertain`.
- **J15** Jobs stay retrievable for `retentionSeconds` after they finish.
- **J16** Clients confirm the transaction on chain against what they approved; one transaction proves one job.
- **J17** SHOULD allow CORS on the manifest and the three endpoints.

Capacity:
- **Q1** SHOULD answer `503` when full and `429` when over the rate limit, with `Retry-After`, before payment.
- **Q2** SHOULD admit a job only if it should start within `maxQueueWaitSeconds`, and `on-success` jobs only if
  they finish before the payment expires.
- **Q3** SHOULD check capacity again on the paid request; a `429` or `503` means nothing was charged.
- **Q4** Load SHOULD NOT fail an accepted job, and queued `upfront` jobs SHOULD survive restarts.
- **Q5** A queued job SHOULD include `queue: { position, estimatedStartAt }`.
- **Q6** A `202`'s `Retry-After` SHOULD reflect the next likely change, 1–60 s.
- **Q7** SHOULD keep check-status and get-result outside capacity limits.
- **Q8** Clients SHOULD retry a busy create-job with the identical request and the same signed payment, within the
  payment's validity.
- **Q9** Clients SHOULD poll no faster than `Retry-After`; a busy answer while polling means "later".

Errors, identity and extensions:
- **E1** Every problem has a `code`, and clients act on it.
- **E2** Problems never contain headers, payment payloads or job tokens.
- **I1** The 8004 registration lists the manifest under `stellar-agent-services`.
- **I2** `provider.agentId` is that registration's id.
- **I3** `payTo` equals `get_agent_wallet(agentId)`.
- **X1** Extra fields go in `extensions` with reverse-DNS keys, and clients ignore unknown ones.
