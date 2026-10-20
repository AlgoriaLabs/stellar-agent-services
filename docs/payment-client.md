# Payment Client: design (open)

> Status: **open**. Needed by Week 1, day 2, because the SOW expects a working Payment Client in Week 1.

## Fixed requirements
- Wallet separation: keys never touch discovery or provider code.
- Explicit approval of the service, price, recipient, asset and network, approved once.
- Spending controls: a per-payment cap and a rolling budget. A failed limit check blocks the payment.
- Challenge validation against the approved manifest.
- Durable journal before sending; never re-sign the same job.
- Recovery through check-status and get-result only.
- On-chain settlement proof before showing "paid".

## Options
1. Node library + CLI with a local encrypted keystore.
2. A separate keyed MCP server that uses MCP elicitation for approval (separate from the read-only search server).
3. A local or browser approval page with a wallet extension (e.g. Freighter); the client never sees the secret.
4. A hybrid: a design-independent core (policy, validation, journal, recovery) plus one approval surface.

## Questions
- Who are the five pilot users: developers in Claude Code/Codex, or non-technical users?
- Should the payer key live in a wallet extension or a local keystore?
- Which surface will the Deliverable 1 video and screenshots show?

## Decision
<!-- To be recorded here. -->
