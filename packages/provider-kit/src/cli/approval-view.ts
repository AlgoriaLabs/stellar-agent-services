// What the approval page shows: the state of one approval session, as the CLI sends it to the page in the
// browser (approve/src). The page renders it as it is, so every word the developer reads comes from here.
// Types only, with no imports, so the page can import this file too.

export type ApprovalState = "connect" | "working" | "review" | "done" | "failed" | "cancelled";

/** One row of a summary: a label and its value. */
export interface ApprovalDetail {
  label: string;
  value: string;
  /** Monospace, for addresses, hashes and ids. */
  mono?: boolean;
  /** Where the value can be looked up, such as an account on Stellar Expert. */
  href?: string;
}

export interface ApprovalStepView {
  id: string;
  title: string;
  status: "pending" | "active" | "done";
  /** What happened, once done, such as "Agent 42". */
  note?: string;
  /** The transaction that did it, once done. */
  transaction?: { hash: string; url: string };
}

/** The transaction waiting for approval. */
export interface ApprovalReview {
  stepId: string;
  title: string;
  /** What signing it does, in plain words. */
  summary: string;
  details: ApprovalDetail[];
  /** The transaction to sign as it is: base64 XDR. */
  xdr: string;
  /** Its hash, hex. Wallets that show a hash show this one. */
  hash: string;
  /** The most it can cost in network fees, such as "0.0012 XLM". */
  maxFee: string;
  /** When the network stops accepting it, in epoch milliseconds. */
  expiresAt: number;
}

export interface ApprovalView {
  /** The command that opened the page, such as "provider-kit register". */
  command: string;
  title: string;
  intro: string;
  network: { id: string; name: string; passphrase: string };
  /** The account to connect, when the command needs a particular one. */
  account?: { address: string; label: string; reason: string };
  /** The account the wallet connected, and the wallet's name. */
  connected?: { address: string; wallet?: string };
  state: ApprovalState;
  /** What is happening while the state is "working". */
  activity?: string;
  /** The steps after connecting a wallet, in order. */
  steps: ApprovalStepView[];
  /** Set while the state is "review". */
  review?: ApprovalReview;
  /** The last problem. `retry` is what the page offers: connect a wallet again, build the transaction again, or nothing. */
  error?: { title: string; message: string; retry: "connect" | "rebuild" | "none" };
  /** How the session ended: set once the state is "done", "failed" or "cancelled". */
  result?: { title: string; message: string; details: ApprovalDetail[] };
}
