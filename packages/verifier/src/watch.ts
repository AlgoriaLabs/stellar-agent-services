// verifier watch, the engine: answers the Stellar 8004 validation requests that name this verifier by
// itself, with no hand-off (docs/verification.md).
//
// Each round, tick():
// 1. reads the requests naming the validator that are new since the last round, and keeps the ones the
//    registry shows no response for;
// 2. works on each one that is due, one at a time, oldest first:
//    - resolves the manifest to check (requests.ts): the request document's, when the agent's registration
//      lists it [I1], else the registration's;
//    - runs every check, C1–C7, with the test payer, within the limits of `verifier verify --pay`. A run
//      starts only while the payer holds what a run may sign for, so an empty payer never fails a provider;
//    - issues the receipt and writes it to <data>/receipts/<sha256>.json with its badges, which handle()
//      serves at <public-url>/receipts/;
//    - publishes validation_response as `verifier publish` does: checkPublication() first, then the Stellar
//      CLI signs with its keychain key, which never enters this process; then the record is read back.
//
// Retries. A provider that is not reachable yet (no answer, or 404, 408, 425, 429 or 5xx for its manifest)
// is checked again with backoff, 1 minute doubling up to 1 hour, until `retryForMs` (24 h) after the
// request was found; then its failing result is the answer. A run that skipped a check without failing any
// is run again, three runs in all. A request whose manifest can't be resolved waits as long, then is
// refused: never verified, never answered.
//
// Never twice. The registry is read before every step, and checkPublication() refuses to sign once a
// request has a response, so a response from `verifier publish` or another watcher is never overwritten.
// The state records a response as sent before the Stellar CLI runs; after a crash, the response gets two
// minutes to show in the registry before it is sent again.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFORMANCE_LEVELS, PROVIDER_STANDARD, stellarAddressKind, type StellarNetwork, type VerificationReceipt } from "@stellar-agent-services/protocol";
import { badgesFor } from "./badges.js";
import { usdcBalance, type ChainReader } from "./chain.js";
import { formatUsdc, type Payer } from "./payments.js";
import { anchorProblems, checkPublication, DEFAULT_MAX_AGE_SECONDS, invokeArguments, PublicationError, type Publication } from "./publish.js";
import { issueReceipt, readReceipt, ReceiptError, writeReceipt } from "./receipt.js";
import type { Registry, ValidationRecord, ValidatorIndex } from "./registry.js";
import { resolveRequest } from "./requests.js";
import { DEFAULT_MAX_PRICE, DEFAULT_MAX_SPEND, verifyProvider, type VerificationReport } from "./verify.js";
import { loadState, saveState, type WatchedRequest, type WatchState } from "./watch-state.js";

/** How long a provider that is not reachable yet is checked again: 24 h after its request was found. */
export const DEFAULT_RETRY_FOR_MS = 24 * 3600_000;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 3600_000;
/** Runs for a provider that skipped a check without failing any. */
const MAX_RUNS = 3;
/** How long a sent response gets to show in the registry before it is sent again. */
const PUBLISH_GRACE_MS = 2 * 60_000;
/** Requests read from the registry's list at a time. */
const PAGE = 20;
/** Answered and refused requests are forgotten after this. Their receipts stay. */
const KEEP_FINISHED_MS = 90 * 24 * 3600_000;
/** Answers for a manifest URL that mean the provider is not up yet, such as a deploy still on its way. */
const NOT_YET = new Set([404, 408, 425, 429]);
const MAX_PROBLEM = 600;

export interface WatcherOptions {
  network: StellarNetwork;
  /** The verifier's G... account: the address of the Stellar CLI key `source`. */
  validator: string;
  registry: Registry & ValidatorIndex;
  chain: ChainReader;
  /** The test payer: a dedicated account holding USDC, never the validator. */
  payer: Payer;
  /** The https:// URL the watcher is served at. Receipts are at <publicUrl>/receipts/<sha256>.json. */
  publicUrl: string;
  /** Holds state.json, watch.lock and receipts/. */
  dataDir: string;
  /** Runs the Stellar CLI and returns its standard output. */
  stellar: (args: string[]) => Promise<string>;
  /** The Stellar CLI key that signs validation_response. */
  source: string;
  /** The Stellar CLI's name for the network: testnet or mainnet. */
  cliNetwork: string;
  /** Highest price of one job, in base units. Default DEFAULT_MAX_PRICE. */
  maxPrice?: bigint;
  /** Most one run may sign for, in base units. Default DEFAULT_MAX_SPEND. */
  maxSpend?: bigint;
  /** Pay pubnet providers: real money. */
  allowPubnet?: boolean;
  /** How long a provider that is not reachable yet is checked again. Default DEFAULT_RETRY_FOR_MS. */
  retryForMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Waits within a run: Retry-After, polling, ledgers. */
  sleep?: (ms: number) => Promise<void>;
  /** One line for the operator. */
  log?: (line: string) => void;
}

export interface Watcher {
  readonly state: WatchState;
  /** One round: finds new requests, then works on each one that is due. */
  tick(): Promise<void>;
  /** GET /receipts/<sha256>.json, /receipts/<sha256>.<badge>.svg, /requests/<request hash>.json and /healthz. */
  handle(request: Request): Promise<Response>;
  /** Stops the round in progress after its current step. */
  stop(): void;
}

/** Opens the data directory and loads the state. Take its lock first (lockDataDir). */
export async function openWatcher(options: WatcherOptions): Promise<Watcher> {
  const publicUrl = options.publicUrl.replace(/\/+$/, "");
  if (!isPublicUrl(publicUrl)) throw new TypeError("the public URL must be https:// without user info, query or fragment: response_uri must be HTTPS");
  if (stellarAddressKind(options.validator) !== "account") throw new TypeError("the validator must be a G... account address");
  if (options.payer.address === options.validator) throw new TypeError("the test payer and the validator must be different accounts");
  await mkdir(join(options.dataDir, "receipts"), { recursive: true });
  const state = await loadState(options.dataDir, options.network, options.validator);
  return new Engine({ ...options, publicUrl }, state);
}

/** An https:// URL without user info, query or fragment. */
export function isPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

type Issue = "scan" | "payer" | "publish";

type Outcome = { kind: "final" } | { kind: "unreachable" | "incomplete"; reason: string };

class Engine implements Watcher {
  private stopped = false;
  /** The test payer can't pay for a run this round: requests that need one wait for the next. */
  private held = false;
  private lastScanAt: number | undefined;
  /** The verifier's own problems, by kind: /healthz shows them. */
  private readonly issues = new Map<Issue, string>();
  private readonly now: () => number;
  private readonly receipts: string;
  private readonly maxSpend: bigint;
  private readonly retryForMs: number;

  constructor(
    private readonly options: WatcherOptions,
    readonly state: WatchState,
  ) {
    this.now = options.now ?? Date.now;
    this.receipts = join(options.dataDir, "receipts");
    this.maxSpend = options.maxSpend ?? DEFAULT_MAX_SPEND;
    this.retryForMs = options.retryForMs ?? DEFAULT_RETRY_FOR_MS;
  }

  stop(): void {
    this.stopped = true;
  }

  async tick(): Promise<void> {
    this.held = false;
    // A payer that was short is looked at again, so /healthz clears once it is funded.
    if (this.issues.has("payer")) this.held = !(await this.payerReady());
    await this.scan();
    const due = Object.entries(this.state.requests)
      .filter(([, entry]) => (entry.status === "waiting" || entry.status === "publishing") && Date.parse(entry.nextAt ?? entry.foundAt) <= this.now())
      .sort(([, a], [, b]) => a.ledger - b.ledger);
    for (const [hash, entry] of due) {
      if (this.stopped) break;
      try {
        await this.work(hash, entry);
      } catch (error) {
        this.log(`request ${short(hash)}: ${messageOf(error)}`);
        this.later(entry, "the verifier ran into a problem of its own; it will try again");
      }
      await this.save();
    }
    if (!Object.values(this.state.requests).some((entry) => entry.status === "publishing")) this.issues.delete("publish");
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return reply(405, { error: "only GET and HEAD" }, false, { Allow: "GET, HEAD" });
    const head = request.method === "HEAD";
    const path = new URL(request.url).pathname;
    if (/\/healthz$/.test(path)) return reply(200, this.health(), head);
    const receipt = /\/receipts\/([0-9a-f]{64}\.json)$/.exec(path);
    if (receipt !== null) return this.file(receipt[1]!, "application/json", head);
    const badge = /\/receipts\/([0-9a-f]{64}\.[a-z0-9-]{1,40}\.svg)$/.exec(path);
    if (badge !== null) return this.file(badge[1]!, "image/svg+xml", head);
    const known = /\/requests\/([0-9a-f]{64})\.json$/.exec(path);
    if (known !== null) {
      const entry = this.state.requests[known[1]!];
      return entry === undefined ? reply(404, { error: "this watcher knows no such request" }, head) : reply(200, this.describe(known[1]!, entry), head);
    }
    return reply(404, { error: "not found" }, head);
  }

  /** Reads the requests naming the validator that are new since the last round: the registry's list only grows. */
  private async scan(): Promise<void> {
    try {
      for (;;) {
        const hashes = await this.options.registry.validatorRequests(this.options.validator, this.state.scanned, PAGE);
        for (const hash of hashes) {
          await this.found(hash);
          this.state.scanned++;
        }
        if (hashes.length > 0) await this.save();
        if (hashes.length < PAGE || this.stopped) break;
      }
      this.lastScanAt = this.now();
      this.issues.delete("scan");
    } catch (error) {
      this.issue("scan", "the Validation Registry can't be read", error);
    }
  }

  private async found(hash: string): Promise<void> {
    if (this.state.requests[hash] !== undefined) return;
    const record = await this.options.registry.validation(hash);
    // The list and the record are written together: an RPC node that lags behind the one that listed it. The scan stops here and goes on next round.
    if (record === undefined) throw new Error(`the registry lists request ${hash} but shows no record of it yet`);
    // Answered already, by `verifier publish` or before this data directory existed: nothing to do.
    if (record.hasResponse || record.validator !== this.options.validator) return;
    const now = iso(this.now());
    this.state.requests[hash] = { agentId: record.agentId, ledger: record.lastUpdate, foundAt: now, status: "waiting", attempts: 0, runs: 0, incomplete: 0, nextAt: now };
    this.log(`request ${hash}: agent ${record.agentId} asks for validation (ledger ${record.lastUpdate})`);
  }

  /** One step for one request. */
  private async work(hash: string, entry: WatchedRequest): Promise<void> {
    const { registry, network, validator, chain } = this.options;
    const record = await registry.validation(hash);
    // Requests are never deleted: a lagging RPC node. Tried again later.
    if (record === undefined) throw new Error("the registry shows no record of this request right now");
    if (record.hasResponse) {
      await this.answered(hash, entry, record);
      return;
    }
    if (entry.status === "publishing") {
      const settled = entry.sentAt === undefined ? 0 : Date.parse(entry.sentAt) + PUBLISH_GRACE_MS;
      if (this.now() < settled) entry.nextAt = iso(settled);
      else await this.publish(hash, entry);
      return;
    }

    const resolution = await resolveRequest(
      { requestHash: hash, agentId: entry.agentId, ledger: entry.ledger },
      { network, validator, registry, chain, ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }) },
    );
    if ("retry" in resolution) {
      this.log(`request ${short(hash)}: ${resolution.retry}; trying again later`);
      this.later(entry, "the verifier can't read the chain right now; it will try again");
      return;
    }
    if ("refuse" in resolution) {
      this.finish(hash, entry, "refused", resolution.refuse);
      return;
    }
    if ("wait" in resolution) {
      if (this.expired(entry)) this.finish(hash, entry, "refused", `${resolution.wait}; given up after ${hours(this.retryForMs)}`);
      else this.wait(hash, entry, resolution.wait);
      return;
    }
    if (entry.manifestUrl !== resolution.manifestUrl) {
      this.log(`request ${short(hash)}: checking ${resolution.manifestUrl}, named by the ${resolution.from === "request" ? "request document" : "agent's registration"}`);
    }
    entry.manifestUrl = resolution.manifestUrl;
    entry.manifestFrom = resolution.from;

    // The request keeps its turn, and its tries, until the payer can pay.
    if (this.held || !(await this.payerReady())) {
      this.held = true;
      return;
    }
    const report = await verifyProvider({
      manifestUrl: resolution.manifestUrl,
      payer: this.options.payer,
      maxPrice: this.options.maxPrice ?? DEFAULT_MAX_PRICE,
      maxSpend: this.maxSpend,
      allowPubnet: this.options.allowPubnet ?? false,
      rpc: chain,
      registry,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      now: this.now,
    });
    entry.runs++;

    // The receipt could not answer this request: it would name another network or agent.
    if (report.network !== undefined && report.network !== network) {
      this.finish(hash, entry, "refused", `the manifest is for ${report.network}, but the request is on ${network}`);
      return;
    }
    if (report.agentId !== undefined && report.agentId !== entry.agentId) {
      this.finish(hash, entry, "refused", `the manifest names agent ${report.agentId}, but the request is for agent ${entry.agentId} [I2]`);
      return;
    }
    const outcome = classify(report);
    if (outcome.kind === "incomplete") entry.incomplete++;
    const again = outcome.kind === "unreachable" || (outcome.kind === "incomplete" && entry.incomplete < MAX_RUNS);
    if (outcome.kind !== "final" && again && !this.expired(entry)) {
      this.wait(hash, entry, outcome.reason);
      return;
    }
    await this.answer(hash, entry, report);
  }

  /** Whether the test payer can pay for a run. A payer that can't is the verifier's problem, never the provider's. */
  private async payerReady(): Promise<boolean> {
    const { payer, chain, network } = this.options;
    let balance: bigint | undefined;
    try {
      balance = await usdcBalance(chain, network, payer.address);
    } catch (error) {
      this.issue("payer", "the test payer's USDC balance can't be read", error);
      return false;
    }
    if (balance === undefined || balance < this.maxSpend) {
      const holds = balance === undefined ? "has no USDC trustline" : `holds ${formatUsdc(balance)}`;
      this.issue("payer", `the test payer ${payer.address} ${holds}, and a run may sign for ${formatUsdc(this.maxSpend)}: fund it`);
      return false;
    }
    this.issues.delete("payer");
    return true;
  }

  /** Issues the receipt, stores and serves it, then publishes it. */
  private async answer(hash: string, entry: WatchedRequest, report: VerificationReport): Promise<void> {
    const receipt = issueReceipt(report, { validator: this.options.validator, network: this.options.network, agentId: entry.agentId });
    const { sha256 } = await writeReceipt(receipt, this.receipts);
    await this.writeBadges(receipt, sha256, false);
    entry.status = "publishing";
    entry.receipt = sha256;
    entry.level = receipt.level;
    entry.score = receipt.score;
    entry.nextAt = iso(this.now());
    delete entry.problem;
    delete entry.sentAt;
    await this.save();
    this.log(`request ${short(hash)}: level ${receipt.level} (${levelName(receipt.level)}), score ${receipt.score}: ${this.receiptUrl(sha256)}`);
    await this.publish(hash, entry);
  }

  /** validation_response, exactly as `verifier publish` sends it. */
  private async publish(hash: string, entry: WatchedRequest): Promise<void> {
    const own = await this.ownReceipt(entry);
    if (own === undefined) {
      this.log(`request ${short(hash)}: its receipt is gone from ${this.receipts}; checking the provider again`);
      this.restart(entry);
      return;
    }
    const { receipt, sha256 } = own;
    let publication: Publication;
    try {
      publication = await checkPublication(receipt, {
        requestHash: hash,
        responseUri: this.receiptUrl(sha256),
        registry: this.options.registry,
        maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
        now: this.now,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      });
    } catch (error) {
      if (!(error instanceof PublicationError)) throw error;
      if (this.now() - Date.parse(receipt.checkedAt) > DEFAULT_MAX_AGE_SECONDS * 1000) {
        this.log(`request ${short(hash)}: its receipt is too old to publish now; checking the provider again`);
        this.restart(entry);
        return;
      }
      this.issue("publish", "answers can't be published", error);
      this.later(entry, "the verifier could not publish its answer yet; it will try again");
      return;
    }
    if (publication.updates) {
      // Answered meanwhile: a second response is never signed.
      const record = await this.options.registry.validation(hash);
      if (record !== undefined) await this.answered(hash, entry, record);
      return;
    }

    entry.sentAt = iso(this.now());
    await this.save();
    try {
      await this.options.stellar(invokeArguments(publication, { source: this.options.source, network: this.options.cliNetwork }));
    } catch (error) {
      this.issue("publish", "the Stellar CLI could not send validation_response", error);
      this.later(entry, "sending the answer failed; the verifier will try again");
      return;
    }
    const record = await this.options.registry.validation(hash);
    if (record !== undefined && anchorProblems(record, receipt, sha256).length === 0) {
      this.issues.delete("publish");
      await this.answered(hash, entry, record);
      return;
    }
    entry.nextAt = iso(this.now() + PUBLISH_GRACE_MS);
    entry.problem = "the answer was sent; waiting for the registry to show it";
  }

  /** The registry holds a response: this watcher's receipt, or another one. */
  private async answered(hash: string, entry: WatchedRequest, record: ValidationRecord): Promise<void> {
    const ours = entry.receipt !== undefined && record.responseHash === entry.receipt;
    const own = ours ? await this.ownReceipt(entry) : undefined;
    if (own !== undefined) await this.writeBadges(own.receipt, own.sha256, anchorProblems(record, own.receipt, own.sha256).length === 0);
    entry.answeredBy = ours ? "watch" : "other";
    this.finish(hash, entry, "answered");
  }

  /** The receipt the request is being answered with, or undefined when its file is gone or damaged. */
  private async ownReceipt(entry: WatchedRequest): Promise<{ receipt: VerificationReceipt; sha256: string } | undefined> {
    try {
      const read = await readReceipt(join(this.receipts, `${entry.receipt}.json`));
      return read.sha256 === entry.receipt ? read : undefined;
    } catch (error) {
      if (error instanceof ReceiptError) return undefined;
      throw error;
    }
  }

  /** Drops a receipt that can't be published, so the provider is checked again. */
  private restart(entry: WatchedRequest): void {
    entry.status = "waiting";
    entry.nextAt = iso(this.now());
    for (const key of ["receipt", "level", "score", "sentAt"] as const) delete entry[key];
  }

  private finish(hash: string, entry: WatchedRequest, status: "answered" | "refused", problem?: string): void {
    entry.status = status;
    entry.doneAt = iso(this.now());
    delete entry.nextAt;
    if (problem === undefined) delete entry.problem;
    else entry.problem = truncate(problem);
    if (status === "refused") this.log(`request ${short(hash)}: refused, never answered: ${problem}`);
    else if (entry.answeredBy === "watch") this.log(`request ${short(hash)}: answered on chain, response ${entry.score}`);
    else this.log(`request ${short(hash)}: it has a response from elsewhere, so this watcher sends none`);
  }

  private wait(hash: string, entry: WatchedRequest, reason: string): void {
    this.later(entry, reason);
    this.log(`request ${short(hash)}: ${reason}. Next try ${entry.nextAt}; tries until ${iso(this.deadline(entry))}`);
  }

  /** Schedules the next try with backoff: 1 minute, doubling, at most 1 hour. */
  private later(entry: WatchedRequest, problem: string): void {
    entry.attempts++;
    entry.nextAt = iso(this.now() + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(entry.attempts - 1, 16)));
    entry.problem = truncate(problem);
  }

  private deadline(entry: WatchedRequest): number {
    return Date.parse(entry.foundAt) + this.retryForMs;
  }

  private expired(entry: WatchedRequest): boolean {
    return this.now() >= this.deadline(entry);
  }

  private issue(kind: Issue, text: string, error?: unknown): void {
    if (this.issues.get(kind) !== text) this.log(error === undefined ? text : `${text}: ${messageOf(error)}`);
    this.issues.set(kind, text);
  }

  private async writeBadges(receipt: VerificationReceipt, sha256: string, validated: boolean): Promise<void> {
    for (const badge of badgesFor(receipt, { receiptSha256: sha256, validated })) {
      await writeFile(join(this.receipts, `${sha256}.${badge.id}.svg`), badge.svg);
    }
  }

  private receiptUrl(sha256: string): string {
    return `${this.options.publicUrl}/receipts/${sha256}.json`;
  }

  private async save(): Promise<void> {
    const forgotten = this.now() - KEEP_FINISHED_MS;
    for (const [hash, entry] of Object.entries(this.state.requests)) {
      if (entry.doneAt !== undefined && Date.parse(entry.doneAt) < forgotten) delete this.state.requests[hash];
    }
    await saveState(this.options.dataDir, this.state);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** A receipt or a badge: named by the receipt's hash, so they never change. */
  private async file(name: string, type: string, head: boolean): Promise<Response> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(this.receipts, name)));
    } catch {
      return reply(404, { error: "no such file" }, head);
    }
    return new Response(head ? null : bytes, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
        ...SHARED_HEADERS,
        ...(type === "image/svg+xml" ? { "Content-Security-Policy": "default-src 'none'" } : {}),
      },
    });
  }

  private health(): Record<string, unknown> {
    const requests = { waiting: 0, publishing: 0, answered: 0, refused: 0 };
    for (const entry of Object.values(this.state.requests)) requests[entry.status]++;
    const problems = [...this.issues.values()];
    return {
      status: problems.length === 0 ? "ok" : "degraded",
      standard: PROVIDER_STANDARD,
      network: this.options.network,
      validator: this.options.validator,
      payer: this.options.payer.address,
      receipts: `${this.options.publicUrl}/receipts/`,
      ...(this.lastScanAt === undefined ? {} : { lastScanAt: iso(this.lastScanAt) }),
      requests,
      ...(problems.length === 0 ? {} : { problems }),
    };
  }

  /** What GET /requests/<hash>.json shows: where the request stands, for the provider's owner. */
  private describe(hash: string, entry: WatchedRequest): Record<string, unknown> {
    const open = entry.status === "waiting" || entry.status === "publishing";
    const ours = entry.receipt !== undefined && entry.answeredBy !== "other";
    return {
      requestHash: hash,
      agentId: entry.agentId,
      network: this.options.network,
      validator: this.options.validator,
      status: entry.status,
      foundAt: entry.foundAt,
      ...(entry.manifestUrl === undefined ? {} : { manifest: entry.manifestUrl }),
      attempts: entry.attempts,
      ...(open && entry.nextAt !== undefined ? { nextAttemptAt: entry.nextAt } : {}),
      ...(entry.status === "waiting" ? { retryUntil: iso(this.deadline(entry)) } : {}),
      ...(entry.problem === undefined ? {} : { problem: entry.problem }),
      ...(ours ? { receipt: this.receiptUrl(entry.receipt!), level: entry.level, score: entry.score } : {}),
      ...(entry.status === "answered" ? { answeredAt: entry.doneAt, answeredBy: entry.answeredBy } : {}),
      ...(entry.status === "refused" ? { refusedAt: entry.doneAt } : {}),
    };
  }
}

/**
 * Whether a run answers the request. A manifest URL that gives no answer, or 404, 408, 425, 429 or 5xx, is a
 * provider that is not reachable yet. A run that failed nothing but skipped a check could not finish: an RPC
 * outage, a provider that stayed busy. C2 skipped for a manifest without an agentId is final.
 */
function classify(report: VerificationReport): Outcome {
  const c1 = report.results.find((result) => result.check === "C1");
  if (c1?.status === "failed") {
    const status = c1.evidence?.["status"];
    if (typeof status !== "number" || NOT_YET.has(status) || status >= 500) {
      return { kind: "unreachable", reason: `not reachable yet: ${c1.findings?.[0]?.message ?? "the manifest can't be fetched"}` };
    }
    return { kind: "final" };
  }
  if (report.results.some((result) => result.status === "failed")) return { kind: "final" };
  const unfinished = report.results.filter((result) => result.status === "skipped" && (result.check !== "C2" || report.agentId !== undefined));
  if (unfinished.length === 0) return { kind: "final" };
  return { kind: "incomplete", reason: `some checks could not finish: ${unfinished.map((result) => `${result.check} ${result.reason ?? "skipped"}`).join("; ")}` };
}

const SHARED_HEADERS = { "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" } as const;

function reply(status: number, body: unknown, head: boolean, headers: Record<string, string> = {}): Response {
  return new Response(head ? null : JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SHARED_HEADERS, ...headers },
  });
}

function levelName(level: number): string {
  return CONFORMANCE_LEVELS.find((each) => each.level === level)?.name ?? "not Described";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function hours(ms: number): string {
  return `${Math.round((ms / 3600_000) * 10) / 10} h`;
}

function short(hash: string): string {
  return hash.slice(0, 12);
}

function truncate(text: string): string {
  return text.length <= MAX_PROBLEM ? text : `${text.slice(0, MAX_PROBLEM - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
