# Mainnet verification and payments

Captured on **2026-11-14** on Stellar **mainnet** (`stellar:pubnet`) with real USDC. The verifier
(`@stellar-agent-services/verifier@0.1.1` from npm) paid three live providers, recovered each paid job without a
second charge, and wrote a verification receipt for every run. Every payment is confirmed on chain.

The providers are AlgoriaLabs services built with the Provider Kit. They are not independent pilot providers, so
this page is not D3 pilot evidence. It shows that the standard, the kit and the verifier work with real money.

## Result

| Agent | Service | Price | Level, score | Paid call | Recovery | Load | Payment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 73 | Stellar Logo Agent, `logo-design` | 0.10 USDC | 3 (Recoverable), 100 | Passed | Passed | Passed | [ledger 65474953](https://stellar.expert/explorer/public/tx/233cf09586366dc92442faad6f23ee01f8409c766da66dc1af30da7b83359475) |
| 72 | Pitch Deck Agent, `pitch-deck` | 0.10 USDC | 3 (Recoverable), 100 | Passed | Passed | Failed | [ledger 65474968](https://stellar.expert/explorer/public/tx/39c0c24369c974d67c02a293f684d5fd0d37fbd4e92b48a906b4d1602fd9028f) |
| 70 | Text to Speech Narration, `narrate-short` | 0.005 USDC | 3 (Recoverable), 100 | Passed | Passed | Passed | [ledger 65474980](https://stellar.expert/explorer/public/tx/edc3e2540e11021aec0444481163e7bf9eb665247255872329d42e374ae6c860) |
| 74 | Instagram Grid Maker, `make-grid` | 0.01 USDC | 1 (Described), 33 | Failed, not charged | Skipped | Passed | none |

- **Receipts:** [agent 73](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.json),
  [agent 72](receipts/e10d1b0e143535af5ec661eefcd376d2e0c15d44145f258dbd91049a4484b098.json),
  [agent 70](receipts/0476f538340fcb9b97d54baf47d456b20c6f895ec7d856d1681773d3c46a1d15.json). Each file is named by
  its SHA-256 and sits next to the badges it earned.
- **On-chain proof:** [payments.json](payments.json) was read from Horizon after the runs. It lists each transfer
  (payer, payee, amount, asset), the account setup and the final balances.
- **Exactly one charge per paid job.** The payer received 0.5 USDC and made exactly three USDC transfers:
  0.10 + 0.10 + 0.005. Recovery (C5) repeated create-job with the same payment and read the result again; no
  second transfer exists [J11], [J13].
- **Pitch Deck recovered a lost response.** The paid create-job got no answer (`paidStatus: null`). The job still
  finished and the verifier collected it, without paying again. This is Job Recovery working on mainnet.
- **Badges.** Agent 73 earned all five: Standard v1, Payment verified, Recovery verified, Load-safe and 8004
  validated. Agent 70 earned the first four, and agent 72 the first three.

![Standard v1](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.standard-v1.svg)
![Payment verified](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.payment-verified.svg)
![Recovery verified](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.recovery-verified.svg)
![Load-safe](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.load-safe.svg)
![8004 validated](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.8004-validated.svg)

## Validation Registry record on mainnet

Agent 73's receipt is anchored in the mainnet Stellar 8004 Validation Registry. The agent owner asked our validator
for validation, signing in Freighter on the `provider-kit request-validation` approval page. The validator answered
with `verifier publish`, signing through the Stellar CLI.

| Field | Value |
| --- | --- |
| Validation request | [1e3bbe10…](https://stellar.expert/explorer/public/tx/1e3bbe105d504f8ea012d51807d30448e1270e9e2fec035b70f52046c751bbd8), ledger 65475185, signed by owner `GDZTNESU…44SC` |
| Validation response | [27cd918b…](https://stellar.expert/explorer/public/tx/27cd918b0b52641be137d96f0606ef32249c68be2ba0c024ae70780d2ba0a2d2), ledger 65475226, signed by validator `GBGCXYSM…3TUU` |
| Request hash | `49a2f06131d3ad85fcfb21d98e3954cb618eda3f6dadab3d437064d033d41a57`, the SHA-256 of the request document on chain |
| Response | score 100, level 3, tag `provider-standard-v1` |
| `response_hash` | `39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd`, the receipt's SHA-256 |
| `response_uri` | [the receipt at commit ee7882a](https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/ee7882ae4ff9c02ac25b46a0485c5b1730a1a396/evidence/mainnet/receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.json), served byte for byte |
| Registry contract | `CBT6WWEVEPT2UFGFGVJJ7ELYGLQAGRYSVGDTGMCJTRWXOH27MWUO7UJG` |

`verifier publish` checked the request's agent and validator, the receipt's age and the public bytes before signing.
`verifier badge --request-hash` then read the record back and issued the 8004 validated badge.
[validation.json](validation.json) holds both transactions, their decoded arguments and the request document.
Logs: [request](runs/request-validation-agent73.txt), [response](runs/publish-agent73.txt).

The receipt was made at 12:53 UTC, about 20 minutes before the request; `publish` accepts receipts up to 24 hours
old. The first response submission timed out in the Stellar CLI ([log](runs/publish-agent73-timeout.txt)). Horizon
and RPC never saw it, and the validator's sequence number had not moved, so it was sent again.

## All six mainnet services, unpaid checks

Before paying, `verifier check` ran against all six AlgoriaLabs services registered in the mainnet 8004 registry
(agents 69–74). Every check that runs without a payment passed for all six (C1, C2, C3, C6, C7): level 1,
Described. Reports are in [unpaid-checks/](unpaid-checks). Agent 71 (phone calls, 1 USDC) and agent 69 (App Store
screenshots, 0.25 USDC) were not paid for, by decision.

## Accounts and limits

| Role | Address | Funding | Key |
| --- | --- | --- | --- |
| Payer | `GA2P2QPSAUA3I7JN2KG3JWHXKCJ4WERZO7FODZAXCVKYLG7RZXFZV4NB` | 3 XLM, 0.5 USDC | macOS Keychain; passed to the verifier's environment at run time, never printed or written to a file |
| Validator | `GBGCXYSM7LIGOOZ7R3OXTOPIPSFEMHHVFAO7HJMKTEHL7KREXGPW3TUU` | 2 XLM | Stellar CLI secure store (macOS Keychain); it never reveals the key |

Each run used `--allow-pubnet`, `--max-price 0.10` and `--max-spend 0.10` (0.01 for agent 70). The cap left C7's
paid part out, so C7 sent only its 20 unpaid requests. The providers' facilitator (OpenZeppelin's, on mainnet)
submitted each payment and paid its network fee. The validator is project-operated, not an independent auditor.

## Findings

Provider findings, for the owners of these services:

- **Agent 74, Instagram Grid Maker.** Paid jobs fail with `service_failed`, both for the manifest's example and for
  a real image (`https://picsum.photos/id/1015/3200/2400`, the service README's own test). The example uses a
  placeholder URL, `https://images.example.com/banner.jpg`. Both signed payments (0.01 USDC each) were never
  settled, as `on-success` requires [S1]. The challenge also lacks the Bazaar extension [P6].
- **Agent 72, Pitch Deck.** Under 20 requests at once, 4 connections were closed with no answer. A busy provider
  should answer 402, or 429 or 503 with `Retry-After` [Q1].
- **Agent 70, Text to Speech.** The server was unreachable for a few seconds about every 40 seconds, with no
  requests from us. Two runs failed on connection errors before a third passed. It looks like a restart loop.

Registry cost:

- **The mainnet validation request cost 17.13 XLM.** Of that, 17.126 XLM was rent: the transaction wrote the
  Validation Registry's contract code entry and extended its lifetime. The registry had little mainnet use, so the
  first caller after a long idle paid the extension. The response that followed cost 0.004 XLM, and agent 73's
  registrations cost about 0.2 XLM each. The kit's own fee check refused the first attempt, when the owner account
  held 4.87 XLM, before anything was signed. The docs' "about 2.5 XLM" estimate for going live on mainnet does not
  cover a request that pays this rent.

Verifier and environment notes:

- One run failed to sign with `Cannot convert undefined or null to object`. Signing then worked for every provider
  with the same package, and the next runs paid. The error came in a run with other network failures, so it is
  most likely a network error surfacing inside the x402 client. It was not reproduced.
- The npm install of the verifier contains two Stellar SDK copies (16.4.1, and 15.1.0 under
  `@trionlabs/stellar8004`), because `npx` does not apply the override a project's `package.json` sets. Payments
  were not affected.

## Failed and partial runs, kept as captured

| Receipt | Agent | What happened | Signed |
| --- | --- | --- | --- |
| [9bd6b59e…](receipts/9bd6b59e03ab7f0590b5026eb5997712e96e12737d02cc6c34ff2e45c2136bf8.json) | 70 | Connection refused after C2 | 0 |
| (none) | 70 | Manifest unreachable; the verifier wrote no receipt ([log](runs/agent70-try2.txt)) | 0 |
| [842f18a0…](receipts/842f18a040dc374819547becd00f2723215ae861029655459cbc4280ba43a5ae.json) | 70 | Signing error above, then connection refused | 0 |
| [5ce8a57c…](receipts/5ce8a57c16996bb4bf4aaad35e96d31826857c312e87d684b0223dc0404b0a5b.json) | 74 | Example input: `service_failed`, not charged | 0.01, never settled |
| [88c5998b…](receipts/88c5998b8387a5b9aa06177895be57a41a1f10aaa5aaca027d5080f192e9a398.json) | 74 | Real image: `service_failed`, not charged | 0.01, never settled |

The console output of every run is in [runs/](runs).

## Not done

- **Records for agents 70 and 72.** Only agent 73 has a mainnet Validation Registry record.

## Closing the accounts

Both accounts were merged into the agent owner, `GDZTNESUUP2YODFWW5TIOVV2PN43JTJFIEZ7ML4JC2VCHOXWNSTV44SC`, after the
runs. The payer sent its 0.295 USDC, removed its trustline and merged
([0f7a9e41…](https://stellar.expert/explorer/public/tx/0f7a9e41c6403102e4d33d5a395746da8a5aa8842d0ac0ba15e819d8f0c53c9a),
ledger 65475396). The validator merged
([bed44e0b…](https://stellar.expert/explorer/public/tx/bed44e0bd201b05c67b9ee46581c1e7dad338ec261ce1e3d4a12ae5e55a1a316),
ledger 65475403). The validation record stays in the registry contract. Both keys remain in the macOS Keychain, so
either account can be funded again.
