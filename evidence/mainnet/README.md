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
- **Badges.** Agents 73 and 70 earned Standard v1, Payment verified, Recovery verified and Load-safe. Agent 72
  earned the first three.

![Standard v1](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.standard-v1.svg)
![Payment verified](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.payment-verified.svg)
![Recovery verified](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.recovery-verified.svg)
![Load-safe](receipts/39971c0234ca3bb7a141aa558bdc68a8b1f91826685621be66ce4d557fbe8ddd.load-safe.svg)

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

- **Validation Registry records on mainnet.** A record needs the agent's owner to sign a validation request naming
  the validator, then `verifier publish` with the receipt served at a public HTTPS URL. The owner wallets are not
  on this computer, so this waits for the owner.
- **Withdrawing what is left.** The payer holds 0.295 USDC and about 3 XLM; the validator holds 2 XLM.
