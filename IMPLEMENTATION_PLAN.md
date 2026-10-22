# Stellar Agent Services: Implementation Plan

Phase 2 of [Stellar Agent Search](https://github.com/berkingurcan/stellar-agent-search). It covers the Provider
Standard, Provider Kit, safe Payment Client, verification receipts, Stellar 8004 Validation Registry records and
Job Recovery, delivered and piloted within one 30-day Instaward sprint.

- **Source of truth:** Instawards SOW "Stellar Agent MCP" (submitted 29.09.2026, $4,000, 30 days).
- **Background:** `stellar-agent-search/docs/provider-network-phase-2.md` and `issues/P3-23-provider-network-phase-2.md`.
- **Network:** Stellar **testnet** for the whole build. Mainnet is a later, separate decision (see [Open decisions](#10-open-decisions)).
- **Status:** Week 1. The protocol package, a thin Provider Kit slice and the payment client (core, `stellar-pay`
  CLI and a minimal web approval page) work end to end on testnet. The other modules are scaffolds with TODO
  comments.

---

## 1. What the SOW commits us to

| SOW deliverable | Contents | Evidence promised |
| --- | --- | --- |
| **D1:** Provider Standard + Safe Payment Client | Provider Standard v1 (purpose, input, output, price, network, job status, result). Payment client that shows payment details, applies spending controls and requires approval. | Public spec, short demo video, screenshots, payment tx link |
| **D2:** Provider Kit, Verification, Job Recovery | Open-source kit, setup guide, sample service. Provider checks, verification receipts and badges, Stellar 8004 Validation Registry publishing. Job Recovery (create-job, check-status, get-result) without paying twice. | Public repo, setup guide, verification receipt, Validation Registry record, recovery demo |
| **D3:** Independent Provider Pilot + Public Evidence | Independent providers each complete at least one paid call. Users run the full flow. Job Recovery demo. Pilot report. Incentives included. | Provider links, payment references, screenshots, pilot report, public evidence page |

**Out of scope (SOW):**
- a new registry or protocol
- the full ERC-8126 specification
- zero-knowledge proofs
- a formal audit
- a consumer marketplace
- custody
- guaranteed adoption or availability

### 1.1 Inconsistencies in the SOW, and the reading we plan against

The SOW gives different numbers in different sections. We plan against the reading that satisfies all of them.

| Topic | What the SOW says | We plan for |
| --- | --- | --- |
| Providers | "two independent providers" (objective, W4, evidence). "three independent providers" (D3). "not more than two" (out of scope). "three working provider integrations" (W4 output). | **3 integrations = our sample provider + 2 independent providers** |
| Users | "five users" (D3, W4 output). "two users" (objective, W4 work, evidence). "not more than five" (out of scope). | **5 completed user flows** (this also covers "two") |
| Where it lives | "add … to Stellar Agent Search" | Phase 2 of Stellar Agent Search, built in this repo. Discovery stays in `stellar-agent-search`. |

> Action: confirm this reading with the Ambassador Chapter Lead before the sprint starts.

---

## 2. Principles

1. **Discovery holds no keys.** `stellar-agent-search` stays read-only and keyless. Nothing in this repo is
   imported into it except read-only types or schemas.
2. **The provider runtime holds no keys.** A provider server only knows its `payTo` public address. The
   facilitator verifies and settles, and the provider owner key is used only offline (registration, validation
   requests) through the Stellar CLI keychain.
3. **Signing happens only in the payment client.** The approved payment is signed exactly once, and only after
   the user approves the exact price, recipient, asset and network, or when the payment fits a budget the user
   explicitly granted.
4. **Never pay twice for one job.** The job identity is fixed before payment. The provider binds it to one
   request and one payment, and recovery never re-sends a payment credential.
5. **Fail closed.** A failed spending-limit check, an unknown settlement, a mismatched challenge or an
   unreadable journal stops the flow. None of them is ever treated as a pass.
6. **One network per flow.** A demo, test or pilot run uses testnet from discovery to feedback, never a mix.
7. **Independent codebase.** No code, schemas or names are taken from Algoria. The foundations are the public
   x402 v2 spec, the `@x402/*` packages, `@stellar/stellar-sdk`, `@trionlabs/stellar8004` and Stellar Agent
   Search's own Phase 1 reference (`examples/x402-demo.ts`).
8. **Stay compatible with ERC-8126 and ERC-8196.** We don't implement them, because a parallel project does. Our
   identity, Validation Registry, policy and journal formats must not block their Stellar versions. See
   [docs/erc-compatibility.md](docs/erc-compatibility.md).
9. **Universal standard.** Any service in any language can implement Provider Standard v1. The spec is
   language-neutral and reuses existing standards (x402, JSON Schema, MCP tool fields, IETF Idempotency-Key,
   RFC 9457). The TypeScript kit and its gateway mode make adoption easier but are never required.

---

## 3. Architecture

```
      ┌──────────────────────────┐   read-only    ┌──────────────────────────────┐
      │ stellar-agent-search     │ ─────────────▶ │ Stellar 8004 registries      │
      │ (discovery, no keys)     │                │ Identity · Reputation ·      │
      └────────────┬─────────────┘                │ Validation (Soroban)         │
                   │ finds provider + manifest URL└──────────────▲───────────────┘
                   ▼                                             │ validation_request (provider owner)
      ┌──────────────────────────┐  create-job (402 → pay)       │ validation_response (verifier)
      │ payment-client  (keys)   │ ───────────────────────────┐  │
      │ approval · limits ·      │  check-status / get-result │  │
      │ journal · recovery       │ ◀──────────────────────────┤  │
      └──────────────────────────┘                            ▼  │
                                                 ┌──────────────────────────┐
      ┌──────────────────────────┐   test calls  │ provider (provider-kit)  │
      │ verifier  (verifier key) │ ────────────▶ │ manifest · x402 server · │
      │ checks · receipt · badge │               │ job store · services     │
      └──────────────────────────┘               └────────────┬─────────────┘
                                                              │ verify / settle
                                                              ▼
                                                 ┌──────────────────────────┐
                                                 │ x402 facilitator         │
                                                 │ (fee-sponsored USDC SAC) │
                                                 └──────────────────────────┘
```

### 3.1 Who holds which key

| Actor | Holds | Must never hold |
| --- | --- | --- |
| `stellar-agent-search` (discovery) | nothing | any secret |
| Provider server (`provider-kit` runtime, library or gateway mode) | `payTo` **public** address, facilitator URL; in gateway mode, the upstream API's own credential if it has one | any Stellar secret key |
| Provider operator (`provider-kit` CLI) | owner key, in the Stellar CLI keychain, used for registration and `validation_request` | payer or verifier keys |
| `payment-client` | the payer's key or wallet connection (§5.6) | provider or verifier keys |
| `verifier` | verifier key (`validation_response`), plus a dedicated testnet test-payer key for the paid-call check | provider owner keys |

### 3.2 Repository layout

```
packages/
  protocol/        Provider Standard v1 as code: types, schemas, header names, job states, receipts,
                   canonical JSON, network constants. Shared by every other package.
  provider-kit/    Server toolkit: defineService, createProvider (Fetch-API handler), gateway mode
                   (any existing HTTP API), x402 resource server, job store + runner,
                   manifest + 8004 registration, operator CLI.
  payment-client/  Buyer side: policy, journal, payment, recovery (§5.6).
  verifier/        Provider checks → verification receipt → badges → Validation Registry response.
apps/
  wallet/          Web approval page: static, no backend, the payment-client core in the browser (§5.6).
examples/
  paid-service/    Sample provider built only with provider-kit (one on-success + one upfront service).
docs/              Provider Standard v1, setup guide, job recovery, verification, payment client, pilot.
evidence/          Receipts, payment references, validation records, pilot report (filled during the sprint).
```

**Tooling:**
- npm workspaces, matching `stellar-agent-search`, with TypeScript project references (`tsc -b`) and vitest.
- Node `>=22.13`; `.node-version` pins 24. Node 22.13 is needed for the built-in `node:sqlite` with no native
  dependency and for `@x402/stellar`.

---

## 4. Network and dependencies (testnet)

| Item | Value or source |
| --- | --- |
| CAIP-2 | `stellar:testnet` (`STELLAR_TESTNET_CAIP2` from `@x402/stellar`) |
| Asset | USDC Stellar Asset Contract: import `USDC_TESTNET_ADDRESS` from `@x402/stellar`, never retype it |
| USDC issuer (trustline check) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| Soroban RPC / Horizon | `https://soroban-testnet.stellar.org` / `https://horizon-testnet.stellar.org` |
| 8004 contracts | `TESTNET_CONFIG` from `@trionlabs/stellar8004`. Validation: `CC5USZRO26MOIAVNYTTJDS63C2OBBLREOAOET4CPF2EZWO3YFKLMO3SL` |
| Facilitator | `https://x402.org/facilitator`. Confirmed: it supports `stellar:testnet` + `exact` with sponsored fees, and sets no authorization window of its own (the window follows `maxTimeoutSeconds`). |
| Decimals | 7 (`0.01 USDC = 100000` base units) |

| Package | Version | Note |
| --- | --- | --- |
| `@x402/core`, `@x402/fetch`, `@x402/stellar` | 2.28.0 | `@x402/stellar` needs `@stellar/stellar-sdk ^16.3.0` |
| `@stellar/stellar-sdk` | 16.3.1 | Root `overrides` force `@trionlabs/stellar8004` (declares `^15`) onto the same copy. `axios` is overridden to 1.20.0 because the SDK pins a vulnerable 1.18.0 (same fix as Phase 1). |
| `@trionlabs/stellar8004` | 0.0.11 | Identity, Reputation and Validation clients; `generateRequestNonce`; metadata helpers |
| `hono`, `@hono/node-server` | 4.x / 2.x | Example service only. The kit itself is framework-agnostic (Fetch `Request`/`Response`). |

---

## 5. Components

### 5.1 Provider Standard v1 (`docs/provider-standard.md`, `packages/protocol`)

The draft spec is in [docs/provider-standard.md](docs/provider-standard.md). It is a thin layer over existing
standards, so the SOW's "no new protocol" holds, and any language can implement it.

| Concern | Standard reused |
| --- | --- |
| Payment | x402 v2 `exact` on Stellar; the manifest's payment option uses x402 `PaymentRequirements` field names |
| Service description | JSON Schema 2020-12 with MCP tool field names (`name`, `title`, `description`, `inputSchema`, `outputSchema`) |
| Discovery inside the 402 | x402 Bazaar extension |
| Idempotency | IETF Idempotency-Key draft-07 (422 for a reused key, 409 while in progress) |
| Long jobs | `202 Accepted` + `Location` + `Retry-After` |
| Errors | RFC 9457 problem details with a stable `code` |
| Identity | Stellar 8004 registration `services[]` entry pointing at the manifest |

**What the spec adds:** the manifest, the `Job-Token` header, and the rules that bind one job to one request and
one payment.

**Main rules:**
- The manifest is at `/.well-known/stellar-agent-services.json` by default, or any HTTPS URL the 8004
  registration names. Job endpoints are fixed paths under one `baseUrl` on the same origin.
- Small required core: `standard`, provider `name`, `baseUrl`, one payment option, and per service `name`,
  `description`, `price.amount`, `inputSchema`, `outputSchema`. Clients ignore unknown fields.
- No sync/async flag. Each service declares `charge: "on-success" | "upfront"` and `expectedDurationSeconds`.
- The 402 challenge equals the manifest payment option plus the service price, field by field.
- Input is validated and capacity checked *before* the 402.
- Conformance levels: Described (C1, C6), Payable (+ C3, C4), Recoverable (+ C5), plus Registered (C2).

**Ways to implement:** gateway mode (any existing HTTP API), the TypeScript library, or natively from the spec,
checked with `verifier check`. The manifest JSON Schema and language-neutral test vectors are in
`packages/protocol` (`schemas/`, `test-vectors/`).

### 5.2 Job Recovery protocol (`docs/job-recovery.md`)

The SOW names three operations.

| Operation | HTTP | Notes |
| --- | --- | --- |
| **create-job** | `POST {baseUrl}/services/{name}/jobs` | x402-protected. Headers: `Idempotency-Key: <uuid>` (becomes the job id) and `Job-Token: <32 random bytes, base64url>` |
| **check-status** | `GET {baseUrl}/jobs/{jobId}` | `Job-Token` required. Returns the job view: status, `charged`, receipt and timestamps |
| **get-result** | `GET {baseUrl}/jobs/{jobId}/result` | `Job-Token` required. Returns the job view with the output |

All three return the same job view: `200` when the job has finished, otherwise `202` with `Retry-After`. A client
that sends neither header (any plain x402 client) gets a provider-generated job id and token in the create-job
response, without the guarantee for lost responses.

**Job states:** `queued → running → succeeded | failed`, plus `payment_uncertain`.

**How double-charging is prevented:**
1. **The client fixes the identity before paying.** It generates `jobId` and the token, then persists both
   together with the binding hash *before* the first request. Because the status URL is a fixed path under
   `baseUrl`, a lost response never loses the handle.
2. **The provider binds the job.** `jobId → (sha256(JCS({ service, input })), sha256(token))`.
   - Repeating create-job with the same binding returns the existing job, with no new 402 and no new charge.
   - A different binding or token gets `422`; a request while the job is still being claimed or settled gets
     `409` (IETF Idempotency-Key draft-07).
   - A wrong token gets `404`, so the response does not reveal whether the job exists.
3. **The provider binds the payment.** A unique payment fingerprint (network, payer, signed auth entry)
   means one signed payment can buy at most one job.
4. **Uncertain means don't pay.** If settlement times out or fails transiently, the job becomes
   `payment_uncertain` and is never re-charged. `provider-kit reconcile` resolves it from on-chain data: the tx
   hash, or the USDC `transfer` event to `payTo`.
5. **Recovery never re-sends `PAYMENT-SIGNATURE`.** It only calls check-status and get-result.

**When the user is charged** is set per service with `charge`:
- `on-success`: verify → run → settle. Work that fails is never charged. The signed payment expires about
  `maxTimeoutSeconds` after signing, so this only suits work well inside that window.
- `upfront` (default): verify → settle → run. Expensive or long work starts only once it is paid.

The **response-loss drill** is test-only, needs an explicit flag, and is off by default. The provider settles and
persists the result, then drops the response. This is how the SOW recovery demo is produced.

### 5.3 Provider Kit (`packages/provider-kit`)

| Module | Responsibility |
| --- | --- |
| `define-service.ts` | `defineService({ name, title, description, price, charge, expectedDurationSeconds, inputSchema, outputSchema, examples, handler })`, with schema validation of input (before the 402) and output (before settling) |
| `provider.ts` | `createProvider(config)` → `{ fetch(request): Promise<Response> }`, which wires every part together |
| `http/router.ts` | Manifest, create-job, check-status and get-result routes, in the spec's processing order. RFC 9457 errors, body size caps, no redirects. |
| `gateway/config.ts`, `gateway/upstream.ts` | Gateway mode: a config file describes services whose handler forwards the input to an existing HTTP API in any language |
| `payments/x402-server.ts` | `@x402/core` resource server with `ExactStellarScheme` (server). Builds the challenge, with the Bazaar extension, from the manifest. |
| `payments/payload-checks.ts` | Local checks run before calling the facilitator: one SAC `transfer(payer → payTo, amount)`, network, asset, timeout cap, fee sponsorship |
| `payments/facilitator.ts` | Facilitator client: HTTPS-only, timeouts, `getSupported()` check at startup |
| `payments/settlement.ts` | Classifies settlement as `settled`, `failed` (definitely not submitted, from an allowlist) or `uncertain` (everything else) |
| `jobs/store.ts` | `JobStore` interface: atomic claim, compare-and-set transitions, fingerprint uniqueness |
| `jobs/memory-store.ts`, `jobs/sqlite-store.ts` | Reference stores (`node:sqlite`). Providers may add Postgres. |
| `jobs/runner.ts` | Both charge policies, the 30-second hold before `202`, retention |
| `manifest.ts` | Builds and validates the Provider Standard v1 manifest |
| `registration.ts` | 8004 registration metadata from the manifest, plus `validation_request` input |
| `cli/` | `serve --config` (gateway mode), `init`, `check` (self-check), `register`, `request-validation`, `reconcile` |

**Developer experience targets (W2 exit criteria):**
- Library: starting from a clean machine, `npm i`, defining one service and running the server produces a
  working paid testnet request, using only the setup guide.
- Gateway: an existing non-TypeScript API (a small Python service) becomes a paid service with only a config
  file and `provider-kit serve`, also from the Docker image.

### 5.4 Verification, receipts, badges and Validation Registry (`packages/verifier`)

**Checks** (each one records evidence):

| # | Check | Pass condition |
| --- | --- | --- |
| C1 | Manifest | Fetched over HTTPS without redirects, schema-valid v1, size limits respected, no remote `$ref`, examples valid |
| C2 | Identity | `agentId` exists in the 8004 Identity registry, its registration points to this manifest, and the manifest `payTo` equals the on-chain `agent_wallet` |
| C3 | Challenge | Invalid input returns `400` before any `402`. Valid unpaid create-job returns `402` whose single `accepts` entry equals the manifest payment option plus the price. `payTo` has a USDC trustline. |
| C4 | Paid call | Test payer pays → result matches the `output` schema; on-chain USDC `transfer` to `payTo` for the exact amount |
| C5 | Recovery | Repeating create-job returns the same job with no second transfer; the same key with other input returns `422`; check-status and get-result work with the token and return `404` without it |
| C6 | Hygiene | No redirects, no secrets in responses, bounded bodies |

**Conformance levels** (each maps to one badge): Described = C1 + C6, Payable = + C3 + C4,
Recoverable = + C5, and Registered = C2 plus a Validation Registry record. `verifier check` runs the no-payment
checks against any URL. With `--dev` it also accepts a local `http://` server (spec [M6]), so providers can test
themselves before going live.

**Verification receipt:**
- Canonical JSON containing: standard version, provider `agentId`, manifest sha256, network, a status and
  evidence for each check, payment tx hash, verifier address and timestamps.
- It is stored under `evidence/receipts/` and published through the evidence page (GitHub Pages).

**Badges:** SVGs derived **only** from a receipt.
- Badge set, one per level: `Standard v1`, `Payment verified`, `Recovery verified`, `8004 validated`.
- Each badge shows the network.

**Validation Registry flow** (contract read from `stellar-8004/contracts/validation-registry`):

1. **Provider owner** runs `provider-kit request-validation`, which calls
   `validation_request(caller = owner, validator_address = verifier G…, agent_id, request_uri, request_hash)`.
   - `request_uri` is the verification request document.
   - `request_hash = sha256(document)`, the spec-compliant `contentHash` mode of `generateRequestNonce`.
2. **Verifier** runs the checks and calls
   `validation_response(caller = verifier, request_hash, response = score 0–100, response_uri = receipt URL, response_hash = sha256(receipt), tag = "provider-standard-v1")`.
3. Anyone can read the result with `get_validation_status(request_hash)` or `get_agent_validations_paginated`.

`response` is higher-is-better (ERC-8004: 0 = failed, 100 = passed). Documents are hashed as
`sha256(RFC 8785 JCS)`. Both rules are shared with the planned Stellar ERC-8126 records, so the two kinds of
record never get mixed up in `get_summary` (docs/erc-compatibility.md, T2).

Mainnet currently reports `totalValidations: 0`, so these will be among the first real Validation Registry
records. Stellar Agent Search's deferred P3-10 (validation trust axis) can then read them.

### 5.5 Example paid service (`examples/paid-service`)

The example is built only with the public `provider-kit` API, so it doubles as the template for pilot providers.

| Service | Charge | Price | Behavior |
| --- | --- | --- | --- |
| `text-stats` | on-success | 0.01 USDC | Deterministic. Answers `200` at once; failed work is never charged. |
| `delayed-report` | upfront | 0.02 USDC | Configurable delay. Answers `202`. Used for the Job Recovery demo. |

It runs on Hono with `@hono/node-server`. The `.env` holds only the `payTo` public address and the facilitator URL.

### 5.6 Payment Client: decided

**Decided 2026-10-21.** The design is in [docs/payment-client.md](docs/payment-client.md):
- One core (`packages/payment-client`) that keeps every safety rule.
- Two strategies behind it (Strategy pattern, built 2026-10-22 with the built-ins only):
  - signers: a local key, browser wallets through Stellar Wallets Kit, then a passkey smart account
  - payment methods: x402 `exact` on Stellar, the only one v1 allows
  - adapters for other projects (such as Eunomia or an ERC-8196 wallet) come later as separate packages that
    must pass the conformance checks
- Two surfaces: a static web app for everyone and a keyed MCP server for agents.
- Policy and journal use ERC-8196 field names. Out of the box, every payment needs approval.

The core, the local-key signer, the `stellar-pay` CLI and a minimal web approval page (`apps/wallet`) work end to
end on testnet. Settlement proof checks the `transfer` event against the approved payment ([J16]).

### 5.7 Discovery integration (changes in `stellar-agent-search`, not this repo)

- **Testnet discovery gap:** the default explorer (`stellar8004.com`) indexes **mainnet only**, and testnet mode
  refuses to start without `EXPLORER_BASE_URL` (P1-07). The full "find → approve → pay → receive" flow on
  testnet therefore needs one of:
  - **(a, recommended)** a keyless direct-registry mode for testnet: resolve allowlisted agent IDs through
    Soroban reads, then fetch their manifest.
  - (b) running a testnet indexer.
  - (c) doing the pilot on mainnet.
- **Manifest awareness:** when an agent's service points to a Provider Standard manifest, show its price,
  network, recovery support and badges, with the badges taken from Validation Registry reads.
- These changes stay read-only and keyless, each in its own small PR to that repo.

---

## 6. Four-week schedule

The sprint start date is still TBD; day 1 is the date the SOW is signed.

### Week 1: Standard, payment client, first paid flow (D1)

- [x] Day 1:
  - Testnet accounts: provider `payTo` and test payer. The verifier account waits for the verifier (Week 3).
  - USDC trustlines and testnet USDC.
  - Facilitator `getSupported()` probe: `stellar:testnet` + `exact` is supported, and the facilitator adds no
    limit of its own on the payment authorization window, so the spec's 30–300 range stands.
- [x] Day 1–2: **Payment client design decision** (§5.6).
- [x] `docs/provider-standard.md` v1 draft.
- [x] Manifest JSON Schema, test vectors and reference checks in `packages/protocol` (canonical JSON, binding
  hash, manifest rules, challenge check).
- [x] Remaining protocol types (job view, job states, errors, receipts), with test vectors.
- [x] Freeze v1 (2026-10-21, open decision 6).
- [x] Verification receipt format defined (spec only).
- [x] Thin provider slice: manifest, create-job with an on-success service, x402 resource server, memory store.
- [x] Payment client, first working version: approval screen, caps, signing, journal.
  - [x] Core, local-key signer and `stellar-pay` CLI (approval prompt, caps, journal, on-chain check).
  - [x] Minimal web approval page (`apps/wallet`), for the D1 video.
- [ ] One successful testnet payment flow, recorded (tx link, screenshots, short video).
  - [x] Testnet tx links.
  - [ ] Screenshots and the short video.
- [ ] Start pilot outreach: shortlist 4–5 candidate providers and 6–7 users.

**Exit:** spec published, approval-before-payment video, testnet tx link.

### Week 2: Provider Kit (D2, part 1)

- [ ] Full `provider-kit`:
  - `defineService` with schemas
  - strict payload checks
  - settlement classification
  - SQLite store
  - background runner
  - both charge policies
- [ ] Gateway mode: `provider-kit serve --config`, a Docker image, tested with a small Python API as upstream.
- [ ] Manifest builder and 8004 registration (`provider-kit register`) on testnet.
- [ ] `examples/paid-service` with both services.
- [ ] Setup guide (`docs/provider-setup-guide.md`), tested on a clean machine.
- [ ] Payment-safety test suite (§7).

**Exit:** a developer installs the kit from scratch, starts the sample provider and completes a paid request. An
existing Python API becomes a paid service through gateway mode.

### Week 3: Verification and Job Recovery (D2, part 2)

- [ ] Complete Job Recovery:
  - create-job, check-status and get-result
  - `payment_uncertain`
  - `reconcile`
  - the response-loss drill
- [ ] Payment client recovery: resume from the journal, never re-sign.
- [ ] `verifier`: checks C1–C6, conformance levels, receipt, badges, and the no-payment `check` command.
- [ ] Validation Registry publishing: `request-validation` (provider) and `validation_response` (verifier) on testnet.
- [ ] Discovery integration, option (a) from §5.7, in `stellar-agent-search`.
- [ ] Pilot providers start integrating: send them the guide and template.

**Exit:**
- The sample provider has a verification receipt and a Validation Registry record (tx).
- One interrupted job has been recovered, with exactly one on-chain transfer.

### Week 4: Pilot and evidence (D3)

- [ ] Two independent providers live: each verified, each with at least one paid call.
- [ ] Five users complete find → approve → pay → receive, and at least one runs a recovery.
- [ ] Fix pilot-blocking issues and record them in the pilot report.
- [ ] Evidence page, demo videos, payment references, validation records, pilot report.

**Exit:** every row of the SOW §6.1 evidence table is linked from `evidence/README.md`.

---

## 7. Testing strategy

**Unit:**
- canonical JSON (key order and whitespace don't change the hash)
- manifest schema and test vectors
- challenge ↔ manifest matching
- settlement classification
- job state transitions

**Payment safety:** these tests must exist before the pilot.
- [ ] A repeated create-job with the same key and input → same job, no facilitator call, no second charge.
- [ ] The same key with different input or token → `422`. A request while still claiming or settling → `409`.
  A wrong token → `404`.
- [ ] Invalid input → `400` before any `402`.
- [ ] One signed payment presented for two jobs → rejected (fingerprint).
- [ ] A facilitator timeout or 5xx → `payment_uncertain`, never `failed`, never re-charged.
- [ ] An `on-success` handler failure or invalid output → no settlement.
- [ ] `on-success` work that outlasts the payment authorization → job failed, nothing charged.
- [ ] A client without `Idempotency-Key` and `Job-Token` → provider-generated id and token, one charge.
- [ ] A challenge whose amount, payTo, asset or network differs from the manifest → the client refuses to sign.
- [ ] A failed spending-limit check → the payment is blocked (fail closed).
- [ ] A lost response → recovery returns the stored result, with one on-chain transfer.

**Integration (testnet, manual or CI-gated):** sample provider + verifier + payment client, end to end.

**Test hygiene:** use fixed transaction timebounds in fixtures. This is the lesson from the Phase 1 timebounds
flake.

---

## 8. Evidence plan (maps to SOW §6.1)

| Deliverable | Evidence | Location |
| --- | --- | --- |
| D1 | Provider Standard v1 | `docs/provider-standard.md` |
| D1 | Video (price, recipient, spending control, approval → payment), screenshots, testnet tx link | `evidence/d1/` |
| D2 | Public repo, setup guide | this repo, `docs/provider-setup-guide.md` |
| D2 | Verification receipt + badges | `evidence/receipts/` |
| D2 | Validation Registry record (request + response tx) | `evidence/validation/` |
| D2 | Recovery demo (video + single-transfer proof) | `evidence/d2/` |
| D3 | Provider links, per-provider paid-call references, screenshots | `evidence/pilot/` |
| D3 | Pilot report (what worked, failed, was fixed) | `evidence/pilot/report.md` |
| D3 | Public evidence page | GitHub Pages from `evidence/` |

Every transaction is listed with network, hash, ledger and explorer link. Testnet evidence is labeled as testnet
everywhere.

---

## 9. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Payment client design not settled by W1 day 2 | Misses the D1 Week 1 output | Build the design-independent core first: policy, validation, journal |
| No testnet 8004 indexer | Discovery step of the pilot flow doesn't work on testnet | Direct-registry testnet mode in `stellar-agent-search` (§5.7) |
| Testnet facilitator unavailable or unsupported | No settlement | Probe on day 1. If needed, look for another facilitator or self-host a settlement path. |
| Independent providers late or unresponsive | D3 missed | Start outreach in W1, use the template repo, offer incentives (SOW), keep a backup provider |
| `validation_request` must be signed by the provider owner | Friction for independent providers | One-command `provider-kit request-validation` using the Stellar CLI keychain |
| `stellar8004` declares stellar-sdk `^15`; x402 needs `^16.3` | Duplicate SDK copies, XDR type mismatch | Root `overrides`, plus a test that only one copy is installed |
| Reviewers expect mainnet evidence (Phase 1 was mainnet) | Evidence questioned | Agree on testnet with the Ambassador Chapter Lead up front; mainnet is optional follow-up |
| Users need testnet USDC | Pilot friction | Pre-fund pilot wallets from the team test account |

---

## 10. Open decisions

| # | Decision | Owner | Needed by |
| --- | --- | --- | --- |
| 1 | ~~Payment client design (§5.6)~~ **Decided 2026-10-21:** docs/payment-client.md | Berkin | W1 day 2 |
| 2 | SOW provider/user counts reading (§1.1) | Berkin + Ambassador Chapter Lead | Before sprint start |
| 3 | Testnet discovery approach (§5.7) | Berkin | W2 |
| 4 | Testnet-only evidence accepted, or a final mainnet run | Berkin + Ambassador Chapter Lead | W2 |
| 5 | npm scope for publishing (placeholder `@stellar-agent-services/*`) | Berkin | W2 (first publish) |
| 6 | ~~Provider Standard v1 freeze~~ **Decided 2026-10-21, frozen as drafted, except the URL:** `Job-Token` header, manifest path, `maxTimeoutSeconds` range, the URL for the schema `$id` and problem `type` values (`algorialabs.github.io/stellar-agent-services`), plus CORS as SHOULD [J17] | Berkin | W1 |
| 7 | Shared ERC-8126/8196 conventions: score direction, tags, hashing, policy extensions (docs/erc-compatibility.md) | Berkin + ERC-8126/8196 Stellar team | W1 for hashing, W3 for validation records |
