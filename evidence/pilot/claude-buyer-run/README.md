# Claude-assisted pilot buyer run (mainnet, 2026-11-17)

On **17 November 2026 (UTC)** a new buyer wallet found both pilot providers with Stellar Agent Search,
reviewed each payment's terms, approved each one and paid once with the published payment client on Stellar
mainnet. Both jobs succeeded and both transfers are confirmed on chain.

**Who the buyer is.** The project owner confirmed that a third pilot user, distinct from the two previously
recorded buyers, ran this flow and personally approved both payments. Claude assisted and the project owner
funded the buyer wallet. The participant is listed as U3 in the [pilot report](../report.md).

## Summary

| | Meeting Action Extractor | X Strategy Agent |
| --- | --- | --- |
| Agent / network | 77 / `stellar:pubnet` | 76 / `stellar:pubnet` |
| Found with | `find "meeting action items"` (ranked 9 of 9), `manifest 77` | `find "X marketing strategy for a GitHub repository"` (ranked 7 of 7), `manifest 76` |
| Price, charged | 0.01 USDC, on success | 0.10 USDC, on success |
| Job | `22c43275-1e93-4b7d-b5b7-9c1dd84ed32c` | `c719bbab-ba60-4536-8b86-962bbe9c938b` |
| Approved (UTC) | 13:40:54 | 13:41:28 |
| Settled on chain | [ledger 65527366, 13:41:12](https://stellar.expert/explorer/public/tx/521aa0de15a3e9de22538774a782257e3540924599bdb417488f93587e9bcbf9) | [ledger 65527387, 13:42:57](https://stellar.expert/explorer/public/tx/2de5f3474913f9e5c6383100a8101a991b9fe38c860ee307114d23e69d9c402e) |
| Result | 3 action items with owners and due dates, 2 decisions, a summary | 22-page PDF "stellar-agent-search: X marketing strategy" with highlights |
| Client confirmation | Confirmed | Not confirmed by the client (RPC lookup failed); confirmed independently on Horizon |

Buyer wallet: [`GAM6BSNAX3UHNH4UMLAG5WU47OBJQEZZWU2PVE3J65TW3DDX2V7MUWSP`](https://stellar.expert/explorer/public/account/GAM6BSNAX3UHNH4UMLAG5WU47OBJQEZZWU2PVE3J65TW3DDX2V7MUWSP).
Through the end of the run, Horizon shows one USDC debit per job (0.01 and 0.10 USDC) and matching credits to
`GDZ2Z5TM…ZFW6` (agent 77) and `GAIBNH5Z…RAKE` (agent 76). [Ledger record](data/04-ledger.json).

## Steps and screenshots

The screenshots are original Terminal captures. The X Strategy Agent result is available as a log and JSON
with the private PDF download URL omitted. Its result screenshot contained the same URL.

1. **Wallet.** A new keypair was created for this run. The project owner funded it with 5.2 XLM. One
   transaction then added the USDC trustline and bought exactly 0.12 USDC for 0.8546577 XLM
   ([ledger 65527294](https://stellar.expert/explorer/public/tx/8681fbb95a7a6b1017545558a298885b486330043628e44f1f9d152ef816017b)).
   [Screenshot](screens/01-wallet-funded.jpg) · [record](data/01-fund.json).
2. **Discovery with Stellar Agent Search** (GitHub `main` at `0f200a1`, mainnet registry).
   - [Meeting query results](screens/02a-search-find-meeting.jpg): [long query](logs/02a-find-meeting-actions.txt),
     [short query](logs/02b-find-meeting-action-items.txt).
   - [Agent 77 manifest](screens/02b-search-manifest-77.jpg): price, payee, identity binding I1–I3 passed
     ([log](logs/02c-manifest-77.txt)).
   - [X strategy query results](screens/02c-search-find-x-strategy.jpg) ([log](logs/02d-find-x-strategy.txt)).
   - [Agent 76 manifest](screens/02d-search-manifest-76.jpg): identity binding I1–I3 passed
     ([log](logs/02e-manifest-76.txt)).
3. **Meeting Action Extractor.** [Approval screen](screens/03a-meeting-actions-approval.jpg): provider, manifest,
   price, network, full payee, asset, job id, the spending limits (0.01 USDC per payment, 0.15 per 24 h, no
   payment without a prompt) and the passing challenge/policy check, shown before anything was signed.
   [Result and confirmed payment](screens/03b-meeting-actions-result.jpg).
   [Log](logs/03-meeting-actions.txt) · [quote](data/quote-meeting-actions.json) ·
   [decision](data/decision-meeting-actions.json) · [result](data/pay-meeting-actions.json) ·
   [input](data/meeting-actions.input.json).
4. **X Strategy Agent.** [Approval screen](screens/04a-x-strategy-approval.jpg) (limit 0.10 USDC per payment).
   [Terminal log with the result](logs/04-x-strategy.txt) · [quote](data/quote-x-strategy.json) ·
   [decision](data/decision-x-strategy.json) · [result](data/pay-x-strategy.json) ·
   [input](data/x-strategy.input.json).

## Tools

- Stellar Agent Search at GitHub `main` (`0f200a1`). The npm release `stellar-agent-search@0.1.0` has no
  `manifest` command and no Provider Standard discovery.
- `@stellar-agent-services/payment-client@0.1.1` (npm), with a local key signer, the default policy narrowed
  to the limits above, a file journal, and `https://mainnet.sorobanrpc.com`. The bundled `stellar-pay` CLI is
  testnet-only, so a short script called `quote()`, `pay()` and `recover()` directly.
- `@stellar/stellar-sdk` for the trustline and USDC purchase. Approval was a typed `yes` at a prompt; an
  empty answer asked again.

## Findings

| Finding | Detail |
| --- | --- |
| Discovery ranked the pilot providers low | The query "extract action items and decisions from a meeting transcript" did not return agent 77 in its 10 results. "meeting action items" returned it 9th of 9 with score 0, although its name and description matched. Agent 76 came 7th of 7 with score 0. Both have x402 services but no reputation yet, and the search scanned 78 registry records. A buyer needs the agent id to reach them quickly. |
| Payment confirmation can report a false "not confirmed" | For X Strategy Agent the job returned `charged: true` with a transaction hash, but the client's RPC lookup failed (`fetch failed`), so it printed "Not confirmed". Horizon shows the transfer settled once. A retry or a Horizon fallback would avoid a false alarm. `recover()` can re-check without paying. |
| Approval held a stray keypress | In a first attempt the approval prompt received an empty answer and declined; nothing was signed and the journal holds only the intent. The run script was changed so an empty answer asks again. |
| Look-alike dust | Ten seconds after the account was created, `GDZTI44P…44SC`, an address imitating the funder `GDZTNESU…44SC`, sent it 0.0001 XLM. This matches what U1 and U2 reported. |
| Mainnet buyer setup is manual | No released tool funds a mainnet buyer wallet or pays from the command line on mainnet. The run used scripts for both. Node 22 or later is required; the operator's default Node 20 had to be switched. |
| Result link is temporary | The X strategy PDF was served from a link with a 24-hour expiry. The result record preserves its title, page count and highlights. |

## Not covered

No interrupted job was recovered in this run. Paid verifier checks (C4/C5), receipts, badges and Validation
Registry records for agents 76 and 77 are outside this run. The wallet key, the payment journal and job tokens
are not published.
