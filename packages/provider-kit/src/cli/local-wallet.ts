// --local-wallet: the owner's steps signed by a local wallet instead of a wallet app, for `provider-kit launch`,
// `trustline`, `register` and `request-validation`. It is an alternative to the approval page (cli/approval.ts) and to
// --source: the person installs and connects nothing, and only sends the account some XLM on Mainnet.
//
// approveWithLocalWallet() stands where the approval page stands. It runs the same ApprovalSession, so every check is
// the same one: each transaction is built when it is due, only what verifySigned() accepts is sent, and a transaction
// whose fate is unknown stops the run, so nothing is sent twice. What differs is who signs: a key provider-kit made
// and keeps on this computer (cli/wallet-store.ts). The key is never printed, logged or written to the project.
//
// Which wallet signs:
// - When the command needs a particular account (PAY_TO, or an agent's owner), that account's local wallet. An account
//   whose key isn't here is refused: nothing is signed.
// - Otherwise this project's local wallet, made now when there is none. A run that stopped half way, such as while it
//   waited for XLM, finds the same wallet again, so a funded account is never orphaned.
// A new account needs XLM before it can sign. On testnet Friendbot gives it, as for any wallet. On Mainnet the person
// sends it, and that is all they do:
// - The command names the account and an amount sized to what it is about to do (fundingAsk): the reserve Stellar locks
//   for the account and its USDC trustline, and the fees of the contract calls, which grow with what they store on chain.
// - Before each transaction it compares the account's spendable XLM with that transaction's own fee, known exactly once
//   it is simulated. When the account is short, it names how much more to send and waits, instead of sending a
//   transaction the network would refuse. So an estimate that turns out low costs one more transfer, never a failure.
// - It waits 15 minutes each time. Giving up signs nothing more, and the next run goes on with the same account.

import { TransactionBuilder, type Keypair, type Transaction } from "@stellar/stellar-sdk";
import { ApprovalSession, type ApprovalOutcome, type ApprovalPlan } from "./approval.js";
import { explorerUrl, formatXlm, networkName, type OwnerChain } from "./owner-chain.js";
import type { WalletRecord, WalletStore } from "./wallet-store.js";

/** What Stellar locks while an account exists, in stroops: 1 XLM. */
const ACCOUNT_RESERVE = 10_000_000n;
/** What it locks for each entry the account holds, such as its USDC trustline: 0.5 XLM. */
const ENTRY_RESERVE = 5_000_000n;
/**
 * What a registry call costs at most, in stroops: 0.12 XLM, plus 0.2 XLM for each 1000 bytes it stores. Measured by
 * simulating register_with_uri on Mainnet (600 bytes: 0.22 XLM; 2000: 0.49; 8000: 1.65). Only the first request is
 * sized by it: every transaction's real fee is checked before it is signed.
 */
const CALL_FEE = 1_200_000n;
const FEE_PER_1000_BYTES = 2_000_000n;
/** Asked on top, in stroops: 0.2 XLM, for fees that moved and the transactions after this one. */
const CUSHION = 2_000_000n;
/** Requests are rounded up to this, in stroops: 0.5 XLM. */
const ROUND_TO = 5_000_000n;
/** What a validation request stores, in bytes, before it is prepared: its document names the manifest, the agent and the verifier. */
export const VALIDATION_REQUEST_BYTES = 600;
/** How long a command waits for XLM to arrive. */
const FUNDING_WAIT_MS = 15 * 60_000;
const FUNDING_POLL_MS = 5000;
/** How often one transaction is built again after the network refused it, such as on a busy ledger. */
const REBUILDS = 2;

export interface LocalWalletOptions {
  wallets: WalletStore;
  /** The project directory: where the command runs. */
  project: string;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** Has a local wallet do `plan`: picks or makes it, waits for its XLM, then signs and sends each step in order. */
export async function approveWithLocalWallet(plan: ApprovalPlan, chain: OwnerChain, options: LocalWalletOptions): Promise<ApprovalOutcome> {
  const { wallets, log } = options;
  let keypair: Keypair;
  if (plan.account !== undefined) {
    const found = await wallets.keypair(plan.account.address);
    if (found === undefined) {
      return {
        status: "failed",
        reason: `${plan.account.address} (${plan.account.label.toLowerCase()}) isn't a local wallet on this computer, so --local-wallet can't sign for it. Nothing was signed. Run the command without --local-wallet to sign in the wallet that holds it.`,
      };
    }
    keypair = found;
    log(`\nSigning with your local wallet ${keypair.publicKey()}`);
  } else {
    const made = await projectWallet(wallets, options.project);
    keypair = (await wallets.keypair(made.record.address))!;
    log("");
    log(made.created ? `Made a local wallet for this project: ${made.record.address}` : `Signing with this project's local wallet ${made.record.address}`);
    if (made.created) log(`  Its key is kept in ${wallets.keptWhere(made.record)}. It is never printed or written to the project.`);
  }
  const address = keypair.publicKey();

  // A new Mainnet account: the person sends its first XLM. A testnet one is funded by the steps, from Friendbot.
  if (chain.network === "stellar:pubnet" && !(await chain.account(address)).exists) {
    log("");
    log(fundingRequest(plan, address));
    const gaveUp = await awaitXlm(chain, address, 0n, fundingAsk(plan), options);
    if (gaveUp !== undefined) return { status: "failed", reason: gaveUp };
  }

  const session = new ApprovalSession(plan, chain, log);
  await session.connect(address, "Local wallet");
  let rebuilds = 0;
  let last: string | undefined;
  while (session.state === "review") {
    const view = session.view();
    if (view.review === undefined) {
      // The network refused the transaction, and it can be built again: a new sequence number and simulation.
      const active = view.steps.find((step) => step.status === "active");
      if (active === undefined || rebuilds >= REBUILDS) break;
      rebuilds += 1;
      await session.rebuild(active.id);
      continue;
    }
    const { review } = view;
    if (review.stepId !== last) rebuilds = 0;
    last = review.stepId;
    const transaction = TransactionBuilder.fromXDR(review.xdr, chain.passphrase) as Transaction;
    if (chain.network === "stellar:pubnet") {
      // Mainnet XLM is the person's own: a transaction the account can't pay for is never sent. They top it up instead.
      const short = await shortfall(chain, address, BigInt(transaction.fee), review.stepId === "trustline");
      if (short !== undefined) {
        const more = roundUp(short.missing + CUSHION);
        log("");
        log(`${review.title} costs up to ${review.maxFee}, and ${address} holds ${formatXlm(short.holds)}, of which Stellar keeps ${formatXlm(short.reserve)} in reserve.`);
        log(`Send it ${formatXlm(more)} more on ${networkName(chain.network)}, from any wallet or exchange. No memo is needed.`);
        const gaveUp = await awaitXlm(chain, address, short.holds + short.missing, more, options);
        if (gaveUp !== undefined) return { status: "failed", reason: gaveUp };
        // The transaction waited with the person: built again, it has a new sequence number and time to land.
        await session.rebuild(review.stepId);
        continue;
      }
    }
    log(`  … ${review.title}: ${review.summary} (fee up to ${review.maxFee})`);
    transaction.sign(keypair);
    await session.submit(review.stepId, transaction.toXDR());
  }

  const { state, error } = session.view();
  if (state === "done") {
    log(`  Income arrives in ${address} · ${explorerUrl(plan.network, "account", address)}`);
    log("  provider-kit wallet shows its balance, wallet withdraw moves money out, and wallet export hands it to a wallet app.");
    if (plan.network === "stellar:pubnet") {
      log("  Its key exists on this computer only. Before real income depends on it, back it up: run provider-kit wallet export");
      log("  yourself, in your own terminal, and import the key into a wallet app.");
    }
  }
  if (state === "done" || state === "failed" || state === "cancelled") return session.finished;
  // The session waits for something a person would do on the page, such as connecting another account.
  return { status: "failed", reason: error === undefined ? "The local wallet couldn't finish the steps." : `${error.title}: ${error.message}` };
}

/** This project's local wallet: the newest one made for it, or a new one. */
export async function projectWallet(wallets: WalletStore, project: string): Promise<{ record: WalletRecord; created: boolean }> {
  const mine = (await wallets.list()).filter((record) => record.project === project).at(-1);
  if (mine !== undefined) return { record: mine, created: false };
  return { record: await wallets.create(project), created: true };
}

/**
 * What to ask a new Mainnet account's owner for, in stroops: the reserve for the account and its USDC trustline, the
 * fees of the plan's contract calls by what they store, and a cushion, rounded up to half an XLM.
 */
export function fundingAsk(plan: Pick<ApprovalPlan, "stores">): bigint {
  const calls = (plan.stores ?? []).reduce((sum, bytes) => sum + CALL_FEE + (FEE_PER_1000_BYTES * BigInt(bytes)) / 1000n, 0n);
  return roundUp(ACCOUNT_RESERVE + ENTRY_RESERVE + calls + CUSHION);
}

/** What the person is asked to send first, and why. */
export function fundingRequest(plan: Pick<ApprovalPlan, "stores" | "network">, address: string): string {
  return [
    `Send ${formatXlm(fundingAsk(plan))} to this account on ${networkName(plan.network)}, from any wallet or exchange. No memo is needed.`,
    `  ${address}`,
    `  Stellar keeps ${formatXlm(ACCOUNT_RESERVE + ENTRY_RESERVE)} of it in reserve (the account, and its USDC trustline). The rest pays the network fees`,
    "  of the steps. What isn't spent stays in the account, and is yours to withdraw.",
  ].join("\n");
}

/**
 * How much XLM the account is short of to pay `fee`, or undefined when it can pay it, or when the chain reader
 * reports no balance. `addsEntry`: the transaction adds an entry that locks more reserve, such as a trustline.
 */
async function shortfall(chain: OwnerChain, address: string, fee: bigint, addsEntry: boolean): Promise<{ missing: bigint; holds: bigint; reserve: bigint } | undefined> {
  const state = await chain.account(address);
  if (state.xlm === undefined) return undefined;
  const entries = BigInt(state.subentries ?? (state.usdcTrustline ? 1 : 0)) + (addsEntry && !state.usdcTrustline ? 1n : 0n);
  const reserve = ACCOUNT_RESERVE + entries * ENTRY_RESERVE;
  const missing = reserve + fee - state.xlm;
  return missing > 0n ? { missing, holds: state.xlm, reserve } : undefined;
}

/**
 * Waits until the account exists and holds at least `needed` stroops. Returns why it gave up, or undefined to go on.
 * `asked` is what the person was asked to send, for the message when nothing arrives.
 */
async function awaitXlm(chain: OwnerChain, address: string, needed: bigint, asked: bigint, options: LocalWalletOptions): Promise<string | undefined> {
  const { log } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  log(`  Waiting for it, up to ${FUNDING_WAIT_MS / 60_000} minutes. Ctrl+C stops; running the command again goes on with the same account.`);
  const deadline = now() + FUNDING_WAIT_MS;
  for (;;) {
    const state = await chain.account(address);
    if (state.exists && (state.xlm === undefined || state.xlm >= needed)) {
      log(`  ✓ Received${state.xlm === undefined ? "" : `: it holds ${formatXlm(state.xlm)}`}`);
      return undefined;
    }
    if (now() >= deadline) {
      const holds = state.exists && state.xlm !== undefined ? `holds only ${formatXlm(state.xlm)}` : "hasn't received any XLM";
      return `${address} ${holds} on ${networkName(chain.network)}. Nothing more was signed. Send it ${formatXlm(asked)}, then run the command again: it goes on with the same wallet.`;
    }
    await sleep(FUNDING_POLL_MS);
  }
}

function roundUp(stroops: bigint): bigint {
  return ((stroops + ROUND_TO - 1n) / ROUND_TO) * ROUND_TO;
}
