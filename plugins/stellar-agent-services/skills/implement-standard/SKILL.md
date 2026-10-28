---
name: implement-standard
description: Implement the provider side of Provider Standard v1 (stellar-agent-services/provider@1) natively in any language or framework (Python, Go, Rust, Java, .NET, Elixir), without the TypeScript Provider Kit, so the service is paid per job in USDC on Stellar via x402 v2 and passes the conformance checks. Use when the user wants a paid Stellar agent service in their own stack and won't use the kit or its gateway, or is writing an SDK for the standard in another language.
---

# Implement Provider Standard v1 natively

A native provider implements the manifest, the challenge, the create-job processing order, jobs, recovery,
capacity and errors itself. This is real money: follow the reference exactly, and test against the vectors.

First, make sure the gateway doesn't fit: an existing JSON-over-HTTP API in any language can use the
wrap-existing-api skill with no code at all. Go native only when the user wants no dependency on the kit.

## Read, in this order

From the repository, or `https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/<path>`:

1. `docs/standard/README-AI.md` §3–§13: constants, manifest, endpoints and headers, the create-job algorithm,
   payment, charge policies and states, capacity, errors, identity, security, testing. It is written for you.
2. `docs/provider-standard.md`: the normative text. It wins when anything disagrees. Cite its rule ids (`[J5]`)
   in code comments.
3. `docs/standard/README-AI.md` §15 (common mistakes) and §16 (rule index), before you write tests.

## Build in this order

1. **Constants and types** (README-AI §3), including the USDC contract addresses and the header patterns.
2. **Canonical JSON** (RFC 8785) and the **binding hash** (§5.3). Pass `canonical-json.json` and
   `binding-hash.json` before going on: everything after depends on them.
3. **Manifest** at `/.well-known/stellar-agent-services.json` (§4). It must pass
   `packages/protocol/schemas/manifest.schema.json` and the cases in `manifests.json`.
4. **create-job** in the exact processing order of README-AI §6: validate input and capacity before any `402`
   `[P8]`, `[Q1]`, look up a known job id before settling `[J5]`, and settle at most once per signed payment `[P9]`.
5. **Payment** (§7): x402 v2, `exact` scheme on Stellar, through a facilitator (`https://x402.org/facilitator` on
   testnet). Decode and check the payment locally before the facilitator sees it. A facilitator timeout or unknown
   answer makes the job `payment_uncertain`, never `failed` `[J13]`.
6. **check-status and get-result** (§5, §8): never charge `[J11]`. The same `404` for unknown, expired and
   wrong-token jobs `[J10]`. Store only the token's hash `[J3]`.
7. **Capacity** (§9): `503` or `429` with `Retry-After` before payment. Status endpoints stay outside the limits.
8. **Errors** (§10): problem documents with a `code`. Never echo headers, payments, tokens or exception text `[E2]`.
9. **Reconciliation:** decide `payment_uncertain` jobs from on-chain data by the payer's auth-entry nonce
   (`docs/job-recovery.md`).

Persist every state change before the next step. Keep the job store durable.

## Test

- Every file in `packages/protocol/test-vectors/` (the README there explains the conventions). Port them as data
  tests in the user's language. Don't copy the expected values by hand.
- The acceptance checklist in `docs/standard/README-AI.md` §13.
- The verifier from a clone (`npm install && npm run build`):
  `node packages/verifier/dist/cli/index.js check http://localhost:<port>/.well-known/stellar-agent-services.json --dev`.
  Each failure names a rule id. Look it up with the MCP tool `get_spec_rule` if available, or in the spec.
- A paid testnet call, after asking the user: `node packages/provider-kit/dist/cli/index.js try <service> --manifest
  http://localhost:<port>/.well-known/stellar-agent-services.json --yes` pays once from a throwaway testnet account
  (README-AI §13). Then the verify-provider skill for C4 and C5.

## Never

- Hold a Stellar secret key in the provider. It knows only `payTo` and the facilitator URL.
- Invent fields, headers, status codes or error codes. Extra data goes in `extensions` `[X1]`.
- Retry a settlement, or charge again for a known job id.
- Skip a MUST because a test passes without it.
