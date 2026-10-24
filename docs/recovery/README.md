# Job Recovery, the short version

> **TL;DR**
> If the internet breaks after you pay, you still get your result.
> You **never pay twice**.
> If nobody knows whether the money moved, **we ask the blockchain**.

Full details: [job-recovery.md](../job-recovery.md) · For AI agents: [README-AI.md](README-AI.md)

---

## 🧃 The idea in one picture

You buy a coffee. You pay. The Wi-Fi drops before the receipt prints.

- ❌ Bad shop: "Pay again."
- ✅ Our shop: "Show me your order number. Here's your coffee."

**The order number = the job id.** The client saves it *before* paying, so it is never lost.

---

## 🔘 Three buttons

| Button | What it does | Costs money? |
| --- | --- | --- |
| **create-job** | Start a job (and pay) | Yes, once |
| **check-status** | "Is it done?" | Never |
| **get-result** | "Give me the answer" | Never |

Lost the connection? Press **get-result** again. Free.

---

## 😬 The scary case: "payment_uncertain"

Sometimes the payment service doesn't answer in time.
Did the money move? **Nobody knows.**

The rule: **don't guess, and don't charge again.** Look at the blockchain instead.

| The blockchain says | What happens |
| --- | --- |
| 💸 The money moved | The job runs, or the result is shown |
| 🚫 The money never moved, and now it can't | Job fails, **you are not charged** |
| 🤷 Can't tell yet | Wait and look again later |

This check is called **reconciliation**.

---

## 🛠️ What I built

1. **The wallet stops panicking.**
   "Still settling" (HTTP `409`) used to look like an error. Now the wallet just waits and keeps asking.

2. **Providers check the blockchain by themselves.**
   Every 30 seconds they look at "uncertain" jobs and decide them.

3. **A command for operators.**
   `provider-kit reconcile`. Add `--dry-run` to see what would happen without changing anything.

4. **A ledger clock.**
   A payment expires at a *blockchain block* (a "ledger"), not at a clock time.
   Jobs are now timed by that block, so nobody works on a payment that already expired.

5. **Docs and tests.**
   27 new tests. All 491 pass.

---

## 🔍 How we find the right payment

The same person can pay the same price many times.
So "100 USDC from Alice" is **not** proof for *this* job.

Every payment has a **one-time number** (a nonce) inside its signature.
The blockchain accepts each one **once**.
→ We look for that exact number. No mix-ups.

---

## 🐛 Bug I caught with real data

I tested against the real Stellar testnet (read-only).
The code skipped every real event, because the network stopped sending one old field.
**Effect:** a paid job could have been marked "not charged". Now it's fixed and tested.

---

## 🛡️ Why nobody pays twice

- The wallet saves the job id **before** paying.
- One job id = one job, forever.
- One signed payment = one job, forever.
- Unsure? **Never charge again**: ask the blockchain.
- Recovery **only reads**. It never pays.

---

## ✅ What's left

- [ ] Record the recovery demo on testnet (video plus proof of one single transfer)
- [ ] Commit this work and open a PR
- [ ] Mainnet providers must set their own RPC URL (testnet uses a free public one)

---

## 📚 Words

| Word | Means |
| --- | --- |
| **Job** | One paid request to a service |
| **Settle** | The payment actually moves on chain |
| **Ledger** | One block of the Stellar blockchain, about every 5 seconds |
| **RPC** | The server we ask about the blockchain |
| **Nonce** | A one-time number inside a payment signature |
| **on-success** | You pay only if the job works |
| **upfront** | You pay first, then the job runs |
