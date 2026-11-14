# @stellar-agent-services/verifier

Checks a provider against [Provider Standard v1](../../docs/provider-standard.md) and turns the result into evidence
anyone can check:

1. **Checks C1–C7:** manifest, identity, payment challenge, paid call, recovery, hygiene and load. Each finding
   cites a rule of the standard.
2. **Verification receipt:** RFC 8785 canonical JSON, stored under its own SHA-256.
3. **Badges:** SVGs drawn only from a receipt.
4. **Validation Registry:** `validation_response` anchors the receipt's hash in the Stellar 8004 Validation
   Registry.
5. **Self-serve:** `verifier watch` does all of it by itself for every validation request that names the verifier.

The full description, with every check and rule, is [docs/verification.md](../../docs/verification.md).

## Use

```bash
npm install -g @stellar-agent-services/verifier   # or run each command as npx @stellar-agent-services/verifier

# A provider testing itself, with no payment and no key:
verifier check http://localhost:8787/.well-known/stellar-agent-services.json --dev

# A verifier, answering every validation request that names it, until stopped:
VERIFIER_PAYER_SECRET=S... verifier watch --source verifier --public-url https://verifier.example.com \
  --data /var/lib/verifier

# The same for one request, by hand: every check, paid by a dedicated testnet account, and a receipt.
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
the report, or the receipt, on standard output. `watch` runs until SIGINT or SIGTERM, then exits `0`.

The paid checks poll an uncertain job within their existing follow deadline, allowing the provider to reconcile
it from the chain [J13]. They read the original job and never sign or send another payment while waiting [J11].
Unresolved uncertainty is skipped and earns no paid check.

As a library:

```ts
import { issueReceipt, localKeyPayer, verifyProvider, writeReceipt } from "@stellar-agent-services/verifier";

const report = await verifyProvider({ manifestUrl, payer: localKeyPayer(process.env.VERIFIER_PAYER_SECRET!) });
const receipt = issueReceipt(report, { validator: "G..." });
const { path, sha256 } = await writeReceipt(receipt, "evidence/receipts");
```

`openWatcher()` is the engine of `verifier watch`: `tick()` runs one round, and `handle(request)` is its HTTP side,
for any Fetch-API server.

## Watch

`verifier watch` answers validation requests with no hand-off. Every `--interval` (default 60 s) it reads the
Validation Registry for new requests that name the `--source` key's address. For each one, it finds the manifest
(the request document, which the agent's registration must agree with [I1], else the registration), runs every check
with the test payer, serves the receipt at `<public-url>/receipts/<sha256>.json` with its badges, and publishes
`validation_response` as `verifier publish` does. A provider that is not reachable yet is checked again with backoff
for `--retry-for` hours (default 24), then answered with its failing result. The state is `<data>/state.json`, so a
restart picks up where it stopped, and a request is never answered twice.

| Path | What it serves |
| --- | --- |
| `/receipts/<sha256>.json` | The receipt, exactly as written: the `response_uri` on chain |
| `/receipts/<sha256>.<badge>.svg` | Its badges |
| `/requests/<request hash>.json` | Where a request stands, for its owner: `waiting`, `publishing`, `answered` or `refused`, and why |
| `/healthz` | `ok`, or `degraded` with the verifier's own problems, such as a test payer to fund |

**Deploying it.** A small server or VM is enough: Node.js 22.13 or later, the Stellar CLI holding the validator key
(`stellar keys generate verifier --network testnet --fund`), and a persistent volume for `--data`. Put HTTPS in
front of `--port` (default `$PORT`, or 8080) at `--public-url`, with a reverse proxy such as Caddy or the platform's
TLS. Back the volume up and keep the URL stable: the chain links to the receipts in it. Keep at least `--max-spend`
(1.00 USDC) in the test payer. Run one watcher per validator key, where it can reach only the public internet: it
fetches URLs that agent owners chose. See
[docs/verification.md](../../docs/verification.md#self-serve-verification-verifier-watch).

## Keys

| Key | Used for | Where it lives |
| --- | --- | --- |
| Test payer | C4, C5 and C7's paid part | `VERIFIER_PAYER_SECRET`: a dedicated testnet account holding a little USDC |
| Validator | `validation_response` | The Stellar CLI keychain. `verifier publish --source <key>` and `verifier watch --source <key>` sign through it; the verifier never sees it. |

The test payer pays only a provider whose manifest passed C1 and whose challenge matches it, at most 0.10 USDC for
a job and 1.00 USDC in a run unless told otherwise, and never on pubnet without `--allow-pubnet`. The validator and
the test payer are always different accounts.

## Layout

| Path | What it does |
| --- | --- |
| `src/verify.ts` | `verifyProvider()`: runs the checks, in order, and returns the report |
| `src/checks/` | One module per check, C1–C7, and C6's probe of the discovery documents |
| `src/jobs.ts` | The job endpoints, called as a careful client calls them, and the job view checks (§5.5–§5.7) |
| `src/http.ts` | The HTTP client for an untrusted provider: no redirects, deadlines, size limits, one origin |
| `src/payments.ts` | The test payer and its limits |
| `src/chain.ts` | Soroban RPC reads: the trustline, the test payer's balance, and the proofs that a payment did or did not settle |
| `src/registry.ts` | Stellar 8004 reads: identity and validation records, and the requests that name a validator |
| `src/receipt.ts`, `src/badges.ts`, `src/publish.ts` | Receipts, badges, and the Validation Registry response |
| `src/requests.ts` | What a validation request asks to check: its document from the `validation_request` event, or the agent's registration [I1] |
| `src/watch.ts` | `openWatcher()`: the engine of `verifier watch`, its retries and its HTTP side |
| `src/watch-state.ts` | The watcher's state file and the lock on its data directory |
| `src/cli/` | The `verifier` command; `cli/watch.ts` runs the watcher, `cli/serve.ts` serves it on Node's HTTP server |

## Tests

The tests run every check against the real Provider Kit in-process, with a facilitator that settles onto a fake
Soroban chain and a test payer that signs real payments offline. A conforming provider must pass every check; for
each rule, a provider made to break it must fail with that rule's id.

The watcher's tests (`test/watch.test.ts`, `test/support/watch.ts`) add a fake Validation Registry with its request
events, a fake Stellar CLI that records `validation_response`, a fetch that reaches the watcher's own HTTP side at its
public URL, and a clock that jumps ahead hours. They cover retries, refusals, restarts and never answering twice.
