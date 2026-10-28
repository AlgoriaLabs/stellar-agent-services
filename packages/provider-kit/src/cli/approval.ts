// Approving the owner's transactions in a browser wallet: how `provider-kit trustline`, `register` and
// `request-validation` sign without --source. The developer connects the wallet they already use (through
// Stellar Wallets Kit: Freighter, xBull, Albedo, Ledger and more) on a page provider-kit serves on this
// computer, reviews each transaction there and approves it in the wallet. No key reaches provider-kit, and the
// Stellar CLI isn't needed.
//
// - ApprovalSession runs one command's steps in order. It builds each transaction only when it is due (a
//   fresh sequence number and simulation), sends only what verifySigned() accepts, and stops for good when
//   a transaction's fate is unknown, so nothing is ever sent twice.
// - startApprovalServer() serves the page (approve/, built into dist/approve) and the session's JSON API on
//   127.0.0.1 only, like a native app's loopback redirect (RFC 8252). The API needs the session's token,
//   which reaches the page only in the link's fragment, and refuses other Host and Origin headers, so
//   neither another site nor DNS rebinding can drive it.
// - approveInBrowser() is what the commands call: it starts both, opens the link and waits for the end.

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { stellarAddressKind, type StellarNetwork } from "@stellar-agent-services/protocol";
import type { Transaction } from "@stellar/stellar-sdk";
import type { ApprovalDetail, ApprovalReview, ApprovalState, ApprovalView } from "./approval-view.js";
import { ApprovalError, explorerUrl, formatXlm, networkName, verifySigned, type OwnerChain, type SendResult } from "./owner-chain.js";

export { ApprovalError };

/** What a command asks the developer to approve. */
export interface ApprovalPlan {
  /** Such as "provider-kit register". */
  command: string;
  title: string;
  intro: string;
  network: StellarNetwork;
  /** The account to connect, when the command needs a particular one. */
  account?: { address: string; label: string; reason: string };
  /** The steps the page lists before a wallet connects. */
  outline: { id: string; title: string }[];
  /** Checks the connected account and returns its steps, in order. Throws an ApprovalError when it can't go on. */
  steps(address: string): Promise<ApprovalStep[]>;
  /** What the page says once every step is done. */
  result(): { title: string; message: string; details: ApprovalDetail[] };
}

export type ApprovalStep =
  /** Something done without a signature, such as funding a new testnet account. Returns what happened. */
  | { kind: "auto"; id: string; title: string; run(): Promise<string> }
  /** A transaction the wallet signs. build() runs when the step is due; done() says what it did. */
  | {
      kind: "sign";
      id: string;
      title: string;
      build(): Promise<ProposedTransaction>;
      done(sent: Extract<SendResult, { status: "success" }>): string | Promise<string>;
    };

/** A transaction to sign, and what it does in plain words. */
export interface ProposedTransaction {
  transaction: Transaction;
  summary: string;
  details: ApprovalDetail[];
}

export type ApprovalOutcome = { status: "done"; address: string } | { status: "cancelled" } | { status: "expired" } | { status: "failed"; reason: string };

/** A request the session can't take now, such as an approval for a step that isn't due. The page reloads the view. */
export class ApprovalConflict extends Error {
  override name = "ApprovalConflict";
}

interface StepRecord {
  step: ApprovalStep;
  status: "pending" | "active" | "done";
  note?: string;
  hash?: string;
}

/** One command's approval: its steps, run in order as the developer connects a wallet and approves. */
export class ApprovalSession {
  readonly finished: Promise<ApprovalOutcome>;
  #resolve!: (outcome: ApprovalOutcome) => void;
  #state: ApprovalState = "connect";
  #steps: StepRecord[] = [];
  #connected: { address: string; wallet?: string } | undefined;
  #review: { record: StepRecord; proposal: ProposedTransaction } | undefined;
  #activity = "";
  #error: ApprovalView["error"];
  #result: ApprovalView["result"];
  #busy = false;
  #cancelling = false;

  constructor(
    readonly plan: ApprovalPlan,
    readonly chain: OwnerChain,
    readonly log: (line: string) => void = () => {},
  ) {
    this.finished = new Promise((resolve) => (this.#resolve = resolve));
  }

  get state(): ApprovalState {
    return this.#state;
  }

  /** Whether a request is under way, such as a check, a build or a transaction being sent. */
  get busy(): boolean {
    return this.#busy;
  }

  view(): ApprovalView {
    const { plan } = this;
    const steps =
      this.#steps.length === 0
        ? plan.outline.map(({ id, title }) => ({ id, title, status: "pending" as const }))
        : this.#steps.map(({ step, status, note, hash }) => ({
            id: step.id,
            title: step.title,
            status,
            ...(note === undefined ? {} : { note }),
            ...(hash === undefined ? {} : { transaction: { hash, url: explorerUrl(plan.network, "tx", hash) } }),
          }));
    const review = this.#state === "review" && this.#review !== undefined ? reviewOf(this.#review.record, this.#review.proposal) : undefined;
    return {
      command: plan.command,
      title: plan.title,
      intro: plan.intro,
      network: { id: plan.network, name: networkName(plan.network), passphrase: this.chain.passphrase },
      ...(plan.account === undefined ? {} : { account: plan.account }),
      ...(this.#connected === undefined ? {} : { connected: this.#connected }),
      state: this.#state,
      ...(this.#state === "working" ? { activity: this.#activity } : {}),
      steps,
      ...(review === undefined ? {} : { review }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
      ...(this.#result === undefined ? {} : { result: this.#result }),
    };
  }

  /** The wallet connected `address`: checks it, then runs the steps up to the first transaction to approve. */
  async connect(address: string, wallet?: string): Promise<void> {
    await this.#exclusive(["connect"], async () => {
      if (stellarAddressKind(address) !== "account") {
        throw new ApprovalError("Connect a Stellar account", "The wallet gave an address that isn't an account. Connect one whose address starts with G.", "connect");
      }
      this.#working("Checking the account");
      const steps = await this.plan.steps(address);
      this.#connected = { address, ...(wallet === undefined || wallet === "" ? {} : { wallet }) };
      this.#steps = steps.map((step) => ({ step, status: "pending" }));
      this.log(`  ✓ Connected ${address}${wallet === undefined || wallet === "" ? "" : ` (${wallet})`}`);
      await this.#advance();
    });
  }

  /** The wallet signed the transaction waiting for approval: checks it is that very transaction, sends it and moves on. */
  async submit(stepId: string, signedXdr: string): Promise<void> {
    await this.#exclusive(["review"], async () => {
      const current = this.#review;
      if (current === undefined || current.record.step.id !== stepId || current.record.step.kind !== "sign") {
        throw new ApprovalConflict("That transaction isn't waiting for approval anymore.");
      }
      const { record, proposal } = current;
      const step = current.record.step;
      const signed = verifySigned(proposal.transaction, signedXdr, this.#connected!.address, this.plan.network, this.chain.passphrase);
      this.#review = undefined;
      this.#working(`Sending to ${networkName(this.plan.network)}`);
      const sent = await this.chain.send(signed);
      if (sent.status === "unknown") {
        this.#stop(`${step.title} was sent, but it isn't confirmed: ${sent.reason}. Look the transaction up before trying again.`, {
          label: `${step.title}, not confirmed`,
          hash: sent.hash,
        });
        return;
      }
      if (sent.status === "failed") throw new ApprovalError(`${step.title} didn't go through`, `${sent.reason} Review it and approve again.`, "rebuild");
      record.hash = sent.hash;
      try {
        record.note = await step.done(sent);
      } catch (error) {
        // It is on chain: building it again would do it twice.
        this.#stop(`${step.title} went through, but its result can't be read: ${(error as Error).message}.`, { label: step.title, hash: sent.hash });
        return;
      }
      record.status = "done";
      this.log(`  ✓ ${step.title}: ${record.note} · ${explorerUrl(this.plan.network, "tx", sent.hash)}`);
      await this.#advance();
    });
  }

  /** Builds the transaction waiting for approval again: after it expired, or after the network refused it. */
  async rebuild(stepId: string): Promise<void> {
    await this.#exclusive(["review"], async () => {
      const record = this.#steps.find((each) => each.status === "active");
      if (record === undefined || record.step.id !== stepId || record.step.kind !== "sign") throw new ApprovalConflict("That step isn't the one waiting for approval.");
      this.#working("Preparing the transaction");
      this.#review = { record, proposal: await record.step.build() };
      this.#state = "review";
    });
  }

  /**
   * Ends the session before it is done. While a request is under way, such as a transaction being sent, it is
   * refused, or with `whenIdle` the session ends as soon as that request finishes.
   */
  cancel(whenIdle = false): void {
    if (isFinal(this.#state)) throw new ApprovalConflict("The session has ended.");
    if (this.#busy) {
      if (!whenIdle) throw new ApprovalConflict("The session is busy. Wait a moment.");
      this.#cancelling = true;
      return;
    }
    const signed = this.#steps.some((record) => record.hash !== undefined);
    this.#result = { title: "Cancelled", message: signed ? "Nothing else was signed. What you approved before stays on chain." : "Nothing was signed.", details: [] };
    this.log("  ✗ Cancelled");
    this.#finish({ status: "cancelled" }, "cancelled");
  }

  /** Ends a session left idle. A session in the middle of something carries on. */
  expire(): void {
    if (this.#busy || isFinal(this.#state)) return;
    this.#result = { title: "This page timed out", message: "Run the command again in your terminal for a new link.", details: [] };
    this.#finish({ status: "expired" }, "cancelled");
  }

  async #advance(): Promise<void> {
    for (const record of this.#steps) {
      if (record.status === "done") continue;
      record.status = "active";
      const { step } = record;
      if (step.kind === "auto") {
        this.#working(step.title);
        record.note = await step.run();
        record.status = "done";
        this.log(`  ✓ ${step.title}: ${record.note}`);
        continue;
      }
      this.#working("Preparing the transaction");
      this.#review = { record, proposal: await step.build() };
      this.#state = "review";
      return;
    }
    this.#result = this.plan.result();
    this.#finish({ status: "done", address: this.#connected!.address }, "done");
  }

  /** Runs one request at a time, in the states that take it. An ApprovalError becomes the page's error. */
  async #exclusive(states: ApprovalState[], action: () => Promise<void>): Promise<void> {
    if (this.#busy) throw new ApprovalConflict("The session is busy. Wait a moment.");
    if (!states.includes(this.#state)) throw new ApprovalConflict(`The session is in the ${this.#state} state.`);
    this.#busy = true;
    this.#error = undefined;
    try {
      await action();
    } catch (error) {
      if (error instanceof ApprovalConflict) throw error;
      this.#fail(error);
    } finally {
      this.#busy = false;
      if (this.#cancelling && !isFinal(this.#state)) this.cancel();
    }
  }

  #fail(error: unknown): void {
    // Anything unexpected, such as an RPC outage, is shown as it is. Connecting again starts over from what is on chain.
    const problem = error instanceof ApprovalError ? error : new ApprovalError("Something went wrong", error instanceof Error ? error.message : String(error), "connect");
    this.#error = { title: problem.title, message: problem.message, retry: problem.retry };
    this.log(`  ! ${problem.title}: ${problem.message}`);
    if (problem.retry === "none") {
      this.#stop(problem.message);
    } else if (problem.retry === "connect") {
      this.#state = "connect";
      this.#connected = undefined;
      this.#steps = [];
      this.#review = undefined;
    } else {
      this.#state = "review";
      this.#review = undefined;
    }
  }

  /** Stops for good: the page says why, and nothing more is sent. `transaction` is the one whose fate is in question. */
  #stop(reason: string, transaction?: { label: string; hash: string }): void {
    const url = transaction === undefined ? undefined : explorerUrl(this.plan.network, "tx", transaction.hash);
    const details: ApprovalDetail[] = transaction === undefined ? [] : [{ label: transaction.label, value: transaction.hash, mono: true, href: url! }];
    this.#error = undefined;
    this.#result = { title: "Stopped", message: reason, details };
    this.log(`  ✗ ${reason}${url === undefined ? "" : ` ${url}`}`);
    this.#finish({ status: "failed", reason }, "failed");
  }

  #working(activity: string): void {
    this.#state = "working";
    this.#activity = activity;
  }

  #finish(outcome: ApprovalOutcome, state: "done" | "failed" | "cancelled"): void {
    this.#state = state;
    this.#review = undefined;
    this.#error = undefined;
    this.#resolve(outcome);
  }
}

function isFinal(state: ApprovalState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

function reviewOf(record: StepRecord, proposal: ProposedTransaction): ApprovalReview {
  const { transaction } = proposal;
  return {
    stepId: record.step.id,
    title: record.step.title,
    summary: proposal.summary,
    details: proposal.details,
    xdr: transaction.toXDR(),
    hash: transaction.hash().toString("hex"),
    maxFee: formatXlm(transaction.fee),
    expiresAt: Number(transaction.timeBounds?.maxTime ?? 0) * 1000,
  };
}

/** What the terminal says when a session ends without finishing. */
export function describeOutcome(outcome: Exclude<ApprovalOutcome, { status: "done" }>): string {
  switch (outcome.status) {
    case "cancelled":
      return "Cancelled. Nothing more was signed.";
    case "expired":
      return "The approval page timed out. Run the command again for a new link.";
    case "failed":
      return `Stopped. ${outcome.reason}`;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The local page and its API.

/** The built page: dist/approve, next to dist/cli. */
export const APPROVAL_PAGE = new URL("../approve/", import.meta.url);
/** The page's port. A fixed one lets wallets remember that they connected to it before; a busy one falls back to any free port. */
export const DEFAULT_APPROVAL_PORT = 8790;
/** A session left alone this long ends. */
const IDLE_MS = 15 * 60_000;
/** The largest request body: a signed registration with an 8 KiB data: URI is about 12 KiB. */
const MAX_BODY_BYTES = 256 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/**
 * The page runs only its own scripts. Wallet modules open their makers' popups, may call their services and
 * show icons from their sites, so frames, connections and images may use HTTPS. None of that can change what
 * is sent: verifySigned() checks the signed transaction here.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  // The wallet picker styles itself at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  // Wallet popups (Albedo, xBull) answer through window.opener.
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Cross-Origin-Resource-Policy": "same-origin",
  // USB and HID for hardware wallets.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(self), hid=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export interface ApprovalServer {
  /** The link to open, with the token in its fragment. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface ApprovalServerOptions {
  /** A port to use, which must be free. Without it: DEFAULT_APPROVAL_PORT, or any free port when that one is busy. */
  port?: number;
  /** The built page's directory. */
  page?: URL;
  /** How long the session may sit idle before it expires. */
  idleMs?: number;
}

export async function startApprovalServer(session: ApprovalSession, options: ApprovalServerOptions = {}): Promise<ApprovalServer> {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const page = options.page ?? APPROVAL_PAGE;
  let port = 0;
  let idle: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idle);
    // A session in the middle of something is left to finish it, then looked at again.
    const fire = () => {
      if (session.busy) idle = setTimeout(fire, 60_000).unref();
      else session.expire();
    };
    idle = setTimeout(fire, options.idleMs ?? IDLE_MS).unref();
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { message: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // DNS rebinding: a page on another name that resolves here gets nothing.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host ?? "")) {
      response.writeHead(403, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" }).end("Forbidden");
      return;
    }
    const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    if (path.startsWith("/api/")) return api(request, response, path);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...SECURITY_HEADERS, Allow: "GET, HEAD" }).end();
      return;
    }
    return asset(request, response, path);
  }

  async function api(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const origin = request.headers.origin;
    const site = request.headers["sec-fetch-site"];
    if ((origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) || (site !== undefined && site !== "same-origin")) {
      return json(response, 403, { message: "Requests from other sites are refused." });
    }
    const given = Buffer.from(request.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return json(response, 401, { message: "This link isn't valid anymore. Run the command again for a new one." });
    }
    touch();
    if (path === "/api/session" && request.method === "GET") return json(response, 200, session.view());
    if (request.method !== "POST") return json(response, 405, { message: "Use POST." });
    if (!(request.headers["content-type"] ?? "").startsWith("application/json")) return json(response, 415, { message: "Send JSON." });
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(response, (error as { status?: number }).status ?? 400, { message: (error as Error).message });
    }
    const text = (field: string): string => {
      const value = body[field];
      if (typeof value !== "string" || value === "") throw new ApprovalConflict(`${field} is missing.`);
      return value;
    };
    try {
      switch (path) {
        case "/api/connect":
          await session.connect(text("address"), typeof body["wallet"] === "string" ? body["wallet"].slice(0, 64) : undefined);
          break;
        case "/api/submit":
          await session.submit(text("stepId"), text("signedTxXdr"));
          break;
        case "/api/rebuild":
          await session.rebuild(text("stepId"));
          break;
        case "/api/cancel":
          session.cancel();
          break;
        default:
          return json(response, 404, { message: "Not found." });
      }
    } catch (error) {
      if (error instanceof ApprovalConflict) return json(response, 409, { message: error.message, view: session.view() });
      throw error;
    }
    return json(response, 200, session.view());
  }

  async function asset(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const file = path === "/" ? "index.html" : path.slice(1);
    const type = CONTENT_TYPES[extname(file)];
    // Only the built page's own files: no dot segments, hidden files or other types.
    let body: Buffer | undefined;
    if (type !== undefined && /^[\w-]+(?:\.[\w-]+)*(?:\/[\w-]+(?:\.[\w-]+)*)*$/.test(file)) {
      body = await readFile(new URL(file, page)).catch(() => undefined);
    }
    if (body === undefined) {
      response.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type!, "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  port = await listenOn(server, options.port ?? DEFAULT_APPROVAL_PORT).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && options.port === undefined) return listenOn(server, 0);
    throw error.code === "EADDRINUSE" ? new Error(`port ${options.port} is in use: pick another with --port`) : error;
  });
  touch();

  return {
    // Wallets treat localhost as a trusted development origin; browsers reach it on 127.0.0.1.
    url: `http://localhost:${port}/#${token}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(idle);
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 2000).unref();
      }),
  };
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // A body over the limit is read to its end but not kept, so the answer reaches the page.
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw Object.assign(new Error("The request is too large."), { status: 413 });
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("The request isn't JSON."), { status: 400 });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw Object.assign(new Error("The request isn't a JSON object."), { status: 400 });
  return value as Record<string, unknown>;
}

/** Opens `url` in the default browser. Best effort: the terminal shows the link too. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The link is printed: the developer can open it.
  }
}

export interface ApproveOptions {
  port?: number;
  /** false: print the link without opening a browser, as over SSH. */
  open?: boolean;
  page?: URL;
  log?: (line: string) => void;
}

/** Opens the approval page for `plan` and waits until the developer finishes or cancels. */
export async function approveInBrowser(plan: ApprovalPlan, chain: OwnerChain, options: ApproveOptions = {}): Promise<ApprovalOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const page = options.page ?? APPROVAL_PAGE;
  if (!existsSync(new URL("index.html", page))) {
    throw new Error("the approval page is not built: run `npm run build` in the stellar-agent-services repository, or sign with the Stellar CLI (--source <key>)");
  }
  const session = new ApprovalSession(plan, chain, log);
  const server = await startApprovalServer(session, { page, ...(options.port === undefined ? {} : { port: options.port }) });

  log("");
  log("Approve in your wallet");
  log(`  ${server.url}`);
  if (options.open !== false) {
    openBrowser(server.url);
    log("  Your browser opens this page. If it doesn't, open the link in the browser that has your wallet.");
  } else {
    log("  Open the link in the browser that has your wallet.");
  }
  if (plan.account !== undefined) log(`  Connect ${plan.account.address} (${plan.account.label.toLowerCase()}).`);
  log("  Waiting for your approval. Ctrl+C cancels.");
  log("");

  let interrupts = 0;
  const interrupt = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    if (session.busy) log("  Cancelling once the step under way finishes. Press Ctrl+C again to quit anyway.");
    session.cancel(true);
  };
  process.on("SIGINT", interrupt);
  try {
    return await session.finished;
  } finally {
    process.off("SIGINT", interrupt);
    await server.close();
  }
}
