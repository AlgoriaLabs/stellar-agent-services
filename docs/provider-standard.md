# Provider Standard v1

> **Status: draft.** Freezes at the end of Week 1 (SOW Deliverable 1). After the freeze, v1 only gains optional
> fields. Identifier: `stellar-agent-services/provider@1`.

This standard describes how a paid AI service on Stellar publishes its purpose, input, output, price, network,
job status and result. Any client can then find it, pay for it once and collect the result, even if the
connection drops.

It works with any language or stack. The Provider Kit is optional: a provider can implement this document
directly, or put the kit's gateway in front of an existing API.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Each rule has an id, such as
**[M3]**, which verification receipts cite.

## Contents

1. [Overview](#1-overview)
2. [Manifest](#2-manifest)
3. [Services](#3-services)
4. [Payment](#4-payment)
5. [Jobs](#5-jobs)
6. [Errors](#6-errors)
7. [Stellar 8004 identity](#7-stellar-8004-identity)
8. [Conformance levels](#8-conformance-levels)
9. [Versioning and extensions](#9-versioning-and-extensions)
10. [Security considerations](#10-security-considerations)
11. [Not in v1](#11-not-in-v1)
12. [Appendix A: example exchange](#appendix-a-example-exchange)
13. [Appendix B: mapping a service to an MCP tool](#appendix-b-mapping-a-service-to-an-mcp-tool)

## 1. Overview

```
Stellar 8004 registration ──▶ manifest ──▶ create-job ──402──▶ pay (x402) ──▶ job
                                                                              │
                                              check-status / get-result ◀─────┘
```

1. The provider's Stellar 8004 registration points to its **manifest**.
2. The manifest lists **services**, each with a price and input and output schemas.
3. The client calls **create-job**. The provider answers `402 Payment Required` with an x402 challenge.
4. The client pays and repeats the request. The provider returns the job: finished (`200`) or still running
   (`202`).
5. If the response is lost, the client uses **check-status** and **get-result**. It never pays again.

### Built on

| Concern | Standard |
| --- | --- |
| Payment | [x402 v2](https://github.com/coinbase/x402), `exact` scheme on Stellar |
| Input and output | JSON Schema 2020-12, with MCP tool field names |
| Idempotency | [IETF Idempotency-Key](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header) (draft-07) |
| Long-running work | HTTP `202 Accepted` with `Location` and `Retry-After` |
| Errors | RFC 9457 problem details |
| Hashing | SHA-256 over RFC 8785 canonical JSON (JCS) |
| Identity | Stellar 8004 (ERC-8004) registration file |

Only three things are specific to this standard:
- the manifest
- the job token
- the rules that bind one job to one request and one payment

### Ways to implement

| Path | For | What the provider writes |
| --- | --- | --- |
| **Gateway** | any existing HTTP API, in any language | A config file. The gateway handles the manifest, payment and jobs, then forwards the input to the upstream API. |
| **TypeScript library** | new services on Node, Workers, Deno or Bun | `defineService(...)` plus a handler function |
| **Native** | any language | This document. The manifest JSON Schema, test vectors and `verifier check` confirm conformance. |

## 2. Manifest

### 2.1 Location

- **[M1]** The manifest MUST be served over HTTPS with status `200` and `Content-Type: application/json`.
- **[M2]** It MAY be at any URL. The default is `/.well-known/stellar-agent-services.json` on the provider's
  origin. The Stellar 8004 registration points to the actual URL (§7).
- **[M3]** Clients MUST NOT follow redirects when fetching the manifest. The manifest MUST be at most 256 KiB.
- **[M4]** Providers SHOULD send `Cache-Control: max-age` of 300 seconds or less.

### 2.2 Example

```json
{
  "standard": "stellar-agent-services/provider@1",
  "provider": {
    "name": "Example Text Tools",
    "description": "Small, deterministic text utilities for agents.",
    "homepage": "https://example.com",
    "agentId": 42,
    "termsUrl": "https://example.com/terms",
    "dataUse": { "storesInputs": false, "trainsOnInputs": false }
  },
  "baseUrl": "https://api.example.com/agent",
  "payment": {
    "protocol": "x402",
    "x402Version": 2,
    "accepts": [
      {
        "scheme": "exact",
        "network": "stellar:testnet",
        "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        "payTo": "<payTo G… address>",
        "maxTimeoutSeconds": 60,
        "extra": { "areFeesSponsored": true }
      }
    ]
  },
  "jobs": { "retentionSeconds": 604800 },
  "services": [
    {
      "name": "text-stats",
      "title": "Text statistics",
      "description": "Counts words, sentences and characters in English text. Use it to check length limits before publishing. Accepts up to 20,000 characters.",
      "price": { "amount": "100000" },
      "charge": "on-success",
      "expectedDurationSeconds": 2,
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": { "text": { "type": "string", "maxLength": 20000 } },
        "required": ["text"],
        "additionalProperties": false
      },
      "outputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "words": { "type": "integer" },
          "sentences": { "type": "integer" },
          "characters": { "type": "integer" }
        },
        "required": ["words", "sentences", "characters"]
      },
      "examples": [
        { "input": { "text": "Hello world." }, "output": { "words": 2, "sentences": 1, "characters": 12 } }
      ],
      "tags": ["text", "analysis"]
    }
  ]
}
```

The `asset` above is the testnet USDC Stellar Asset Contract. Implementations take it from `@x402/stellar`
(`USDC_TESTNET_ADDRESS`, `USDC_PUBNET_ADDRESS`) rather than retyping it. The `payTo` is a placeholder.

### 2.3 Fields

Required fields are in **bold**.

| Field | Type | Rules |
| --- | --- | --- |
| **`standard`** | string | `stellar-agent-services/provider@1` |
| **`provider.name`** | string | 1–120 characters |
| `provider.description` | string | ≤ 500 characters |
| `provider.homepage` | URL | HTTPS |
| `provider.agentId` | integer | Stellar 8004 agent id (u32). Needed for the identity check (§7). |
| `provider.termsUrl` | URL | HTTPS |
| `provider.dataUse.storesInputs` | boolean | Whether inputs are kept after the job finishes |
| `provider.dataUse.trainsOnInputs` | boolean | Whether inputs are used to train models |
| **`baseUrl`** | URL | Job endpoints live under it (§5.1) |
| **`payment.protocol`** | string | `x402` |
| **`payment.x402Version`** | integer | `2` |
| **`payment.accepts`** | array | Exactly one entry in v1 (§4.1) |
| `jobs.retentionSeconds` | integer | How long results stay retrievable. Default 86400, minimum 3600. |
| **`services`** | array | 1–25 services (§3) |
| `extensions` | object | See §9 |

- **[M5]** `baseUrl` MUST be HTTPS, MUST have the same origin as the manifest URL, MUST NOT have a query or
  fragment, and MUST NOT end with `/`.
- **[M6]** Every URL in the manifest MUST be HTTPS and at most 300 characters.
- **[M7]** Service `name` values MUST be unique within the manifest.
- **[M8]** Clients MUST ignore fields they don't recognize. Clients MUST reject a manifest whose `standard` has a
  different major version.

## 3. Services

### 3.1 Fields

| Field | Type | Rules |
| --- | --- | --- |
| **`name`** | string | Matches `^[a-z0-9][a-z0-9_-]{0,63}$`. Also used in URLs, MCP tool names and LLM function names. |
| `title` | string | ≤ 120 characters |
| **`description`** | string | 1–1000 characters (§3.4) |
| **`price.amount`** | string | Integer in the asset's base units. USDC has 7 decimals, so `"100000"` is 0.01 USDC. |
| `charge` | string | `on-success` or `upfront` (§3.2). Default `upfront`. |
| `expectedDurationSeconds` | integer | Typical time to finish. Required when `charge` is `on-success`. |
| **`inputSchema`** | object | JSON Schema 2020-12 (§3.3) |
| **`outputSchema`** | object | JSON Schema 2020-12 (§3.3) |
| `examples` | array | Up to 5 `{ input, output }` pairs. Each `input` MUST validate against `inputSchema` and each `output` against `outputSchema`. |
| `maxInputBytes` | integer | Request body limit. Default 1 MiB (1,048,576), maximum 10 MiB. |
| `tags` | array | Up to 10 strings matching `^[a-z0-9-]{1,32}$` |
| `extensions` | object | See §9 |

There is no sync or async flag. Every service uses the same job flow (§5), and `expectedDurationSeconds` is the
hint.

### 3.2 When the user is charged

| `charge` | Order | If the work fails |
| --- | --- | --- |
| `on-success` | verify payment → do the work → settle | Not charged |
| `upfront` | verify payment → settle → do the work | Charged. v1 has no refunds. |

- **[S1]** For `on-success`, the provider MUST settle only if the output is valid against `outputSchema`.
- **[S2]** A signed Stellar x402 payment expires about `maxTimeoutSeconds` after the client signs it. For
  `on-success`, if the work and settlement don't finish before then, the job fails and the client is not charged.
  Providers SHOULD keep `expectedDurationSeconds` at or below half of `maxTimeoutSeconds`. Longer work SHOULD use
  `upfront`.
- **[S3]** Clients MUST show the `charge` value to the user before payment approval.

### 3.3 Schemas

- **[S4]** The root of `inputSchema` MUST be `"type": "object"`. MCP tools and LLM function calling require it.
- **[S5]** Schemas MUST NOT reference anything outside themselves. `$ref` is allowed only within the same schema
  (`#/...`), and clients MUST NOT fetch remote schemas.
- **[S6]** Each schema MUST be at most 32 KiB as JSON.
- **[S7]** Providers SHOULD use the portable subset of JSON Schema, which most agent frameworks support:
  - `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`
  - `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`, `format`
  - `title`, `description`, `default`, `examples`
  - `anyOf`, plus `$defs` with local `$ref`

  Providers SHOULD avoid `if`/`then`/`else`, `patternProperties` and `oneOf` or `allOf` at the root.

**Files and media:**
- Large inputs and outputs (images, audio, PDFs) SHOULD be passed as HTTPS URLs, using `"format": "uri"`.
- Small binaries MAY be inline, as `"contentEncoding": "base64"` with `"contentMediaType"`.
- **[S8]** URLs inside an output MUST remain valid for `jobs.retentionSeconds`.

### 3.4 Descriptions

An agent usually decides whether to call a service from its `description` alone. A good description says:
1. what the service does
2. when to use it
3. its limits: input size, languages, quality, or what it won't do

Don't put prices, URLs or instructions to the agent in the description. Price and network come from structured
fields only.

## 4. Payment

### 4.1 Payment options

`payment.accepts` uses the field names of an x402 v2 `PaymentRequirements` object, without `amount`, which comes
from each service's `price`.

| Field | Rules |
| --- | --- |
| `scheme` | `exact` |
| `network` | `stellar:testnet` or `stellar:pubnet` (CAIP-2) |
| `asset` | The USDC Stellar Asset Contract (`C…`) for that network |
| `payTo` | Stellar address (`G…` or `C…`) that receives the payment |
| `maxTimeoutSeconds` | 30–300 |
| `extra.areFeesSponsored` | `true`. The facilitator pays network fees, so the payer needs only USDC. |

- **[P1]** In v1, `accepts` MUST have exactly one entry, so one manifest uses one network and one asset.
- **[P2]** A `G…` `payTo` MUST have a USDC trustline.

### 4.2 The challenge

- **[P3]** create-job without payment returns `402` with the x402 v2 `PAYMENT-REQUIRED` header.
- **[P4]** The challenge's `accepts` MUST have exactly one entry. That entry MUST equal the manifest's entry, with
  `amount` set to the service's `price.amount`. This applies to `scheme`, `network`, `asset`, `payTo`, `amount`,
  `maxTimeoutSeconds` and `extra.areFeesSponsored`.
- **[P5]** `resource.url` MUST be the public HTTPS create-job URL, never an internal or `http://` URL.
- **[P6]** The challenge SHOULD include x402's Bazaar discovery extension (`extensions.bazaar`), built from the
  service's `inputSchema`, `outputSchema` and first example. Generic x402 clients and catalogs can then use the
  service.
- **[P7]** Clients MUST compare the challenge with the manifest the user approved. They MUST refuse to sign if any
  field in [P4] differs.

### 4.3 Before payment, and after

- **[P8]** The provider MUST validate the input and check its capacity *before* sending a `402`. Nobody pays for
  invalid input or a full queue.
- **[P9]** One signed payment pays for at most one job. The provider MUST refuse to settle a payment it has
  already used. It answers `402` with the x402 `error` set to `payment_already_used`.
- **[P10]** A response that completes settlement SHOULD carry the x402 `PAYMENT-RESPONSE` header. The job view
  always carries the receipt (§5.6), including for jobs settled after the response was sent.

## 5. Jobs

### 5.1 Endpoints

All paths are relative to `baseUrl`.

| Operation | Request | Auth |
| --- | --- | --- |
| create-job | `POST /services/{name}/jobs` | x402 payment |
| check-status | `GET /jobs/{jobId}` | `Job-Token` |
| get-result | `GET /jobs/{jobId}/result` | `Job-Token` |

The paths are fixed. A client that knows `baseUrl` and a job id can always reach the job, even if it lost every
response.

### 5.2 create-job request

- The body is the input object itself, as `Content-Type: application/json`.
- `Idempotency-Key`: a UUID (RFC 9562), lowercase. It becomes the job id. Clients SHOULD use UUID v4 or v7.
- `Job-Token`: 32 random bytes, base64url without padding (43 characters). Only the client and the provider
  know it.
- `PAYMENT-SIGNATURE`: the x402 payment, on the paid request.

- **[J1]** Clients SHOULD send `Idempotency-Key` and `Job-Token`. They MUST send both or neither. A client that
  sends them and saves them before paying can always recover the job.
- **[J2]** If both are missing, the provider creates the job id and token itself and returns them once, in the
  create-job response (`jobId`, `jobToken`). This lets any x402 client pay. Such a client can still lose the job
  if the response is lost.
- **[J3]** The provider stores only `sha256(Job-Token)` and compares it in constant time.

### 5.3 Binding

The **binding hash** of a request is:

```
bindingHash = hex(sha256(JCS({ "service": <name>, "input": <input> })))
```

- **[J4]** A job id is bound to one binding hash and one token hash, permanently.
- **[J5]** create-job with an existing job id, the same binding hash and the same token returns the existing job.
  There is no new `402`. If the request carries a payment, the provider MUST NOT settle it.
- **[J6]** The same job id with a different binding hash or token returns `422 idempotency_key_reused`.
- **[J7]** A request whose job id is still being claimed, verified or settled returns `409 request_in_progress`
  with `Retry-After`.

### 5.4 Processing order

The provider processes a create-job request in this order:

1. Check the headers and the body size: `400` or `413`.
2. Find the service: `404 service_not_found`.
3. If the job id exists, apply [J5]–[J7].
4. Validate the input against `inputSchema`: `400 invalid_input`.
5. Check capacity: `429` or `503` with `Retry-After`.
6. If there is no payment, answer `402` (§4.2).
7. Check and verify the payment through the facilitator. If it is invalid, answer `402` with the reason.
8. Claim the job id and the payment together, atomically ([J4], [P9]).
9. Settle and run the work in the order set by `charge` (§3.2).
10. Respond (§5.5).

### 5.5 Responses

create-job, check-status and get-result all return a **job view**:

```json
{
  "jobId": "0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d",
  "service": "text-stats",
  "status": "succeeded",
  "charge": "on-success",
  "charged": true,
  "createdAt": "2026-10-20T10:00:00Z",
  "updatedAt": "2026-10-20T10:00:02Z",
  "expiresAt": "2026-10-27T10:00:02Z",
  "output": { "words": 2, "sentences": 1, "characters": 12 },
  "payment": {
    "network": "stellar:testnet",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "amount": "100000",
    "payTo": "<payTo G… address>",
    "payer": "<payer G… address>",
    "transaction": "3b1f…e9a0",
    "settledAt": "2026-10-20T10:00:02Z"
  }
}
```

| Field | Present |
| --- | --- |
| `output` | create-job and get-result, when `status` is `succeeded` |
| `error` | when `status` is `failed`: a problem object (§6) |
| `payment` | when `charged` is `true` |
| `jobToken` | only in the create-job response, and only when the provider created the token ([J2]) |

- **[J8]** If the job has finished (`succeeded` or `failed`), the response is `200`. Otherwise it is `202` with
  `Retry-After` and, for create-job, `Location: {baseUrl}/jobs/{jobId}`.
- **[J9]** A provider MAY hold the create-job response open while the work runs, for at most 30 seconds. After
  that it MUST answer `202`. Clients SHOULD use an HTTP timeout above 30 seconds.
- **[J10]** check-status and get-result without a valid `Job-Token`, for an unknown job, or for an expired job
  return `404 job_not_found`. The response never reveals whether the job exists.
- **[J11]** check-status and get-result never take a payment and never cause a charge.

### 5.6 States

| `status` | Meaning | `charged` |
| --- | --- | --- |
| `queued` | Paid, or payment verified, and waiting to run | `true` for `upfront`; `false` for `on-success` |
| `running` | The work is in progress | as above |
| `succeeded` | Output ready | `true` |
| `failed` | Finished without output; see `error.code` | `true` for `upfront`, unless `error.code` is `payment_failed`; `false` for `on-success` |
| `payment_uncertain` | Settlement was attempted and its outcome is unknown | `"unknown"` |

Allowed transitions:

```
(new)              → queued | running | payment_uncertain | failed
queued             → running
running            → succeeded | failed | payment_uncertain    (payment_uncertain: on-success only)
payment_uncertain  → queued | succeeded | failed               (decided from on-chain data)
```

- **[J12]** `succeeded` and `failed` are final. To try again after a failure, the client uses a new job id.
- **[J13]** An uncertain settlement MUST NOT be retried with a new charge. The provider decides it from on-chain
  data: the transaction, or a USDC `transfer` to `payTo`. If it was not settled, the job becomes `failed` with
  `charged: false`.
- **[J14]** While `payment_uncertain`, the output is withheld.
- **[J15]** Jobs stay retrievable for `jobs.retentionSeconds` after they finish.

### 5.7 Receipt

The `payment` object uses x402 `SettleResponse` names where they exist.

| Field | Meaning |
| --- | --- |
| `network`, `asset`, `amount`, `payTo` | What was paid. They match the challenge. |
| `payer` | The paying address |
| `transaction` | Stellar transaction hash |
| `settledAt` | Time the provider saw the settlement |

- **[J16]** A receipt is a claim. Clients MUST confirm the transaction on chain before showing "paid".

## 6. Errors

Errors other than `402` use RFC 9457 problem details (`Content-Type: application/problem+json`):

```json
{
  "type": "<spec URL>#error-invalid_input",
  "title": "Input does not match the service's inputSchema",
  "status": 400,
  "code": "invalid_input",
  "errors": [{ "pointer": "/text", "message": "must be a string" }]
}
```

- **[E1]** Every problem has a `code`. Clients MUST use `code`, not `title` or `detail`, to decide what to do.
- **[E2]** Problems never contain request headers, payment payloads or job tokens.
- `402` responses use x402's own format.

| `code` | HTTP | When |
| --- | --- | --- |
| `invalid_request` | 400 | Malformed JSON, wrong content type, bad header format, or only one of `Idempotency-Key` / `Job-Token` |
| `invalid_input` | 400 | The input fails `inputSchema`. `errors[]` lists JSON Pointers. |
| `service_not_found` | 404 | No service with that name |
| `job_not_found` | 404 | Unknown, expired, or wrong or missing token |
| `request_in_progress` | 409 | [J7]; with `Retry-After` |
| `payload_too_large` | 413 | Body over `maxInputBytes` |
| `idempotency_key_reused` | 422 | [J6] |
| `rate_limited` | 429 | With `Retry-After` |
| `unavailable` | 503 | With `Retry-After` |

Codes for a failed job, in the job view's `error.code`:

| `code` | Meaning |
| --- | --- |
| `service_failed` | The work failed |
| `output_invalid` | The output did not match `outputSchema` |
| `timeout` | The work did not finish in time |
| `payment_failed` | Settlement did not happen, so the job did not run or its output is withheld. Not charged. |

## 7. Stellar 8004 identity

- **[I1]** The provider's Stellar 8004 registration file MUST list the manifest in `services`:
  `{ "name": "stellar-agent-services", "endpoint": "<manifest URL>", "version": "1" }`.
  It SHOULD also list `{ "name": "web", "endpoint": "<baseUrl>" }` and set the `x402` flag.
- **[I2]** The manifest's `provider.agentId` MUST be the id of that registration.
- **[I3]** The manifest's `payTo` MUST equal the agent's on-chain wallet, `get_agent_wallet(agentId)`.

Together, these three rules authenticate the manifest without signing it:
- the on-chain registration names the manifest URL
- HTTPS proves the origin
- the wallet the user pays is the one the owner set on chain

The provider runtime needs no secret key.

Verification results are published to the Stellar 8004 Validation Registry. See
[verification.md](verification.md) and, for the shared conventions with ERC-8126,
[erc-compatibility.md](erc-compatibility.md).

## 8. Conformance levels

| Level | Name | Checks | Badge |
| --- | --- | --- | --- |
| 1 | Described | C1 manifest, C6 hygiene | Standard v1 |
| 2 | Payable | Level 1 + C3 challenge, C4 paid call | Payment verified |
| 3 | Recoverable | Level 2 + C5 recovery | Recovery verified |
| – | Registered | C2 identity, plus a Validation Registry record | 8004 validated |

- Each level includes the one below. Registered is independent of the levels.
- `verifier check <manifest-url>` runs C1, C3 and C6 with no payment, including against `localhost`.
- `verifier verify <manifest-url> --pay` runs every check with a funded testnet payer.

The checks are listed in [verification.md](verification.md).

## 9. Versioning and extensions

- Changes inside v1 only add optional fields. `standard` stays `stellar-agent-services/provider@1`.
- A breaking change gets a new major version (`@2`).
- **[X1]** `extensions` objects (top level and per service) hold fields outside this standard. Keys SHOULD be
  reverse-DNS names, such as `com.example.sla`. Clients ignore extensions they don't know.

## 10. Security considerations

- **Keys:** the provider runtime holds no Stellar secret key. It knows its `payTo` address and a facilitator
  URL. Owner actions such as registration run offline.
- **Job tokens:** they are bearer secrets. Providers store only their hash, and `404` hides whether a job exists.
- **Manifest changes:** a provider can change its manifest at any time. Clients approve a specific manifest and
  check the challenge against it ([P7]).
- **Schemas:** no remote `$ref` ([S5]), and size limits on every field.
- **Prompt injection:** `description`, `title` and examples are untrusted text. Clients that show them to an LLM
  SHOULD label them as provider-supplied.

## 11. Not in v1

Each item has room to be added later without breaking v1.

| Feature | Where it would go |
| --- | --- |
| Usage-based pricing, such as per token | `price` gains new fields; x402 is adding an `upto` scheme |
| Several networks or assets | `payment.accepts` already is an array |
| Other payment protocols, such as MPP | `payment.protocol` |
| Streaming output | A new optional endpoint |
| Webhooks | An optional callback field on create-job |
| Refunds | A new `charge` value |

## Appendix A: example exchange

Unpaid request:

```http
POST /agent/services/text-stats/jobs HTTP/1.1
Host: api.example.com
Content-Type: application/json
Idempotency-Key: 0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d
Job-Token: q7Zt3m0bX0s8b6f5JmS2kQ9xg3Y1rZcV4nL8pW2eA0c

{"text":"Hello world."}
```

```http
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64 x402 PaymentRequired: accepts = manifest entry + amount "100000">
```

Paid retry, with the same headers and body plus `PAYMENT-SIGNATURE`:

```http
HTTP/1.1 200 OK
Content-Type: application/json
PAYMENT-RESPONSE: <base64 x402 SettleResponse>

{ "jobId": "0192d3a4-…", "status": "succeeded", "charged": true, "output": { … }, "payment": { … } }
```

If that response is lost, the client asks again without paying:

```http
GET /agent/jobs/0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d/result HTTP/1.1
Host: api.example.com
Job-Token: q7Zt3m0bX0s8b6f5JmS2kQ9xg3Y1rZcV4nL8pW2eA0c
```

A longer `upfront` job answers `202 Accepted` with `Location` and `Retry-After`. The client then polls
check-status until the job finishes and calls get-result.

## Appendix B: mapping a service to an MCP tool

A client can offer each service to an LLM as a tool without converting anything:

| MCP tool | Service |
| --- | --- |
| `name` | `name` |
| `title` | `title` |
| `description` | `description` |
| `inputSchema` | `inputSchema` |
| `outputSchema` | `outputSchema` |

The price, network and `charge` stay outside the tool definition. The client shows them to the user for approval.

---

Test vectors (canonical JSON, binding hashes, sample challenges) and the manifest JSON Schema will be published in
`packages/protocol` with the v1 freeze.
