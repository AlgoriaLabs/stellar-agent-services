# D3 pilot participant feedback

Feedback supplied for the two paid mainnet pilots on 16–17 November 2026. X Strategy Agent’s developer
also acted as its buyer. Meeting Action Extractor’s buyer participated independently. The notes describe
what each participant reported using and observing during the pilot. [Pilot report and findings](report.md).

## X Strategy Agent

Stellar mainnet agent 76, 16 November 2026. [Provider and payment evidence](../mainnet/x-strategy.md).

### Provider experience (P1)

**What worked**

- `npm create stellar-service` produced a runnable project from flags without prompts. `provider-kit dev`
  used a throwaway testnet payout account, so wallet setup could wait until launch.
- `createProvider()` rejected invalid configurations on startup. `check` and `verifier check` cited rule IDs,
  and `status` named the next command.
- `launch --local-wallet` showed the exact 2 XLM to fund, waited for it, signed the trustline and 8004
  registration, and saved `PAY_TO` and `AGENT_ID` in `.env`. The dry run showed what it would sign first.
- `signTestPayment` made it easy to write an offline test covering the HTTP 402 response, payment and result.

**Friction**

- npm 0.1.1 lacked the documented `--local-wallet`, `/openapi.json` and `/llms.txt`. The provider packed
  the Kit from a local clone into `vendor/` and called this the biggest problem.
- With no default mainnet validator, launch skipped the validation request. Reaching the verified stage
  required knowing a validator’s address.
- The automated deploy path assumed Fly.io. The provider wrote Oracle deployment scripts because launch
  printed settings for other hosts and stopped.
- The template only served provider routes. To serve PDF files, the provider wrapped `provider.fetch`.
- C7 sent 20 requests, filling the provider’s 20-per-minute rate limit. The first request after the check
  received an HTTP 429 response.

### Buyer experience (U1)

**What worked**

- The payment client checked the HTTP 402 challenge against the manifest and spending limit, signed once,
  and confirmed the transfer on chain on the first attempt.
- The facilitator covered the network fee, on-success charging made the buyer comfortable proceeding, and
  the job took 58 seconds.

**Friction**

- The provider reported that `stellar-pay` only offered a testnet flow. Acting as the buyer, they wrote their
  own mainnet payer for key storage, the USDC trustline and the DEX purchase.
- The 0.10 USDC job required 2.5 XLM up front, including 1.5 XLM held as reserve.
- Both newly funded accounts received dust from a look-alike of the funding address within seconds.
  The tooling did not surface it.
- The PDF link was available for 24 hours, so the buyer needed to save the file.

The participant’s suggested priorities were publishing a release that matches the docs, adding a mainnet
buyer wallet with funding guidance, and naming a default mainnet validator.

## Meeting Action Extractor

Stellar mainnet agent 77, 17 November 2026. [Provider and payment evidence](../mainnet/meeting-actions.md).

### Provider experience (P2)

**What worked**

- `AGENTS.md` helped choose the integration path. `defineService` and `createProvider` covered a provider
  of about 400 lines.
- `signTestPayment` and a fake facilitator covered the HTTP 402 response, payment and result offline.
- `dev`, `check` and `try` worked on testnet on the first attempt. The throwaway payout and paid test
  command removed manual wallet setup during development.
- `launch --local-wallet` showed the exact 2.5 XLM to fund, waited for it, signed the trustline and 8004
  registration, and saved `PAY_TO` and `AGENT_ID` without requiring a separate wallet installation.
- The “How agents see you” hints in `check` and the next command shown by `status` were useful.

**Friction and suggestions**

- npm 0.1.1 lacked `--local-wallet`, `/openapi.json` and `/llms.txt`. The provider used tarballs packed
  from a checkout and requested a 0.1.2 release.
- The provider used a scratch copy to keep the testnet `PAY_TO` written by `provider-kit dev` out of the
  mainnet `.env`. They suggested a dedicated dev environment file or a mainnet configuration guard.
- The provider wrote their own systemd and Caddy deployment. A permissions issue and macOS `._*` files
  affected the first attempt. They suggested a VM deployment template with rollback.
- The provider reported no default mainnet verifier and pointed to validation rent that can exceed
  17 XLM. With `--no-validation`, the service stayed unverified. They suggested a default verifier or
  a way to use a confirmed paid call as evidence for C4.
- `status --url` showed a failed local check for a remote deployment. The provider suggested hiding the
  local check for this mode.
- Mainnet search matched the provider name and description. The provider put keywords in the description
  and suggested indexing service tags as well.

### Buyer experience (U2)

**What worked**

- The quote, payment check, spending limit and on-chain confirmation worked on the first attempt.
  The job succeeded, charged once and retained a record.
- On-success charging was reassuring. The result came back in seconds, and the buyer could inspect the
  settlement in the explorer.

**Friction and suggestions**

- Preparing a buyer wallet was the largest step. The 0.01 USDC call required a reserve, a USDC trustline,
  a DEX purchase and a handwritten payer script. The buyer suggested mainnet wallet creation, funding
  and closure commands in `stellar-pay`, or the Agent Wallet on mainnet.
- The buyer wanted the funding instructions to explain the 1.5 XLM reserve and when it can be recovered
  through wallet closure.
- A look-alike account sent dust within 15 seconds of funding. The buyer suggested highlighting suspicious
  transfers and requiring explicit entry of the return address.
- Horizon returned one transient “fetch failed” before the transaction was submitted. The buyer suggested
  retries for read-only calls.
- Passing a long transcript as command-line JSON was awkward. The buyer suggested supporting
  `@file.json` input.
